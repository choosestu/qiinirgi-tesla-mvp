import "dotenv/config";
import express from "express";
import routes from "./routes";
import { loadConfig } from "./config";
import { getRealtimeReading } from "./sungrow";
import { setLatestSolarState } from "./solarState";
import { onSolarReading } from "./chargeController";
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

let pollInFlight = false;

/**
 * Polls iSolarCloud every SUNGROW_POLL_INTERVAL_MS (15 s by default) and
 * feeds each reading to the charge controller (chargeController.ts), which
 * decides when -- rarely -- the Tesla needs to be read or commanded. Every
 * poll updates the dashboard's solar reading.
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

  try {
        const reading = await getRealtimeReading(config);
        const { decision, commandResult } = await onSolarReading(config, reading);
        setLatestSolarState({ reading, decision, decidedAt: new Date().toISOString(), commandResult });
  } catch (err) {
        console.error("[sungrow-poll] Failed to poll/process reading:", err instanceof Error ? err.message : err);
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
