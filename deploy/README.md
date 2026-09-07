# Preview service

The public site stays on GitHub Pages. Only `/soundcloud-tempo-control/api/`
is served by the Oracle VM at `88.96.45.138`.

Runtime files live in `/opt/tempo-preview`, owned by the `tempo` service account.
Node listens on loopback port 4322; nginx terminates HTTPS and forwards requests.
The proxy overwrites `X-Real-IP`, which the app trusts only from loopback when
`TRUST_LOOPBACK_PROXY=1`. Both layers limit requests. nginx access logging is off
so pasted track URLs are not retained in an access log.

`install-runtime.sh` is the bootstrap used for this VM, after installing nginx
and Python 3.12 from Oracle's package repositories. It checks the pinned Node
archive and installs yt-dlp from the hash-locked requirements file. It does not
request the certificate or install the HTTPS configuration; those follow once
port 80 is reachable.

The IP certificate uses Let's Encrypt's `shortlived` profile with webroot
`/var/www/tempo-acme`. `tempo-cert-renew.timer` checks twice daily and reloads nginx
after renewal. Keep port 80 open for validation. If the VM's public IP changes,
replace the certificate, nginx server names, and `PUBLIC_API_BASE` in the Pages
workflow before publishing.

Useful checks on the VM:

```sh
sudo systemctl status tempo-preview nginx tempo-cert-renew.timer
sudo journalctl -u tempo-preview -n 50 --no-pager
sudo /opt/tempo-certbot/bin/certbot renew --dry-run
curl https://88.96.45.138/soundcloud-tempo-control/api/status
```

For an application update, copy `server/`, `scripts/config.cjs`, and
`release.config.json` to `/opt/tempo-preview`, reinstall the pinned requirements
if they changed, then restart `tempo-preview`. Never copy private SSH keys,
GitHub credentials, or a developer's `.env` to the server.
