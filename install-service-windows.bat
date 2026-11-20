@echo off
setlocal
title Instalador del Agente Puente de Escaner - Talento Humano
echo ================================================================
echo   INSTALACION DEL AGENTE PUENTE DE ESCANER COMO SERVICIO
echo   Sistema de Gestion Documental - Alcaldia de Valledupar
echo ================================================================
echo.

set "SCRIPT_DIR=%~dp0"
set "VBS_PATH=%SCRIPT_DIR%scanner-bridge\run-hidden.vbs"

if not exist "%VBS_PATH%" (
    echo [ERROR] No se encontro el archivo %VBS_PATH%
    pause
    exit /b 1
)

echo Registrando inicio automatico con Windows en segundo plano...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "TalentoScannerBridge" /t REG_SZ /d "wscript.exe \"%VBS_PATH%\"" /f >nul

if %ERRORLEVEL% EQU 0 (
    echo [OK] Inicio automatico registrado correctamente.
    echo.
    echo Iniciando el agente ahora mismo en segundo plano...
    wscript.exe "%VBS_PATH%"
    echo.
    echo ================================================================
    echo   LISTO: El Agente Puente ya esta activo y se iniciara solo
    echo   cada vez que encienda su computador.
    echo.
    echo   Ya puede abrir la pagina web y presionar 'Escanear Documento'.
    echo ================================================================
) else (
    echo [ERROR] No se pudo registrar en el inicio automatico.
)

echo.
pause
