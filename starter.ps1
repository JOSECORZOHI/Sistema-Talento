Start-Process -NoNewWindow -FilePath "node" -ArgumentList "server.js" -WorkingDirectory "C:\Users\joseg\Desktop\sistema alcaldia" 
Write-Output "Started node server.js PID: $((Get-Process node -ErrorAction SilentlyContinue).Id)"
Start-Sleep -Seconds 8

# Test connectivity
try {
  $r = Invoke-WebRequest -Uri "http://localhost:3000" -TimeoutSec 5 -UseBasicParsing
  Write-Output "SERVER UP: $($r.StatusCode)"
} catch {
  Write-Output "SERVER DOWN: $($_.Exception.Message)"
}

# Keep running
Write-Output "Server should be running in background. Press any key to exit..."
Read-Host
