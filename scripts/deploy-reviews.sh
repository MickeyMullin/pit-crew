#!/usr/bin/env bash
#
# deploy-reviews.sh — render the sanitized sources into a runnable local copy.
#
# Everything committed to this repo uses the literal placeholder {{HOME}} instead of
# a real home directory path, so no machine-specific path ever enters git history.
# Nothing reading those files expands {{HOME}} on its own: Claude Code does not
# expand placeholders, shell variables, or ~ inside command files, and an agent
# reading a prompt treats the path as literal text. Substitution therefore has to
# happen ahead of time, which is what this script does.
#
# Sources (committed)          ->  Output (local only, gitignored)
#   prompts/review/*.md        ->  deploy/prompts/review/*.md
#   commands/claude/*.md       ->  deploy/commands/claude/*.md
#   commands/skills/*/SKILL.md ->  deploy/commands/skills/*/SKILL.md
#
# Usage:
#   scripts/deploy-reviews.sh                  # render into ./deploy
#   scripts/deploy-reviews.sh --install        # also install for every agent found
#   scripts/deploy-reviews.sh --install=codex  # install for named agents only
#   scripts/deploy-reviews.sh --force          # render even if deploy/ has unsanitized edits
#   DEPLOY_DIR=/tmp/x scripts/deploy-reviews.sh
#   HOME_SUBSTITUTE=/Users/other scripts/deploy-reviews.sh
#
# Agents and where each one's commands are installed:
#
#   claude  ~/.claude/commands/<name>.md          CLAUDE_COMMANDS_TARGET
#   hermes  ~/.hermes/skills/pit-crew/<name>/     HERMES_SKILLS_TARGET
#   codex   ~/.codex/skills/<name>/               CODEX_SKILLS_TARGET
#
# Claude Code reads a directory of flat markdown slash commands; Hermes and Codex
# both read SKILL.md skill directories, so those two share one source tree. A bare
# --install installs for every agent whose directory exists on this machine and
# says which ones it skipped; --install=<agent>[,<agent>] is explicit and fails if
# a named agent is not there.
#
# Anything about to be overwritten is copied into backups/ first -- both the
# outgoing deploy/ tree and, with --install, the commands already installed.
# backups/ is untracked and local; see "Undo" at the end of the run output.
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${DEPLOY_DIR:-$repo_root/deploy}"

install=0
install_agents=""   # empty with install=1 means "every agent found on this machine"
force=0
for arg in "$@"; do
  case "$arg" in
    --install) install=1 ;;
    --install=*) install=1; install_agents="${arg#--install=}" ;;
    --force)   force=1 ;;
    -h|--help) sed -n '2,44p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# What {{HOME}} becomes. Override to render for a different account or checkout.
home_substitute="${HOME_SUBSTITUTE:-$HOME}"

if [[ -z "$home_substitute" ]]; then
  echo "error: HOME is empty and HOME_SUBSTITUTE was not set; nothing to substitute." >&2
  exit 1
fi

case "$home_substitute" in
  */) home_substitute="${home_substitute%/}" ;;
esac

# The substitution is applied with sed using | as the delimiter, so a replacement
# containing | or a backslash would corrupt the output rather than fail loudly.
case "$home_substitute" in
  *[\|\\]*)
    echo "error: substitution path contains | or \\, which sed cannot use here: $home_substitute" >&2
    exit 1
    ;;
esac

# The agent registry: one line per agent, "name|source|target|form|env".
#
# Installing under $home_substitute rather than $HOME is deliberate. The rendered
# command files contain $home_substitute/agents/prompts/... , so installing them
# into a different account's directory would hand that account commands pointing
# at paths it does not have. The two always match unless an env var overrides one.
#
# form=flat   a directory of *.md slash commands (Claude Code)
# form=skills a directory of <name>/SKILL.md skill directories (Hermes, Codex)
#
# Hermes is namespaced under a pit-crew/ directory because it discovers SKILL.md
# at any depth and treats the directory above a skill as its category -- so the
# extra level both groups these skills and keeps uninstalling them to one `rm -r`.
# Codex takes its skills at the top level, beside its own, so it gets no wrapper.
agents="\
claude|commands/claude|${CLAUDE_COMMANDS_TARGET:-${COMMANDS_TARGET:-$home_substitute/.claude/commands}}|flat|CLAUDE_COMMANDS_TARGET
hermes|commands/skills|${HERMES_SKILLS_TARGET:-$home_substitute/.hermes/skills/pit-crew}|skills|HERMES_SKILLS_TARGET
codex|commands/skills|${CODEX_SKILLS_TARGET:-$home_substitute/.codex/skills}|skills|CODEX_SKILLS_TARGET"

