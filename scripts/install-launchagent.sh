#!/usr/bin/env bash
# Run Claude Team UI at login on macOS, through launchd, and start it again when it stops.
#   scripts/install-launchagent.sh [--lan|--tailscale]   install or update the agent, then start it
#   scripts/install-launchagent.sh --uninstall           stop it and remove the agent
#   scripts/install-launchagent.sh --print [...]         print the plist instead of installing it (tests, a look first)
# Logs: ~/Library/Logs/claude-team-ui/out.log and err.log. The agent gets no shell profile, so the folders of node,
# tmux, gh, git and claude found now go into its PATH (and NTFY_URL, when set); run it again after moving one of them.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
LABEL="com.claude-team-ui"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
LOGS="$HOME/Library/Logs/claude-team-ui"
mode=""; print=0; uninstall=0
for a in "$@"; do
  case "$a" in
    --lan|--tailscale) mode="$a";;
    --print) print=1;;
    --uninstall) uninstall=1;;
    *) echo "Unknown option: $a" >&2; exit 1;;
  esac
done
if [ "$uninstall" = 1 ]; then
  launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
  rm -f "$PLIST"
  echo "Removed $LABEL. The console no longer starts at login."
  exit 0
fi
NODE="$(command -v node || true)"
[ -n "$NODE" ] || { echo "✗ node is missing. Install: brew install node" >&2; exit 1; }
dirs=""
add() { case ":$dirs:" in *":$1:"*) ;; *) dirs="${dirs:+$dirs:}$1";; esac; }
for b in node tmux gh git claude; do
  p="$(command -v "$b" 2>/dev/null || true)"; [ -n "$p" ] && add "$(dirname "$p")"
done
for d in /usr/bin /bin /usr/sbin /sbin; do add "$d"; done
AGENT_PATH="$dirs"
xml() { printf '%s' "$1" | sed 's/&/\&amp;/g; s/</\&lt;/g; s/>/\&gt;/g'; }
plist="<?xml version=\"1.0\" encoding=\"UTF-8\"?>
<!DOCTYPE plist PUBLIC \"-//Apple//DTD PLIST 1.0//EN\" \"http://www.apple.com/DTDs/PropertyList-1.0.dtd\">
<plist version=\"1.0\">
<dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key>
  <array>
    <string>$(xml "$NODE")</string>
    <string>$(xml "$HERE/server.js")</string>${mode:+
    <string>$mode</string>}
  </array>
  <key>WorkingDirectory</key><string>$(xml "$HERE")</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key><string>$(xml "$AGENT_PATH")</string>
    <key>HOME</key><string>$(xml "$HOME")</string>${NVM_DIR:+
    <key>NVM_DIR</key><string>$(xml "$NVM_DIR")</string>}${NTFY_URL:+
    <key>NTFY_URL</key><string>$(xml "$NTFY_URL")</string>}
  </dict>
  <key>StandardOutPath</key><string>$(xml "$LOGS/out.log")</string>
  <key>StandardErrorPath</key><string>$(xml "$LOGS/err.log")</string>
</dict>
</plist>"
if [ "$print" = 1 ]; then printf '%s\n' "$plist"; exit 0; fi
[ "$(uname)" = Darwin ] || { echo "✗ launchd is macOS only. Elsewhere, run ./start.sh under your service manager." >&2; exit 1; }
mkdir -p "$(dirname "$PLIST")" "$LOGS"
printf '%s\n' "$plist" > "$PLIST"
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
sleep 1
launchctl print "gui/$(id -u)/$LABEL" 2>/dev/null | grep -E "^\s+(state|pid) = " || true
echo "Installed $LABEL: the console runs at login${mode:+ with $mode}. Logs: $LOGS/out.log and err.log"
echo "Stop it for good with: scripts/install-launchagent.sh --uninstall"
