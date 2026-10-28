#!/usr/bin/env bash
#
# test-deploy-reviews.sh — exercise deploy-reviews.sh against a throwaway home.
#
# Every run points HOME, HOME_SUBSTITUTE, DEPLOY_DIR and BACKUP_DIR into a fresh
# temporary directory, so nothing real is read or written: not ~/agents, not any
# agent's commands, not this checkout's deploy/ or backups/. Only the sources are
# read from the repo. The temporary directories are removed on exit.
#
# Covers the four states of ~/agents/prompts and ~/agents/bin (missing, linked
# here, linked elsewhere or dangling, a real file or directory), each with and
# without --install, plus idempotence and the behavior that predates linking.
#
# Usage:
#   scripts/test-deploy-reviews.sh
#
# Exit codes: 0 every check passed; 1 at least one failed.
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
script="$repo_root/scripts/deploy-reviews.sh"

# Overrides from the caller's environment would send installs somewhere real.
unset HOME_SUBSTITUTE DEPLOY_DIR BACKUP_DIR COMMANDS_TARGET \
  CLAUDE_COMMANDS_TARGET HERMES_SKILLS_TARGET CODEX_SKILLS_TARGET

tmp="${TMPDIR:-/tmp}"
scratch="$(mktemp -d "${tmp%/}/test-deploy-reviews.XXXXXX")"
trap 'rm -rf "$scratch"' EXIT

failures=0
checks=0
case_name=""
root="" home="" out="" err="" status=0

# fresh_case <name> -- a new empty root with a home that has Claude Code only.
fresh_case() {
  case_name="$1"
  root="$scratch/$(printf '%s' "$1" | tr -c 'A-Za-z0-9' '-')"
  home="$root/home"
  mkdir -p "$home/.claude"
  echo "case: $case_name"
}

# run [args...] -- run the script in the current case's root.
run() {
  status=0
  HOME="$home" HOME_SUBSTITUTE="$home" DEPLOY_DIR="$root/deploy" BACKUP_DIR="$root/backups" \
    "$script" "$@" > "$root/out" 2> "$root/err" || status=$?
  out="$(cat "$root/out")"
  err="$(cat "$root/err")"
}

pass() { checks=$((checks + 1)); }
fail() {
  checks=$((checks + 1))
  failures=$((failures + 1))
  echo "  FAIL: $*"
  echo "    --- stdout ---"; sed 's/^/    /' "$root/out"
  echo "    --- stderr ---"; sed 's/^/    /' "$root/err"
}

expect_status() {
  if [[ "$status" -eq "$1" ]]; then pass; else fail "exit $status, expected $1"; fi
}
expect_out()     { if grep -qF -- "$1" <<< "$out"; then pass; else fail "stdout lacks: $1"; fi; }
expect_err()     { if grep -qF -- "$1" <<< "$err"; then pass; else fail "stderr lacks: $1"; fi; }
expect_no_out()  { if grep -qF -- "$1" <<< "$out"; then fail "stdout has: $1"; else pass; fi; }
expect_err_empty() { if [[ -z "$err" ]]; then pass; else fail "stderr not empty"; fi; }

# expect_linked <name> -- home/agents/<name> is a symlink resolving into deploy/.
expect_linked() {
  local l="$home/agents/$1"
  if [[ -L "$l" && "$(cd -P "$l" && pwd -P)" == "$(cd -P "$root/deploy/$1" && pwd -P)" ]]; then
    pass
  else
    fail "$l is not a symlink to $root/deploy/$1"
  fi
}

# expect_points <name> <target> -- the link text is exactly <target> (untouched).
expect_points() {
  local l="$home/agents/$1"
  if [[ -L "$l" && "$(readlink "$l")" == "$2" ]]; then pass; else fail "$l no longer points at $2"; fi
}

expect_installed() {
  if [[ -f "$home/.claude/commands/review-pr.md" ]]; then pass; else fail "commands were not installed"; fi
}

# --- 1. Missing ------------------------------------------------------------

fresh_case "missing, without --install"
run
expect_status 0
expect_out "file(s) rendered, no placeholders remaining."
expect_out "Commands were rendered but NOT installed."
expect_out "Note: $home/agents/prompts does not exist; --install links it to $root/deploy/prompts."
expect_out "Note: $home/agents/bin does not exist; --install links it to $root/deploy/bin."
expect_no_out "ln -sfn"
if [[ ! -e "$home/agents" ]]; then pass; else fail "$home/agents was created without --install"; fi

fresh_case "missing, with --install"
run --install
expect_status 0
expect_err_empty
expect_installed
expect_linked prompts
expect_linked bin
expect_out "linked:     $home/agents/prompts -> $root/deploy/prompts"
expect_out "linked:     $home/agents/bin -> $root/deploy/bin"
expect_out "Undo: remove the link(s) this run created with"
expect_out "  rm $home/agents/prompts"
expect_out "  rm $home/agents/bin"

# --- 2. Already linked here, and idempotence ---------------------------------

