#!/bin/bash

set -e
set -u
set -o pipefail

# ─── Validate argument ───────────────────────────────────────────────────────
if [ -z "${1:-}" ]; then
    echo "Usage: ./release.sh <version>"
    echo "Example: ./release.sh 1.0.5  or  ./release.sh v1.0.5"
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

# ─── Pull latest main ────────────────────────────────────────────────────────
echo ""
echo "📦 Pulling latest main..."
git checkout main
git pull origin main

# ─── Create and push tag ─────────────────────────────────────────────────────
echo ""
echo "🏷️  Creating and pushing tag $TAG..."

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
