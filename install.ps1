# FLiAI Quick Call installer for Windows. Run in PowerShell:
#   irm https://cdn-quickcall.fliai.lk/install.ps1 | iex
# Downloading from PowerShell skips the SmartScreen "Windows protected your PC" warning.
$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

Write-Host "Downloading FLiAI Quick Call..."
$installer = Join-Path $env:TEMP "fliai-quick-call-setup.exe"
Invoke-WebRequest "https://cdn-quickcall.fliai.lk/fliai-quick-call-setup.exe" -OutFile $installer -UseBasicParsing

Get-Process | Where-Object { $_.Path -like "*FLiAI Quick Call*" } | Stop-Process -Force -ErrorAction SilentlyContinue
Start-Process $installer -ArgumentList "/S" -Wait
Remove-Item $installer

$dir = Join-Path $env:LOCALAPPDATA "FLiAI Quick Call"
$exe = Get-ChildItem $dir -Filter *.exe | Where-Object { $_.Name -notlike "uninstall*" } | Select-Object -First 1
if ($exe) { Start-Process $exe.FullName }

Write-Host "Installed. Move your mouse to the top center of the screen to open it."
Write-Host "If Windows Firewall asks, allow it on Private networks."
