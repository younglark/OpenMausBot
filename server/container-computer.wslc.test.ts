import { afterEach, describe, expect, it, vi } from "vitest";
import { resolve } from "node:path";

import {
  BASE_IMAGE_DIGEST,
  BASE_IMAGE_LABEL,
  CUA_DRIVER_VERSION,
  DRIVER_LABEL,
  IMAGE,
  IMAGE_LAYER_LABEL,
  IMAGE_LAYER_VERSION,
  MANAGED_LABEL,
  VM_WORKSPACE_DIR,
  VM_WORKSPACE_GUEST,
  WORKSPACE_LABEL,
  WSLC_COMPUTERS_ENV,
  containerComputerAction,
  containerComputerStatus,
  containerRunArgs,
  containerRuntimeStatus,
  perBotLocalVmTarget,
  setupCommands,
  wslcComputersEnabled,
  wslcSecurityIsAcceptable,
  type CommandRunner,
  type WslcInspectDetail,
} from "./container-computer.ts";

const imageLabels = {
  [MANAGED_LABEL]: "1",
  [DRIVER_LABEL]: CUA_DRIVER_VERSION,
  [BASE_IMAGE_LABEL]: BASE_IMAGE_DIGEST,
  [IMAGE_LAYER_LABEL]: IMAGE_LAYER_VERSION,
};
const imageId = `sha256:${"a".repeat(64)}`;
const imageInspect = JSON.stringify([{ Id: imageId, Config: { Labels: imageLabels } }]);

/** Deliberately NOT 6080: dockerViewerPort() falls back to 6080 for the shared target, so a
 * fake that reports 6080 cannot distinguish "read top-level Ports" from "silently failed". */
const HOST_PORT = 51_234;

type PortBinding = { HostIp?: string; HostPort?: string };
type Mount = {
  Type?: string;
  Source?: string;
  Destination?: string;
  RW?: boolean;
  ReadWrite?: boolean;
};
type WslcDetail = {
  Id: string;
  Image: string;
  Config: { Image: string; Labels: Record<string, string>; Env: string[] };
  HostConfig?: Record<string, unknown>;
  Ports?: Record<string, PortBinding[] | null>;
  Mounts?: Mount[];
  State: { Running: boolean; FinishedAt: string };
};

/** Real wslc 3.0.3.0 shape: top-level Ports, Mounts.ReadWrite, four-field HostConfig. */
function baseDetail(): WslcDetail {
  return {
    Id: `sha256:${"b".repeat(64)}`,
    Image: imageId,
    Config: {
      Image: IMAGE,
      Labels: { ...imageLabels, [WORKSPACE_LABEL]: "1" },
      Env: ["VNC_PW=probe"],
    },
    HostConfig: { Memory: 4 * 1024 * 1024 * 1024, NanoCpus: 2_000_000_000, NetworkMode: "bridge", Ulimits: [] },
    Ports: { "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: String(HOST_PORT) }] },
    Mounts: [{
      Type: "bind",
      Source: resolve(VM_WORKSPACE_DIR),
      Destination: VM_WORKSPACE_GUEST,
      ReadWrite: true,
    }],
    State: { Running: true, FinishedAt: "0001-01-01T00:00:00Z" },
  };
}

function inspectWith(overrides: Partial<WslcDetail> = {}): string {
  return JSON.stringify([{ ...baseDetail(), ...overrides }]);
}

function detailWith(overrides: Partial<WslcDetail> = {}): WslcInspectDetail {
  return JSON.parse(inspectWith(overrides))[0] as WslcInspectDetail;
}

const readyScreenshot = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47]),
  Buffer.alloc(600),
  Buffer.from("IEND"),
]).toString("base64");

function fakeWslc(inspectJson = inspectWith()) {
  const calls: string[] = [];
  const run: CommandRunner = async (command, args) => {
    const key = [command, ...args].join(" ");
    calls.push(key);
    if (command === "where.exe" && args[0] === "wslc") return { stdout: "C:\\Program Files\\WSL\\wslc.exe" };
    if (command === "wslc" && args[0] === "info") return { stdout: "{}" };
    if (command === "wslc" && args[0] === "image" && args[1] === "inspect") return { stdout: imageInspect };
    if (command === "wslc" && args[0] === "inspect") return { stdout: inspectJson };
    if (command === "wslc" && (args[0] === "pull" || args[0] === "build")) return { stdout: "" };
    if (key.includes(" --version")) return { stdout: `cua-driver ${CUA_DRIVER_VERSION}` };
    if (key.includes(" status --socket")) return { stdout: "ok" };
    if (key.includes("call health_report")) return { stdout: JSON.stringify({ schema_version: "1", overall: "ok", checks: [] }) };
    if (key.includes("call get_desktop_state")) return { stdout: "ok" };
    if (key.includes("base64 -w0")) return { stdout: readyScreenshot };
    throw new Error(`unexpected command: ${key}`);
  };
  return { calls, run };
}

afterEach(() => vi.unstubAllEnvs());

