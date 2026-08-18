#!/bin/sh
# Wrapper so the dev server always runs with the correct cwd regardless of
# how the launching process was spawned. Uses npx (not a hardcoded
# node_modules/vite path) since npm workspaces hoist shared deps to the
# repo root, not always into web/node_modules directly.
cd "$(dirname "$0")"
export PATH="/Users/royreina/Family app/.tools/node-v24.19.0-darwin-arm64/bin:$PATH"
exec npx vite dev --port 5173 --strictPort
