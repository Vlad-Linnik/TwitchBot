@echo off
taskkill /F /IM node.exe >nul 2>&1
git pull
npm install
start /B "" powershell -WindowStyle Hidden -Command "node .\index.js"