#!/usr/bin/env bash
# Add mcpolyglot to Claude Code (https://docs.claude.com/en/docs/claude-code/mcp).
set -euo pipefail

CONFIG="$(cd "$(dirname "$0")" && pwd)/mcpolyglot.config.ts"

claude mcp add mcpolyglot -- npx -y @mcpolyglot/cli serve --config "$CONFIG"
echo "Added mcpolyglot to Claude Code (config: $CONFIG)"
