#!/usr/bin/env bash
set -euo pipefail
: "${GITHUB_OUTPUT:?GITHUB_OUTPUT is required}"
: "${GITHUB_REPOSITORY:?GITHUB_REPOSITORY is required}"

tag="${1:?Usage: prepare-release.sh TAG ASSET...}"
shift
if (( $# == 0 )); then
  echo "At least one release asset is required." >&2
  exit 1
fi
for asset in "$@"; do
  if [[ ! -s "$asset" ]]; then
    echo "Release asset is missing or empty: $asset" >&2
    exit 1
  fi
done

encoded_tag=$(bun -e 'process.stdout.write(encodeURIComponent(process.argv[1]))' "$tag")
if response=$(gh api --include "repos/$GITHUB_REPOSITORY/releases/tags/$encoded_tag" --jq '.draft'); then
  draft="${response##*$'\n'}"
else
  status="${response%%$'\n'*}"
  if [[ ! "$status" =~ ^HTTP/[0-9.]+[[:space:]]404([[:space:]]|$) ]]; then
    echo "Unable to determine release state; refusing to create or modify a release." >&2
    exit 1
  fi
  gh release create "$tag" --draft --generate-notes --verify-tag
  draft=true
fi

case "$draft" in
  false)
    echo "Release $tag is already published; leaving its assets and image tags unchanged."
    echo "published=true" >> "$GITHUB_OUTPUT"
    exit 0
    ;;
  true) ;;
  *)
    echo "Unexpected release state: $draft" >&2
    exit 1
    ;;
esac

# Failed uploads can be retried safely while the release remains a draft.
gh release upload "$tag" "$@" --clobber
echo "published=false" >> "$GITHUB_OUTPUT"
