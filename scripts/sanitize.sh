#!/usr/bin/env bash
#
# sanitize.sh — the reverse of deploy-reviews.sh.
#
# deploy-reviews.sh renders committed sources into deploy/ with {{HOME}} replaced
# by a real path. This script takes the other direction: it reads the files in
# deploy/, swaps the real home path back to the {{HOME}} placeholder, and writes
# the result over the committed sources, ready for review and commit.
#
#   sources (committed)          deploy/ (gitignored, real paths)
#   prompts/review/*.md    --->  deploy/prompts/review/*.md      deploy-reviews.sh
#   commands/claude/*.md   <---  deploy/commands/claude/*.md     sanitize.sh
#
# The point is that deploy/ is what actually runs. Edit a prompt there, run a real
# review against it, and once it works, bring the tested version back here without
# hand-editing paths and without risking a real home path reaching git history.
#
# Usage:
#   scripts/sanitize.sh              # sanitize deploy/ back over the sources
#   scripts/sanitize.sh --dry-run    # report what would change, write nothing
#   scripts/sanitize.sh --force      # proceed even if the sources are dirty
#   HOME_SUBSTITUTE=/Users/other scripts/sanitize.sh
#
# Exit codes: 0 nothing pending or changes applied; 1 error; 2 bad usage;
# 3 --dry-run found pending changes.
#
# This does not run `git add`. Read the diff first: the substitution is textual,
# and a wrong replacement here is exactly the leak this repo exists to prevent.
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${DEPLOY_DIR:-$repo_root/deploy}"

dry_run=0
force=0
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --force)   force=1 ;;
    -h|--help) sed -n '2,28p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) echo "error: unknown argument: $arg" >&2; exit 2 ;;
  esac
done

# The path being replaced. Must match whatever deploy-reviews.sh substituted in.
home_substitute="${HOME_SUBSTITUTE:-$HOME}"
case "$home_substitute" in
  */) home_substitute="${home_substitute%/}" ;;
esac

# This script replaces every occurrence of $home_substitute with a placeholder.
# A short or empty value would rewrite huge amounts of unrelated text -- HOME=/
# would turn every path separator in every file into {{HOME}}. Refuse outright
# rather than corrupt the sources.
if [[ -z "$home_substitute" ]]; then
  echo "error: HOME is empty and HOME_SUBSTITUTE was not set; nothing to replace." >&2
  exit 1
