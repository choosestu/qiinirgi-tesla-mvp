import "dotenv/config";
import express from "express";
import routes, { processSolarReading } from "./routes";
import { loadConfig, type AppConfig } from "./config";
import { getRealtimeReading } from "./sungrow";
import { decideChargingAction, type ChargingDecision, type SolarReading } from "./solar";
import { setLatestSolarState } from "./solarState";
import { getVehicleChargingStatus, type VehicleChargingStatus } from "./tesla";
import { DASHBOARD_HTML } from "./dashboardPage";

const app = express();

app.use(express.json());

// Lets Brett's phone dashboard, hosted at qiinirgi.lovable.app, read live
// status from this API even though it runs on a different web address.
app.use((req, res, next) => {
        res.setHeader("Access-Control-Allow-Origin", "https://qiinirgi.lovable.app");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
        if (req.method === "OPTIONS") {
                  res.sendStatus(204);
                  return;
        }
        next();
});
app.use("/", routes);

// Serves Brett's mobile-friendly live status page (see dashboardPage.ts).
app.get("/dashboard", (_req, res) => {
      res.type("html").send(DASHBOARD_HTML);
});

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});

// Last known Tesla state, so most Sungrow polls can run the charging decision
// against it without paying for a vehicle_data call. Tesla is only re-checked
// when the decision would change (see shouldCheckTesla) or the fallback
// interval has passed.
interface VehicleCache {
    vehicle: VehicleChargingStatus | null;
    /** Last Tesla call attempt, successful or not (failures back off too). */
    checkedAt: number;
    /** Decision (action + amps) made at the last Tesla check, for edge detection. */
    decisionKey: string | null;
}
let vehicleCache: VehicleCache | null = null;

const teslaFallbackCheckMs = Number(process.env.TESLA_FALLBACK_CHECK_INTERVAL_MS) || 300000;

function decisionKey(decision: ChargingDecision): string {
    return decision.amps !== undefined ? `${decision.action}@${decision.amps}A` : decision.action;
}

function describeSurplus(reading: SolarReading): string {
    return `surplus ${Math.round(reading.solarProductionW - reading.homeLoadW)}W`;
}

/**
 * Decides whether this poll needs a fresh Tesla vehicle_data call. Returns
 * the reason to check, or null to skip. The decision is re-run against the
 * cached vehicle state; Tesla is only called when that predicted decision is
 * actionable and differs from the one made at the last check (i.e. surplus
 * crossed the start threshold, dropped below the continue threshold, or the
 * target amps moved), or when the fallback interval has elapsed. Comparing
 * against the last decision (edge, not level) matters: while the charging
 * command isn't applied (dry run, car asleep), a level check would call Tesla
 * on every poll.
 */
function shouldCheckTesla(reading: SolarReading, config: AppConfig, now: number): string | null {
    if (!vehicleCache) {
          return "no known vehicle state yet";
    }
    const sinceLastMs = now - vehicleCache.checkedAt;
    if (sinceLastMs >= teslaFallbackCheckMs) {
          return `fallback: ${Math.round(sinceLastMs / 1000)}s since last Tesla check`;
    }
    if (!vehicleCache.vehicle) {
          // Last attempt failed (e.g. car asleep); wait for the fallback.
          return null;
    }
    const predicted = decideChargingAction(reading, vehicleCache.vehicle, config);
    if (predicted.action === "noop" || decisionKey(predicted) === vehicleCache.decisionKey) {
          return null;
    }
    if (predicted.action === "start") return `${describeSurplus(reading)} crossed start threshold`;
    if (predicted.action === "stop") return `${describeSurplus(reading)} dropped below continue threshold`;
    return `${describeSurplus(reading)} moved target to ${predicted.amps}A (from ${vehicleCache.vehicle.charging_current}A)`;
}

let pollInFlight = false;

