#!/bin/bash
set -euo pipefail
cd /home/opc/tempo-upload
curl -fSLO https://nodejs.org/dist/v24.20.0/node-v24.20.0-linux-x64.tar.xz
printf '%s\n' '2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2  node-v24.20.0-linux-x64.tar.xz' | sha256sum --check
sudo tar -xJf node-v24.20.0-linux-x64.tar.xz -C /opt
id tempo >/dev/null 2>&1 || sudo useradd --system --home-dir /opt/tempo-preview --shell /sbin/nologin tempo
sudo install -d -o tempo -g tempo /opt/tempo-preview
sudo cp -r server scripts release.config.json /opt/tempo-preview/
sudo chown -R tempo:tempo /opt/tempo-preview
sudo -u tempo env PYTHON=python3.12 /opt/node-v24.20.0-linux-x64/bin/node /opt/tempo-preview/scripts/setup-backend.mjs
sudo python3.12 -m venv /opt/tempo-certbot
sudo /opt/tempo-certbot/bin/pip install 'certbot>=5.4,<6'
sudo install -d /var/www/tempo-acme
sudo restorecon -R /var/www/tempo-acme
sudo install -m 644 deploy/tempo-http.conf /etc/nginx/conf.d/tempo-http.conf
sudo install -m 644 deploy/tempo-preview.service /etc/systemd/system/tempo-preview.service
sudo setsebool -P httpd_can_network_connect 1
sudo firewall-cmd --permanent --add-service=http --add-service=https
sudo firewall-cmd --reload
sudo nginx -t
sudo systemctl daemon-reload
sudo systemctl enable --now nginx tempo-preview
