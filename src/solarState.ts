// In-memory store of the most recent solar reading and the decision made
// from it. Fine for a single-instance MVP (same pattern already used for
// OAuth state in auth.ts) -- this is a cache for visibility/debugging via
// GET /solar/status, not a source of truth; the source of truth is always
// the next reading the bridge sends.

import type { SolarReading, ChargingDecision } from "./solar";

export interface SolarStateSnapshot {
    reading: SolarReading;
    decision: ChargingDecision;
    decidedAt: string;
    commandResult?: { ok: boolean; message: string };
}

let latest: SolarStateSnapshot | undefined;

export function setLatestSolarState(snapshot: SolarStateSnapshot): void {
    latest = snapshot;
}

export function getLatestSolarState(): SolarStateSnapshot | undefined {
    return latest;
}
