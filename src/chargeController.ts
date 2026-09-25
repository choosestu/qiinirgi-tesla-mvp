// Session-based solar charging controller, fed a Sungrow reading every poll.
//
// Goal: charge the car from solar surplus with as few (billed) Tesla calls
// as possible. Brett's home battery absorbs short cloud dips, so instead of
// following the sun amp-by-amp this runs charging "sessions":
//
//  - Idle: no Tesla calls at all. Watch the non-EV surplus from Sungrow.
//    When its average over START_SUSTAIN_MS supports at least
//    MIN_SESSION_AMPS, that's an opportunity: read the car once (waking it
//    if asleep) and start at the rate the surplus supports. If the car is
//    unplugged/full, don't look again for UNAVAILABLE_RECHECK_MS.
//  - Charging: hold a steady rate. While the home battery is at/above the
//    floor (BATTERY_RESERVE_SOC_PERCENT), it covers dips, so the rate only
//    follows the ADJUST_WINDOW_MS average, and only when it moves by
//    AMPS_DEADBAND or more, at most every MIN_ADJUST_INTERVAL_MS. Below the
//    floor the battery gets priority: the car only gets what the surplus
//    alone supports, and stops if that's under MIN_SESSION_AMPS.
//  - The car's draw shows up in Sungrow's home load, so a session is only
//    re-confirmed with Tesla when that draw disappears (car full, unplugged
//    or stopped by hand) or every SESSION_CONFIRM_MS as a backstop.
//
// Charging at MIN_SESSION_AMPS (8 A) or more rather than trickling at 5 A
// matters: the car spends a roughly fixed few hundred watts just being awake
// while charging, which is ~25% of a 5 A charge but ~8% of a 16 A one.

import type { AppConfig } from "./config";
import type { ChargingDecision, SolarReading } from "./solar";
import { CHARGING_DRY_RUN, executeChargingAction, type CommandResult } from "./chargeCommands";
import { getCachedVehicle, readVehicle } from "./vehicleState";
import { MAX_CHARGING_AMPS, wakeVehicle, type VehicleChargingStatus } from "./tesla";

const MIN = 60 * 1000;
const envMs = (name: string, fallbackMs: number) => Number(process.env[name]) || fallbackMs;

const MIN_SESSION_AMPS = Number(process.env.CHARGE_MIN_SESSION_AMPS) || 8;
const AMPS_DEADBAND = 2;
const START_SUSTAIN_MS = envMs("CHARGE_START_SUSTAIN_MS", 10 * MIN);
const ADJUST_WINDOW_MS = envMs("CHARGE_ADJUST_WINDOW_MS", 20 * MIN);
const MIN_ADJUST_INTERVAL_MS = envMs("CHARGE_MIN_ADJUST_INTERVAL_MS", 15 * MIN);
const RESTART_COOLDOWN_MS = envMs("CHARGE_RESTART_COOLDOWN_MS", 15 * MIN);
const UNAVAILABLE_RECHECK_MS = envMs("CHARGE_UNAVAILABLE_RECHECK_MS", 45 * MIN);
const SESSION_CONFIRM_MS = envMs("CHARGE_SESSION_CONFIRM_MS", 60 * MIN);
const WAKE_RETRY_MS = 1 * MIN;
const MAX_WAKES_PER_DAY = Number(process.env.CHARGE_MAX_WAKES_PER_DAY) || 2;
const UNPLUGGED_AFTER_WAKE_RECHECK_MS = envMs("CHARGE_UNPLUGGED_AFTER_WAKE_RECHECK_MS", 3 * 60 * MIN);
const LOW_DRAW_CONFIRM_MS = 5 * MIN;
const LOW_DRAW_MIN_CONFIRM_INTERVAL_MS = 30 * MIN;

interface Sample {
  t: number;
  /** Power the car could take without drawing from the grid or a below-floor battery, W. */
  availableW: number;
}

type Mode = "idle" | "charging";

const state = {
  samples: [] as Sample[],
  mode: "idle" as Mode,
  sessionAmps: 0,
  sessionStartedAt: 0,
  lastCommandAt: 0,
  lastStopAt: 0,
  lastConfirmAt: 0,
  /** Don't read the car again before this (unplugged / full / asleep backoff). */
  nextVehicleCheckAt: 0,
  wakeRequestedAt: 0,
  wakesDay: "",
  wakesToday: 0,
  lowDrawSince: null as number | null,
  lastLoggedKey: "",
};

export interface ControllerResult {
  decision: ChargingDecision;
  commandResult?: CommandResult;
}

