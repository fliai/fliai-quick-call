# FLiAI Quick Call

Tap a teammate on the shoulder when they're wearing headphones. You click their name, and their screen gets a full-screen colored border showing who's calling.

- It lives in a Dynamic Island at the top center of the screen. On MacBooks with a notch it hides inside the notch. Everywhere else it's a "liquid" island that melts out of the top edge. Move the mouse to the top center to open it.
- Each person sets their own status: 🟢 Available / 🔴 Busy. ⚪ Offline is automatic.
- Busy means do not disturb. You can't call a Busy person, and if a call arrives anyway they see nothing and the caller gets "Busy".
- Replies are **Coming** or **Busy**. An unanswered call times out after 30 s.
- No server. Peers find each other with mDNS (Bonjour) on the office network and talk directly over TCP (port 47800).

## Install / update

Mac (Terminal):

```sh
curl -fsSL https://cdn-quickcall.fliai.lk/install.sh | sh
```

Windows (PowerShell):

```powershell
irm https://cdn-quickcall.fliai.lk/install.ps1 | iex
```

To update, run the same command, or `update.sh` / `update.ps1`. It checks the installed version: if it's current it says "already up to date", otherwise it closes the app, replaces it and reopens it. Settings are kept.

Installing from the terminal skips the macOS "unverified developer" and Windows SmartScreen warnings. The `.dmg` and `-setup.exe` can also be downloaded directly from `https://cdn-quickcall.fliai.lk/`, but then the first open needs System Settings → Privacy & Security → **Open Anyway** (Mac), or **More info → Run anyway** (Windows).

Mac builds are universal (Apple Silicon + Intel).

## Run / build

Needs Rust (`rustup`) and Node.

```sh
npm install
npm run dev      # run locally
npm run build    # installer: .dmg on macOS, .exe (NSIS) on Windows
```

Test two copies on one machine:

```sh
QUICKCALL_PROFILE=test2 ./src-tauri/target/debug/fliai-quick-call
```

## Release

```sh
npm run release -- patch   # or minor | major | 1.2.3
```

This bumps the version, commits, tags `vX.Y.Z` and pushes. GitHub Actions then:

1. builds a universal Mac `.dmg` and a Windows `-setup.exe`,
2. uploads them with the install/update scripts and `latest.json` to the R2 bucket behind `cdn-quickcall.fliai.lk`. Only the latest release is kept, and the bucket is capped at 50 MB.
3. runs the real install command on Windows (PowerShell 5.1) and the update command (pwsh 7) to check both work.

The bucket and domain are defined in [`infra/`](infra/README.md) (Terraform).

## Notes

- Everyone must be on the same network. Guest Wi-Fi with client isolation, or some VPNs, will block discovery.
- macOS asks for Local Network permission on first run. Windows Firewall asks to allow the app on private networks.
- The app is ad-hoc signed, not signed with an Apple Developer ID. That's why the terminal install is recommended.
- Anyone on the LAN can send a call, so it's meant for a trusted office network.
