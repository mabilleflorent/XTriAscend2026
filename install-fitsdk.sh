#!/bin/bash
# Lance ce script dans ton terminal WSL :  bash install-fitsdk.sh
set -e
source ~/.nvm/nvm.sh 2>/dev/null || true
cd "$(dirname "$0")"
echo "==> Suppression de fit-file-parser..."
npm uninstall fit-file-parser 2>/dev/null || true
echo "==> Installation de @garmin/fitsdk..."
npm install @garmin/fitsdk
echo "==> OK : $(ls node_modules/@garmin/fitsdk/src/index.js)"
