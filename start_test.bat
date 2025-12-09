@echo off
taskkill /F /IM node.exe >nul 2>&1
npm install
set CHANNEL=test 
node index.js
pause