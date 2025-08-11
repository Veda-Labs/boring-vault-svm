#!/bin/bash

# tag.sh - Create or replace an annotated tag and optionally push it
# Usage: ./tag.sh <name> <program-id> <message> [client]

set -euo pipefail            # Exit on error, undefined variable, and pipeline failures
IFS=$'\n\t'

NAME=$1
PROGRAM_ID=$2
MESSAGE=$3
# Optional client parameter (defaults to 'dev')
CLIENT=${4:-dev}

# Validate inputs: 3 or 4 args and required fields non-empty
if [[ $# -lt 3 || $# -gt 4 || -z "$NAME" || -z "$PROGRAM_ID" || -z "$MESSAGE" ]]; then
    echo "Usage: $0 <name> <program-id> <message> [client]"
    echo "Example: $0 release-v1 ALPHAProgramId111111111111111111111111111 'Initial release' dev"
    exit 1
fi

# Get current git info
CURRENT_BRANCH=$(git branch --show-current)
CURRENT_COMMIT=$(git rev-parse --short HEAD)

# Determine last tag (if any) to build changelog
LAST_TAG=$(git describe --tags --abbrev=0 2>/dev/null || echo "")
if [[ -n "$LAST_TAG" ]]; then
    COMMITS=$(git log "$LAST_TAG"..HEAD --reverse --pretty='* %s (%h)')
else
    COMMITS=$(git log --reverse --pretty='* %s (%h)')
fi

# Create tag name directly from NAME arg
TAG="$NAME"

# Handle existing tag
REPLACED_TAG=false
if git rev-parse -q --verify "$TAG" >/dev/null 2>&1; then
    read -rp "Tag '$TAG' already exists. Delete and recreate it? [y/N] " del_ans
    if [[ $del_ans =~ ^[Yy] ]]; then
        echo "🔄 Deleting existing local tag '$TAG' ..."
        git tag -d "$TAG"
        REPLACED_TAG=true
    else
        echo "Aborting without changes."
        exit 1
    fi
fi

echo "🚀 Deployment Setup:"
echo "   Tag Name: $TAG"
echo "   Program ID: $PROGRAM_ID"
echo "   Client: $CLIENT"
echo "   Branch: $CURRENT_BRANCH"
echo "   Commit: $CURRENT_COMMIT"
echo

# Build tag message in a temp file to preserve newlines
TAG_MSG_FILE=$(mktemp)
{
    echo "Client: $CLIENT"
    echo "Program ID: $PROGRAM_ID"
    echo
    echo "Description: *$MESSAGE*"
    echo
    echo "Branch: $CURRENT_BRANCH"
    echo "Timestamp: $(date -u)"
    echo "Deployer: $(whoami)"
    if [[ -n "$COMMITS" ]]; then
        echo
        echo "Changes since ${LAST_TAG:-project start}:"
        echo "$COMMITS"
    fi
} > "$TAG_MSG_FILE"

# Create annotated tag with deployment metadata
echo "🏷️  Creating (or replacing) tag: $TAG"
git tag -a "$TAG" -F "$TAG_MSG_FILE"

echo "✅ Successfully tagged deployment!"

# Optionally push the tag
read -rp "Push tag '$TAG' to origin? [y/N] " answer
if [[ $answer =~ ^[Yy] ]]; then
    echo "📤 Pushing tag to origin..."
    if [[ $REPLACED_TAG == true ]]; then
        # Attempt to delete remote tag first (ignore failure if it didn't exist remotely)
        git push --delete origin "$TAG" 2>/dev/null || true
    fi
    git push origin "$TAG" --force
    echo "✅ Tag pushed."
    # Optionally create/update GitHub release
    if command -v gh >/dev/null 2>&1; then
        read -rp "Create or update GitHub release for '$TAG'? [y/N] " rel_ans
        if [[ $rel_ans =~ ^[Yy] ]]; then
            if gh release view "$TAG" >/dev/null 2>&1; then
                read -rp "Release '$TAG' exists. Delete and recreate? [y/N] " rel_del_ans
                if [[ $rel_del_ans =~ ^[Yy] ]]; then
                    gh release delete "$TAG" -y
                else
                    echo "Skipping release creation."
                    rm -f "$TAG_MSG_FILE"
                    exit 0
                fi
            fi
            gh release create "$TAG" --title "$TAG" -F "$TAG_MSG_FILE" --verify-tag
            echo "✅ GitHub release created."
        fi
    fi
else
    echo "Skipping push. You can push later with: git push origin '$TAG' --force"
fi

# Clean up temp file
rm -f "$TAG_MSG_FILE"
