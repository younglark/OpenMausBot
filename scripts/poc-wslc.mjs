// Spike probe: does wslc.exe satisfy the Local VM container contract in server/container-computer.ts?
// Run with plain Node (no pnpm install needed): node scripts/poc-wslc.mjs [image]
// Creates and removes ONLY the container named omb-wslc-poc-contract. No product code is changed.

import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const WSLC = process.env.WSLC_BIN ?? "C:\\Program Files\\WSL\\wslc.exe";
const IMAGE = process.argv[2] ?? "docker.m.daocloud.io/library/ubuntu:24.04";
const NAME = "omb-wslc-poc-contract";
const MANAGED_LABEL = "com.openmausbot.local-vm=1";
const VM_WORKSPACE_GUEST = "/home/cua/workspace";
const INTERNAL_VIEWER_PORT = 6901;
const HOST_VIEWER_PORT = 16901;

async function wslc(args, timeout = 180_000) {
  const { stdout } = await exec(WSLC, args, {
    timeout,
    maxBuffer: 32 * 1024 * 1024,
    windowsHide: true,
  });
  return stdout;
}

function stdioRoundTrip(args, input) {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(WSLC, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code === 0) resolvePromise(stdout);
      else reject(new Error(stderr || `wslc exited ${code}`));
    });
    child.stdin.write(`${input}\n`);
    child.stdin.end();
  });
}

// Mirrors the readers in server/container-computer.ts (dockerSecurityIsHardened,
// dockerPortsAreLocal, dockerWorkspaceMountIsSafe, wslcSecurityIsAcceptable). Kept inline so
// this probe runs on stock Node with no pnpm install.
function dockerSecurityIsHardened(config) {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? []).map((cap) => cap.toLowerCase().replace(/^cap_/, "")).sort();
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((o) => /(?:^|=)(?:unconfined|disable)$/i.test(o));
  const restartPolicy = config.RestartPolicy?.Name;
  const restartPolicyOk = restartPolicy === undefined || restartPolicy === "" || restartPolicy === "no";
  return (
    capDrop.includes("all") &&
    capAdd.join(",") === "setgid,setuid" &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    !(config.Devices?.length) &&
    !(config.DeviceRequests?.length) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.AutoRemove !== true &&
    restartPolicyOk
  );
}

