# Build and install this checkout

`pnpm local:run` and `pnpm local:install` build the desktop app from this working
tree and put it in front of you. They exist for the loop where you changed the
source and want the real packaged app, not the Vite dev server.

| Command | What it builds | What it does after |
|---|---|---|
| `pnpm local:run` | `package:prepare` + the Windows CUA driver + `electron-builder --win dir` | starts `release/win-unpacked/OpenMausBot.exe` |
| `pnpm local:install` | the same, then the NSIS installer (about 268MB) | verifies it, closes the running app, installs `/S`, checks the installed version, starts it |

`local:run` skips NSIS compression and is the faster loop (roughly 3-6 minutes
once the downloads are cached). `local:install` is the one that proves the
installer path.

On Windows, `build-install.bat` in the repository root runs `local:install` and
accepts the same options. Double-click it, or run
`build-install.bat --no-launch` from a terminal.

## Requirements

- Windows x64. macOS and Linux are not implemented yet: the macOS build needs
  an ad-hoc signed app and Linux needs root for the `.deb`.
- Node 24 or newer (the `engines` range in `package.json`). Pass
  `--allow-unsupported-node` only if you know your Node builds this tree.
- `pnpm --version` must answer `10.33.0`, the version the checkout pins. A
  standalone pnpm on PATH is used when Corepack is absent, which is the case
  from Node 25 onwards. `npm i -g pnpm@10.33.0` (or
  `corepack prepare pnpm@10.33.0 --activate`) fixes a mismatch.
- About 5GB free. The first build downloads roughly 400-500MB: the Electron
  binary, the packaged browser, cloudflared, Android platform tools and the CUA
  driver. Later builds reuse `dist-native/`.

## Options

```
--run                      build release/win-unpacked and start it (skips NSIS)
--clean                    remove dist, dist-server, dist-companion and release first
--skip-build               install the installer already in release/
--no-install               build and verify the installer, do not install it
--no-launch                do not start the app after installing
--keep-update              leave resources/app-update.yml pointing at the upstream feed
--yes                      do not prompt (closes a running app without asking)
--dry-run                  print the commands instead of running them
--dir <path>               install to <path> instead of the current per-user location
--allow-unsupported-node   run on a Node below the engines range
--help                     print the usage
```

## What it changes on this machine

- **The installed app is replaced.** The installer is per-user and needs no
  administrator rights. It overwrites the directory already recorded for this
  user, or `%LOCALAPPDATA%\Programs\openmausbot` when nothing is installed yet,
  unless `--dir` says otherwise. There is no rollback: a failed install is
  repaired by installing a released installer again.
- **A running app is closed.** When OpenMausBot is running the script asks
  first; `--yes` skips the question for automation. The installer would close it
  anyway, first politely and then with `/F`, so anything unsaved in the app is
  lost either way.
- **Updates are disabled by default.** The build carries
  `electron-builder.yml`'s upstream publish target, so a packaged app checks the
  official feed 15 seconds after it starts and would replace this build with the
  released one. The script renames the installed `resources/app-update.yml` to
  `app-update.yml.disabled`; rename it back, or pass `--keep-update`, to follow
  the upstream feed again.
- **Your data is untouched.** Bots, settings and transcripts live in
  `%USERPROFILE%\.openmausbot`, outside the install directory. A build from a
  newer tree can migrate that data forward, and an older build may not read it.

The installer is not code-signed, exactly like the released Windows installer,
so SmartScreen shows "unknown publisher" the first time the app is opened from
Explorer. A build produced here is not marked as downloaded, so the installer
itself does not raise that prompt.

## Troubleshooting

- **`pnpm` is not found**: install it with `npm i -g pnpm@10.33.0`, or run
  `corepack enable` on a Node that still bundles Corepack, then check
  `pnpm --version` in the repository.
- **The Electron download fails**: set `ELECTRON_MIRROR`, for example
  `https://npmmirror.com/mirrors/electron/`, and run the same command again. The
  script only downloads it when `node_modules/electron/dist` is missing.
- **The installer exits non-zero**: the log under
  `%TEMP%\openmausbot-local-build\` holds every command and its exit code. A NSIS
  build from a tree that failed halfway often leaves `release/win-unpacked`
  behind; `--clean` removes it.
- **`/api/health` never answers**: the window may still be starting. Open the
  app and check, or use `--no-launch` and start it yourself.
