@echo off
cd /d "%~dp0"
if not exist node_modules (
  echo Instalando dependencias...
  call npm install
  if errorlevel 1 pause & exit /b 1
)
echo.
echo Iniciando REMOTO IA V2...
node bridge.js
pause
