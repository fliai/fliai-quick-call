# FLiAI Quick Call

Tap a teammate on the shoulder when they're wearing headphones. You click their name, and their screen gets a full-screen colored border showing who's calling.

- A small always-on-top pill sits at the top center of the screen.
- Each person sets their own status: 🟢 Available / 🔴 Busy. ⚪ Offline is automatic.
- Calling someone who is Busy gives them a quiet alert only: the pill, with no border and no sound.
- Replies are **Coming** or **Busy**. An unanswered call times out after 30 s.
- No server. Peers find each other with mDNS (Bonjour) on the office network and talk directly over TCP (port 47800).

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

This bumps the version, commits, tags `vX.Y.Z` and pushes. GitHub Actions then builds a universal Mac `.dmg` and a Windows `-setup.exe` and publishes both under **Releases**.

## Notes

- Everyone must be on the same network. Guest Wi-Fi with client isolation, or some VPNs, will block discovery.
- macOS asks for Local Network permission on first run. Windows Firewall asks to allow the app on private networks.
- The app isn't code-signed. On macOS, the first time you open it, right-click → Open.
- Anyone on the LAN can send a call, so it's meant for a trusted office network.
