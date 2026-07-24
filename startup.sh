#!/bin/bash
if [ -d "sensa-chrome-extension-backend" ]; then
  cd sensa-chrome-extension-backend
elif [ -d "sensa-backend" ]; then
  cd sensa-backend
fi

npm install
node server.js
