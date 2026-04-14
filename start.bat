@echo off
taskkill /F /IM node.exe >nul 2>&1

echo Pulling updates...
git fetch --all
git reset --hard origin/main

echo Installing dependencies...
call npm ci

echo Starting app...
start /B "" powershell -WindowStyle Hidden -Command "node .\index.js"