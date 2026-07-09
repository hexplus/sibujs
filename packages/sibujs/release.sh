#!/bin/bash

# SibuJS release helper.
#
# This script does NOT publish anything itself. Publishing is a pnpm workspace
# operation (@sibujs/core -> sibujs -> @sibujs/labs) handled by
# .github/workflows/publish.yml, which runs `pnpm -r publish` so the
# `workspace:` dependency ranges are rewritten to concrete versions. npm
# provenance is produced by that workflow via OIDC (`id-token: write`), NOT by
# any field in package.json.
#
# All this script does is create and push an annotated git tag for the current
# HEAD. Pushing the tag lets you draft the matching GitHub Release, whose
# `published` event triggers publish.yml. Run it from the branch you intend to
# release (the publish workflow asserts tag == workspace version).

set -e
set -u
set -o pipefail

# ─── Validate argument ───────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
    echo "Usage: ./release.sh <version>"
    echo "Example: ./release.sh 4.0.0-alpha.0  or  ./release.sh v4.0.0-alpha.0"
    exit 1
fi

if ! echo "$1" | grep -Eq '^v?[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.]+)?$'; then
    echo "Error: invalid version format: $1"
    echo "Expected: 1.2.3 or v1.2.3 (optional -prerelease suffix)"
    exit 1
fi

VERSION="${1#v}"
TAG="v$VERSION"

echo "🚀 Starting release for $TAG"

# ─── Create and push tag on the current HEAD ─────────────────────────────────
echo ""
echo "🏷️  Creating and pushing tag $TAG on $(git rev-parse --abbrev-ref HEAD)..."

# Delete local tag if already exists
if git tag | grep -Fxq "$TAG"; then
    echo "   Tag $TAG already exists locally, deleting it..."
    git tag -d "$TAG"
fi

# Delete remote tag if already exists (explicit refs/tags/ to avoid ambiguity)
if git ls-remote --tags origin | awk '{print $2}' | grep -Fxq "refs/tags/$TAG"; then
    echo "   Tag $TAG already exists on remote, deleting it..."
    git push origin --delete "refs/tags/$TAG"
fi

git tag "$TAG"
git push origin "refs/tags/$TAG"

# ─── Done ────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Tag $TAG pushed!"
echo "👉 Go to GitHub → Releases → Draft a new release → select $TAG → Publish"
echo "   The 'published' event runs .github/workflows/publish.yml (pnpm -r publish)."
