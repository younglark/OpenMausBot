// Container isolation checks shared by Local VM and VPS computers.
// Kept in its own module: server/container-computer.ts is size-ratcheted and must not grow.
import { resolve } from "node:path";

export const INTERNAL_VIEWER_PORT = 6901;
export const MEMORY_BYTES = 4 * 1024 * 1024 * 1024;
export const VM_WORKSPACE_GUEST = "/home/cua/workspace";

/** wslc is strictly opt-in through `localVm.wslc` in config.json or OMB_WSLC_COMPUTERS, which
 * forces it on ("1") or off ("0"). All containers in one wslc session share a single WSL VM kernel
 * (verified: identical boot_id, one system session); each still has its own PID/network/mount
 * namespace, Docker's default capability set and a seccomp filter. But wslc accepts none of the
 * hardening flags and exposes no HostConfig evidence, so the 12-point dockerSecurityIsHardened()
 * contract can be neither configured nor machine-verified here.
 * Turning it on deliberately trades that auditable contract for a working Windows backend;
 * the status therefore reports "relaxed" (only when wslcSecurityIsAcceptable() passes) and the UI
 * says so, never "hardened". */
export const WSLC_COMPUTERS_ENV = "OMB_WSLC_COMPUTERS";
type WslcConfig = { localVm?: { wslc?: boolean } };

/** Null when the variable is unset or not one of the two explicit values. */
export function wslcComputersEnvValue(env: NodeJS.ProcessEnv = process.env): boolean | null {
  const raw = env[WSLC_COMPUTERS_ENV];
  return raw === "1" ? true : raw === "0" ? false : null;
}

export function wslcComputersEnabled(cfg: WslcConfig = {}, env: NodeJS.ProcessEnv = process.env): boolean {
  return wslcComputersEnvValue(env) ?? cfg.localVm?.wslc === true;
}

type RuntimeName = "docker" | "podman" | "container" | "wslc";
export type ContainerBinding = Record<string, Array<{ HostIp?: string; HostPort?: string }> | null>;

function loopback(address: string | undefined): boolean {
  return address === "127.0.0.1" || address === "::1" || address === "[::1]";
}

