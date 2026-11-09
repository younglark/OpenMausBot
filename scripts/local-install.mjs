// Build this checkout's desktop app and install it on this machine.
//
// `pnpm local:install` is the full path: prepare, package the NSIS installer,
// verify it, close the app that is running, install silently (/S) and start it
// again to check /api/health. `pnpm local:run` stops after the unpacked build
// and starts release/win-unpacked, for a loop that only needs the new code.
//
// An installer built here still carries electron-builder.yml's upstream publish
// target, so the packaged app offers the official release ~15s after it starts
// and would replace this build. Unless --keep-update is passed, the installed
// resources/app-update.yml is renamed aside; see docs/local-build.md.
//
// Windows only for now: scripts/defender-check-win.mjs already proves the /S
// install and the install-directory check on Windows, while macOS needs an
// ad-hoc signed app and Linux needs root. The other platforms are a follow-up.
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, createReadStream, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statfsSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const APP_EXECUTABLE = "OpenMausBot.exe";
const PRODUCT = "OpenMausBot";
const PNPM_VERSION = "10.33.0";
const MIN_NODE_MAJOR = 24;
const MIN_FREE_BYTES = 5 * 1024 ** 3;
const MIN_INSTALLER_BYTES = 200 * 1024 ** 2;
const DESKTOP_PORTS = [8799, 18799, 28799];
const HEALTH_TIMEOUT_MS = 60_000;
const INSTALL_TIMEOUT_MS = 10 * 60_000;

const USAGE = `Usage: node scripts/local-install.mjs [options]

  --run                      build release/win-unpacked and start it (skips NSIS)
  --clean                    remove dist, dist-server, dist-companion and release first
  --skip-build               install the installer already in release/
  --no-install               build and verify the installer, do not install it
  --no-launch                do not start the app after installing
  --keep-update              leave resources/app-update.yml pointing at the upstream feed
  --yes                      do not prompt (closes a running app without asking)
  --dry-run                  print the commands instead of running them
  --dir <path>               install to <path> instead of %LOCALAPPDATA%\\Programs\\OpenMausBot
  --allow-unsupported-node   run on a Node below the engines range in package.json
  --help                     show this text`;

function parseArgs(args) {
  const options = {
    run: false, clean: false, skipBuild: false, noInstall: false, launch: true, keepUpdate: false,
    yes: false, dryRun: false, dir: null, allowUnsupportedNode: false, help: false,
  };
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--run") options.run = true;
    else if (arg === "--clean") options.clean = true;
    else if (arg === "--skip-build") options.skipBuild = true;
    else if (arg === "--no-install") options.noInstall = true;
    else if (arg === "--no-launch") options.launch = false;
    else if (arg === "--keep-update") options.keepUpdate = true;
    else if (arg === "--yes") options.yes = true;
    else if (arg === "--dry-run") options.dryRun = true;
    else if (arg === "--allow-unsupported-node") options.allowUnsupportedNode = true;
    else if (arg === "--help") options.help = true;
    else if (arg === "--dir") {
      const value = args[index + 1];
      if (!value || value.startsWith("--")) throw new Error("--dir needs a path");
      options.dir = path.resolve(value);
      index += 1;
    } else throw new Error(`unknown option ${arg}\n\n${USAGE}`);
  }
  if (options.dir && /["'\r\n]/.test(options.dir)) {
    throw new Error("--dir cannot contain quotes or newlines: NSIS /D= takes an unquoted path");
  }
  return options;
}

let logFile = null;
function log(line = "") {
  console.log(line);
  if (logFile) appendFileSync(logFile, `${line}\n`);
}

function fail(message) {
  log(`\nERROR: ${message}`);
  process.exit(1);
}

function openLog(runDirectory) {
  mkdirSync(runDirectory, { recursive: true });
  logFile = path.join(runDirectory, `local-install-${new Date().toISOString().replace(/[:.]/g, "-")}.log`);
  appendFileSync(logFile, `${PRODUCT} local build/install log\n`);
  log(`log: ${logFile}`);
}

function step(title) {
  const began = Date.now();
  log(`\n== ${title}`);
  return () => log(`-- ${title}: ${((Date.now() - began) / 1000).toFixed(1)}s`);
}

const delay = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

