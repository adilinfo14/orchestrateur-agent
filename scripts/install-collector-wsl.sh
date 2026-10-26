#!/usr/bin/env bash
# Installe le collecteur dans WSL 2 comme service systemd utilisateur.
# Prérequis : systemd activé dans WSL (/etc/wsl.conf : [boot] systemd=true), Claude Code installé DANS WSL.
# Le collecteur WSL est une machine distincte du collecteur Windows (son propre ~/.claude, ses propres sessions).
set -euo pipefail
REPO="$(cd "$(dirname "$0")/.." && pwd)"
NODE="$(command -v node)"
UNIT="$HOME/.config/systemd/user/acc-collector.service"
mkdir -p "$(dirname "$UNIT")" "$HOME/.acc"
cat > "$UNIT" <<UNIT
[Unit]
Description=Agent Command Center - collecteur Claude Code (WSL)
After=network-online.target

[Service]
ExecStart=$NODE $REPO/apps/collector/src/cli.ts run
WorkingDirectory=$REPO
Environment=NODE_NO_WARNINGS=1
Environment=PATH=$(dirname "$NODE"):$HOME/.local/bin:/usr/local/bin:/usr/bin:/bin
Restart=always
RestartSec=10

[Install]
WantedBy=default.target
UNIT
systemctl --user daemon-reload
systemctl --user enable --now acc-collector.service
echo "Collecteur installé. Journal : journalctl --user -u acc-collector -f"
echo "Pour qu'il tourne sans session ouverte : sudo loginctl enable-linger $USER"
