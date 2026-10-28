#!/usr/bin/env bash
# Start Claude Team UI.
#   ./start.sh                         projects already registered, this machine only
#   ./start.sh ~/code/repo-a repo-b    register these repositories too
#   ./start.sh --lan                   also open it to your phone (same Wi-Fi or Tailscale)
#   ./start.sh --install [--lan|--tailscale]   macOS: run it at login instead, through launchd (scripts/install-launchagent.sh)
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
if [ "${1:-}" = "--install" ]; then shift; exec "$HERE/scripts/install-launchagent.sh" "$@"; fi

need() { command -v "$1" >/dev/null 2>&1 || { echo "✗ $1 is missing. $2"; exit 1; }; }
need node "Install: brew install node   (Node 18+)"
need tmux "Install: brew install tmux"
need git "Install: xcode-select --install"
need claude "Install: curl -fsSL https://claude.ai/install.sh | bash   then run claude and /login"
command -v gh >/dev/null 2>&1 || echo "· No GitHub CLI: works without issues and PRs. Install: brew install gh && gh auth login"
major="$(node -p 'process.versions.node.split(".")[0]')"
[ "$major" -ge 18 ] || { echo "✗ Node 18+ needed, found $(node -v)"; exit 1; }

args=()
for a in "$@"; do
  if [[ "$a" == --* ]]; then args+=("$a")
  elif [ -d "$a" ]; then args+=(--project "$(cd "$a" && pwd)")
  else echo "✗ No such folder: $a"; exit 1
  fi
done
exec node "$HERE/server.js" ${args[@]+"${args[@]}"}
