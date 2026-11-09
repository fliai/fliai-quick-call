# FLiAI Quick Call installer / updater for Windows. Run in PowerShell (5.1 or 7):
#   irm https://cdn-quickcall.fliai.lk/install.ps1 | iex     (first install)
#   irm https://cdn-quickcall.fliai.lk/update.ps1 | iex      (update; same script)
# Downloading from PowerShell skips the SmartScreen "Windows protected your PC" warning.
# Everything runs inside a script block so nothing leaks into, or closes, the user's session.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  $base = "https://cdn-quickcall.fliai.lk"
  $name = "FLiAI Quick Call"

  try {
    $latest = (Invoke-RestMethod "$base/latest.json" -UseBasicParsing).version
    $installed = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq $name } | Select-Object -First 1 -ExpandProperty DisplayVersion -ErrorAction SilentlyContinue

    if ($latest -and $installed -eq $latest) {
      Write-Host "$name $installed is already up to date."
      return
    }
    if ($installed) { Write-Host "Updating $name $installed -> $latest..." }
    else { Write-Host "Installing $name $latest..." }

    $installer = Join-Path $env:TEMP "fliai-quick-call-setup.exe"
    Invoke-WebRequest "$base/fliai-quick-call-setup.exe" -OutFile $installer -UseBasicParsing

    Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\$name\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
    $setup = Start-Process $installer -ArgumentList "/S" -Wait -PassThru
    Remove-Item $installer -Force -ErrorAction SilentlyContinue
    if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)" }

    $dir = Join-Path $env:LOCALAPPDATA $name
    $exe = Get-ChildItem $dir -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "uninstall*" } | Select-Object -First 1
    if ($exe) { Start-Process $exe.FullName }

    Write-Host "Done. Move your mouse to the top center of the screen to open it."
    Write-Host "If Windows Firewall asks, allow it on Private networks."
  }
  catch {
    Write-Host "Could not install $name`: $($_.Exception.Message)" -ForegroundColor Red
  }
}