function loopback(address) {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

function dockerPortsAreLocal(bindings) {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

/** wslc spells Docker's RW as ReadWrite. Normalize before ANY check, otherwise `RW !== false`
 * silently passes on `undefined` and a read-only mount looks durable. */
function normalizeWslcMounts(mounts) {
  return mounts?.map((mount) => ({ ...mount, RW: mount.ReadWrite ?? mount.RW }));
}

function dockerWorkspaceMountIsSafe(mounts, expectedWorkspace) {
  const source = mounts?.[0]?.Source;
  const sourceMatches = Boolean(
    source && resolve(source).toLowerCase() === resolve(expectedWorkspace).toLowerCase(),
  );
  return Boolean(
    mounts?.length === 1 &&
      mounts[0]?.Type === "bind" &&
      sourceMatches &&
      mounts[0]?.Destination === VM_WORKSPACE_GUEST &&
      mounts[0]?.RW === true,
  );
}

/** The minimal positive-evidence check used for security: "relaxed" in product code. */
function wslcSecurityIsAcceptable(detail, expectedWorkspace) {
  const host = detail?.HostConfig;
  if (!host || host.NetworkMode !== "bridge") return false;
  if (host.Privileged === true || host.PidMode || host.IpcMode === "host" || host.UTSMode === "host") return false;
  if (host.Devices?.length || host.DeviceRequests?.length) return false;
  if ((host.SecurityOpt ?? []).some((o) => /(?:^|=)(?:unconfined|disable)$/i.test(o))) return false;
  if (host.Memory !== undefined && host.Memory < 4 * 1024 * 1024 * 1024) return false;
  if (host.NanoCpus !== undefined && host.NanoCpus < 2e9) return false;
  if (!dockerPortsAreLocal(detail?.Ports)) return false;
  const mounts = normalizeWslcMounts(detail?.Mounts);
  return dockerWorkspaceMountIsSafe(mounts, expectedWorkspace) && mounts?.[0]?.RW === true;
}

async function removeContainer() {
  for (const args of [["rm", "-f", NAME], ["container", "remove", "-f", NAME]]) {
    try {
      await wslc(args, 30_000);
      return;
    } catch {}
  }
}

// Optional second gate: can `wslc exec -i` carry the Cua Driver MCP stdio bridge?
// Set POC_CUA_CONTAINER to a running container built from the Cua XFCE base image.
function probeMcpBridge(container) {
  const initialize = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "omb-wslc-poc", version: "1" },
    },
  });
  return new Promise((resolvePromise) => {
    const args = [
      "exec", "-i", "-u", "cua",
      "-e", "HOME=/home/cua",
      "-e", "DISPLAY=:1",
      container,
      "/opt/venv/bin/cua-driver", "mcp", "--socket", "/tmp/omb-poc.sock",
    ];
    const child = spawn(WSLC, args, { windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), 10_000);
    child.stdout.on("data", (chunk) => { stdout += chunk; });
    child.stderr.on("data", (chunk) => { stderr += chunk; });
    child.on("error", (error) => {
      clearTimeout(timer);
      resolvePromise({ respondedWithJsonRpc: false, error: error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      const firstLine = stdout.split(/\r?\n/).find((line) => line.trim().startsWith("{")) ?? "";
      let parsed = null;
      try { parsed = JSON.parse(firstLine); } catch {}
      resolvePromise({
        respondedWithJsonRpc: Boolean(parsed?.jsonrpc),
        responseId: parsed?.id ?? null,
        exitCode: code,
        stderrHead: stderr.trim().slice(0, 200),
      });
    });
    child.stdin.write(`${initialize}\n`);
  });
}

async function main() {
  const report = { image: IMAGE, checks: {} };
  const workspace = await mkdtemp(join(tmpdir(), "omb-wslc-poc-"));
  try {
    const info = JSON.parse(await wslc(["info", "--format", "json"]));
    report.wslc = { version: info.Client?.Version, session: info.Server?.Sessions?.[0]?.Name };

    await removeContainer();
    await wslc([
      "run", "-d", "--name", NAME,
      "--label", MANAGED_LABEL,
      "--memory", "4g", "--cpus", "2", "--shm-size", "512m",
      "-p", `127.0.0.1:${HOST_VIEWER_PORT}:${INTERNAL_VIEWER_PORT}`,
      "--mount", `type=bind,source=${workspace},target=${VM_WORKSPACE_GUEST}`,
      IMAGE, "sleep", "infinity",
    ]);

    const inspected = JSON.parse(await wslc(["container", "inspect", "-f", "json", NAME]));
    const detail = inspected[0];
    // Docker readers use HostConfig.PortBindings / NetworkSettings.Ports; wslc publishes at the top level.
    const bindings = detail?.Ports ?? detail?.HostConfig?.PortBindings ?? detail?.NetworkSettings?.Ports;
    const mounts = normalizeWslcMounts(detail?.Mounts);
    report.checks = {
      inspectIsDockerShapedArray: Array.isArray(inspected) && Boolean(detail?.State),
      imageLabelsReadable: Boolean(detail?.Config?.Labels?.[MANAGED_LABEL.split("=")[0]]),
      portBindingsLocation: detail?.HostConfig?.PortBindings ? "HostConfig.PortBindings" : detail?.Ports ? "top-level Ports" : "missing",
      portsAreLocal: dockerPortsAreLocal(bindings),
      mountRwEvidence: mounts?.[0]?.RW === true,
      workspaceMountIsSafe: dockerWorkspaceMountIsSafe(mounts, workspace),
      securityIsHardened: dockerSecurityIsHardened(detail?.HostConfig),
      minimalEvidencePass: wslcSecurityIsAcceptable(detail, workspace),
      hostConfigFields: Object.keys(detail?.HostConfig ?? {}),
    };

    const probe = "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"tools/list\"}";
    const bridge = await stdioRoundTrip(
      ["exec", "-i", NAME, "sh", "-c", "read l; echo ACK:$l"],
      probe,
    );
    report.checks.stdioBridgeEcho = bridge.trim() === `ACK:${probe}`;

    const roundTrip = await wslc(["exec", NAME, "sh", "-c", `echo omb-ok > ${VM_WORKSPACE_GUEST}/probe.txt && cat ${VM_WORKSPACE_GUEST}/probe.txt`]);
    report.checks.mountRoundTrip = roundTrip.trim() === "omb-ok";

    if (process.env.POC_CUA_CONTAINER) {
      report.cuaMcpBridge = await probeMcpBridge(process.env.POC_CUA_CONTAINER);
    }

    report.verdict = report.checks.securityIsHardened
      ? "PASS: wslc container satisfies the existing hardening contract"
      : report.checks.minimalEvidencePass
        ? "RELAXED: the 12-point contract is unverifiable, but the minimal wslc evidence check passes"
        : "BLOCKED: neither the hardening contract nor the minimal wslc evidence check passes";
  } finally {
    await removeContainer();
    await rm(workspace, { recursive: true, force: true });
  }
  const out = process.env.POC_OUT;
  if (out) await writeFile(out, JSON.stringify(report, null, 2) + "\n", "utf8");
  console.log(JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error("POC_FAILED", error?.message ?? String(error));
  process.exitCode = 1;
});
