@echo off
title Agente Puente de Escaner - Talento Humano
echo ===================================================
echo   Iniciando Agente Puente de Escaner...
echo ===================================================
echo.
cd /d "%~dp0"
node scanner-bridge/bridge.js
pause