export function dockerPortsAreLocal(bindings: ContainerBinding | undefined): boolean {
  const viewer = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`] ?? [];
  const published = Object.values(bindings ?? {}).flatMap((entries) => entries ?? []);
  return viewer.length > 0 && published.length === viewer.length && published.every((entry) => loopback(entry.HostIp));
}

export function dockerViewerPort(bindings: ContainerBinding | undefined, fallback: number | null): number | null {
  const raw = bindings?.[`${INTERNAL_VIEWER_PORT}/tcp`]?.find((entry) => loopback(entry.HostIp))?.HostPort;
  const parsed = raw ? Number(raw) : NaN;
  return Number.isInteger(parsed) && parsed > 0 && parsed <= 65_535 ? parsed : fallback;
}

export function applePortsAreLocal(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
): boolean {
  return Boolean(
    bindings?.length === 1 &&
      bindings[0]?.containerPort === INTERNAL_VIEWER_PORT &&
      loopback(bindings[0]?.hostAddress),
  );
}

export function appleViewerPort(
  bindings: Array<{ hostAddress?: string; hostPort?: number; containerPort?: number }> | undefined,
  fallback: number | null,
): number | null {
  const raw = bindings?.find(
    (binding) => binding.containerPort === INTERNAL_VIEWER_PORT && loopback(binding.hostAddress),
  )?.hostPort;
  return Number.isInteger(raw) && Number(raw) > 0 && Number(raw) <= 65_535 ? Number(raw) : fallback;
}

export function sameWorkspaceSource(
  source: string | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
): boolean {
  if (!source) return false;
  const actual = resolve(source);
  const expected = resolve(expectedWorkspace);
  return platform === "win32" ? actual.toLowerCase() === expected.toLowerCase() : actual === expected;
}

/** Podman Machine exposes a Windows bind source through its WSL mount path; accept only the exact translation. */
export function samePodmanWindowsWorkspaceSource(source: string | undefined, expectedWorkspace: string): boolean {
  if (!source) return false;
  const match = expectedWorkspace.match(/^([A-Za-z]):[\\/](.+)$/);
  if (!match) return false;
  const expected = `/mnt/${match[1].toLowerCase()}/${match[2].replaceAll("\\", "/")}`;
  const actual = source.replaceAll("\\", "/");
  return actual.toLowerCase() === expected.toLowerCase();
}

export function dockerWorkspaceMountIsSafe(
  mounts: Array<{ Type?: string; Source?: string; Destination?: string; RW?: boolean }> | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
  runtime: RuntimeName = "docker",
): boolean {
  const sourceMatches = sameWorkspaceSource(mounts?.[0]?.Source, platform, expectedWorkspace) ||
    (runtime === "podman" &&
      platform === "win32" &&
      samePodmanWindowsWorkspaceSource(mounts?.[0]?.Source, expectedWorkspace));
  return Boolean(
    mounts?.length === 1 &&
      mounts[0]?.Type === "bind" &&
      sourceMatches &&
      mounts[0]?.Destination === VM_WORKSPACE_GUEST &&
      mounts[0]?.RW !== false,
  );
}

export function appleWorkspaceMountIsSafe(
  mounts: Array<{ source?: string; destination?: string; options?: string[] }> | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
): boolean {
  const options = mounts?.[0]?.options ?? [];
  return Boolean(
    mounts?.length === 1 &&
      sameWorkspaceSource(mounts[0]?.source, platform, expectedWorkspace) &&
      mounts[0]?.destination === VM_WORKSPACE_GUEST &&
      !options.some((option) => option === "ro" || option === "readonly"),
  );
}

export interface DockerHardeningConfig {
  Memory?: number;
  MemorySwap?: number;
  NanoCpus?: number;
  PidsLimit?: number | null;
  CapDrop?: string[] | null;
  CapAdd?: string[] | null;
  Privileged?: boolean;
  PidMode?: string;
  IpcMode?: string;
  UTSMode?: string;
  ShmSize?: number;
  Devices?: unknown[] | null;
  DeviceRequests?: unknown[] | null;
  SecurityOpt?: string[] | null;
  UsernsMode?: string;
  CgroupnsMode?: string;
  OomKillDisable?: boolean | null;
  AutoRemove?: boolean;
  RestartPolicy?: { Name?: string; MaximumRetryCount?: number };
}

/** Shared isolation contract for Local VM and VPS containers; Podman alone needs chroot for Firefox's sandbox. */
export function dockerSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  options: { restartPolicy?: "no" | "unless-stopped" | "any"; podmanBrowserSandbox?: boolean } = {},
): boolean {
  if (!config) return false;
  const capDrop = (config.CapDrop ?? []).map((cap) => cap.toLowerCase());
  const capAdd = (config.CapAdd ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const unsafeSecurityOption = (config.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option));
  const restartPolicy = config.RestartPolicy?.Name;
  const restartPolicyOk =
    options.restartPolicy === "any" || (options.restartPolicy === "unless-stopped"
      ? restartPolicy === "unless-stopped"
      : restartPolicy === undefined || restartPolicy === "" || restartPolicy === "no");
  return (
    capDrop.includes("all") &&
    capAdd.join(",") === (options.podmanBrowserSandbox ? "setgid,setuid,sys_chroot" : "setgid,setuid") &&
    config.Privileged === false &&
    !config.PidMode &&
    config.IpcMode === "private" &&
    !config.UTSMode &&
    (!config.Devices || config.Devices.length === 0) &&
    (!config.DeviceRequests || config.DeviceRequests.length === 0) &&
    !unsafeSecurityOption &&
    !config.UsernsMode &&
    config.CgroupnsMode === "private" &&
    config.AutoRemove !== true &&
    restartPolicyOk
  );
}

/** Podman normalizes HostConfig capability and namespace fields in inspect output, so its effective/bounding sets decide. */
export function podmanSecurityIsHardened(
  config: DockerHardeningConfig | undefined,
  effectiveCaps: string[] | undefined,
  boundingCaps: string[] | undefined,
): boolean {
  if (!config) return false;
  const normalizeCaps = (caps: string[] | undefined) => (caps ?? [])
    .map((cap) => cap.toLowerCase().replace(/^cap_/, ""))
    .sort();
  const exactCaps = "setgid,setuid,sys_chroot";
  if (normalizeCaps(effectiveCaps).join(",") !== exactCaps) return false;
  if (normalizeCaps(boundingCaps).join(",") !== exactCaps) return false;
  return dockerSecurityIsHardened({
    ...config,
    CapDrop: ["all"],
    CapAdd: effectiveCaps,
    PidMode: config.PidMode === "private" ? "" : config.PidMode,
    UTSMode: config.UTSMode === "private" ? "" : config.UTSMode,
    // Rootless keep-id maps the workspace owner to the guest cua account; never arbitrary userns sharing or host namespaces.
    UsernsMode: config.UsernsMode === "private" || config.UsernsMode === "keep-id:uid=1000,gid=1000"
      ? "" : config.UsernsMode,
    CgroupnsMode: config.CgroupnsMode || "private",
  }, { podmanBrowserSandbox: true });
}

/** The shape wslc 3.0.3.0 inspect actually returns: Docker-shaped, but with top-level Ports,
 * Mounts.ReadWrite and a four-field HostConfig. */
export interface WslcInspectDetail {
  Config?: { Image?: string; Labels?: Record<string, string>; Env?: string[] };
  HostConfig?: DockerHardeningConfig & { NetworkMode?: string };
  Ports?: ContainerBinding;
  Mounts?: Array<{
    Type?: string;
    Source?: string;
    Destination?: string;
    RW?: boolean;
    ReadWrite?: boolean;
  }>;
  State?: { Running?: boolean; FinishedAt?: string };
  Image?: string;
}

const WSLC_CPUS_NANO = 2 * 1_000_000_000;

/** wslc cannot produce the 12-field Docker hardening contract, but its inspect still carries
 * enough positive evidence to reject a container we did not create. "relaxed" is a conclusion
 * drawn from those fields, not a synonym for the runtime name. Missing evidence fails closed. */
export function wslcSecurityIsAcceptable(
  detail: WslcInspectDetail | undefined,
  platform: NodeJS.Platform,
  expectedWorkspace: string,
): boolean {
  const host = detail?.HostConfig;
  if (!host) return false;
  // Require the bridge network by value: wslc refuses --network host, and an absent field is not proof.
  if (host.NetworkMode !== "bridge") return false;
  // Reject explicit escapes too, in case a future wslc starts accepting these flags.
  if (host.Privileged === true || host.PidMode || host.IpcMode === "host" || host.UTSMode === "host") return false;
  if (host.Devices?.length || host.DeviceRequests?.length) return false;
  if ((host.SecurityOpt ?? []).some((option) => /(?:^|=)(?:unconfined|disable)$/i.test(option))) return false;
  // containerRunArgs() asks for 4 GiB / 2 CPUs; when wslc reports them they must be honoured.
  if (host.Memory !== undefined && host.Memory < MEMORY_BYTES) return false;
  if (host.NanoCpus !== undefined && host.NanoCpus < WSLC_CPUS_NANO) return false;
  // The viewer must exist and be the only publication, bound to loopback.
  if (!dockerPortsAreLocal(detail?.Ports)) return false;
  // Exactly one writable workspace bind. ReadWrite is wslc's spelling of Docker's RW; a missing
  // flag is not evidence of a writable mount.
  const mounts = detail?.Mounts?.map((mount) => ({ ...mount, RW: mount.ReadWrite ?? mount.RW }));
  if (!dockerWorkspaceMountIsSafe(mounts, platform, expectedWorkspace, "wslc")) return false;
  return mounts?.[0]?.RW === true;
}
