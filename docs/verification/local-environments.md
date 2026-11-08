# Local environments (switchable setups)

Design: [local environments design](../superpowers/specs/2026-10-07-local-environments-design.md);
summary: [plan](../plans/local-environments.md).

Creating and switching named local environments is packaged-desktop
behavior: the control surface cannot drive it, and an unpackaged dev run
returns `dev` for create and switch (the "Environments on this computer"
card stays hidden because the bridge reports `packaged: false`). Verify it
by hand on an installed build, exactly as below.

## Floor: unit tests

```sh
node --test electron/environments.node-test.mjs electron/environment-switch.node-test.mjs
```

`pnpm test:electron` runs these with the whole Electron suite. They cover
registry parsing and migration, the create guard rules (absolute paths, no
duplicate, no nesting, not the default directory), the orchestrator's
stop→lease→start→probe→persist order, and rollback on every failure path.
They do not prove the user workflow — the recipe does.

## Setup

- A packaged desktop installation of this branch, signed in on This
  computer with at least one bot so the bot list is visibly non-empty.
- The registry lives in the app's user-data folder: on macOS
  `~/Library/Application Support/OpenMausBot/environments.json`.
- The app log (`server.log` in the app's logs directory) records every
  switch decision; keep it open.

## 1. Create an environment

1. Open **Settings → Servers**. Under "Environments on this computer",
   enter the name `APRS Chat`, leave the data folder empty, choose
   **Create**.
2. Expect: a row `APRS Chat` with path `~/.openmausbot-aprs-chat`, a
   **Switch** button and a Forget (trash) affordance. No restart happens,
   and "This computer" still shows **Current**. Nothing is written to the
   new directory yet — creating registers the entry; the directory is
   created (and seeds itself) at first switch.
3. Expect `environments.json` to contain the entry with `"kind": "local"`,
   a generated `id`, and `activeId` still `"local"`.

## 2. Switch to it

1. Click **Switch**, then confirm "Switch to APRS Chat? The app restarts on
   that environment."
2. Expect: the window goes blank/unavailable while the old server child is
   stopped and the target boots, then reloads onto the new environment —
   roughly fifteen seconds for an already-existing directory. The boot
   probe allows up to 60 seconds per port attempt (ports 8799, 18799,
   28799, two passes), so a first boot on a cold disk can take longer.
3. Expect on arrival: an **empty bot list** (fresh environment), the sidebar
   pill reading `APRS Chat`, and "APRS Chat" marked Current in
   Settings → Servers.
4. Expect from a terminal: `~/.openmausbot-aprs-chat/environment-id` exists
   and is a UUID **different** from `~/.openmausbot/environment-id` — the
   two environments are distinct servers, and every state file lives under
   its own directory. `environments.json` now has `activeId` set to the
   entry's id.
5. Create a throwaway bot here, then confirm `~/.openmausbot/` gained no
   trace of it.

## 3. Switch back

Switch to **This computer** from the same page (or the Server menu).
Expect the same reload, your original bot list back, and the new
environment still listed with its bot intact when you look again.

## 4. Unmounted-volume abort (stay put)

Simulate an environment on a drive that is gone, without a real drive:

1. Quit the app completely.
2. Edit `environments.json`: point an **inactive** entry's `dataDir` at a
   path whose parent does not exist, e.g. `/Volumes/NO-VOLUME/openmausbot-env`.
3. Launch the app on This computer. Expect: the row shows a **missing**
   badge (the flag is stamped at read time, so it clears when the path
   reappears).
4. Click **Switch** and confirm. Expect: a short unavailability while the
   switch aborts, the dialog **"Could not switch environments"** ("…The app
   log has the details."), and the installation left exactly where it was —
   This computer running, `activeId` unchanged, old server restarted by the
   rollback. The log shows
   `switch to /Volumes/NO-VOLUME/openmausbot-env aborted: target unavailable`
   followed by `environment switch to … failed (unavailable)` — the probe
   refused to create a directory through the missing parent, and the entry
   keeps its **missing** badge.

## 5. Boot fallback (unhealthy environment)

Make the **active** environment unbootable:

1. Quit the app. Create an unwritable parent, e.g.
   `sudo mkdir /opt/omb-locked && sudo chmod 500 /opt/omb-locked`, set the
   active entry's `dataDir` to `/opt/omb-locked/env` and `activeId` to that
   entry's id.
2. Launch. Expect the boot to fail across the port schedule (a child that
   cannot create its data dir exits quickly; a hung child burns the full
   probe timeout per attempt), then:
   - the installation comes up on This computer with normal data,
   - a dialog titled **"The environment was unhealthy"** says OpenMausBot
     "came up on this computer's default data folder instead" and to choose
     the environment again once it is available,
   - `environments.json` shows `activeId` reset to `"local"`, and the entry
     stays put for debugging.

## Dev-mode note

Under `pnpm dev:desktop` the feature is intentionally off: the environments
card does not render, and `environments:create` / local `environments:switch`
answer `{ ok: false, error: "dev" }`. Remote-server entries keep working in
dev; only local data-dir switching is packaged-gated.

## Not proven here

Cross-process lease contention (two app processes, one environment) is
covered by `electron/data-dir-lease.node-test.mjs`, not this recipe. This
recipe does not cover Forget's delete-files choice, Windows/Linux paths, or
the packaged build matrix.

## wslc (WSL Containers) Local VM — opt-in, reduced isolation

`OMB_WSLC_COMPUTERS=1` adds `wslc.exe` as a Windows Local VM runtime and
prefers it over Docker/Podman. Without the variable the runtime list is
unchanged, so existing installs are unaffected. wslc is built into Windows, so
the setup card offers no Podman Desktop installer when it is the detected
runtime; Step 2 shows the `wslc info --format json` health probe only when the
session is not ready (sessions are created on first use).

The switch is env-only, unlike `agentsToolBridge`'s config + env layering.
That is a deliberate scope call: threading a config object through every
`containerComputerStatus()` caller would widen the options surface this
runtime already depends on. A Settings toggle should be added later together
with that refactor, not bolted onto the env read.

This is a deliberate security downgrade, and the reason is **verifiability**,
not a total absence of protection. Measured on wslc 3.0.3.0: containers in one
session share a single WSL VM kernel (identical `boot_id`, one
`system session`), while each container still has its own PID namespace,
Docker's default capability set (`CapEff=00000000a80425fb`) and a seccomp
filter (`Seccomp: 2`); no host filesystem is auto-mounted. But wslc rejects
`--cap-drop`, `--cap-add`, `--pids-limit`, `--ipc`, `--cgroupns`,
`--memory-swap` and `--security-opt`, and its `inspect` `HostConfig` exposes
only `Memory`, `NanoCpus`, `NetworkMode` and `Ulimits`. The 12-point
`dockerSecurityIsHardened()` contract can therefore be neither configured nor
machine-verified.

`security: "relaxed"` is **earned, not assumed**: `wslcSecurityIsAcceptable()`
in `server/container-security.ts` (the shared isolation helpers live there so
the size-ratcheted `container-computer.ts` does not grow) requires the four-field `HostConfig` with `NetworkMode === "bridge"`, no
privileged/host-namespace/device escapes, honouring the requested 4 GiB / 2 CPU
limits when reported, exactly one loopback viewer publication, and exactly one
writable workspace bind with an explicit `ReadWrite`/`RW === true`. Missing
evidence or a public port falls to `"unsafe"` and gets the recreate prompt.
The Settings card shows a warning; `hardened` is never reported.

Two accepted consequences: there is **no PID limit** (`--pids-limit` is
rejected and `raisePidsLimit` is skipped), so a fork bomb can exhaust the
shared session VM; and because `build --force-rm` is unsupported, a failed
managed-image build can leave intermediate containers that must be removed by
hand. Bind-mounting the Windows workspace remains a deliberate path from the
container to the host. Only enable this on a machine you trust.

Verified against wslc 3.0.3.0 on Windows 10 Pro 26H2 (build 26300):

- `inspect` / `image inspect` emit Docker-shaped JSON by default; no
  `--format` is needed for those calls, but `info` needs `--format json`.
- Published ports live at top-level `Ports` with the same shape as Docker's
  `HostConfig.PortBindings`; `127.0.0.1:` bindings are honoured.
- `Mounts` uses `ReadWrite`, not `RW`; Windows bind sources round-trip.
- `run` accepts `--memory --cpus --shm-size --label --mount -e -p`, `pull`
  accepts digest pins, and `build` accepts `FROM/LABEL/USER/RUN` but not
  `--force-rm`.
- `exec -i -u -e`, `rm -f`, `rmi`, `start` and `stop` work.
- `scripts/poc-wslc.mjs` recreates the production `run` flags and records
  `minimalEvidencePass`, `mountRwEvidence` and `portsAreLocal` from a real
  inspect; `scripts/poc-wslc-isolation.mjs` records the isolation probe
  (shared kernel `boot_id`, PID-namespace marker, capabilities, seccomp).
  Both write to the OS temp dir by default (`POC_OUT` overrides) and remove
  only the containers they create.

To verify: set the variable, restart the desktop app, then use Settings →
Local computer → Prepare / Create. Confirm the reduced-isolation warning is
visible and that `dockerSecurityIsHardened()` is never relied on for this
runtime. `pnpm typecheck && pnpm test` must pass; see
`server/container-computer.wslc.test.ts`.