/** The EV's own draw as it appears in Sungrow's home load, W. */
function estimatedEvDrawW(config: AppConfig): number {
  if (CHARGING_DRY_RUN) {
    // Commands aren't applied, so the car only draws if it was charging for
    // some other reason when last read.
    const v = getCachedVehicle()?.vehicle;
    return v && v.charging_state === "Charging" ? v.charging_current * config.assumedVoltageV : 0;
  }
  return state.mode === "charging" ? state.sessionAmps * config.assumedVoltageV : 0;
}

/**
 * Surplus the car could use: solar minus non-EV home load. If the home
 * battery is below the floor, whatever it's currently charging at is
 * reserved for it (and if that's unknown, assume it needs everything).
 */
function availableForEvW(reading: SolarReading, config: AppConfig, evDrawW: number): number {
  const surplusW = reading.solarProductionW - (reading.homeLoadW - evDrawW);
  if (reading.batterySocPercent >= config.batteryReserveSocPercent) return surplusW;
  if (reading.batteryPowerW === null) return 0;
  return surplusW - Math.max(reading.batteryPowerW, 0);
}

function average(since: number): { avgW: number; coversWindow: boolean } | null {
  const window = state.samples.filter((s) => s.t >= since);
  if (window.length === 0) return null;
  const avgW = window.reduce((sum, s) => sum + s.availableW, 0) / window.length;
  return { avgW, coversWindow: state.samples[0].t <= since };
}

function ampsFor(watts: number, config: AppConfig): number {
  return Math.floor(watts / config.assumedVoltageV);
}

function clampAmps(amps: number): number {
  return Math.min(MAX_CHARGING_AMPS, Math.max(MIN_SESSION_AMPS, amps));
}

function time(ms: number): string {
  // Brett's car is in AEST (UTC+10).
  return new Date(ms + 10 * 60 * MIN).toISOString().slice(11, 16) + " AEST";
}

function aestDate(ms: number): string {
  return new Date(ms + 10 * 60 * MIN).toISOString().slice(0, 10);
}

function noop(reason: string): ControllerResult {
  return { decision: { action: "noop", reason } };
}

async function act(config: AppConfig, decision: ChargingDecision, now: number): Promise<ControllerResult> {
  const commandResult = await executeChargingAction(config, decision);
  state.lastCommandAt = now;
  if (decision.action === "start") {
    state.mode = "charging";
    state.sessionAmps = decision.amps ?? MIN_SESSION_AMPS;
    state.sessionStartedAt = now;
    state.lastConfirmAt = now;
    state.lowDrawSince = null;
  } else if (decision.action === "set_amps") {
    state.sessionAmps = decision.amps ?? state.sessionAmps;
  } else if (decision.action === "stop") {
    state.mode = "idle";
    state.lastStopAt = now;
  }
  return { decision, commandResult };
}

/** Treats a car that has stopped charging (full, unplugged, stopped by hand) as ending the session. */
function endSessionFromVehicle(vehicle: VehicleChargingStatus, now: number): void {
  state.mode = "idle";
  state.lastStopAt = now;
  if (!vehicle.plugged_in || vehicle.charging_state === "Complete" || vehicle.state_of_charge >= vehicle.charging_limit) {
    state.nextVehicleCheckAt = now + UNAVAILABLE_RECHECK_MS;
  }
}

