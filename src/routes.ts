import { Router, type Request, type Response } from "express";
import { loadConfig, ConfigError } from "./config";
import {
        buildAuthorizeUrl,
        consumeState,
        createState,
        exchangeCodeForTokens,
        getAuthStatus,
        saveTokens,
        OAuthError,
        TOKENS_FILE,
} from "./auth";
import {
        getVehicleChargingStatus,
        startCharging,
        stopCharging,
        setChargingAmps,
        MIN_CHARGING_AMPS,
        MAX_CHARGING_AMPS,
        TeslaApiError,
} from "./tesla";
import { TESLA_VIRTUAL_KEY_PUBLIC_PEM } from "./virtualKey";
import { decideChargingAction, type SolarReading } from "./solar";
import { getLatestSolarState, setLatestSolarState } from "./solarState";

const router = Router();

/** Health check. */
router.get("/", (_req, res) => {
        res.json({ status: "ok" });
});

/**
 * Serves this app's virtual key public key at the fixed path Tesla requires.
 * Must stay reachable indefinitely once registered (see scripts/register-partner-account.ts) --
 * Tesla vehicles and the Fleet API check this URL to validate the key.
 * Docs: https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide
 */
router.get("/.well-known/appspecific/com.tesla.3p.public-key.pem", (_req, res) => {
        res.type("application/x-pem-file").send(TESLA_VIRTUAL_KEY_PUBLIC_PEM);
});

/** Redirects the browser to Tesla's OAuth authorization page. */
router.get("/login", (_req: Request, res: Response) => {
        try {
                  const config = loadConfig();
                  const state = createState();
                  res.redirect(buildAuthorizeUrl(config, state));
        } catch (err) {
                  handleError(res, err);
        }
});

/**
 * OAuth callback: validates state, exchanges the authorization code
       * for tokens, and saves them to tokens.json.
 * Registered on both /callback and /auth/tesla/callback so it works
 * regardless of which path the configured redirect URI uses.
 */
async function callbackHandler(req: Request, res: Response): Promise<void> {
        try {
                  const { code, state, error, error_description } = req.query;

          if (typeof error === "string") {
                      res.status(400).json({
                                    error: "tesla_authorization_denied",
                                    message: `Tesla returned an error: ${error}${
                                                    typeof error_description === "string" ? ` (${error_description})` : ""
                                    }`,
                      });
                      return;
          }

          if (typeof code !== "string" || code === "") {
                      res.status(400).json({
                                    error: "missing_code",
                                    message: "No authorization code in callback. Start the flow at /login.",
                      });
                      return;
          }

          if (typeof state !== "string" || !consumeState(state)) {
                      res.status(400).json({
                                    error: "invalid_state",
                                    message: "State validation failed (missing, unknown, or expired). Start the flow again at /login.",
                      });
                      return;
          }

          const config = loadConfig();
                  const tokens = await exchangeCodeForTokens(config, code);
                  await saveTokens(tokens);

          res.json({
                      status: "authenticated",
                      message: `Tokens saved to ${TOKENS_FILE}`,
                      expires_in: tokens.expires_in,
          });
        } catch (err) {
                  handleError(res, err);
        }
}

/** Reports whether valid tokens are stored, without exposing token values. */
router.get("/auth/status", async (_req: Request, res: Response) => {
        try {
                  res.json(await getAuthStatus());
        } catch (err) {
                  handleError(res, err);
        }
});

/** Live charging status for the account's first vehicle (Fleet API vehicle_data). */
router.get("/vehicle", async (_req: Request, res: Response) => {
        try {
                  const config = loadConfig();
                  res.json(await getVehicleChargingStatus(config));
        } catch (err) {
                  handleError(res, err);
        }
});

/** Body accepted by POST /charge/current. */
interface SetCurrentRequestBody {
        amps: number;
}

function parseAmps(body: unknown): number | null {
        if (typeof body !== "object" || body === null) {
                  return null;
        }
        const amps = (body as Partial<SetCurrentRequestBody>).amps;
        if (
                  typeof amps !== "number" ||
                  !Number.isInteger(amps) ||
                  amps < MIN_CHARGING_AMPS ||
                  amps > MAX_CHARGING_AMPS
                ) {
                  return null;
        }
        return amps;
}

/** Starts charging the account's first vehicle. */
router.post("/charge/start", async (_req: Request, res: Response) => {
        try {
                  const config = loadConfig();
                  res.json(await startCharging(config));
        } catch (err) {
                  handleError(res, err);
        }
});

/** Stops charging the account's first vehicle. */
router.post("/charge/stop", async (_req: Request, res: Response) => {
        try {
                  const config = loadConfig();
                  res.json(await stopCharging(config));
        } catch (err) {
                  handleError(res, err);
        }
});

/** Sets the charging current. Body: { "amps": 16 } (integer, 5-32). */
router.post("/charge/current", async (req: Request, res: Response) => {
        try {
                  const amps = parseAmps(req.body);
                  if (amps === null) {
                              res.status(400).json({
                                            error: "invalid_amps",
                                            message: `Body must be JSON of the form {"amps": n} where n is an integer between ${MIN_CHARGING_AMPS} and ${MAX_CHARGING_AMPS}.`,
                              });
                              return;
                  }
                  const config = loadConfig();
                  res.json(await setChargingAmps(config, amps));
        } catch (err) {
                  handleError(res, err);
        }
});

