#!/usr/bin/env bash
# Jalankan DI VPS (SSH), dari folder aplikasi:
#   bash scripts/vps-update.sh
set -euo pipefail
cd "$(dirname "$0")/.."
echo "==> $(pwd)"
git fetch origin main
git checkout main
git pull origin main
if command -v pm2 >/dev/null 2>&1; then
  pm2 restart all
  pm2 status
else
  echo "pm2 tidak ditemukan. Restart proses Node secara manual."
fi
echo "==> Selesai. Hard-refresh browser (Ctrl+Shift+R), lalu hapus device GANANET duplikat."