echo "case: linked here, second --install run (same root)"
run --install
expect_status 0
expect_err_empty
expect_linked prompts
expect_linked bin
expect_no_out "linked:"
expect_no_out "Note:"
expect_no_out "remove the link"
expect_out "Undo: restore what this run replaced with"
expect_out "cp -R $root/backups/"

echo "case: linked here, without --install (same root)"
run
expect_status 0
expect_err_empty
expect_no_out "Note:"
expect_linked prompts

fresh_case "linked here through another route to the same directory"
run
ln -s "$root" "$root/alias"
mkdir -p "$home/agents"
ln -s "$root/alias/deploy/prompts" "$home/agents/prompts"
ln -s "$root/alias/deploy/bin" "$home/agents/bin"
run --install
expect_status 0
expect_err_empty
expect_points prompts "$root/alias/deploy/prompts"
expect_no_out "linked:"

# --- 3. A symlink elsewhere, or dangling ---------------------------------------

fresh_case "linked elsewhere, without --install"
mkdir -p "$home/agents" "$root/other/prompts"
ln -s "$root/other/prompts" "$home/agents/prompts"
ln -s "$root/gone/bin" "$home/agents/bin"
run
expect_status 0
expect_out "Note: $home/agents/prompts is a symlink to $root/other/prompts, not to this render."
expect_out "Note: $home/agents/bin is a symlink to $root/gone/bin, which does not exist."
expect_out "ln -sfn $root/deploy/prompts $home/agents/prompts"
expect_points prompts "$root/other/prompts"
expect_points bin "$root/gone/bin"

echo "case: linked elsewhere, with --install (same root)"
run --install
expect_status 1
expect_installed
expect_err "error: $home/agents/prompts is a symlink to $root/other/prompts, not to this render."
expect_err "error: $home/agents/bin is a symlink to $root/gone/bin, which does not exist."
expect_err "  ln -sfn $root/deploy/prompts $home/agents/prompts"
expect_err "  ln -sfn $root/deploy/bin $home/agents/bin"
expect_err "error: 2 link(s) under $home/agents need fixing by hand"
expect_err "the install is NOT"
expect_points prompts "$root/other/prompts"
expect_points bin "$root/gone/bin"
expect_no_out "remove the link"

# --- 4. A real file or directory ------------------------------------------------

fresh_case "real directory and file, without --install"
mkdir -p "$home/agents/prompts"
echo keep > "$home/agents/prompts/mine.md"
echo keep > "$home/agents/bin"
run
expect_status 0
expect_out "Note: $home/agents/prompts is a real directory, not a symlink to this render."
expect_out "Note: $home/agents/bin is a real file, not a symlink to this render."

echo "case: real directory and file, with --install (same root)"
run --install
expect_status 1
expect_installed
expect_err "error: $home/agents/prompts is a real directory, not a symlink to this render."
expect_err "error: $home/agents/bin is a real file, not a symlink to this render."
expect_err "  mv $home/agents/prompts $home/agents/prompts.bak-"
expect_err "  ln -s $root/deploy/prompts $home/agents/prompts"
expect_err "the install is NOT"
if [[ -d "$home/agents/prompts" && ! -L "$home/agents/prompts" && -f "$home/agents/prompts/mine.md" ]]; then pass; else fail "real prompts directory was changed"; fi
if [[ ! -e "$home/agents/prompts/prompts" ]]; then pass; else fail "a link was created inside the real directory"; fi
if [[ -f "$home/agents/bin" && ! -L "$home/agents/bin" && "$(cat "$home/agents/bin")" == keep ]]; then pass; else fail "real bin file was changed"; fi

echo "case: one fixed by hand, rerun links the other (same root)"
rm "$home/agents/bin"
run --install
expect_status 1
expect_linked bin
expect_err "error: 1 link(s) under $home/agents need fixing by hand"

fresh_case "agents itself is a file, with --install"
echo keep > "$home/agents"
run --install
expect_status 1
expect_installed
expect_err "error: $home/agents exists but is not a directory"
if [[ -f "$home/agents" && "$(cat "$home/agents")" == keep ]]; then pass; else fail "$home/agents was changed"; fi

# --- Behavior that predates linking ---------------------------------------------

fresh_case "unknown argument"
run --bogus
expect_status 2
expect_err "error: unknown argument: --bogus"

fresh_case "explicit agent that is absent"
run --install=codex
expect_status 1
expect_err "error: codex was named explicitly"
if [[ ! -e "$root/deploy" && ! -e "$home/agents" ]]; then pass; else fail "files were written before the refusal"; fi

fresh_case "hand-edited deploy/ is refused"
run --install
echo edit >> "$root/deploy/prompts/review/review-pr.md"
run --install
expect_status 1
expect_err "error: deploy/ has been edited since it was last rendered."
if grep -q '^edit$' "$root/deploy/prompts/review/review-pr.md"; then pass; else fail "the hand edit was discarded"; fi

echo
if [[ "$failures" -eq 0 ]]; then
  echo "$checks check(s) passed."
else
  echo "$failures of $checks check(s) FAILED."
  exit 1
fi
