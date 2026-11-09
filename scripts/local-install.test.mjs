import { spawn, spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { appInstallGuid, installDirectory, nsisLaunch, parseArgs, parseInstallLocation } from "./local-install.mjs";

describe("local-install arguments", () => {
  it("installs the packaged app and launches it by default", () => {
    const options = parseArgs([]);
    expect(options.run).toBe(false);
    expect(options.launch).toBe(true);
    expect(options.keepUpdate).toBe(false);
    expect(options.skipBuild).toBe(false);
    expect(options.dryRun).toBe(false);
    expect(options.dir).toBeNull();
  });

  it("reads the build and install switches", () => {
    const options = parseArgs(["--run", "--clean", "--skip-build", "--no-install", "--no-launch", "--keep-update", "--yes", "--dry-run", "--allow-unsupported-node"]);
    expect(options).toMatchObject({
      run: true, clean: true, skipBuild: true, noInstall: true, launch: false,
      keepUpdate: true, yes: true, dryRun: true, allowUnsupportedNode: true,
    });
  });

  it("resolves --dir against the working directory", () => {
    expect(parseArgs(["--dir", "build/here"]).dir).toBe(path.resolve("build/here"));
  });

  it("keeps an absolute --dir as given", () => {
    const absolute = path.resolve("somewhere", "OpenMausBot");
    expect(parseArgs(["--dir", absolute]).dir).toBe(absolute);
  });

  it("rejects an unknown option instead of ignoring it", () => {
    expect(() => parseArgs(["--nope"])).toThrow(/unknown option --nope/);
  });

  it("rejects --dir without a path", () => {
    expect(() => parseArgs(["--dir"])).toThrow(/--dir needs a path/);
    expect(() => parseArgs(["--dir", "--yes"])).toThrow(/--dir needs a path/);
  });

  it("rejects a --dir that would break the unquoted NSIS /D= argument", () => {
    expect(() => parseArgs(["--dir", 'C:\\bad"path'])).toThrow(/quotes or newlines/);
    expect(() => parseArgs(["--dir", "C:\\bad\npath"])).toThrow(/quotes or newlines/);
  });

  it("keeps a --dir that contains spaces", () => {
    expect(parseArgs(["--dir", "C:\\Program Files\\OpenMausBot"]).dir).toBe(path.resolve("C:\\Program Files\\OpenMausBot"));
  });
});

describe("where the per-user installer writes", () => {
  it("uses electron-builder's appId guid", () => {
    expect(appInstallGuid("com.openmausbot.app")).toBe("900d443d-e5ca-503b-acd1-193a402ade45");
  });

  it("reads InstallLocation and drops a quote left by a quoted /D=", () => {
    const text = [
      "HKEY_CURRENT_USER\\Software\\900d443d-e5ca-503b-acd1-193a402ade45",
      "    InstallLocation    REG_SZ    C:\\Users\\ada\\AppData\\Local\\Programs\\openmausbot",
      "",
    ].join("\r\n");
    expect(parseInstallLocation(text)).toBe("C:\\Users\\ada\\AppData\\Local\\Programs\\openmausbot");
    expect(parseInstallLocation('    InstallLocation    REG_SZ    C:\\Program Files\\openmausbot"')).toBe("C:\\Program Files\\openmausbot");
    expect(parseInstallLocation("nothing")).toBeNull();
  });

  it("prefers --dir, then the recorded location, then the package-name default", () => {
    const localAppData = "C:\\Users\\ada\\AppData\\Local";
    expect(installDirectory({ dir: "D:\\custom" }, { recorded: "D:\\old\\openmausbot", localAppData })).toBe("D:\\custom");
    expect(installDirectory({ dir: null }, { recorded: "D:\\old\\openmausbot\\", localAppData })).toBe("D:\\old\\openmausbot");
    expect(installDirectory({ dir: null }, { recorded: null, localAppData, folderName: "openmausbot" })).toBe("C:\\Users\\ada\\AppData\\Local\\Programs\\openmausbot");
    expect(installDirectory({ dir: null }, { recorded: null, localAppData })).toBe("C:\\Users\\ada\\AppData\\Local\\Programs\\openmausbot");
    expect(installDirectory({ dir: null }, { recorded: null, localAppData: "" })).toBeNull();
  });

  it("passes /D= last and unquoted", () => {
    expect(nsisLaunch("setup.exe", "C:\\Program Files\\openmausbot")).toEqual({
      command: "setup.exe",
      args: ["/S", "/D=C:\\Program Files\\openmausbot"],
      windowsVerbatimArguments: true,
    });
  });

  it.skipIf(process.platform !== "win32" || tmpdir().includes(" "))("leaves /D= unquoted on the command line", () => {
    const directory = "C:\\Program Files\\openmausbot";
    const dir = mkdtempSync(path.join(tmpdir(), "omb-nsis-"));
    const script = path.join(dir, "sleep.ps1");
    writeFileSync(script, "Start-Sleep -Seconds 8\r\n");
    const launch = nsisLaunch("powershell.exe", directory);
    const child = spawn(launch.command, ["-NoProfile", "-File", script, ...launch.args], {
      windowsHide: true,
      windowsVerbatimArguments: launch.windowsVerbatimArguments,
      stdio: "ignore",
    });
    try {
      const result = spawnSync("powershell.exe", ["-NoProfile", "-Command", `
        $deadline = (Get-Date).AddSeconds(8)
        do {
          $line = (Get-CimInstance Win32_Process -Filter "ProcessId=${child.pid}").CommandLine
          if ($line) { Write-Output $line; exit 0 }
          Start-Sleep -Milliseconds 100
        } while ((Get-Date) -lt $deadline)
        exit 1
      `], { encoding: "utf8" });
      expect(result.status).toBe(0);
      expect(result.stdout).toContain(`/D=${directory}`);
      expect(result.stdout).not.toMatch(/"\/D=/);
    } finally {
      spawnSync("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], { stdio: "ignore" });
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
