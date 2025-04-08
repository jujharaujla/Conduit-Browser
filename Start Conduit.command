#!/bin/bash
set -e
cd "$(dirname "$0")"
if [ ! -d node_modules/electron ]; then
  npm install --registry=https://registry.npmjs.org/ --no-package-lock
fi
npm start
