import "dotenv/config";
import express from "express";
import routes, { processSolarReading } from "./routes";
import { loadConfig } from "./config";
import { getRealtimeReading } from "./sungrow";

const app = express();

app.use(express.json());
app.use("/", routes);

const port = Number(process.env.PORT) || 3000;

app.listen(port, () => {
    console.log(`Server listening on http://localhost:${port}`);
});

/**
 * Polls iSolarCloud for a fresh reading and runs it through the same
 * decide-and-execute pipeline as POST /solar/reading (see routes.ts). This
 * is now the primary way readings arrive -- no local bridge hardware
 * required. Stays a quiet no-op, logging once per poll, until Sungrow
 * approves Brett's iSolarCloud app and the SUNGROW_* env vars are set.
 */
async function pollSungrow(): Promise<void> {
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

  try {
        const reading = await getRealtimeReading(config);
        const result = await processSolarReading(config, reading);
        console.log(
                `[sungrow-poll] ${reading.solarProductionW}W solar, ${reading.homeLoadW}W load, ` +
                  `${reading.batterySocPercent}% battery -> ${result.decision.action} (${result.decision.reason})`
              );
  } catch (err) {
        console.error("[sungrow-poll] Failed to poll/process reading:", err instanceof Error ? err.message : err);
  }
}

// Read the poll interval directly from env (mirrors config.ts's own default)
// rather than requiring a full loadConfig() at module scope, so the server
// can still start even if unrelated required Tesla env vars aren't set yet.
const pollIntervalMs = Number(process.env.SUNGROW_POLL_INTERVAL_MS) || 300000;
setInterval(() => {
    void pollSungrow();
}, pollIntervalMs);

// Also run one poll shortly after startup rather than waiting a full interval.
setTimeout(() => {
    void pollSungrow();
}, 5000);
