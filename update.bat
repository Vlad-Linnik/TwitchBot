@echo off
taskkill /IM node.exe /F >nul 2>&1

git pull
npm install
pause