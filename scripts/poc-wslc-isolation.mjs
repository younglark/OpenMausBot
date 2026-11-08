#!/usr/bin/env node
// PoC: is wslc's VM boundary per container, or per session (shared kernel)?
// Pure Node stdlib so it runs on the repo's unsupported Node 22 without pnpm install.
// Creates two throwaway containers, compares kernel boot identity and PID visibility,
// then removes only the containers it created.
import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

const WSLC = process.env.WSLC_BIN ?? "C:/Program Files/WSL/wslc.exe";
const IMAGE = "ubuntu:24.04";
const A = "omb-iso-a";
const B = "omb-iso-b";
const MARKER = "/tmp/ombmarker";
let markerPid = null;
// The repo has no poc-wslc/ directory; default to the OS temp dir so a bare `node` run works.
const OUT = process.env.POC_OUT ?? join(tmpdir(), "omb-wslc-isolation-report.json");

function wslc(args, timeout = 120_000) {
  return execFileSync(WSLC, args, { encoding: "utf8", timeout, windowsHide: true }).trim();
}

function tryWslc(args, timeout = 60_000) {
  try { return wslc(args, timeout); } catch { return ""; }
}

function remaining(names) {
  const list = tryWslc(["container", "list", "-a", "--format", "json"]);
  return names.filter((name) => list.includes(name));
}

const probe = `
echo "boot_id=$(cat /proc/sys/kernel/random/boot_id)"
echo "kernel=$(uname -r)"
echo "uptime=$(cut -d' ' -f1 /proc/uptime)"
echo "hostname=$(hostname)"
echo "machine_id=$(cat /etc/machine-id 2>/dev/null || echo none)"
echo "capeff=$(grep CapEff /proc/self/status | sed 's/.*:[[:space:]]*//')"
echo "capbnd=$(grep CapBnd /proc/self/status | sed 's/.*:[[:space:]]*//')"
echo "seccomp=$(grep Seccomp /proc/self/status | sed 's/.*:[[:space:]]*//')"
echo "pid1=$(cat /proc/1/comm)"
echo "proc_count=$(ls -d /proc/[0-9]* 2>/dev/null | wc -l)"
echo "marker_comm=$(for p in /proc/[0-9]*/comm; do cat $p 2>/dev/null; done | grep -c ombmarker || true)"
echo "pid_list=$(ls -d /proc/[0-9]* 2>/dev/null | sed 's#.*/##' | paste -sd,)"
echo "netdev_count=$(grep -c ':' /proc/net/dev)"
echo "ip_addr=$(hostname -I 2>/dev/null || echo none)"
echo "host_fs_mounts=$(grep -cE 'drvfs|9p|virtiofs|/mnt/c' /proc/mounts || true)"
echo "caps_raw=$(grep CapEff /proc/self/status)"
`;

function parseProbe(raw) {
  const out = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf("=");
    if (i > 0) out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

const report = {
  date: new Date().toISOString(),
  wslc: null,
  sessions: null,
  containers: {},
  analysis: {},
  verdict: null,
  cleanup: null,
};

try {
  report.wslc = wslc(["version"]);
  report.sessions = JSON.parse(wslc(["system", "info", "--format", "json"])).Server?.Sessions ?? null;

  for (const name of [A, B]) tryWslc(["rm", "-f", name]);
  for (const name of [A, B]) {
    wslc(["run", "-d", "--name", name, IMAGE, "sleep", "infinity"]);
  }

  // A leaves a uniquely named long-running process. If B can see it, the two
  // containers share a PID namespace (and therefore one VM kernel).
  markerPid = wslc(["exec", A, "sh", "-c", `cp /bin/sleep ${MARKER}; ${MARKER} 600 >/dev/null 2>&1 & echo $!`]).trim().split(/\s+/).pop();

  for (const name of [A, B]) {
    report.containers[name] = parseProbe(wslc(["exec", name, "sh", "-c", probe]));
  }
  report.peerMarkerComm = tryWslc(["exec", B, "sh", "-c", `cat /proc/${markerPid}/comm 2>/dev/null || echo absent`]) || "absent";

  const a = report.containers[A];
  const b = report.containers[B];
  const pidsB = new Set((b.pid_list ?? "").split(",").filter(Boolean));
  const markerPidVisibleInPeer = pidsB.has(markerPid);
  report.analysis = {
    sameBootId: Boolean(a.boot_id) && a.boot_id === b.boot_id,
    sameKernel: a.kernel === b.kernel,
    markerPid,
    markerPidVisibleInPeer,
    peerMarkerComm: report.peerMarkerComm,
    samePidNamespace: markerPidVisibleInPeer || report.peerMarkerComm === "ombmarker",
    sameHostname: a.hostname === b.hostname,
    capEff: a.capeff,
    capBnd: a.capbnd,
    dockerDefaultCapSet: a.capeff === "00000000a80425fb",
    seccompMode: a.seccomp,
    seccompFilterActive: a.seccomp === "2",
    hostFsMounts: a.host_fs_mounts,
    ipA: a.ip_addr,
    ipB: b.ip_addr,
    sessionCount: Array.isArray(report.sessions) ? report.sessions.length : null,
  };
  const shared = report.analysis.sameBootId || report.analysis.samePidNamespace;
  report.verdict = shared
    ? "SHARED_SESSION_VM: containers in one wslc session share a single Linux kernel; the VM boundary separates Windows from Linux, not container from container"
    : "PER_CONTAINER_VM: each container has its own kernel boot identity";
} catch (error) {
  report.error = String(error?.message ?? error);
} finally {
  for (const name of [A, B]) tryWslc(["rm", "-f", name]);
  const left = remaining([A, B]);
  report.cleanup = left.length === 0
    ? "removed omb-iso-a, omb-iso-b"
    : `CLEANUP INCOMPLETE: ${left.join(", ")}`;
  mkdirSync(dirname(OUT), { recursive: true });
  writeFileSync(OUT, JSON.stringify(report, null, 2) + "\n");
  console.log(JSON.stringify(report, null, 2));
}
