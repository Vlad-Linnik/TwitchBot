taskkill /F /IM node.exe >nul 2>&1
git pull
call npm install
call npm audit fix
node .\index.js
pause