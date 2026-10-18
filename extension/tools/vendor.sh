#!/usr/bin/env bash
# Re-fetch the vendored browser libraries into extension/media/vendor/.
# Pinned versions; no npm needed. Run from anywhere.
set -euo pipefail

KATEX=0.16.11
MARKDOWN_IT=14.1.0
MERMAID=11.4.1
HLJS=11.10.0

here="$(cd "$(dirname "$0")" && pwd)"
vendor="$here/../media/vendor"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

fetch_tgz() {  # name version -> extracts to $work/<name>/package
  mkdir -p "$work/$1"
  curl -sSL -o "$work/$1/pkg.tgz" "https://registry.npmjs.org/$1/-/$1-$2.tgz"
  tar -xzf "$work/$1/pkg.tgz" -C "$work/$1"
}

fetch_tgz katex "$KATEX"
fetch_tgz markdown-it "$MARKDOWN_IT"
fetch_tgz highlight.js "$HLJS"
fetch_tgz mermaid "$MERMAID"

mkdir -p "$vendor/katex/contrib"
cp "$work/katex/package/dist/katex.min.js" "$work/katex/package/dist/katex.min.css" "$vendor/katex/"
rm -rf "$vendor/katex/fonts" && cp -r "$work/katex/package/dist/fonts" "$vendor/katex/fonts"
cp "$work/katex/package/dist/contrib/auto-render.min.js" "$vendor/katex/contrib/"
cp "$work/katex/package/LICENSE" "$vendor/katex/LICENSE"

cp "$work/markdown-it/package/dist/markdown-it.min.js" "$vendor/"
cp "$work/markdown-it/package/LICENSE" "$vendor/LICENSE.markdown-it"

# highlight.js ships no browser bundle on npm; cdnjs has the UMD build of the same release.
curl -sSL -o "$vendor/highlight.min.js" "https://cdnjs.cloudflare.com/ajax/libs/highlight.js/$HLJS/highlight.min.js"
cp "$work/highlight.js/package/styles/github-dark.min.css" "$vendor/hljs-github-dark.min.css"
cp "$work/highlight.js/package/LICENSE" "$vendor/LICENSE.highlight.js"

# mermaid 11 on npm is ESM + chunks (32 MB); the single-file IIFE build is on jsdelivr.
curl -sSL -o "$vendor/mermaid.min.js" "https://cdn.jsdelivr.net/npm/mermaid@$MERMAID/dist/mermaid.min.js"
cp "$work/mermaid/package/LICENSE" "$vendor/LICENSE.mermaid"

du -sh "$vendor"