async function handleIdle(config: AppConfig, now: number): Promise<ControllerResult> {
  const startThresholdW = MIN_SESSION_AMPS * config.assumedVoltageV + config.surplusBufferW;
  if (now < state.lastStopAt + RESTART_COOLDOWN_MS) {
    return noop(`Idle; cooling down after the last stop until ${time(state.lastStopAt + RESTART_COOLDOWN_MS)}.`);
  }
  const avg = average(now - START_SUSTAIN_MS);
  if (!avg || !avg.coversWindow || avg.avgW < startThresholdW) {
    const avgText = avg ? `${Math.round(avg.avgW)}W` : "n/a";
    return noop(
      `Idle; ${START_SUSTAIN_MS / MIN}-min average surplus ${avgText}` +
        `${avg && !avg.coversWindow ? " (still collecting)" : ""}, start needs ${startThresholdW}W sustained. No Tesla call.`
    );
  }
  if (now < state.nextVehicleCheckAt) {
    return noop(
      `Surplus ${Math.round(avg.avgW)}W could charge the car, but it was unavailable at the last check; ` +
        `not checking again until ${time(state.nextVehicleCheckAt)}.`
    );
  }

  let vehicle: VehicleChargingStatus;
  try {
    vehicle = await readVehicle(config, `surplus ${Math.round(avg.avgW)}W sustained ${START_SUSTAIN_MS / MIN} min, charging opportunity`);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const asleep = /asleep|offline|408/.test(message);
    // An asleep car might not even be at home, so wakes are capped per day
    // (they cost $0.02 each, 10x a read, and drain the car's battery).
    const today = aestDate(now);
    if (state.wakesDay !== today) {
      state.wakesDay = today;
      state.wakesToday = 0;
    }
    if (asleep && state.wakesToday >= MAX_WAKES_PER_DAY) {
      state.nextVehicleCheckAt = now + UNAVAILABLE_RECHECK_MS;
      return noop(
        `Charging opportunity, but the car is asleep and today's ${MAX_WAKES_PER_DAY}-wake limit is used; ` +
          `reading again (no wake) at ${time(state.nextVehicleCheckAt)}.`
      );
    }
    if (asleep && now - state.wakeRequestedAt > UNAVAILABLE_RECHECK_MS) {
      state.wakeRequestedAt = now;
      state.wakesToday += 1;
      state.nextVehicleCheckAt = now + WAKE_RETRY_MS;
      if (CHARGING_DRY_RUN) {
        // Plugged-in Teslas sleep when not charging, so assume it's plugged in
        // and carry on, so the dry-run log shows what a live session would do.
        console.log("[charging] DRY RUN: car is asleep; would have woken it. No wake sent; assuming it's plugged in.");
        const amps = clampAmps(ampsFor(avg.avgW - config.surplusBufferW, config));
        return act(config, {
          action: "start",
          amps,
          reason: `${Math.round(avg.avgW)}W surplus sustained ${START_SUSTAIN_MS / MIN} min; starting at ${amps}A (after a wake).`,
        }, now);
      }
      try {
        await wakeVehicle(config);
        return noop("Charging opportunity; car was asleep, wake requested. Re-checking in 1 min.");
      } catch (wakeErr) {
        console.error("[charging] Wake failed:", wakeErr instanceof Error ? wakeErr.message : wakeErr);
      }
    }
    state.nextVehicleCheckAt = now + UNAVAILABLE_RECHECK_MS;
    return noop(`Charging opportunity, but the car couldn't be read (${message}); retrying at ${time(state.nextVehicleCheckAt)}.`);
  }

  if (!vehicle.plugged_in) {
    // If we just woke it to find out, it's likely away or not coming back
    // soon: back off longer so we don't keep paying to wake it.
    const wokeForThis = now - state.wakeRequestedAt <= 5 * MIN;
    state.nextVehicleCheckAt = now + (wokeForThis ? UNPLUGGED_AFTER_WAKE_RECHECK_MS : UNAVAILABLE_RECHECK_MS);
    return noop(`Charging opportunity, but the car isn't plugged in; next check ${time(state.nextVehicleCheckAt)}.`);
  }
  if (vehicle.charging_state === "Complete" || vehicle.state_of_charge >= vehicle.charging_limit) {
    state.nextVehicleCheckAt = now + UNAVAILABLE_RECHECK_MS;
    return noop(`Car is at its charge limit (${vehicle.state_of_charge}% / ${vehicle.charging_limit}%); next check ${time(state.nextVehicleCheckAt)}.`);
  }
  if (vehicle.charging_state === "Charging") {
    // Already charging (started by hand or by a schedule): take over the session at its current rate.
    state.mode = "charging";
    state.sessionAmps = Math.round(vehicle.charging_current);
    state.sessionStartedAt = now;
    state.lastConfirmAt = now;
    state.lastCommandAt = now;
    return noop(`Car is already charging at ${state.sessionAmps}A; taking over the session.`);
  }

  const amps = clampAmps(ampsFor(avg.avgW - config.surplusBufferW, config));
  return act(config, { action: "start", amps, reason: `${Math.round(avg.avgW)}W surplus sustained ${START_SUSTAIN_MS / MIN} min; starting at ${amps}A.` }, now);
}

