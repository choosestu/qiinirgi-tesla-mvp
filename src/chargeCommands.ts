// Executes charging decisions against the Tesla, behind the dry-run guard.
// Shared by the charge controller (server.ts poller) and the manual
// POST /solar/reading path in routes.ts.

import type { AppConfig } from "./config";
import type { ChargingDecision } from "./solar";
import { setChargingAmps, startCharging, stopCharging } from "./tesla";

// TEMPORARY SAFETY GUARD: decisions are computed and logged but no charging
// commands are sent to the car, until the controller's behaviour has been
// watched against Brett's real plant for a day. Remove once verified.
export const CHARGING_DRY_RUN = true;

export interface CommandResult {
  ok: boolean;
  message: string;
}

function describe(decision: ChargingDecision): string {
  return decision.amps !== undefined ? `${decision.action} @ ${decision.amps}A` : decision.action;
}

/**
 * Sends the Tesla command(s) for a start/stop/set_amps decision. "start" sets
 * the amps before starting, so the car never briefly charges at whatever
 * (possibly much higher) rate it was last left at. Returns undefined for noop.
 */
export async function executeChargingAction(
  config: AppConfig,
  decision: ChargingDecision
): Promise<CommandResult | undefined> {
  if (decision.action === "noop") return undefined;

  if (CHARGING_DRY_RUN) {
    const message = `DRY RUN: would have executed "${describe(decision)}" (${decision.reason}); no command sent.`;
    console.log(`[charging] ${message}`);
    return { ok: true, message };
  }

  try {
    if (decision.action === "start" && decision.amps !== undefined) {
      await setChargingAmps(config, decision.amps);
      const outcome = await startCharging(config);
      return { ok: outcome.result, message: outcome.reason };
    }
    if (decision.action === "stop") {
      const outcome = await stopCharging(config);
      return { ok: outcome.result, message: outcome.reason };
    }
    if (decision.action === "set_amps" && decision.amps !== undefined) {
      const outcome = await setChargingAmps(config, decision.amps);
      return { ok: outcome.result, message: outcome.reason };
    }
    return undefined;
  } catch (err) {
    return { ok: false, message: err instanceof Error ? err.message : "Unknown error executing command." };
  } finally {
    console.log(`[charging] Executed "${describe(decision)}" (${decision.reason})`);
  }
}