function corepackPath() {
  return path.join(path.dirname(process.execPath), process.platform === "win32" ? "corepack.cmd" : "corepack");
}

// Node 25 stopped bundling Corepack; a standalone pnpm on PATH runs the same
// pinned CLI.
function standalonePnpmPath() {
  const result = spawnSync(process.platform === "win32" ? "where.exe" : "which", ["pnpm"], { encoding: "utf8" });
  if (result.status !== 0) return null;
  const candidates = String(result.stdout ?? "").split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  if (process.platform === "win32") return candidates.find((file) => /\.(cmd|exe|bat)$/i.test(file)) ?? null;
  return candidates[0] ?? null;
}

function pnpmLauncher() {
  if (existsSync(corepackPath())) {
    return {
      command: process.platform === "win32" ? "corepack.cmd" : "corepack",
      shimCommand: corepackPath(),
      prefix: ["pnpm"],
      label: "corepack pnpm",
    };
  }
  const standalone = standalonePnpmPath();
  if (!standalone) return null;
  return { command: process.platform === "win32" ? "pnpm.cmd" : "pnpm", shimCommand: standalone, prefix: [], label: "pnpm" };
}

// package:prepare is a chain of package.json scripts (`pnpm build && pnpm
// build:server && …`), and those inner calls run a bare `pnpm`. That name may
// not resolve: Corepack only puts `pnpm` on PATH after `corepack enable`.
// Every child gets a shim directory ahead of PATH whose pnpm forwards to the
// launcher this script resolved.
const SHIM_DIRECTORY = path.join(tmpdir(), "openmausbot-local-build", "bin");

function ensurePnpmShim() {
  const launcher = pnpmLauncher();
  if (!launcher) return;
  mkdirSync(SHIM_DIRECTORY, { recursive: true });
  const forwarded = launcher.prefix.length ? ` ${launcher.prefix.join(" ")}` : "";
  if (process.platform === "win32") {
    writeFileSync(path.join(SHIM_DIRECTORY, "pnpm.cmd"), `@echo off\r\n"${launcher.shimCommand}"${forwarded} %*\r\n`);
  } else {
    writeFileSync(path.join(SHIM_DIRECTORY, "pnpm"), `#!/bin/sh\nexec "${launcher.shimCommand}"${forwarded} "$@"\n`, { mode: 0o755 });
  }
}

function childEnv() {
  const env = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toLowerCase() === "path") delete env[key];
  }
  env.PATH = `${SHIM_DIRECTORY}${path.delimiter}${process.env.Path ?? process.env.PATH ?? ""}`;
  return env;
}

function pnpmLabel() {
  return pnpmLauncher()?.label ?? "pnpm";
}

function pnpm(args, { capture = false } = {}) {
  const launcher = pnpmLauncher();
  if (!launcher) throw new Error(`pnpm was not found; install it with npm i -g pnpm@${PNPM_VERSION}`);
  log(`$ ${launcher.label} ${args.join(" ")}`);
  const result = spawnSync(launcher.command, [...launcher.prefix, ...args], {
    cwd: ROOT,
    stdio: capture ? ["ignore", "pipe", "pipe"] : "inherit",
    encoding: "utf8",
    shell: process.platform === "win32",
    env: childEnv(),
  });
  if (result.error) throw new Error(`could not start ${launcher.label}: ${result.error.message}`);
  if (result.status !== 0) {
    const tail = capture ? `${result.stderr ?? ""}${result.stdout ?? ""}`.trim().split(/\r?\n/).slice(-8).join("\n") : "";
    throw new Error(`${launcher.label} ${args.join(" ")} exited with ${result.status}${tail ? `\n${tail}` : ""}`);
  }
  return capture ? String(result.stdout ?? "").trim() : "";
}

function existingFile(candidates) {
  return candidates.find((file) => existsSync(file)) ?? null;
}

function packageVersion() {
  return JSON.parse(readFileSync(path.join(ROOT, "package.json"), "utf8")).version;
}

function sha256(file) {
  const hash = createHash("sha256");
  return pipeline(createReadStream(file), hash).then(() => hash.digest("hex"));
}

function freeBytes(directory) {
  try {
    const stats = statfsSync(directory);
    return Number(stats.bavail) * Number(stats.bsize);
  } catch {
    // statfs is unavailable on some filesystems; a null means "do not gate on it".
    return null;
  }
}

