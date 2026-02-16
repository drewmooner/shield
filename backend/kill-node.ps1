# Kill all Node.js processes
Write-Host "Killing all Node.js processes..."
Get-Process -Name node -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "Killing process $($_.Id)..."
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 2
Write-Host "✅ All Node processes killed"
Write-Host ""
Write-Host "You can now run: npm start"

