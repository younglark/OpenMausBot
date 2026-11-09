// The Local VM's settings, read from the config the server loaded.
import type { AppConfig } from "./config.ts";
import { wslcComputersEnabled, wslcComputersEnvValue } from "./container-security.ts";

export const DEFAULT_LOCAL_VM_MODE = "shared" as const;
export const DEFAULT_LOCAL_VM_MAX_INSTANCES = 2;
export const MIN_LOCAL_VM_MAX_INSTANCES = 1;
export const MAX_LOCAL_VM_MAX_INSTANCES = 8;
export const DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 480;
export const MIN_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 5;
export const MAX_LOCAL_VM_IDLE_TIMEOUT_MINUTES = 1_440;

export function localVmMode(cfg: AppConfig): "shared" | "per-bot" | "pool" {
  return cfg.localVm?.mode ?? DEFAULT_LOCAL_VM_MODE;
}

export function localVmMaxInstances(cfg: AppConfig): number {
  return cfg.localVm?.maxInstances ?? DEFAULT_LOCAL_VM_MAX_INSTANCES;
}

export function localVmIdleTimeoutMinutes(cfg: AppConfig): number {
  return cfg.localVm?.idleTimeoutMinutes ?? DEFAULT_LOCAL_VM_IDLE_TIMEOUT_MINUTES;
}

/** App preservation is deliberately opt-in: a normal image replacement keeps its existing small, predictable footprint. */
export function localVmPreservesInstalledApps(cfg: AppConfig): boolean {
  return cfg.localVm?.preserveInstalledApps === true;
}

/** `wslc_forced` tells the settings switch that OMB_WSLC_COMPUTERS overrides it. */
export function localVmWslcFields(cfg: AppConfig): { wslc_enabled: boolean; wslc_forced: boolean } {
  return { wslc_enabled: wslcComputersEnabled(cfg), wslc_forced: wslcComputersEnvValue() !== null };
}
