# FLiAI Quick Call uninstaller for Windows. Run in PowerShell (5.1 or 7):
#   irm https://cdn-quickcall.fliai.lk/uninstall.ps1 | iex
# Quits the app, stops it starting at sign-in, and removes the app and its settings.
# For the Microsoft Store version, use Start menu > right-click the app > Uninstall.
# Keep this file ASCII-only: Windows PowerShell 5.1 may decode `irm` output with the wrong charset.
& {
  $ErrorActionPreference = "Stop"
  $name = "FLiAI Quick Call"
  $id = "lk.fliai.quickcall"

  $utf8 = $false
  try { $utf8 = [Console]::OutputEncoding.CodePage -eq 65001 } catch {}
  $tick = if ($utf8) { [string][char]0x2713 } else { "+" }
  function Ok($text) {
    Write-Host "  $tick " -ForegroundColor Green -NoNewline
    Write-Host $text
  }

  try {
    Write-Host ""
    Write-Host "  $name" -ForegroundColor White
    Write-Host ""
    $found = $false

    # Quit it.
    $procs = Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\$name\*" }
    if ($procs) {
      $procs | Stop-Process -Force -ErrorAction SilentlyContinue
      Start-Sleep -Milliseconds 500
      Ok "Closed the app"; $found = $true
    }

    # Stop it starting at sign-in (the installer's uninstaller doesn't remove this).
    $run = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run"
    $approved = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run"
    $hadRun = $null -ne (Get-ItemProperty $run -Name $name -ErrorAction SilentlyContinue)
    Remove-ItemProperty $run -Name $name -ErrorAction SilentlyContinue
    Remove-ItemProperty $approved -Name $name -ErrorAction SilentlyContinue
    if ($hadRun) { Ok "Removed start at sign-in"; $found = $true }

    # The app itself, via its own uninstaller.
    $dir = Join-Path $env:LOCALAPPDATA $name
    $uninstaller = Join-Path $dir "uninstall.exe"
    if (Test-Path $uninstaller) {
      Start-Process $uninstaller -ArgumentList "/S" -Wait | Out-Null
      # NSIS copies itself to a temp folder and returns early; wait until the files are gone.
      for ($i = 0; $i -lt 40 -and (Test-Path (Join-Path $dir "*.exe")); $i++) { Start-Sleep -Milliseconds 250 }
      Ok "Removed the app"; $found = $true
    }
    if (Test-Path $dir) { Remove-Item $dir -Recurse -Force -ErrorAction SilentlyContinue }

    # Settings (name, status, identity) and web view data.
    $removed = $false
    foreach ($path in @((Join-Path $env:APPDATA $id), (Join-Path $env:LOCALAPPDATA $id))) {
      if (Test-Path $path) { Remove-Item $path -Recurse -Force -ErrorAction SilentlyContinue; $removed = $true }
    }
    if ($removed) { Ok "Removed settings"; $found = $true }

    Write-Host ""
    if ($found) {
      Write-Host "  Done! " -ForegroundColor Green -NoNewline
      Write-Host "$name is uninstalled."
    } else {
      Write-Host "  $name isn't installed." -ForegroundColor DarkGray
    }
    Write-Host ""
  }
  catch {
    Write-Host "  Could not uninstall $name`: $($_.Exception.Message)" -ForegroundColor Red
  }
}