agent_field() {
  # agent_field <name> <1-based field>; prints nothing if the agent is unknown.
  printf '%s\n' "$agents" | awk -F'|' -v n="$1" -v f="$2" '$1 == n { print $f }'
}

# An agent counts as present when the PARENT of its target exists: ~/.claude for
# Claude, ~/.hermes/skills for Hermes, ~/.codex for Codex. The target itself may
# legitimately not exist yet -- it is ours to create -- but its parent is the
# agent's own directory, and creating that would be inventing an install.
agent_present() {
  [[ -d "$(dirname "$(agent_field "$1" 3)")" ]]
}

# Resolve which agents this run installs for, before anything is written -- the
# backup step needs the target list, and an unknown agent name should fail before
# deploy/ is touched rather than after.
selected_agents=""
skipped_agents=""
if [[ "$install" -eq 1 ]]; then
  if [[ -n "$install_agents" ]]; then
    for a in ${install_agents//,/ }; do
      if [[ -z "$(agent_field "$a" 1)" ]]; then
        echo "error: unknown agent '$a'." >&2
        echo "       Known agents: $(printf '%s\n' "$agents" | cut -d'|' -f1 | tr '\n' ' ')" >&2
        exit 2
      fi
      if ! agent_present "$a"; then
        echo "error: $a was named explicitly but $(dirname "$(agent_field "$a" 3)") does not exist." >&2
        echo "       Install $a first, or point $(agent_field "$a" 5) somewhere that exists." >&2
        exit 1
      fi
      selected_agents="$selected_agents $a"
    done
  else
    while IFS='|' read -r name _ _ _ _; do
      [[ -n "$name" ]] || continue
      if agent_present "$name"; then
        selected_agents="$selected_agents $name"
      else
        skipped_agents="$skipped_agents $name"
      fi
    done <<< "$agents"
    if [[ -z "$selected_agents" ]]; then
      echo "error: --install was given but no supported agent was found." >&2
      printf '%s\n' "$agents" | while IFS='|' read -r name _ target _ env; do
        echo "       $name: expected $(dirname "$target")  (override with $env)" >&2
      done
      echo "       Install one, or set its target env var; see --help." >&2
      exit 1
    fi
  fi
fi

echo "repo:       $repo_root"
echo "deploy dir: $deploy_dir"
echo "{{HOME}}   -> $home_substitute"
[[ -n "$selected_agents" ]] && echo "installing:$selected_agents"
echo

# Back up whatever is about to be destroyed, before destroying it. deploy/ is
# gitignored and the installed commands live outside the repo, so neither has a
# git safety net -- this directory is the only undo either one gets.
backup_root="${BACKUP_DIR:-$repo_root/backups}"
stamp="$(date +%Y%m%d-%H%M%S)"
backup_dir="$backup_root/$stamp"
backed_up=0

back_up() {
  local src="$1" label="$2"
  [[ -e "$src" ]] || return 0
  mkdir -p "$backup_dir/$label"
  cp -R "$src/." "$backup_dir/$label/" 2>/dev/null || true
  backed_up=$((backed_up + 1))
}

hash_file() {
  if command -v shasum >/dev/null 2>&1; then
    shasum -a 256 "$1" | awk '{print $1}'
  else
    sha256sum "$1" | awk '{print $1}'
  fi
}

# Rendering destroys deploy/. If it holds edits that never made it back to the
# sources, this run would discard them -- and deploy/ is gitignored, so git would
# not have them either.
#
# Comparing deploy/ against the sources is NOT enough to detect that: the trees
# also differ in the ordinary case where a source was edited and deploy/ is
# simply stale, which is exactly what this script is for. A difference alone
# cannot tell which side moved. So each render records the hash of every file it
# wrote, and this check asks a narrower question -- has anything in deploy/
# changed since the render that produced it? Only a hand-edit answers yes.
if [[ -d "$deploy_dir" && "$force" -eq 0 && -f "$deploy_dir/.manifest" ]]; then
  drifted=""
  while read -r recorded rel; do
    [[ -n "$rel" ]] || continue
    if [[ ! -f "$deploy_dir/$rel" ]]; then
      drifted="$drifted  D $rel"$'\n'
    elif [[ "$(hash_file "$deploy_dir/$rel")" != "$recorded" ]]; then
      drifted="$drifted  M $rel"$'\n'
    fi
  done < "$deploy_dir/.manifest"

  if [[ -n "$drifted" ]]; then
    echo "error: deploy/ has been edited since it was last rendered." >&2
    echo "       Rendering would discard those edits." >&2
    echo >&2
    printf '%s' "$drifted" >&2
    echo >&2
    echo "       Keep them:    scripts/sanitize.sh" >&2
    echo "       Discard them: scripts/deploy-reviews.sh --force" >&2
    exit 1
  fi
fi

back_up "$deploy_dir" "deploy"
for a in $selected_agents; do
  back_up "$(agent_field "$a" 3)" "$a-commands"
done

if [[ "$backed_up" -gt 0 ]]; then
  echo "backed up:  $backup_dir"
  echo
fi

# Render into a staging directory and swap it in only once everything has been
# written and checked. deploy/ is what actually runs, so a run interrupted
# halfway -- a SIGPIPE, a full disk, a failed check -- must not be able to leave
# a half-rendered tree behind for an agent to read.
# Staged as a sibling of deploy/, not in TMPDIR: the final mv is then a rename
# within one filesystem, which is atomic. A cross-device mv degrades to a
# copy-then-delete and reintroduces the half-written window this exists to close.
stage_dir="$(mktemp -d "$(dirname "$deploy_dir")/.deploy-stage.XXXXXX")"
trap 'rm -rf "$stage_dir"' EXIT
mkdir -p "$stage_dir"

rendered=0

# Walk the tree rather than naming known directories. New prompt families --
# prompts/document, prompts/release, whatever comes next -- are then picked up
# automatically. Hardcoding the set means a directory nobody remembered to add
# here is silently dropped from deploy/, which is where the live copy lives.
render_tree() {
  local root="$1" f rel
  [[ -d "$repo_root/$root" ]] || return 0
  while IFS= read -r f; do
    rel="${f#$repo_root/}"
    mkdir -p "$stage_dir/$(dirname "$rel")"
    sed "s|{{HOME}}|$home_substitute|g" "$f" > "$stage_dir/$rel"
    echo "  $rel"
    rendered=$((rendered + 1))
  done < <(find "$repo_root/$root" -type f -name '*.md' | sort)
}

echo "rendered:"
render_tree "prompts"
render_tree "commands"

if [[ "$rendered" -eq 0 ]]; then
  echo "error: no source files found; refusing to report success." >&2
  echo "       deploy/ was left untouched." >&2
  exit 1
fi

# The whole point is that no unsubstituted placeholder survives into something
# that gets run. This check is deliberately generic rather than looking for
# {{HOME}} specifically: a placeholder added later is caught without anyone
# remembering to extend this. Angle brackets are NOT matched here, because the
# prompts use <number>, <owner>, <ref> and friends as their own runtime
# convention -- those are resolved by the agent while it works, and must survive
# deployment untouched. Only {{...}} means "substitute me before this runs".
if grep -rlE '\{\{[A-Za-z0-9_]+\}\}' "$stage_dir" >/dev/null 2>&1; then
  echo >&2
  echo "error: unsubstituted placeholder(s) remain in:" >&2
  grep -rlE '\{\{[A-Za-z0-9_]+\}\}' "$stage_dir" >&2
  echo "       deploy/ was left untouched." >&2
  exit 1
fi

# Record what this render produced, so the next run can tell a hand-edited
# deploy/ from one that is merely stale. Paths are relative to deploy/.
manifest="$stage_dir/.manifest"
: > "$manifest"
while IFS= read -r f; do
  rel="${f#$stage_dir/}"
  echo "$(hash_file "$f") $rel" >> "$manifest"
done < <(find "$stage_dir" -type f -name '*.md' | sort)

# Everything rendered and checked. Swap the staged tree in. Rebuilding from
# scratch also drops any file deleted upstream, which a copy-over would keep.
rm -rf "$deploy_dir"
mkdir -p "$(dirname "$deploy_dir")"
mv "$stage_dir" "$deploy_dir"

echo
echo "$rendered file(s) rendered, no placeholders remaining."

# Both installers report through the global $installed rather than by printing a
# count, so the names they list can go straight to the screen as they work.
installed=0

# Install a flat directory of *.md slash commands (Claude Code's form).
install_flat() {
  local src="$1" target="$2" f n
  for f in "$src"/*.md; do
    [[ -e "$f" ]] || continue
    # README.md documents the commands; it is not one of them.
    n="$(basename "$f")"
    [[ "$n" == "README.md" ]] && continue
    cp "$f" "$target/$n"
    echo "  $n"
    installed=$((installed + 1))
  done
}

# Install <name>/SKILL.md skill directories (Hermes's and Codex's form). The whole
# directory is copied, not just SKILL.md, so a skill that later grows scripts/ or
# references/ beside it installs without this needing to be taught about them.
install_skills() {
  local src="$1" target="$2" d n
  for d in "$src"/*/; do
    [[ -f "$d/SKILL.md" ]] || continue
    n="$(basename "$d")"
    # Replace rather than merge: a file dropped from a skill upstream must not
    # survive in the installed copy, where nothing would ever remove it.
    rm -rf "${target:?}/$n"
    cp -R "$d" "$target/$n"
    echo "  $n/"
    installed=$((installed + 1))
  done
}

if [[ "$install" -eq 1 ]]; then
  for a in $selected_agents; do
    src="$deploy_dir/$(agent_field "$a" 2)"
    target="$(agent_field "$a" 3)"
    form="$(agent_field "$a" 4)"

    if [[ ! -d "$src" ]]; then
      echo "error: nothing rendered at $src for agent $a." >&2
      exit 1
    fi
    mkdir -p "$target"

    echo
    echo "installing $a into $target"
    installed=0
    if [[ "$form" == "flat" ]]; then
      install_flat "$src" "$target"
    else
      install_skills "$src" "$target"
    fi

    if [[ "$installed" -eq 0 ]]; then
      echo "error: nothing was installed for $a; expected command files in $src." >&2
      exit 1
    fi
    echo "$installed installed for $a."
  done
  if [[ -n "$skipped_agents" ]]; then
    echo
    echo "Not installed (no directory for them on this machine):$skipped_agents"
  fi
else
  echo
  echo "Commands were rendered but NOT installed. Re-run with --install to install"
  echo "them for every agent found here, or --install=<agent> for one:"
  printf '%s\n' "$agents" | while IFS='|' read -r name src target form env; do
    if agent_present "$name"; then
      echo "  $name -> $target"
    else
      echo "  $name -> $target (not found here)"
    fi
  done
fi

if [[ "$backed_up" -gt 0 ]]; then
  echo
  echo "Undo: restore what this run replaced with"
  echo "  cp -R $backup_dir/deploy/. $deploy_dir/"
  for a in $selected_agents; do
    [[ -d "$backup_dir/$a-commands" ]] || continue
    echo "  cp -R $backup_dir/$a-commands/. $(agent_field "$a" 3)/"
  done
fi

if [[ ! -L "$home_substitute/agents/prompts" ]]; then
  echo
  echo "Note: $home_substitute/agents/prompts is not a symlink into this render."
  echo "  ln -sfn $deploy_dir/prompts $home_substitute/agents/prompts"
fi