function preflight(options) {
  if (process.platform !== "win32") {
    fail("this script installs the Windows build only; macOS and Linux are a follow-up (docs/local-build.md)");
  }
  const major = Number(process.versions.node.split(".")[0]);
  if (major < MIN_NODE_MAJOR) {
    const detail = `Node ${process.versions.node} is below the engines range (>=${MIN_NODE_MAJOR})`;
    if (!options.allowUnsupportedNode) {
      fail(`${detail}. Upgrade Node, or pass --allow-unsupported-node to build on it anyway.`);
    }
    log(`WARNING: ${detail}; continuing because --allow-unsupported-node was passed.`);
  }
  const version = pnpm(["--version"], { capture: true });
  if (version !== PNPM_VERSION) {
    fail(`resolved pnpm ${version}; this checkout pins ${PNPM_VERSION}. Run: npm i -g pnpm@${PNPM_VERSION} (or corepack prepare pnpm@${PNPM_VERSION} --activate)`);
  }
  const free = freeBytes(ROOT);
  if (free !== null && free < MIN_FREE_BYTES) {
    fail(`only ${(free / 1024 ** 3).toFixed(1)}GB free; packaging needs about 5GB`);
  }
  log(`node ${process.versions.node}, pnpm ${version}, ${process.platform}-${process.arch}`);
}

function prepareDependencies(options) {
  const done = step("dependencies");
  if (!existsSync(path.join(ROOT, "node_modules"))) {
    if (options.dryRun) log("$ corepack pnpm install --frozen-lockfile");
    else pnpm(["install", "--frozen-lockfile"]);
  }
  const electronDist = path.join(ROOT, "node_modules", "electron", "dist");
  const electronBinary = existingFile([path.join(electronDist, "electron.exe"), path.join(electronDist, "electron")]);
  if (!electronBinary) {
    const installer = path.join(ROOT, "node_modules", "electron", "install.js");
    if (!existsSync(installer)) fail("electron is not installed; run corepack pnpm install --frozen-lockfile");
    if (options.dryRun) {
      log("$ node node_modules/electron/install.js   # downloads the Electron binary once (~120MB)");
    } else {
      log("electron binary is missing; downloading it once (about 120MB)");
      const result = spawnSync(process.execPath, [installer], { cwd: ROOT, stdio: "inherit" });
      if (result.status !== 0) {
        fail("electron/install.js failed. On a slow network set ELECTRON_MIRROR (for example https://npmmirror.com/mirrors/electron/) and retry.");
      }
    }
  }
  done();
}

function cleanOutputs(options) {
  if (!options.clean) return;
  const done = step("clean");
  for (const name of ["dist", "dist-server", "dist-companion", "release"]) {
    const target = path.join(ROOT, name);
    log(`removing ${name}`);
    if (options.dryRun) continue;
    try {
      rmSync(target, { recursive: true, force: true });
    } catch (error) {
      fail(`could not remove ${name}: ${error.message}. Close anything using it and run again.`);
    }
  }
  done();
}

function build(options) {
  if (options.skipBuild) {
    log("\n== build skipped (--skip-build)");
    return;
  }
  const done = step(options.run ? "build (unpacked)" : "build (installer)");
  if (options.run) {
    // dir packaging skips NSIS compression, but still needs every extraResource
    // package:prepare stages plus the Windows CUA driver.
    if (options.dryRun) log(`$ ${pnpmLabel()} package:prepare && ${pnpmLabel()} build:cua:win && ${pnpmLabel()} exec electron-builder --win dir --x64 --publish never`);
    else {
      pnpm(["package:prepare"]);
      pnpm(["build:cua:win"]);
      pnpm(["exec", "electron-builder", "--win", "dir", "--x64", "--publish", "never"]);
    }
  } else if (options.dryRun) {
    log(`$ ${pnpmLabel()} package:win`);
  } else {
    pnpm(["package:win"]);
  }
  done();
}