describe("wslc opt-in switch", () => {
  it("reads localVm.wslc, with OMB_WSLC_COMPUTERS forcing either way", () => {
    expect(wslcComputersEnabled({})).toBe(false);
    expect(wslcComputersEnabled({ localVm: { wslc: true } })).toBe(true);
    expect(wslcComputersEnabled({ localVm: { wslc: true } }, { [WSLC_COMPUTERS_ENV]: "0" })).toBe(false);
    expect(wslcComputersEnabled({ localVm: { wslc: false } }, { [WSLC_COMPUTERS_ENV]: "1" })).toBe(true);
    expect(wslcComputersEnabled({}, { [WSLC_COMPUTERS_ENV]: "0" })).toBe(false);
    expect(wslcComputersEnabled({}, { [WSLC_COMPUTERS_ENV]: "yes" })).toBe(false);
    expect(wslcComputersEnabled({}, { [WSLC_COMPUTERS_ENV]: "1" })).toBe(true);
  });

  it("does not enter the Windows runtime list when disabled", async () => {
    const { calls, run } = fakeWslc();
    const status = await containerRuntimeStatus(run, "win32", { wslcEnabled: false });
    expect(status.available).toEqual([]);
    expect(status.runtime).toBeNull();
    expect(calls.some((call) => call.includes("wslc"))).toBe(false);
  });

  it("prefers wslc and health-checks it with --format json when enabled", async () => {
    const { calls, run } = fakeWslc();
    const status = await containerRuntimeStatus(run, "win32", { wslcEnabled: true });
    expect(status.runtime).toBe("wslc");
    expect(status.daemonUp).toBe(true);
    expect(calls).toContain("wslc info --format json");
  });

  it("does not offer wslc on non-Windows platforms", async () => {
    const { run } = fakeWslc();
    const status = await containerRuntimeStatus(run, "linux", { wslcEnabled: true });
    expect(status.available).not.toContain("wslc");
  });

  it("works through the production path, which passes no options and reads the saved config", async () => {
    vi.stubEnv(WSLC_COMPUTERS_ENV, "1");
    const enabled = await containerComputerStatus(fakeWslc().run, "win32");
    expect(enabled.runtime).toBe("wslc");
    expect(enabled.security).toBe("relaxed");
    expect(enabled.ready).toBe(true);

    vi.stubEnv(WSLC_COMPUTERS_ENV, "0");
    const disabled = await containerComputerStatus(fakeWslc().run, "win32");
    expect(disabled.runtime).toBeNull();
    expect(disabled.problem).toContain("Install a supported container runtime");
    expect(disabled.ready).toBe(false);
  });
});

describe("wslcSecurityIsAcceptable (minimal evidence, fails closed)", () => {
  const acceptable = (overrides: Partial<WslcDetail> = {}) =>
    wslcSecurityIsAcceptable(detailWith(overrides), "win32", VM_WORKSPACE_DIR);

  it("accepts the real wslc inspect shape", () => {
    expect(acceptable()).toBe(true);
  });

  it("accepts Docker's RW spelling too", () => {
    const mounts = baseDetail().Mounts?.map(({ ReadWrite, ...mount }) => ({ ...mount, RW: ReadWrite }));
    expect(acceptable({ Mounts: mounts })).toBe(true);
  });

  it("rejects a partial inspect with no HostConfig", () => {
    expect(acceptable({ HostConfig: undefined })).toBe(false);
  });

  it("rejects host networking, privileged mode and host namespaces", () => {
    expect(acceptable({ HostConfig: { ...baseDetail().HostConfig, NetworkMode: "host" } })).toBe(false);
    expect(acceptable({ HostConfig: { ...baseDetail().HostConfig, Privileged: true } })).toBe(false);
    expect(acceptable({ HostConfig: { ...baseDetail().HostConfig, PidMode: "host" } })).toBe(false);
  });

  it("rejects missing field names rather than treating them as proof", () => {
    expect(acceptable({ HostConfig: {} })).toBe(false);
  });

  it("rejects undersized resource limits", () => {
    expect(acceptable({ HostConfig: { ...baseDetail().HostConfig, Memory: 1024 } })).toBe(false);
    expect(acceptable({ HostConfig: { ...baseDetail().HostConfig, NanoCpus: 1 } })).toBe(false);
  });

  it("rejects a missing, public or extra published port", () => {
    expect(acceptable({ Ports: undefined })).toBe(false);
    expect(acceptable({ Ports: { "6901/tcp": [{ HostIp: "0.0.0.0", HostPort: String(HOST_PORT) }] } })).toBe(false);
    expect(acceptable({ Ports: {
      "6901/tcp": [{ HostIp: "127.0.0.1", HostPort: String(HOST_PORT) }],
      "8080/tcp": [{ HostIp: "127.0.0.1", HostPort: "58080" }],
    } })).toBe(false);
  });

  it("rejects a read-only, missing or unproven workspace mount", () => {
    const mount = baseDetail().Mounts?.[0];
    expect(acceptable({ Mounts: [{ ...mount, ReadWrite: false }] })).toBe(false);
    expect(acceptable({ Mounts: undefined })).toBe(false);
    expect(acceptable({ Mounts: [{ Type: "bind", Source: resolve(VM_WORKSPACE_DIR), Destination: VM_WORKSPACE_GUEST }] })).toBe(false);
  });
});

