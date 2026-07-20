// Solar-aware charging decision logic.
//
// This module is deliberately independent of *how* readings arrive (Sungrow
// Modbus today, potentially another inverter brand later) and independent of
// *how* commands get sent to a vehicle (Tesla today). It takes a snapshot of
// the home's current energy state plus the vehicle's current charging state,
// and decides what, if anything, should change. Keeping this pure and
// vehicle/inverter-agnostic is what makes it possible to swap either side
// out later without touching this file.

import type { AppConfig } from "./config";
import type { VehicleChargingStatus } from "./tesla";
import { MIN_CHARGING_AMPS, MAX_CHARGING_AMPS } from "./tesla";

/**
 * A single point-in-time reading from the home's solar/battery system.
 * All power values are in watts. Positive batteryPowerW means the battery
 * is charging (absorbing power); negative means it's discharging (supplying
 * power). This mirrors how most hybrid inverters, including Sungrow's,
 * report battery power.
 */
export interface SolarReading {
    /** Instantaneous solar (PV) production, in watts. */
  solarProductionW: number;
    /** Instantaneous whole-home load, in watts. Typically already includes
     * whatever the EV charger is currently drawing, since the inverter/meter
     * can't distinguish EV load from any other home load. */
  homeLoadW: number;
    /** Battery state of charge, 0-100. */
  batterySocPercent: number;
    /** Battery charge (+) or discharge (-) power, in watts. */
  batteryPowerW: number;
    /** ISO timestamp the reading was taken, set by the bridge that read it. */
  readingTakenAt: string;
}

export type ChargingAction = "start" | "stop" | "set_amps" | "noop";

export interface ChargingDecision {
    action: ChargingAction;
    /** Target charging current in amps. Present when action is "start" or "set_amps". */
  amps?: number;
    /** Human-readable explanation, useful for logging and debugging. */
  reason: string;
}

/** Minimum change in amps required before we bother sending a new set_amps command. */
const AMPS_CHANGE_HYSTERESIS = 2;

/**
 * Estimates the EV's own current draw from the vehicle's reported charging
 * current, so it can be added back to home load to figure out how much
 * surplus is actually available (the inverter's homeLoadW figure already
 * includes whatever the EV is drawing right now).
 */
function estimateEvDrawW(vehicle: VehicleChargingStatus, config: AppConfig): number {
    if (vehicle.charging_state !== "Charging") {
          return 0;
    }
    return vehicle.charging_current * config.assumedVoltageV;
}

/**
 * Decides what charging action, if any, to take given the current home
 * energy state and the vehicle's current charging state.
 *
 * The logic, in order:
 * 1. Figure out how much power is genuinely spare: solar production minus
 *    everything else the home is using, with the EV's own current draw
 *    added back in (since it's already counted in homeLoadW).
 * 2. If the home battery is below its reserve target and currently
 *    charging, that power is claimed first -- it doesn't count as spare
 *    for the EV.
 * 3. Convert whatever's left to an amp value Tesla's API understands, and
 *    clamp it to the vehicle's supported charging range.
 * 4. Decide start/stop/adjust based on that value versus the vehicle's
 *    current state, with a small hysteresis band so it doesn't thrash
 *    charging current up and down by 1A every reading.
 */
export function decideChargingAction(
    reading: SolarReading,
    vehicle: VehicleChargingStatus,
    config: AppConfig
  ): ChargingDecision {
    const evDrawW = estimateEvDrawW(vehicle, config);
    const rawSurplusW = reading.solarProductionW - reading.homeLoadW + evDrawW;

  const batteryBelowReserve = reading.batterySocPercent < config.batteryReserveSocPercent;
    const batteryClaimW = batteryBelowReserve && reading.batteryPowerW > 0 ? reading.batteryPowerW : 0;

  const availableForEvW = rawSurplusW - batteryClaimW;

  if (!vehicle.plugged_in) {
        return { action: "noop", reason: "Vehicle is not plugged in." };
  }

  if (availableForEvW < config.surplusBufferW + MIN_CHARGING_AMPS * config.assumedVoltageV) {
        if (vehicle.charging_state === "Charging") {
                return {
                          action: "stop",
                          reason: `Available surplus (${Math.round(availableForEvW)}W) is below the minimum charging threshold; stopping to avoid drawing from the grid or the reserved battery.`,
                };
        }
        return {
                action: "noop",
                reason: `Available surplus (${Math.round(availableForEvW)}W) is below the minimum charging threshold; nothing to do.`,
        };
  }

  const rawAmps = Math.floor(availableForEvW / config.assumedVoltageV);
    const targetAmps = Math.min(MAX_CHARGING_AMPS, Math.max(MIN_CHARGING_AMPS, rawAmps));

  if (vehicle.charging_state !== "Charging") {
        return {
                action: "start",
                amps: targetAmps,
                reason: `${Math.round(availableForEvW)}W available; starting charge at ${targetAmps}A.`,
        };
  }

  const currentAmps = Math.round(vehicle.charging_current);
    if (Math.abs(targetAmps - currentAmps) < AMPS_CHANGE_HYSTERESIS) {
          return {
                  action: "noop",
                  reason: `Target (${targetAmps}A) is close enough to current (${currentAmps}A); leaving as is.`,
          };
    }

  return {
        action: "set_amps",
        amps: targetAmps,
        reason: `${Math.round(availableForEvW)}W available; adjusting from ${currentAmps}A to ${targetAmps}A.`,
  };
}