/**
 * Checks the Bearer token on an incoming bridge request against the
 * configured LOCAL_BRIDGE_API_KEY. Returns false (refusing the request)
 * whenever no key is configured, since an unconfigured key means no local
 * bridge should be trusted yet.
 */
function isAuthorizedBridgeRequest(req: Request, config: ReturnType<typeof loadConfig>): boolean {
        if (!config.localBridgeApiKey) {
                  return false;
        }
        const header = req.header("authorization") ?? "";
        const [scheme, token] = header.split(" ");
        return scheme === "Bearer" && token === config.localBridgeApiKey;
}

/** Validates and normalizes the body accepted by POST /solar/reading. */
function parseSolarReading(body: unknown): SolarReading | null {
        if (typeof body !== "object" || body === null) {
                  return null;
        }
        const b = body as Record<string, unknown>;
        const { solarProductionW, homeLoadW, batterySocPercent, batteryPowerW, readingTakenAt } = b;
        if (
                  typeof solarProductionW !== "number" ||
                  typeof homeLoadW !== "number" ||
                  typeof batterySocPercent !== "number" ||
                  typeof batteryPowerW !== "number"
                ) {
                  return null;
        }
        return {
                  solarProductionW,
                  homeLoadW,
                  batterySocPercent,
                  batteryPowerW,
                  readingTakenAt: typeof readingTakenAt === "string" ? readingTakenAt : new Date().toISOString(),
        };
}

/**
 * Accepts a solar/battery reading from the local bridge, decides whether to
 * start/stop/adjust EV charging, executes that decision against the Tesla
 * API, and records the outcome so GET /solar/status can report it.
 */
router.post("/solar/reading", async (req: Request, res: Response) => {
        try {
                  const config = loadConfig();

          if (!isAuthorizedBridgeRequest(req, config)) {
                      res.status(401).json({
                                    error: "unauthorized",
                                    message: "Missing or invalid Bearer token. Set LOCAL_BRIDGE_API_KEY and send it as an Authorization header.",
                      });
                      return;
          }

          const reading = parseSolarReading(req.body);
                  if (reading === null) {
                              res.status(400).json({
                                            error: "invalid_reading",
                                            message:
                                                            "Body must include numeric solarProductionW, homeLoadW, batterySocPercent, and batteryPowerW.",
                              });
                              return;
                  }

          const vehicle = await getVehicleChargingStatus(config);
                  const decision = decideChargingAction(reading, vehicle, config);

          let commandResult: { ok: boolean; message: string } | undefined;
                  try {
                              if (decision.action === "start" && decision.amps !== undefined) {
                                            const outcome = await startCharging(config);
                                            await setChargingAmps(config, decision.amps);
                                            commandResult = { ok: outcome.result, message: outcome.reason };
                              } else if (decision.action === "stop") {
                                            const outcome = await stopCharging(config);
                                            commandResult = { ok: outcome.result, message: outcome.reason };
                              } else if (decision.action === "set_amps" && decision.amps !== undefined) {
                                            const outcome = await setChargingAmps(config, decision.amps);
                                            commandResult = { ok: outcome.result, message: outcome.reason };
                              }
                  } catch (commandErr) {
                              commandResult = {
                                            ok: false,
                                            message: commandErr instanceof Error ? commandErr.message : "Unknown error executing command.",
                              };
                  }

          setLatestSolarState({
                      reading,
                      decision,
                      decidedAt: new Date().toISOString(),
                      commandResult,
          });

          res.json({ reading, decision, commandResult });
        } catch (err) {
                  handleError(res, err);
        }
});

/** Reports the most recent solar reading and the decision made from it. */
router.get("/solar/status", (_req: Request, res: Response) => {
        const latest = getLatestSolarState();
        if (!latest) {
                  res.status(404).json({
                              error: "no_data",
                              message: "No solar reading has been received yet.",
                  });
                  return;
        }
        res.json(latest);
});

router.get("/callback", callbackHandler);
router.get("/auth/tesla/callback", callbackHandler);

function handleError(res: Response, err: unknown): void {
        if (err instanceof ConfigError) {
                  res.status(500).json({ error: "configuration_error", message: err.message });
        } else if (err instanceof OAuthError) {
                  res.status(502).json({ error: "oauth_error", message: err.message });
        } else if (err instanceof TeslaApiError) {
                  const status =
                              err.statusCode === 401
                      ? 401
                                : err.statusCode === 404
                      ? 404
                                : err.statusCode !== undefined && err.statusCode >= 400 && err.statusCode < 500
                                ? err.statusCode
                                : 502;
                  res.status(status).json({ error: "tesla_api_error", message: err.message });
        } else {
                  console.error("Unexpected error:", err);
                  res.status(500).json({
                              error: "internal_error",
                              message: "Unexpected server error. Check server logs for details.",
                  });
        }
}

export default router;
