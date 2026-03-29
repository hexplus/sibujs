#!/bin/bash

set -e

# ─── Validate argument ───────────────────────────────────────────────────────
if [ -z "$1" ]; then
    echo "Usage: ./release.sh <version>"
    echo "Example: ./release.sh 1.0.5"
    exit 1
fi

VERSION=$1
BRANCH=$VERSION
TAG="v$VERSION"

echo "🚀 Starting release process for $TAG"

# ─── Step 1: Checkout main and pull latest ───────────────────────────────────
echo ""
echo "📦 Checking out main..."
git checkout main
git pull origin main

# ─── Step 2: Create release branch ──────────────────────────────────────────
echo ""
echo "🌿 Creating branch $BRANCH..."
git checkout -b "$BRANCH"

# ─── Step 3: Bump version in package.json (no tag, no commit) ───────────────
echo ""
echo "🔢 Bumping version to $VERSION..."
npm version "$VERSION" --no-git-tag-version

# ─── Step 4: Commit and push branch ──────────────────────────────────────────
echo ""
echo "📤 Committing and pushing branch..."
git add package.json
git commit -m "chore: bump version to $VERSION"
git push origin "$BRANCH"

# ─── Step 5: Wait for PR to be merged ────────────────────────────────────────
echo ""
echo "⏳ Open a PR from '$BRANCH' → 'main' and merge it."
echo "   Then press ENTER to continue..."
read -r

# ─── Step 6: Checkout main, pull, create and push tag ────────────────────────
echo ""
echo "🏷️  Creating and pushing tag $TAG..."
git checkout main
git pull origin main
git tag "$TAG"
git push origin "$TAG"

# ─── Done ─────────────────────────────────────────────────────────────────────
echo ""
echo "✅ Tag $TAG pushed successfully!"
echo "👉 Now go to GitHub → Releases → Draft a new release → select $TAG → Publish"