async function handleCharging(config: AppConfig, reading: SolarReading, now: number): Promise<ControllerResult> {
  const floor = config.batteryReserveSocPercent;

  // Is the car still drawing? Its draw appears in home load; if load falls
  // well below what we set for 5+ min, the car probably finished or was
  // unplugged -- confirm with one read. Also re-confirm hourly regardless.
  // In dry run no command reaches the car, so the session is only simulated
  // and there's nothing to confirm.
  const expectedDrawW = state.sessionAmps * config.assumedVoltageV;
  if (!CHARGING_DRY_RUN && reading.homeLoadW < expectedDrawW * 0.5) {
    state.lowDrawSince ??= now;
  } else {
    state.lowDrawSince = null;
  }
  const lowDrawSustained =
    state.lowDrawSince !== null &&
    now - state.lowDrawSince >= LOW_DRAW_CONFIRM_MS &&
    now - state.lastConfirmAt >= LOW_DRAW_MIN_CONFIRM_INTERVAL_MS;
  const confirmDue = !CHARGING_DRY_RUN && now - state.lastConfirmAt >= SESSION_CONFIRM_MS;
  if (lowDrawSustained || confirmDue) {
    state.lastConfirmAt = now;
    try {
      const vehicle = await readVehicle(
        config,
        lowDrawSustained
          ? `home load ${Math.round(reading.homeLoadW)}W is below the car's expected ${expectedDrawW}W draw, confirming it's still charging`
          : `hourly session check`
      );
      if (vehicle.charging_state !== "Charging") {
        endSessionFromVehicle(vehicle, now);
        return noop(`Car is no longer charging (${vehicle.charging_state}); session ended.`);
      }
      state.sessionAmps = Math.round(vehicle.charging_current) || state.sessionAmps;
    } catch (err) {
      // Asleep/offline means it isn't charging.
      state.mode = "idle";
      state.lastStopAt = now;
      state.nextVehicleCheckAt = now + UNAVAILABLE_RECHECK_MS;
      return noop(`Couldn't confirm the session (${err instanceof Error ? err.message : err}); treating it as ended.`);
    }
  }

  if (reading.batterySocPercent < floor) {
    // Battery below floor gets priority; the car only gets surplus beyond it.
    const avg = average(now - START_SUSTAIN_MS);
    const supported = avg ? ampsFor(avg.avgW - config.surplusBufferW, config) : 0;
    if (supported < MIN_SESSION_AMPS) {
      return act(config, {
        action: "stop",
        reason: `Home battery ${reading.batterySocPercent.toFixed(1)}% is below the ${floor}% floor and surplus alone supports only ${Math.max(supported, 0)}A; stopping.`,
      }, now);
    }
    if (supported < state.sessionAmps) {
      return act(config, {
        action: "set_amps",
        amps: supported,
        reason: `Home battery below the ${floor}% floor; lowering to the ${supported}A surplus alone supports.`,
      }, now);
    }
    return noop(`Charging at ${state.sessionAmps}A; home battery below floor but surplus covers it.`);
  }

  // Battery at/above floor: it buffers dips, so follow only the longer average.
  const avg = average(now - ADJUST_WINDOW_MS);
  if (!avg) return noop(`Charging at ${state.sessionAmps}A.`);
  const target = clampAmps(ampsFor(avg.avgW - config.surplusBufferW, config));
  const sinceCommandMs = now - state.lastCommandAt;
  if (Math.abs(target - state.sessionAmps) >= AMPS_DEADBAND && sinceCommandMs >= MIN_ADJUST_INTERVAL_MS) {
    return act(config, {
      action: "set_amps",
      amps: target,
      reason: `${ADJUST_WINDOW_MS / MIN}-min average surplus ${Math.round(avg.avgW)}W; adjusting from ${state.sessionAmps}A to ${target}A.`,
    }, now);
  }
  return noop(
    `Charging at ${state.sessionAmps}A (target ${target}A from ${Math.round(avg.avgW)}W ${ADJUST_WINDOW_MS / MIN}-min average); ` +
      `home battery ${reading.batterySocPercent.toFixed(1)}% covers dips. No Tesla call.`
  );
}

/** Runs one controller step for a fresh Sungrow reading. */
export async function onSolarReading(config: AppConfig, reading: SolarReading): Promise<ControllerResult> {
  const now = Date.now();
  const evDrawW = estimatedEvDrawW(config);
  state.samples.push({ t: now, availableW: availableForEvW(reading, config, evDrawW) });
  const keepSince = now - Math.max(START_SUSTAIN_MS, ADJUST_WINDOW_MS);
  while (state.samples.length > 0 && state.samples[0].t < keepSince) state.samples.shift();

  const result = state.mode === "charging" ? await handleCharging(config, reading, now) : await handleIdle(config, now);

  // Log on actions, and otherwise only when the Sungrow data or the kind of
  // decision changes, so a 15 s poll doesn't repeat the same line 20 times
  // between Sungrow's ~5-minute refreshes.
  const key =
    `${reading.solarProductionW}|${reading.homeLoadW}|${reading.batterySocPercent}|` +
    result.decision.reason.replace(/-?\d+(\.\d+)?W/g, "#W");
  if (result.decision.action !== "noop" || key !== state.lastLoggedKey) {
    console.log(
      `[charge] ${reading.solarProductionW}W solar, ${reading.homeLoadW}W load, ` +
        `${reading.batterySocPercent.toFixed(1)}% battery -> ${result.decision.action}: ${result.decision.reason}`
    );
    state.lastLoggedKey = key;
  }
  return result;
}