describe("wslc Local VM status", () => {
  it("emits only run flags wslc accepts, and keeps the loopback viewer port", () => {
    const args = containerRunArgs("wslc", "probe-password");
    const forbidden = [
      "--cap-drop", "--cap-add", "--pids-limit", "--ipc", "--cgroupns",
      "--memory-swap", "--security-opt", "--hostname", "--userns",
    ];
    for (const flag of forbidden) expect(args).not.toContain(flag);
    for (const flag of ["--memory", "--cpus", "--shm-size", "--mount", "--label", "-p", "-e"]) {
      expect(args).toContain(flag);
    }
    expect(args).toContain("127.0.0.1:6080:6901");
  });

  it("reports relaxed and resolves the viewer port from top-level Ports, not the fallback", async () => {
    const { run } = fakeWslc();
    const status = await containerComputerStatus(run, "win32", undefined, { wslcEnabled: true });
    expect(status.runtime).toBe("wslc");
    expect(status.security).toBe("relaxed");
    expect(status.network).toBe("loopback");
    expect(status.persistence).toBe("durable");
    expect(status.viewer_port).toBe(HOST_PORT);
    expect(status.viewer_url).toContain(`127.0.0.1:${HOST_PORT}`);
    expect(status.viewer_url).not.toContain(":6080");
    expect(status.problem).toBeNull();
    expect(status.ready).toBe(true);
    expect(status.resumable).toBe(false);
  });

  it("resolves the per-bot random port even though that target has no fallback", async () => {
    const target = perBotLocalVmTarget("bot-1");
    const inspect = inspectWith({
      Mounts: [{ ...baseDetail().Mounts?.[0], Source: resolve(target.workspaceDir) }],
    });
    const status = await containerComputerStatus(fakeWslc(inspect).run, "win32", target, { wslcEnabled: true });
    expect(status.viewer_port).toBe(HOST_PORT);
    expect(status.viewer_url).toContain(`127.0.0.1:${HOST_PORT}`);
    expect(status.security).toBe("relaxed");
  });

  it("does not report relaxed for a publicly published viewer", async () => {
    const inspect = inspectWith({
      Ports: { "6901/tcp": [{ HostIp: "0.0.0.0", HostPort: String(HOST_PORT) }] },
    });
    const status = await containerComputerStatus(fakeWslc(inspect).run, "win32", undefined, { wslcEnabled: true });
    expect(status.network).toBe("unsafe");
    expect(status.security).toBe("unsafe");
    expect(status.ready).toBe(false);
    expect(status.problem).toContain("exposes its viewer publicly");
  });

  it("does not report relaxed for a read-only workspace mount", async () => {
    const mount = baseDetail().Mounts?.[0];
    const inspect = inspectWith({ Mounts: [{ ...mount, ReadWrite: false }] });
    const status = await containerComputerStatus(fakeWslc(inspect).run, "win32", undefined, { wslcEnabled: true });
    expect(status.persistence).toBe("unsafe");
    expect(status.security).toBe("unsafe");
    expect(status.ready).toBe(false);
    expect(status.problem).toMatch(/safety limits|durable folder/);
  });

  it("proves security is not a runtime alias: loopback and durable still pass, but no evidence fails", async () => {
    const inspect = inspectWith({ HostConfig: undefined });
    const status = await containerComputerStatus(fakeWslc(inspect).run, "win32", undefined, { wslcEnabled: true });
    expect(status.runtime).toBe("wslc");
    expect(status.network).toBe("loopback");
    expect(status.persistence).toBe("durable");
    expect(status.security).toBe("unsafe");
    expect(status.problem).toContain("missing safety limits");
  });

  it("does not ask for --force-rm when building the managed image", async () => {
    const { calls, run } = fakeWslc();
    await containerComputerAction("pull", run, "win32", undefined, { wslcEnabled: true });
    const build = calls.find((call) => call.startsWith("wslc build "));
    expect(build).toBeDefined();
    expect(build).not.toContain("--force-rm");
  });
});

describe("setupCommands (wslc)", () => {
  it("does not offer the Podman installer, but gives an actionable session probe", () => {
    const commands = setupCommands("wslc", "win32");
    expect(commands.install).toBeNull();
    expect(commands.runtimeStart).toBe("wslc info --format json");
    expect(commands.run).toMatch(/^wslc run /);
    expect(commands.run).not.toContain("podman");
    expect(commands.run).not.toContain("--cap-drop");
  });

  it("still offers the Podman installer when no other runtime is selected", () => {
    expect(setupCommands(null, "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
    expect(setupCommands("docker", "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
    expect(setupCommands("podman", "win32").install).toBe("winget install -e --id RedHat.Podman-Desktop");
  });

  it("keeps the loopback viewer and the wslc-shaped lifecycle commands", () => {
    const commands = setupCommands("wslc", "win32");
    expect(commands.pull).toMatch(/^wslc pull /);
    expect(commands.run).toContain("127.0.0.1:6080:6901");
    expect(commands.remove).toMatch(/^wslc rm -f /);
  });
});
