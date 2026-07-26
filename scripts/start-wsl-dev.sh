#!/bin/bash
# Start NanoClaw's dev server under WSL/Linux, wired up to a local copilot-api
# proxy so containers can call GitHub Copilot-backed Claude models instead of
# needing native Anthropic credentials or OneCLI.
#
# Why this exists: production NanoClaw only ever runs on Linux, and running
# real Docker containers from native Windows has different mount/permission
# semantics — so local dev/testing of anything that spawns a container agent
# (which is most things) should happen from WSL. See e2e.tier1.test.ts's
# header comment for the same rule applied to the Tier 1 e2e harness.
#
# Usage (from a WSL shell, at the repo root or anywhere):
#   scripts/start-wsl-dev.sh
#
# Override the proxy port or default models via env vars, e.g.:
#   COPILOT_API_PORT=4200 ANTHROPIC_MODEL=claude-opus-5 scripts/start-wsl-dev.sh
set -euo pipefail
cd "$(dirname "$0")/.."

COPILOT_API_PORT="${COPILOT_API_PORT:-4141}"
COPILOT_API_LOG="/tmp/copilot-api.log"
GITHUB_TOKEN_FILE="$HOME/.local/share/copilot-api/github_token"

is_copilot_api_up() {
  curl -s -o /dev/null "http://localhost:${COPILOT_API_PORT}/"
}

# One-time GitHub device-code login (persists to $GITHUB_TOKEN_FILE, so this
# is only interactive the very first time).
if [ ! -f "$GITHUB_TOKEN_FILE" ]; then
  echo "No copilot-api GitHub token found — running device-code auth flow."
  echo "Follow the prompt below (visit the URL, enter the code)."
  npx copilot-api@latest auth
fi

# Start copilot-api in the background if it isn't already listening.
if is_copilot_api_up; then
  echo "copilot-api already running on port ${COPILOT_API_PORT}"
else
  echo "Starting copilot-api on port ${COPILOT_API_PORT} (log: ${COPILOT_API_LOG})..."
  setsid nohup npx copilot-api@latest start --port "${COPILOT_API_PORT}" \
    > "$COPILOT_API_LOG" 2>&1 < /dev/null &
  for _ in $(seq 1 30); do
    is_copilot_api_up && break
    sleep 1
  done
  if ! is_copilot_api_up; then
    echo "copilot-api didn't come up in time — check ${COPILOT_API_LOG}" >&2
    exit 1
  fi
  echo "copilot-api is up."
fi

# Route Claude Code's Agent SDK traffic (inside the container) to the host's
# copilot-api proxy instead of api.anthropic.com. container-runner.ts forwards
# these into the container when ANTHROPIC_BASE_URL is set, and skips OneCLI
# gateway credential injection entirely (see container-runner.ts).
export ANTHROPIC_BASE_URL="http://host.docker.internal:${COPILOT_API_PORT}"
# copilot-api doesn't validate this token — Claude Code just needs it non-empty
# to consider itself "logged in" when using a custom ANTHROPIC_BASE_URL.
export ANTHROPIC_AUTH_TOKEN="${ANTHROPIC_AUTH_TOKEN:-dummy}"
# copilot-api only recognizes its own short model names (no dated suffixes) —
# see `npx copilot-api@latest start` output for the full list it exposes.
export ANTHROPIC_MODEL="${ANTHROPIC_MODEL:-claude-sonnet-4.5}"
export ANTHROPIC_DEFAULT_SONNET_MODEL="${ANTHROPIC_DEFAULT_SONNET_MODEL:-claude-sonnet-4.5}"
export ANTHROPIC_SMALL_FAST_MODEL="${ANTHROPIC_SMALL_FAST_MODEL:-claude-haiku-4.5}"
export ANTHROPIC_DEFAULT_HAIKU_MODEL="${ANTHROPIC_DEFAULT_HAIKU_MODEL:-claude-haiku-4.5}"

echo "Starting NanoClaw (ANTHROPIC_BASE_URL=${ANTHROPIC_BASE_URL}, model=${ANTHROPIC_MODEL})..."
exec npm run dev
