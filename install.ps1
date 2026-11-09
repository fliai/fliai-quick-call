# FLiAI Quick Call installer / updater for Windows. Run in PowerShell (5.1 or 7):
#   irm https://cdn-quickcall.fliai.lk/install.ps1 | iex     (first install)
#   irm https://cdn-quickcall.fliai.lk/update.ps1 | iex      (update; same script)
# Downloading from PowerShell skips the SmartScreen "Windows protected your PC" warning.
# Everything runs inside a script block so nothing leaks into, or closes, the user's session.
# Keep this file ASCII-only: Windows PowerShell 5.1 may decode `irm` output with the wrong charset.
& {
  $ErrorActionPreference = "Stop"
  $ProgressPreference = "SilentlyContinue"
  try { [Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12 } catch {}

  $base = "https://cdn-quickcall.fliai.lk"
  $name = "FLiAI Quick Call"

  # ---------- pretty output ----------
  $fancy = $false
  try { $fancy = -not [Console]::IsOutputRedirected } catch {}
  $utf8 = $false
  try { $utf8 = [Console]::OutputEncoding.CodePage -eq 65001 } catch {}
  $tick = if ($utf8) { [string][char]0x2713 } else { "+" }
  $full = [string][char]0x2588   # solid block, exists in every console code page
  $empty = [string][char]0x2591  # light shade

  function Ok($text) {
    Write-Host "  $tick " -ForegroundColor Green -NoNewline
    Write-Host $text
  }
  function Clear-Line { if ($fancy) { [Console]::Write("`r" + (" " * ([Math]::Max(0, [Console]::WindowWidth - 1))) + "`r") } }
  function Mb($bytes) { "{0:N1} MB" -f ($bytes / 1MB) }

  # Download with a live bar:  ##############---------------  48%  14.2 / 29.7 MB  3.9 MB/s
  function Get-WithProgress($url, $outFile) {
    $req = [Net.HttpWebRequest]::Create($url)
    $req.UserAgent = "fliai-quick-call-installer"
    $res = $req.GetResponse()
    $total = $res.ContentLength
    $in = $res.GetResponseStream()
    $out = [IO.File]::Create($outFile)
    $buf = New-Object byte[] 65536
    $done = 0
    $watch = [Diagnostics.Stopwatch]::StartNew()
    $lastDraw = -1000
    $width = 30
    try {
      while (($n = $in.Read($buf, 0, $buf.Length)) -gt 0) {
        $out.Write($buf, 0, $n)
        $done += $n
        $ms = $watch.ElapsedMilliseconds
        if ($fancy -and ($ms - $lastDraw -ge 100)) {
          $lastDraw = $ms
          $speed = if ($ms -gt 0) { $done / ($ms / 1000) } else { 0 }
          [Console]::Write("`r  ")
          if ($total -gt 0) {
            $p = [Math]::Min(1, $done / $total)
            $filled = [int][Math]::Floor($p * $width)
            Write-Host ($full * $filled) -ForegroundColor Cyan -NoNewline
            Write-Host ($empty * ($width - $filled)) -ForegroundColor DarkGray -NoNewline
            Write-Host (" {0,3}%  " -f [int]($p * 100)) -NoNewline
            Write-Host ("{0:N1} / {1:N1} MB  {2:N1} MB/s   " -f ($done / 1MB), ($total / 1MB), ($speed / 1MB)) -ForegroundColor DarkGray -NoNewline
          } else {
            Write-Host "Downloading  " -ForegroundColor Cyan -NoNewline
            Write-Host ("{0:N1} MB  {1:N1} MB/s   " -f ($done / 1MB), ($speed / 1MB)) -ForegroundColor DarkGray -NoNewline
          }
        }
      }
    } finally {
      $out.Close(); $in.Close(); $res.Close()
    }
    Clear-Line
    Ok "Downloaded $(Mb $done)"
  }

  function Step($label, [scriptblock]$action) {
    if ($fancy) { Write-Host "  ... $label" -ForegroundColor DarkGray -NoNewline }
    & $action
    Clear-Line
    Ok $label
  }

  # ---------- install ----------
  try {
    Write-Host ""
    Write-Host "  $name" -ForegroundColor White
    Write-Host ""

    $latest = (Invoke-RestMethod "$base/latest.json" -UseBasicParsing).version
    $installed = Get-ItemProperty "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\*" -ErrorAction SilentlyContinue |
      Where-Object { $_.DisplayName -eq $name } | Select-Object -First 1 -ExpandProperty DisplayVersion -ErrorAction SilentlyContinue

    if ($latest -and $installed -eq $latest) {
      Ok "$name $installed is already up to date."
      Write-Host ""
      return
    }
    if ($installed) {
      Write-Host "  Updating " -NoNewline
      Write-Host $installed -ForegroundColor DarkGray -NoNewline
      Write-Host " -> " -NoNewline
      Write-Host $latest -ForegroundColor Green
    } else {
      Write-Host "  Installing version " -NoNewline
      Write-Host $latest -ForegroundColor Green
    }
    Write-Host ""

    $installer = Join-Path $env:TEMP "fliai-quick-call-setup.exe"
    Get-WithProgress "$base/fliai-quick-call-setup.exe" $installer

    if ($installed) {
      Step "Closing the running app" {
        Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.Path -like "*\$name\*" } | Stop-Process -Force -ErrorAction SilentlyContinue
        Start-Sleep -Milliseconds 500
      }
    }

    Step "Installing" {
      $setup = Start-Process $installer -ArgumentList "/S" -Wait -PassThru
      Remove-Item $installer -Force -ErrorAction SilentlyContinue
      if ($setup.ExitCode -ne 0) { throw "Installer exited with code $($setup.ExitCode)" }
    }

    $dir = Join-Path $env:LOCALAPPDATA $name
    $exe = Get-ChildItem $dir -Filter *.exe -ErrorAction SilentlyContinue | Where-Object { $_.Name -notlike "uninstall*" } | Select-Object -First 1
    if ($exe) { Step "Starting $name" { Start-Process $exe.FullName } }

    Write-Host ""
    Write-Host "  Done! " -ForegroundColor Green -NoNewline
    Write-Host "Move your mouse to the top center of the screen to open it."
    Write-Host "  It starts by itself when you sign in." -ForegroundColor DarkGray
    Write-Host "  If Windows Firewall asks, allow it on Private networks." -ForegroundColor DarkGray
    Write-Host ""
  }
  catch {
    Clear-Line
    Write-Host "  Could not install $name`: $($_.Exception.Message)" -ForegroundColor Red
  }
}