function unpackedExecutable() {
  const direct = path.join(ROOT, "release", "win-unpacked", APP_EXECUTABLE);
  if (existsSync(direct)) return direct;
  const release = path.join(ROOT, "release");
  if (!existsSync(release)) return null;
  for (const entry of readdirSync(release, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const candidate = path.join(release, entry.name, APP_EXECUTABLE);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

function installerPath(version) {
  const expected = path.join(ROOT, "release", `${PRODUCT}-${version}-setup.exe`);
  if (existsSync(expected)) return expected;
  const release = path.join(ROOT, "release");
  if (!existsSync(release)) return null;
  const found = readdirSync(release).filter((name) => name.endsWith("-setup.exe"));
  if (found.length === 0) return null;
  if (found.length > 1) log(`WARNING: ${found.length} installers in release/; using ${found[0]}`);
  log(`WARNING: ${found[0]} does not match package.json ${version}`);
  return path.join(release, found[0]);
}

async function verifyInstaller(file, version) {
  const done = step("verify installer");
  const bytes = statSync(file).size;
  log(`${path.basename(file)} ${(bytes / 1024 ** 2).toFixed(0)}MB`);
  if (bytes < MIN_INSTALLER_BYTES) fail(`installer is only ${(bytes / 1024 ** 2).toFixed(0)}MB; a complete one is about 268MB`);
  if (!path.basename(file).includes(version)) fail(`installer name does not carry package.json ${version}`);
  log(`sha256 ${await sha256(file)}`);
  done();
}

function tasklist() {
  const result = spawnSync("tasklist.exe", ["/FI", `IMAGENAME eq ${APP_EXECUTABLE}`, "/FO", "CSV", "/NH"], { encoding: "utf8" });
  if (result.status !== 0 || !result.stdout) return [];
  return result.stdout.split(/\r?\n/).filter((line) => line.startsWith('"')).map((line) => {
    const [name, pid] = line.replaceAll('"', "").split(",");
    return { name, pid: Number(pid) };
  });
}

async function closeRunningApp(options) {
  const running = tasklist();
  if (running.length === 0) return;
  log(`\n== ${PRODUCT} is running (${running.length} process${running.length === 1 ? "" : "es"})`);
  if (!options.yes) {
    if (!process.stdin.isTTY) {
      fail(`${PRODUCT} is running. Close it, or pass --yes to let this script close it (unsaved work in it is lost).`);
    }
    const prompt = createInterface({ input: process.stdin, output: process.stdout });
    const answer = await prompt.question(`Close it and continue? Unsaved work in the app is lost. [y/N] `);
    prompt.close();
    if (!/^y(es)?$/i.test(answer.trim())) fail("stopped at the running app; nothing was installed");
  }
  log("asking the app to close");
  spawnSync("taskkill.exe", ["/IM", APP_EXECUTABLE, "/T"], { stdio: "ignore" });
  for (let attempt = 0; attempt < 20 && tasklist().length > 0; attempt += 1) await delay(500);
  if (tasklist().length > 0) {
    log("the app did not exit; forcing it closed");
    spawnSync("taskkill.exe", ["/F", "/T", "/IM", APP_EXECUTABLE], { stdio: "ignore" });
    await delay(1000);
  }
  if (tasklist().length > 0) fail(`could not close ${APP_EXECUTABLE}`);
}

function installedDirectory(options) {
  if (options.dir) return options.dir;
  const programs = path.join(process.env.LOCALAPPDATA ?? "", "Programs");
  if (!existsSync(programs)) return null;
  for (const entry of readdirSync(programs, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(programs, entry.name);
    if (existsSync(path.join(directory, APP_EXECUTABLE))) return directory;
  }
  return null;
}

function productVersion(executable) {
  const script = `(Get-Item -LiteralPath '${executable.replaceAll("'", "''")}').VersionInfo.ProductVersion`;
  const result = spawnSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], { encoding: "utf8" });
  if (result.status !== 0) return null;
  return String(result.stdout ?? "").replace(/^\uFEFF/, "").trim() || null;
}

function install(options, installer, version) {
  const done = step("install");
  const args = ["/S"];
  if (options.dir) args.push(`/D=${options.dir}`);
  log(`$ ${path.basename(installer)} ${args.join(" ")}`);
  const result = spawnSync(installer, args, { stdio: "inherit", timeout: INSTALL_TIMEOUT_MS });
  if (result.error?.code === "ETIMEDOUT") fail("the installer did not finish within 10 minutes");
  if (result.error) fail(`could not start the installer: ${result.error.message}`);
  if (result.status !== 0) fail(`the installer exited with ${result.status}`);
  done();

  const verify = step("verify install");
  const directory = installedDirectory(options);
  if (!directory) fail("the installer finished but no installed OpenMausBot.exe was found");
  const executable = path.join(directory, APP_EXECUTABLE);
  const found = productVersion(executable);
  log(`installed ${executable}`);
  log(`product version ${found ?? "unknown"} (expected ${version})`);
  if (!found || found.split(".").slice(0, 3).join(".") !== version) {
    fail(`installed version ${found ?? "unknown"} does not match package.json ${version}`);
  }
  if (!existsSync(path.join(directory, "Uninstall OpenMausBot.exe"))) fail("the installed tree has no uninstaller");
  verify();
  return executable;
}

function disableUpdateFeed(executable) {
  const feed = path.join(path.dirname(executable), "resources", "app-update.yml");
  if (!existsSync(feed)) return;
  const disabled = `${feed}.disabled`;
  renameSync(feed, disabled);
  log(`updates disabled: ${path.basename(disabled)} (rename it back to app-update.yml to restore the upstream feed)`);
}

async function waitForHealth() {
  const deadline = Date.now() + HEALTH_TIMEOUT_MS;
  while (Date.now() < deadline) {
    for (const port of DESKTOP_PORTS) {
      try {
        const answer = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(1500) });
        if (answer.ok) return port;
      } catch {
        // the embedded server is not listening yet
      }
    }
    await delay(1000);
  }
  return null;
}

