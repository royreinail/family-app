#!/bin/sh
# Wrapper so the dev server always runs with the correct cwd regardless of
# how the launching process was spawned.
cd "$(dirname "$0")"
exec "/Users/royreina/Family app/.tools/node-v24.19.0-darwin-arm64/bin/node" node_modules/vite/bin/vite.js dev --port 5173 --strictPort
