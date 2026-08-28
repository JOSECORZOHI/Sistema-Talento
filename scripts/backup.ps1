param(
  [string]$OutputDir = "$PSScriptRoot\..\backups",
  [string]$DatabaseUrl = ""
)

<#
  Backup completo de MongoDB Atlas (colecciones + GridFS) vía mongodump.
  GridFS (fs.files/fs.chunks) queda incluido automáticamente en el dump de la BD.

  Uso:
    npm run backup                      -> usa DATABASE_URL del .env y carpeta .\backups
    .\scripts\backup.ps1                -> igual
    .\scripts\backup.ps1 -OutputDir D:\bak
  Requiere: mongodb-database-tools (mongodump) en el PATH.
#>

$ErrorActionPreference = 'Stop'

# Cargar DATABASE_URL desde .env si no se pasó explícitamente
if (-not $DatabaseUrl) {
  $envFile = Join-Path $PSScriptRoot '..\.env'
  if (Test-Path -LiteralPath $envFile) {
    $line = Get-Content -LiteralPath $envFile | Where-Object { $_ -match '^DATABASE_URL=' } | Select-Object -First 1
    if ($line) { $DatabaseUrl = ($line -replace '^DATABASE_URL=', '').Trim('"').Trim("'") }
  }
}
if (-not $DatabaseUrl) {
  Write-Error 'No se encontró DATABASE_URL en .env. Pase -DatabaseUrl o defina la variable.'
}

# Extraer nombre de la BD desde la URI (último segmento antes de ?)
if ($DatabaseUrl -match '/([^/?]+)(\?|$)') { $DbName = $Matches[1] } else { $DbName = 'talento_humano' }

$stamp = Get-Date -Format 'yyyyMMdd_HHmmss'
$target = Join-Path $OutputDir $stamp
New-Item -ItemType Directory -Path $target -Force | Out-Null

Write-Host "[BACKUP] BD: $DbName"
Write-Host "[BACKUP] Destino: $target"

mongodump --uri "$DatabaseUrl" --db $DbName --out $target

if ($LASTEXITCODE -ne 0) { Write-Error "mongodump falló (código $LASTEXITCODE)." }

# Comprimir en un único .gz para facilitar la descarga
$archive = "$target.gz"
& tar -zcf $archive -C (Split-Path $target) (Split-Path $target -Leaf)
if ($LASTEXITCODE -eq 0) {
  Remove-Item -LiteralPath $target -Recurse -Force
  Write-Host "[BACKUP] OK -> $archive"
} else {
  Write-Host "[BACKUP] Compresión omitida; el dump quedó en $target"
}

# Rotación: conservar solo los 10 backups más recientes
$old = Get-ChildItem -LiteralPath $OutputDir -Filter '*.gz' | Sort-Object LastWriteTime -Descending | Select-Object -Skip 10
foreach ($f in $old) { Remove-Item -LiteralPath $f.FullName -Force }
Write-Host "[BACKUP] Listo."