fi
if [[ "$home_substitute" != /* || ${#home_substitute} -lt 4 ]]; then
  echo "error: refusing to treat '$home_substitute' as a home directory --" >&2
  echo "       it must be absolute and more than a few characters." >&2
  exit 1
fi
case "$home_substitute" in
  *[\|\\]*)
    echo "error: path contains | or \\, which sed cannot use here: $home_substitute" >&2
    exit 1
    ;;
esac

if [[ ! -d "$deploy_dir" ]]; then
  echo "error: no deploy directory at $deploy_dir" >&2
  echo "       run scripts/deploy-reviews.sh first, then edit the files there." >&2
  exit 1
fi

# Applying would overwrite the sources. That is recoverable through git only if
# the sources are committed, so uncommitted work in them blocks the run -- but
# only when there is actually something to write. Checking up front would refuse
# runs that would not overwrite anything at all, including the common case where
# the trees already agree and this script is just refreshing the manifest.
sources_checked=0
ensure_sources_clean() {
  [[ "$sources_checked" -eq 0 ]] || return 0
  sources_checked=1
  [[ "$dry_run" -eq 0 && "$force" -eq 0 ]] || return 0
  if ! git -C "$repo_root" diff --quiet -- prompts commands 2>/dev/null; then
    echo "error: prompts/ or commands/ has uncommitted changes." >&2
    echo "       Sanitizing would overwrite them with the deploy/ versions." >&2
    echo "       Commit or stash them first, or re-run with --force." >&2
    exit 1
  fi
}

echo "repo:       $repo_root"
echo "deploy dir: $deploy_dir"
echo "$home_substitute -> {{HOME}}"
[[ "$dry_run" -eq 1 ]] && echo "mode:       dry run (nothing will be written)"
echo

# deploy/ and the sources agree once this script finishes -- whether it wrote
# anything or found nothing to bring back. Either way a render would reproduce
# what is already there, so refresh deploy-reviews.sh's manifest to say so.
# Without this it keeps seeing pre-sanitize hashes and refuses to run, blocking
# on edits that have in fact already been preserved.
refresh_manifest() {
  [[ -f "$deploy_dir/.manifest" ]] || return 0
  local f
  : > "$deploy_dir/.manifest"
  while IFS= read -r f; do
    if command -v shasum >/dev/null 2>&1; then
      echo "$(shasum -a 256 "$f" | awk '{print $1}') ${f#$deploy_dir/}" >> "$deploy_dir/.manifest"
    else
      echo "$(sha256sum "$f" | awk '{print $1}') ${f#$deploy_dir/}" >> "$deploy_dir/.manifest"
    fi
  done < <(find "$deploy_dir" -type f -name '*.md' | sort)
  echo "Render manifest refreshed; deploy/ and the sources are in sync."
}

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT

changed=0
unchanged=0
added=0

sanitize_tree() {
  local src_dir="$1" dst_dir="$2" f name staged
  for f in "$deploy_dir/$src_dir"/*.md; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f")"
    staged="$tmp_dir/$name"

    sed "s|$home_substitute|{{HOME}}|g" "$f" > "$staged"

    # Prove the round trip before trusting it: re-rendering what we just produced
    # must reproduce the deploy file byte for byte. If it does not, the file held
    # something this simple substitution cannot represent -- a literal {{HOME}},
    # say -- and writing it over the source would silently change meaning.
    if ! sed "s|{{HOME}}|$home_substitute|g" "$staged" | cmp -s - "$f"; then
      echo "error: round trip failed for $src_dir/$name" >&2
      echo "       sanitizing then re-rendering does not reproduce the original." >&2
      echo "       Inspect that file by hand; nothing has been written." >&2
      exit 1
    fi

    if [[ ! -e "$repo_root/$dst_dir/$name" ]]; then
      echo "  + $dst_dir/$name (new)"
      added=$((added + 1))
    elif cmp -s "$staged" "$repo_root/$dst_dir/$name"; then
      unchanged=$((unchanged + 1))
      continue
    else
      echo "  M $dst_dir/$name"
      changed=$((changed + 1))
    fi

    if [[ "$dry_run" -eq 0 ]]; then
      ensure_sources_clean
      cp "$staged" "$repo_root/$dst_dir/$name"
    fi
  done
}

sanitize_tree "prompts/review"  "prompts/review"
sanitize_tree "commands/claude" "commands/claude"

if [[ $((changed + added)) -eq 0 ]]; then
  echo "  (nothing to bring back -- sources already match deploy/)"
  echo
  echo "$unchanged file(s) checked, 0 changed."
  # Not on a dry run: a dry run must leave every trace of state alone.
  [[ "$dry_run" -eq 1 ]] || refresh_manifest
  exit 0
fi

echo
echo "$((changed + added)) file(s) to update, $unchanged unchanged."

if [[ "$dry_run" -eq 1 ]]; then
  echo
  echo "Dry run: nothing written. Re-run without --dry-run to apply."
  # Exit 3, not 0: a dry run that found pending changes is a distinct outcome,
  # and deploy-reviews.sh checks for exactly this before overwriting deploy/.
  exit 3
fi

# Last line of defence. If a real path survived into the sources, it is one
# commit away from being permanent.
if grep -rl "$home_substitute" "$repo_root/prompts" "$repo_root/commands" >/dev/null 2>&1; then
  echo >&2
  echo "error: a real home path remains in the sources after sanitizing:" >&2
  grep -rl "$home_substitute" "$repo_root/prompts" "$repo_root/commands" >&2
  echo "       DO NOT COMMIT. Fix these before going further." >&2
  exit 1
fi

echo "No real home path remains in the sources."

refresh_manifest

echo
echo "Next:"
echo "  git -C $repo_root diff -- prompts commands   # review before committing"
echo "  git -C $repo_root add -A && git commit"
echo
echo "deploy/ and the sources now match, so there is no need to re-run"
echo "deploy-reviews.sh unless you change the sources directly."
