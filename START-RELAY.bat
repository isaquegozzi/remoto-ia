@echo off
cd /d "%~dp0"
if not exist node_modules call npm install
node relay\relay-server.js
pause
