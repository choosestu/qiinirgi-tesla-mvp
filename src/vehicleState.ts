// Last known Tesla charging state, shared by the charge controller and the
// dashboard so neither has to pay for a vehicle_data call every time it
// wants to know whether the car is plugged in / charging.

import type { AppConfig } from "./config";
import { getVehicleChargingStatus, type VehicleChargingStatus } from "./tesla";

export interface CachedVehicle {
  vehicle: VehicleChargingStatus;
  checkedAt: number;
}

let cached: CachedVehicle | null = null;
let lastAttemptAt = 0;
let lastError: string | null = null;

/** Reads live vehicle state from Tesla (one billable call) and caches it. */
export async function readVehicle(config: AppConfig, reason: string): Promise<VehicleChargingStatus> {
  lastAttemptAt = Date.now();
  console.log(`[tesla] Reading vehicle state: ${reason}`);
  try {
    const vehicle = await getVehicleChargingStatus(config);
    cached = { vehicle, checkedAt: lastAttemptAt };
    lastError = null;
    return vehicle;
  } catch (err) {
    lastError = err instanceof Error ? err.message : "Unable to reach the vehicle.";
    throw err;
  }
}

export function getCachedVehicle(): CachedVehicle | null {
  return cached;
}

// The dashboard may refresh vehicle state itself, but at most this often,
// however many times the page polls /dashboard/summary.
const DASHBOARD_VEHICLE_MAX_AGE_MS = Number(process.env.DASHBOARD_VEHICLE_MAX_AGE_MS) || 15 * 60 * 1000;

/**
 * Vehicle state for /dashboard/summary: the cached state, refreshed from
 * Tesla only if it (and the last attempt) is older than
 * DASHBOARD_VEHICLE_MAX_AGE_MS. Never wakes the car.
 */
export async function getVehicleForDashboard(
  config: AppConfig
): Promise<{ vehicle: VehicleChargingStatus | null; checkedAt: string | null; error: string | null }> {
  const now = Date.now();
  if (now - lastAttemptAt >= DASHBOARD_VEHICLE_MAX_AGE_MS) {
    try {
      await readVehicle(config, "dashboard view, cached state is stale");
    } catch {
      // Keep serving the cached state; lastError says why it's stale.
    }
  }
  return {
    vehicle: cached?.vehicle ?? null,
    checkedAt: cached ? new Date(cached.checkedAt).toISOString() : null,
    error: cached ? null : lastError,
  };
}
