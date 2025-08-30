taskkill /F /IM node.exe >nul 2>&1
set CHANNEL=test && node index.js
pause