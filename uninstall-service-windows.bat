@echo off
setlocal
title Desinstalador del Agente Puente de Escaner
echo ================================================================
echo   DESINSTALACION DEL AGENTE PUENTE DE ESCANER
echo ================================================================
echo.

reg delete "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "TalentoScannerBridge" /f >nul 2>&1
echo [OK] Inicio automatico eliminado del registro de Windows.

echo.
echo ================================================================
echo   El Agente Puente ha sido desinstalado.
echo ================================================================
echo.
pause