async function launch(executable) {
  const done = step("launch");
  const child = spawn(executable, [], { detached: true, stdio: "ignore" });
  child.unref();
  const port = await waitForHealth();
  if (port === null) {
    log(`WARNING: started ${path.basename(executable)} but /api/health did not answer within ${HEALTH_TIMEOUT_MS / 1000}s`);
    log("the app may still be starting; open it and check, or run the same command with --no-launch next time");
  } else {
    log(`/api/health answered on 127.0.0.1:${port}`);
  }
  done();
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    console.log(USAGE);
    return;
  }
  openLog(path.join(tmpdir(), "openmausbot-local-build"));
  ensurePnpmShim();
  log(`${options.run ? "local:run" : "local:install"}${options.dryRun ? " (dry run)" : ""}`);

  preflight(options);
  prepareDependencies(options);
  cleanOutputs(options);
  build(options);

  const version = packageVersion();
  if (options.run) {
    if (options.dryRun) {
      log(`\nwould start release/win-unpacked/${APP_EXECUTABLE}${options.launch ? " and check /api/health" : ""}`);
      return;
    }
    const executable = unpackedExecutable();
    if (!executable) fail(`no ${APP_EXECUTABLE} under release/; run without --skip-build`);
    log(`\nunpacked build: ${executable}`);
    if (!options.keepUpdate) disableUpdateFeed(executable);
    if (options.launch) await launch(executable);
    else log("--no-launch: not starting it");
    return;
  }

  const installer = installerPath(version);
  if (!installer) {
    if (options.dryRun) {
      log(`\nwould verify release/${PRODUCT}-${version}-setup.exe, then install it with /S`);
      return;
    }
    fail(`no *-setup.exe in release/; run without --skip-build`);
  }
  if (options.dryRun) {
    log(`\ninstaller: ${installer}`);
    log(`would install with /S${options.dir ? ` /D=${options.dir}` : ""}, then ${options.launch ? "start it and check /api/health" : "stop"}`);
    return;
  }
  await verifyInstaller(installer, version);
  if (options.noInstall) {
    log(`\n--no-install: ${installer} is ready`);
    return;
  }

  const previous = installedDirectory(options);
  if (previous) log(`\nreplacing ${previous}`);
  await closeRunningApp(options);

  const executable = install(options, installer, version);
  if (!options.keepUpdate) disableUpdateFeed(executable);
  if (options.launch) await launch(executable);
  log(`\ninstalled ${version} at ${path.dirname(executable)}`);
}

export { parseArgs };

// Imported by scripts/local-install.test.mjs: only a direct `node
// scripts/local-install.mjs` run should touch this machine.
const entry = process.argv[1] ? path.resolve(process.argv[1]) : "";
if (entry && entry.toLowerCase() === fileURLToPath(import.meta.url).toLowerCase()) {
  main().catch((error) => fail(error instanceof Error ? error.message : String(error)));
}
