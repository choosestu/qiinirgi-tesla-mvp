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
import { getVehicleChargingStatus, TeslaApiError } from "./tesla";

const router = Router();

/** Health check. */
router.get("/", (_req, res) => {
  res.json({ status: "ok" });
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
