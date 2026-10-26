#!/usr/bin/env bash
# Installe le collecteur comme agent launchd de l'utilisateur (démarrage à la connexion, relance auto).
# Désinstallation : launchctl bootout gui/$(id -u)/com.agent-command-center.collector && rm ~/Library/LaunchAgents/com.agent-command-center.collector.plist
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
LABEL="com.agent-command-center.collector"
PLIST="$HOME/Library/LaunchAgents/$LABEL.plist"
mkdir -p "$HOME/Library/LaunchAgents" "$HOME/.acc"
cat > "$PLIST" <<PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>Label</key><string>$LABEL</string>
  <key>ProgramArguments</key><array><string>$NODE</string><string>$REPO/apps/collector/src/cli.ts</string><string>run</string></array>
  <key>WorkingDirectory</key><string>$REPO</string>
  <key>EnvironmentVariables</key><dict>
    <key>PATH</key><string>$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>NODE_NO_WARNINGS</key><string>1</string>
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ThrottleInterval</key><integer>10</integer>
  <key>StandardOutPath</key><string>$HOME/.acc/collector.log</string>
  <key>StandardErrorPath</key><string>$HOME/.acc/collector.log</string>
</dict></plist>
PLIST
launchctl bootout "gui/$(id -u)/$LABEL" 2>/dev/null || true
launchctl bootstrap "gui/$(id -u)" "$PLIST"
echo "Collecteur installé ($PLIST). Journal : ~/.acc/collector.log"