/**
 * Polls iSolarCloud for a fresh reading every SUNGROW_POLL_INTERVAL_MS and
 * runs it through the same decide-and-execute pipeline as POST /solar/reading
 * (see routes.ts) -- but only calls Tesla when shouldCheckTesla says the
 * decision could change. Skipped polls still update the dashboard's solar
 * reading, with the decision predicted from the cached vehicle state.
 */
async function pollSungrow(): Promise<void> {
    if (pollInFlight) {
          return;
    }
    pollInFlight = true;
    try {
          await runPoll();
    } finally {
          pollInFlight = false;
    }
}

async function runPoll(): Promise<void> {
    let config;
    try {
          config = loadConfig();
    } catch (err) {
          console.error("[sungrow-poll] Config error, skipping this poll:", err instanceof Error ? err.message : err);
          return;
    }

  if (!config.sungrowAppKey || !config.sungrowAppSecret || !config.sungrowAppId || !config.sungrowRedirectUri) {
        console.log("[sungrow-poll] Sungrow iSolarCloud not configured yet (waiting on app approval); skipping.");
        return;
  }

  let reading: SolarReading;
    try {
          reading = await getRealtimeReading(config);
    } catch (err) {
          console.error("[sungrow-poll] Failed to poll Sungrow:", err instanceof Error ? err.message : err);
          return;
    }

  const now = Date.now();
    const checkReason = shouldCheckTesla(reading, config, now);
    if (checkReason === null) {
          const cached = vehicleCache?.vehicle;
          const why = cached ? "no threshold crossed" : "last Tesla check failed, waiting for fallback";
          console.log(
                  `[sungrow-poll] ${reading.solarProductionW}W solar, ${reading.homeLoadW}W load, ` +
                    `${reading.batterySocPercent}% battery; ${describeSurplus(reading)}, ${why}, skipping Tesla check`
                );
          if (cached) {
                  setLatestSolarState({
                            reading,
                            decision: decideChargingAction(reading, cached, config),
                            decidedAt: new Date(now).toISOString(),
                            commandResult: { ok: true, message: "Tesla check skipped; decision predicted from cached vehicle state." },
                  });
          }
          return;
    }

  console.log(`[sungrow-poll] ${checkReason}, checking Tesla`);
    try {
          const vehicle = await getVehicleChargingStatus(config);
          const result = await processSolarReading(config, reading, vehicle);
          vehicleCache = { vehicle, checkedAt: now, decisionKey: decisionKey(result.decision) };
          console.log(
                  `[sungrow-poll] ${reading.solarProductionW}W solar, ${reading.homeLoadW}W load, ` +
                    `${reading.batterySocPercent}% battery -> ${result.decision.action} (${result.decision.reason})`
                );
    } catch (err) {
          vehicleCache = { vehicle: null, checkedAt: now, decisionKey: null };
          console.error("[sungrow-poll] Failed to check Tesla/process reading:", err instanceof Error ? err.message : err);
    }
}

// Read the poll interval directly from env (mirrors config.ts's own default)
// rather than requiring a full loadConfig() at module scope, so the server
// can still start even if unrelated required Tesla env vars aren't set yet.
const pollIntervalMs = Number(process.env.SUNGROW_POLL_INTERVAL_MS) || 15000;
setInterval(() => {
    void pollSungrow();
}, pollIntervalMs);

// Also run one poll shortly after startup rather than waiting a full interval.
setTimeout(() => {
    void pollSungrow();
}, 5000);


// Exits immediately on the stop signal Railway sends during a routine
// redeploy, so the old container is reported as stopped rather than
// crashed. Without this, npm/node can be slow to shut down and Railway
// force-kills the process after a timeout, which it logs as a crash.
process.on("SIGTERM", () => {
        console.log("Received SIGTERM, shutting down.");
        process.exit(0);
});
process.on("SIGINT", () => {
        console.log("Received SIGINT, shutting down.");
        process.exit(0);
});
