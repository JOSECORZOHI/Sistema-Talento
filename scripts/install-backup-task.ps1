<#
  Registra (o elimina) una tarea programada de Windows para ejecutar el backup
  automático todos los días, con prueba de restauración integrada.

  Uso (ejecutar PowerShell como Administrador):
    .\scripts\install-backup-task.ps1                 -> backup diario a las 02:00 con verificación
    .\scripts\install-backup-task.ps1 -Time 23:30     -> a otra hora
    .\scripts\install-backup-task.ps1 -Verify:$false  -> sin prueba de restauración
    .\scripts\install-backup-task.ps1 -Remove         -> elimina la tarea

  Notas:
    - La tarea se registra con S4U (se ejecuta aunque el usuario no tenga la
      sesión abierta). Requiere permisos de Administrador y que la cuenta tenga
      el derecho "Iniciar sesión como trabajo por lotes".
    - El equipo debe estar encendido y con internet a la hora programada.
#>
param(
  [string]$Time = '02:00',
  [string]$TaskName = 'TalentoHumano-Backup',
  [string]$User = "$env:USERDOMAIN\$env:USERNAME",
  [switch]$Verify = $true,
  [switch]$Remove
)

$ErrorActionPreference = 'Stop'

if ($Remove) {
  try {
    Unregister-ScheduledTask -TaskName $TaskName -Confirm:$false
    Write-Host "[TAREA] Eliminada: $TaskName"
  } catch {
    Write-Warning "[TAREA] No se pudo eliminar '$TaskName': $($_.Exception.Message)"
  }
  return
}

$repo = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$backupScript = Join-Path $repo 'scripts\backup.ps1'
if (-not (Test-Path -LiteralPath $backupScript)) {
  Write-Error "No se encontró $backupScript"
}

$argument = "-NoProfile -ExecutionPolicy Bypass -File `"$backupScript`""
if ($Verify) { $argument += ' -Verify' }

try {
  $action = New-ScheduledTaskAction -Execute 'powershell.exe' -Argument $argument -WorkingDirectory $repo
  $trigger = New-ScheduledTaskTrigger -Daily -At $Time
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -DontStopOnIdleEnd `
    -ExecutionTimeLimit (New-TimeSpan -Hours 3) -MultipleInstances IgnoreNew
  $principal = New-ScheduledTaskPrincipal -UserId $User -LogonType S4U -RunLevel Highest

  Register-ScheduledTask -TaskName $TaskName -Action $action -Trigger $trigger `
    -Settings $settings -Principal $principal -Force `
    -Description 'Backup diario de MongoDB (Talento Humano) con prueba de restauración' | Out-Null

  Write-Host "[TAREA] Registrada: $TaskName"
  Write-Host "[TAREA] Hora diaria: $Time"
  Write-Host "[TAREA] Comando: powershell.exe $argument"
  Write-Host '[TAREA] Compruébela con: Get-ScheduledTask -TaskName TalentoHumano-Backup; Get-ScheduledTaskInfo -TaskName TalentoHumano-Backup'
} catch {
  Write-Error "No se pudo registrar la tarea. Ejecute PowerShell como Administrador. Detalle: $($_.Exception.Message)"
}
