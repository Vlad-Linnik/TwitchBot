@echo off
git pull
start /B powershell -WindowStyle Hidden -Command "node .\index.js"
