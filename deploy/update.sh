#!/usr/bin/env bash
# Pull the latest code from GitHub and restart the site. Data is kept.
# Run on the server:   bash deploy/update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
git pull --ff-only
sudo systemctl restart groupbuy
sleep 2
if curl -fsS http://127.0.0.1:3000/api/config >/dev/null; then echo "✅ 已更新"; else echo "❌ 啟動失敗：sudo journalctl -u groupbuy -n 50"; exit 1; fi
