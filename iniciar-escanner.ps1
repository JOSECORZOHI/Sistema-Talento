# Inicia el servidor local del escáner en el PC de la alcaldía.
# Ubicación recomendada: C:\Sistema-Talento\iniciar-escanner.ps1
$ErrorActionPreference = 'Stop'
Set-Location (Split-Path -Parent $MyInvocation.MyCommand.Path)

if (-not (Get-Command node -ErrorAction SilentlyContinue)) {
  Write-Host "No se encontro Node.js. Instale Node 18+ desde https://nodejs.org y marque 'Add to PATH'." -ForegroundColor Red
  Read-Host "Pulse Enter para salir"
  exit 1
}

if (-not (Test-Path .\.env)) {
  Write-Host "Falta el archivo .env en esta carpeta. Copie .env.example a .env y complete DATABASE_URL, JWT_SECRET y DOC_ENC_KEY." -ForegroundColor Yellow
  Read-Host "Pulse Enter para salir"
  exit 1
}

if (-not (Test-Path .\node_modules)) {
  Write-Host "Instalando dependencias por primera vez..." -ForegroundColor Cyan
  npm install
  if ($LASTEXITCODE -ne 0) {
    Write-Host "La instalacion fallo. Revise la conexion a internet." -ForegroundColor Red
    Read-Host "Pulse Enter para salir"
    exit 1
  }
}

Write-Host "Levantando servidor local del escaner en http://localhost:3000" -ForegroundColor Green
Write-Host "Para detenerlo: Ctrl+C" -ForegroundColor Gray
npm start