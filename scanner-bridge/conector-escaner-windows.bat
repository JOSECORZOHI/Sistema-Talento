@echo off
setlocal enabledelayedexpansion
title Instalador del Conector de Escaner - Talento Humano
color 0A
echo ================================================================
echo   INSTALANDO CONECTOR DE ESCANER (Oficina de Talento Humano)
echo ================================================================
echo.

set "DEST_DIR=%LOCALAPPDATA%\TalentoScannerBridge"
if not exist "%DEST_DIR%" mkdir "%DEST_DIR%"
set "PS_SCRIPT=%DEST_DIR%\bridge.ps1"

echo [1/3] Generando conector autonomo en %DEST_DIR%...

(
echo # Conector Autonomo de Escaner - Talento Humano
echo Add-Type -AssemblyName System.Drawing
echo Add-Type -AssemblyName System.Web
echo.
echo $port = 5070
echo $listener = New-Object System.Net.HttpListener
echo $listener.Prefixes.Add^("http://127.0.0.1:$port/"^)
echo try {
echo     $listener.Start^(^)
echo } catch {
echo     exit 0
echo }
echo.
echo function Send-Json^($res, $obj, $code = 200^) {
echo     $res.StatusCode = $code
echo     $res.Headers.Add^("Access-Control-Allow-Origin", "*"^)
echo     $res.Headers.Add^("Access-Control-Allow-Methods", "GET, POST, OPTIONS"^)
echo     $res.Headers.Add^("Access-Control-Allow-Headers", "Content-Type, X-Requested-With"^)
echo     $res.ContentType = "application/json; charset=utf-8"
echo     $json = $obj ^| ConvertTo-Json -Compress
echo     $buf = [System.Text.Encoding]::UTF8.GetBytes^($json^)
echo     $res.ContentLength64 = $buf.Length
echo     $res.OutputStream.Write^($buf, 0, $buf.Length^)
echo     $res.Close^(^)
echo }
echo.
echo while ^($listener.IsListening^) {
echo     try {
echo         $context = $listener.GetContext^(^)
echo         $req = $context.Request
echo         $res = $context.Response
echo.
echo         if ^($req.HttpMethod -eq "OPTIONS"^) {
echo             $res.StatusCode = 204
echo             $res.Headers.Add^("Access-Control-Allow-Origin", "*"^)
echo             $res.Headers.Add^("Access-Control-Allow-Methods", "GET, POST, OPTIONS"^)
echo             $res.Headers.Add^("Access-Control-Allow-Headers", "Content-Type, X-Requested-With"^)
echo             $res.Close^(^)
echo             continue
echo         }
echo.
echo         if ^($req.HttpMethod -eq "GET" -and ^($req.Url.AbsolutePath -eq "/status" -or $req.Url.AbsolutePath -eq "/health"^)^) {
echo             $scanners = @^(^)
echo             try {
echo                 $dm = New-Object -ComObject WIA.DeviceManager
echo                 foreach ^($di in $dm.DeviceInfos^) {
echo                     if ^(^($di.Type -band 1^) -eq 1^) {
echo                         $desc = ""
echo                         foreach ^($p in $di.Properties^) { if ^($p.PropertyID -eq 4^) { $desc = [string]$p.Value } }
echo                         $scanners += [PSCustomObject]@{ name = $desc; status = "Conectado"; type = "USB" }
echo                     }
echo                 }
echo             } catch {}
echo             try {
echo                 Get-PnpDevice -Status OK -Class Image -ErrorAction SilentlyContinue ^| ForEach-Object {
echo                     $fn = $_.FriendlyName
echo                     $exists = $false
echo                     foreach ^($s in $scanners^) { if ^($s.name -eq $fn^) { $exists = $true; break } }
echo                     if ^(-not $exists^) { $scanners += [PSCustomObject]@{ name = $fn; status = "Conectado"; type = "USB" } }
echo                 }
echo             } catch {}
echo             Send-Json $res @{ ok = $true; bridge = $true; platform = "win32"; scanners = $scanners; count = $scanners.Count; connected = ^($scanners.Count -gt 0^) }
echo             continue
echo         }
echo.
echo         if ^($req.HttpMethod -eq "POST" -and $req.Url.AbsolutePath -eq "/scan"^) {
echo             $reader = New-Object System.IO.StreamReader^($req.InputStream, $req.ContentEncoding^)
echo             $body = $reader.ReadToEnd^(^)
echo             $reader.Close^(^)
echo             $fnBase = "Escaneo_" + [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds^(^)
echo             try {
echo                 $parsed = $body ^| ConvertFrom-Json
echo                 if ^($parsed.filename^) { $fnBase = $parsed.filename }
echo             } catch {}
echo.
echo             try {
echo                 $dm = New-Object -ComObject WIA.DeviceManager
echo                 $devInfo = $null
echo                 foreach ^($di in $dm.DeviceInfos^) {
echo                     if ^(^($di.Type -band 1^) -eq 1^) { $devInfo = $di; break }
echo                 }
echo                 if ^(-not $devInfo^) {
echo                     Send-Json $res @{ ok = $false; error = "No hay ningun escaner conectado por USB o encendido." } 400
echo                     continue
echo                 }
echo                 $device = $devInfo.Connect^(^)
echo                 $item = $device.Items^(1^)
echo                 $image = $item.Transfer^(^)
echo                 $tmpBmp = [System.IO.Path]::GetTempFileName^(^) + ".bmp"
echo                 $tmpPng = [System.IO.Path]::GetTempFileName^(^) + ".png"
echo                 $image.SaveFile^($tmpBmp^)
echo                 $bmp = [System.Drawing.Image]::FromFile^($tmpBmp^)
echo                 $bmp.Save^($tmpPng, [System.Drawing.Imaging.ImageFormat]::Png^)
echo                 $bmp.Dispose^(^)
echo                 Remove-Item $tmpBmp -ErrorAction SilentlyContinue
echo                 $bytes = [System.IO.File]::ReadAllBytes^($tmpPng^)
echo                 Remove-Item $tmpPng -ErrorAction SilentlyContinue
echo                 $b64 = [System.Convert]::ToBase64String^($bytes^)
echo                 Send-Json $res @{ ok = $true; filename = "$fnBase.png"; imageBase64 = $b64; sizeBytes = $bytes.Length }
echo             } catch {
echo                 Send-Json $res @{ ok = $false; error = $_.Exception.Message } 500
echo             }
echo             continue
echo         }
echo.
echo         Send-Json $res @{ error = "Ruta no encontrada" } 404
echo     } catch {}
echo }
) > "%PS_SCRIPT%"

echo [2/3] Configurando inicio automatico con Windows...
reg add "HKCU\Software\Microsoft\Windows\CurrentVersion\Run" /v "TalentoScannerBridge" /t REG_SZ /d "powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File \"%PS_SCRIPT%\"" /f >nul

echo [3/3] Iniciando conector en segundo plano...
start "" /B powershell.exe -WindowStyle Hidden -ExecutionPolicy Bypass -File "%PS_SCRIPT%"

echo.
echo ================================================================
echo   INSTALACION COMPLETADA CON EXITO
echo.
echo   El conector ya quedo activo en tu computador y se iniciara solo
echo   cada vez que prendas la PC.
echo.
echo   Ya puedes regresar a la pagina web en tu navegador.
echo ================================================================
echo.
timeout /t 5 >nul
exit /b 0
