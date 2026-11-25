#!/usr/bin/env bash
# Publish helper for Command Optimizer
# Usage: ./publish.sh <github-owner/repo-name>
set -euo pipefail

REPO_SLUG="${1:-}"
PLUGIN_NAME="$(node -e "const p=require('./.claude-plugin/plugin.json'); process.stdout.write(p.name)")"
VERSION="$(node -e "const p=require('./.claude-plugin/plugin.json'); process.stdout.write(p.version)")"

echo "==> 1. Validating plugin and marketplace manifest..."
if command -v claude >/dev/null 2>&1; then
  claude plugin validate --strict .
  echo "==> 2. Running automated mod test suite..."
  claude plugin test .
else
  echo "Warning: 'claude' CLI not found on PATH; skipping local CLI validation."
fi

if [ -z "$REPO_SLUG" ]; then
  echo ""
  echo "Local validation complete! To push and publish to GitHub, run:"
  echo "  ./publish.sh <your-github-username>/<your-repo-name>"
  exit 0
fi

echo "==> 3. Initializing Git repository and committing release v${VERSION}..."
if [ ! -d .git ]; then
  git init -b main
fi

git add .
git commit -m "chore(release): publish ${PLUGIN_NAME} v${VERSION}" || true

REMOTE_URL="https://github.com/${REPO_SLUG}.git"
if git remote get-url origin >/dev/null 2>&1; then
  git remote set-url origin "$REMOTE_URL"
else
  git remote add origin "$REMOTE_URL"
fi

TAG="${PLUGIN_NAME}--v${VERSION}"
echo "==> 4. Pushing main branch and release tag ${TAG}..."
git push -u origin main

if git rev-parse -q --verify "refs/tags/$TAG" >/dev/null; then
  echo "Tag $TAG already exists; bump the version before publishing again."
else
  git tag "$TAG"
  git push origin "$TAG"
fi

echo ""
echo "Published! Anyone can now install your plugin in Claude Code with:"
echo "  /plugin install ${PLUGIN_NAME} --marketplace ${REPO_SLUG}"
echo "or from their shell:"
echo "  claude plugin install ${PLUGIN_NAME} --marketplace ${REPO_SLUG}"
