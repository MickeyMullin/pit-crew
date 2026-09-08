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
#
# Usage:
#   scripts/deploy-reviews.sh            # render into ./deploy
#   DEPLOY_DIR=/tmp/x scripts/deploy-reviews.sh
#   HOME_SUBSTITUTE=/Users/other scripts/deploy-reviews.sh
#
set -euo pipefail

repo_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
deploy_dir="${DEPLOY_DIR:-$repo_root/deploy}"

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

echo "repo:       $repo_root"
echo "deploy dir: $deploy_dir"
echo "{{HOME}}   -> $home_substitute"
echo

# Rebuild from scratch so a source file deleted upstream does not linger here.
rm -rf "$deploy_dir"
mkdir -p "$deploy_dir/prompts/review" "$deploy_dir/commands/claude"

rendered=0
render_tree() {
  local src_dir="$1" dst_dir="$2" f name
  for f in "$repo_root/$src_dir"/*.md; do
    [[ -e "$f" ]] || continue
    name="$(basename "$f")"
    sed "s|{{HOME}}|$home_substitute|g" "$f" > "$dst_dir/$name"
    echo "  $src_dir/$name"
    rendered=$((rendered + 1))
  done
}

echo "rendered:"
render_tree "prompts/review"  "$deploy_dir/prompts/review"
render_tree "commands/claude" "$deploy_dir/commands/claude"

if [[ "$rendered" -eq 0 ]]; then
  echo "error: no source files found; refusing to report success." >&2
  exit 1
fi

# The whole point is that no unsubstituted placeholder survives into something
# that gets run. This check is deliberately generic rather than looking for
# {{HOME}} specifically: a placeholder added later is caught without anyone
# remembering to extend this. Angle brackets are NOT matched here, because the
# prompts use <number>, <owner>, <ref> and friends as their own runtime
# convention -- those are resolved by the agent while it works, and must survive
# deployment untouched. Only {{...}} means "substitute me before this runs".
if grep -rlE '\{\{[A-Za-z0-9_]+\}\}' "$deploy_dir" >/dev/null 2>&1; then
  echo >&2
  echo "error: unsubstituted placeholder(s) remain in:" >&2
  grep -rlE '\{\{[A-Za-z0-9_]+\}\}' "$deploy_dir" >&2
  exit 1
fi

echo
echo "$rendered file(s) rendered, no placeholders remaining."
echo
echo "Next steps (not performed by this script):"
echo "  point prompts at the render:"
echo "    ln -sfn $deploy_dir/prompts $home_substitute/agents/prompts"
echo "  install the Claude Code commands:"
echo "    cp $deploy_dir/commands/claude/review-*.md $home_substitute/.claude/commands/"
