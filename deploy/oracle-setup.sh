#!/usr/bin/env bash
# One-time setup of 夾團台 on a fresh Ubuntu server (e.g. Oracle Cloud Always Free).
# Run it from inside the cloned repo:   bash deploy/oracle-setup.sh
# It installs Node.js and Caddy (which gets a free HTTPS certificate), runs the app as a
# background service that restarts on its own, and opens ports 80/443 in the server firewall.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
APP_USER="$(id -un)"
DATA_DIR=/var/lib/groupbuy

echo "夾團台 server setup"
echo
read -rp "你嘅網址 (例如 mygroupbuy.duckdns.org): " DOMAIN
if [[ ! "$DOMAIN" =~ ^[A-Za-z0-9.-]+\.[A-Za-z]{2,}$ ]]; then
  echo "網址格式唔啱，應該似 mygroupbuy.duckdns.org"; exit 1
fi
read -rsp "通行碼 ACCESS_CODE (打字時唔會顯示): " CODE; echo
if [[ ! "$CODE" =~ ^[A-Za-z0-9._-]{6,100}$ ]]; then
  echo "通行碼要 6 個字或以上，只可以用英文字母、數字、. _ -"; exit 1
fi

echo; echo "== 1/5 安裝 Node.js 同 Caddy =="
sudo apt-get update
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y ca-certificates curl git caddy iptables-persistent
if ! command -v node >/dev/null || [ "$(node -p 'process.versions.node.split(".")[0]')" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
  sudo apt-get install -y nodejs
fi
echo "Node $(node --version)"

echo; echo "== 2/5 準備資料夾 ($DATA_DIR) =="
sudo mkdir -p "$DATA_DIR"
sudo chown "$APP_USER": "$DATA_DIR"

echo; echo "== 3/5 設定背景服務 =="
sudo tee /etc/groupbuy.env >/dev/null <<EOF
ACCESS_CODE=$CODE
DATA_FILE=$DATA_DIR/data.json
PORT=3000
HOST=127.0.0.1
EOF
sudo chmod 600 /etc/groupbuy.env
sudo tee /etc/systemd/system/groupbuy.service >/dev/null <<EOF
[Unit]
Description=Group buy site
After=network.target

[Service]
User=$APP_USER
WorkingDirectory=$APP_DIR
EnvironmentFile=/etc/groupbuy.env
ExecStart=$(command -v node) server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
EOF
sudo systemctl daemon-reload
sudo systemctl enable groupbuy
sudo systemctl restart groupbuy

echo; echo "== 4/5 設定 HTTPS (Caddy) =="
sudo tee /etc/caddy/Caddyfile >/dev/null <<EOF
$DOMAIN {
	encode gzip
	reverse_proxy 127.0.0.1:3000
}
EOF
sudo systemctl enable caddy
sudo systemctl restart caddy

echo; echo "== 5/5 打開 port 80 同 443 =="
for p in 80 443; do
  if ! sudo iptables -C INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT 2>/dev/null; then
    # Oracle's Ubuntu image ends the INPUT chain with a REJECT rule; insert above it.
    n="$(sudo iptables -L INPUT --line-numbers | awk '/REJECT/ {print $1; exit}')"
    if [ -n "$n" ]; then
      sudo iptables -I INPUT "$n" -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    else
      sudo iptables -A INPUT -p tcp --dport "$p" -m state --state NEW -j ACCEPT
    fi
  fi
done
sudo netfilter-persistent save

echo; echo "== 檢查 =="
sleep 2
if curl -fsS http://127.0.0.1:3000/api/config >/dev/null; then
  echo "✅ 網站已經喺 server 上面運行"
else
  echo "❌ 網站未能啟動，請睇：sudo journalctl -u groupbuy -n 50"; exit 1
fi
echo
echo "完成！一兩分鐘後打開： https://$DOMAIN"
echo "(第一次 Caddy 要時間攞 HTTPS 證書。如果打唔開，請確認 Oracle 嘅 Security List 已經開咗 port 80 同 443。)"
