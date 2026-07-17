// Tesla Fleet API OAuth 2.0 Authorization Code Flow.
// Docs: https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens

import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";

/** Scopes requested from the user. offline_access is required for a refresh token. */
const SCOPES = [
    "openid",
    "offline_access",
    "vehicle_device_data",
    "vehicle_charging_cmds",
  ].join(" ");

/**
 * How much time before the recorded expiry we treat an access token as
 * "expired" and proactively refresh it. This avoids a race where a token
 * is valid when checked but expires mid-request.
 */
const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Response body from Tesla's /oauth2/v3/token endpoint. */
export interface TeslaTokenResponse {
    access_token: string;
    refresh_token: string;
    id_token?: string;
    token_type: string;
    expires_in: number;
}

/** Shape persisted to tokens.json. */
export interface StoredTokens {
    access_token: string;
    refresh_token: string;
    token_type: string;
    expires_in: number;
    obtained_at: string; // ISO timestamp
}

export class OAuthError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
          super(message);
          this.name = "OAuthError";
    }
}

/**
 * Directory tokens.json is stored in. Defaults to the working directory,
 * which on most container platforms (including Railway without an attached
 * Volume) is ephemeral and can be reset on restart, redeploy, or a
 * scale-to-zero event, silently losing the stored tokens.
 *
 * Set TOKENS_DIR to the mount path of a persistent Volume (e.g. "/data")
 * to survive restarts. Falls back to process.cwd() for local dev.
 */
const TOKENS_DIR =
    process.env.TOKENS_DIR && process.env.TOKENS_DIR.trim() !== ""
    ? process.env.TOKENS_DIR.trim()
      : process.cwd();

export const TOKENS_FILE = path.resolve(TOKENS_DIR, "tokens.json");

// In-memory store of issued state values (CSRF protection).
// Fine for a single-instance MVP; states expire after STATE_TTL_MS.
// Widened from an earlier 10-minute window: a real user going through
// Tesla's login (which may require 2FA or an email verification code)
// can easily take longer than 10 minutes, causing a legitimate login
// attempt to fail with "invalid_state" through no fault of their own.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 30 * 60 * 1000;

/** Generates a random state value and remembers it for later validation. */
export function createState(): string {
    const state = randomBytes(24).toString("hex");
    pendingStates.set(state, Date.now() + STATE_TTL_MS);
    return state;
}

/** Validates and consumes a state value returned by Tesla. */
export function consumeState(state: string): boolean {
    const expiry = pendingStates.get(state);
    pendingStates.delete(state);
    return expiry !== undefined && expiry > Date.now();
}

/** Builds the Tesla authorization URL the browser should be redirected to. */
export function buildAuthorizeUrl(config: AppConfig, state: string): string {
    const url = new URL("/oauth2/v3/authorize", config.teslaAuthBase);
    url.search = new URLSearchParams({
          response_type: "code",
          client_id: config.teslaClientId,
          redirect_uri: config.teslaRedirectUri,
          scope: SCOPES,
          state,
    }).toString();
    return url.toString();
}

function isTokenResponse(value: unknown): value is TeslaTokenResponse {
    const v = value as TeslaTokenResponse;
    return (
          typeof v === "object" &&
          v !== null &&
          typeof v.access_token === "string" &&
          typeof v.refresh_token === "string"
        );
}

/**
 * Exchanges an authorization code for access and refresh tokens.
 * Per Tesla docs, this call must go to the fleet-auth domain and include
 * a Fleet API base URL as the `audience`.
 */
export async function exchangeCodeForTokens(
    config: AppConfig,
    code: string
  ): Promise<TeslaTokenResponse> {
    const url = new URL("/oauth2/v3/token", config.teslaTokenBase);

  let response: Response;
    try {
          response = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                            grant_type: "authorization_code",
                            client_id: config.teslaClientId,
                            client_secret: config.teslaClientSecret,
                            code,
                            audience: config.teslaApiBase,
                            redirect_uri: config.teslaRedirectUri,
                  }),
          });
    } catch (err) {
          throw new OAuthError(
                  `Could not reach Tesla token endpoint at ${url.host}. Check your network connection.`,
                  err
                );
    }

  const bodyText = await response.text();

  if (!response.ok) {
        throw new OAuthError(
                `Tesla token exchange failed (HTTP ${response.status}). ` +
                  `A common cause is an expired authorization code (invalid_auth_code). Response: ${bodyText}`
              );
  }

  let body: unknown;
    try {
          body = JSON.parse(bodyText);
    } catch {
          throw new OAuthError(`Tesla token endpoint returned non-JSON response: ${bodyText}`);
    }

  if (!isTokenResponse(body)) {
        throw new OAuthError(
                `Tesla token response is missing access_token or refresh_token. ` +
                  `Ensure the offline_access scope was granted. Response: ${bodyText}`
              );
  }

  return body;
}

/**
 * Exchanges a stored refresh token for a new access token (and a new refresh
 * token, which Tesla rotates on every use).
 *
 * Per Tesla docs, the refresh grant does NOT take client_secret or audience,
 * only grant_type, client_id, and refresh_token:
 * https://developer.tesla.com/docs/fleet-api/authentication/third-party-tokens#refresh-tokens
 *
 * Tesla keeps the immediately-prior refresh token valid for up to 24 hours
 * as a safety net, but the new refresh_token returned here must be persisted
 * so the *next* refresh has a token to use.
 */
export async function refreshTokens(
    config: AppConfig,
    refreshToken: string
  ): Promise<TeslaTokenResponse> {
    const url = new URL("/oauth2/v3/token", config.teslaTokenBase);

  let response: Response;
    try {
          response = await fetch(url, {
                  method: "POST",
                  headers: { "Content-Type": "application/x-www-form-urlencoded" },
                  body: new URLSearchParams({
                            grant_type: "refresh_token",
                            client_id: config.teslaClientId,
                            refresh_token: refreshToken,
                  }),
          });
    } catch (err) {
          throw new OAuthError(
                  `Could not reach Tesla token endpoint at ${url.host} to refresh tokens. Check your network connection.`,
                  err
                );
    }

  const bodyText = await response.text();

  if (!response.ok) {
        // Per Tesla docs, a 401 login_required here means the refresh token is
      // expired/cycled out, or the user changed their Tesla password. Either
      // way, the only fix is a fresh /login.
      throw new OAuthError(
              `Tesla token refresh failed (HTTP ${response.status}). ` +
                `If this is a 401, the refresh token is no longer valid and someone must ` +
                `re-authenticate at /login. Response: ${bodyText}`
            );
  }

  let body: unknown;
    try {
          body = JSON.parse(bodyText);
    } catch {
          throw new OAuthError(
                  `Tesla token endpoint returned non-JSON response during refresh: ${bodyText}`
                );
    }

  if (!isTokenResponse(body)) {
        throw new OAuthError(
                `Tesla refresh response is missing access_token or refresh_token. Response: ${bodyText}`
              );
  }

  return body;
}

/** Persists tokens to tokens.json in TOKENS_DIR. */
export async function saveTokens(tokens: TeslaTokenResponse): Promise<void> {
    const stored: StoredTokens = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          token_type: tokens.token_type,
          expires_in: tokens.expires_in,
          obtained_at: new Date().toISOString(),
    };
    try {
          await writeFile(TOKENS_FILE, JSON.stringify(stored, null, 2) + "\n", "utf8");
          // Deliberately logged: this is the one line of evidence that a save
      // actually happened, so a future "why did my tokens disappear" can be
      // answered by checking whether this line exists in Deploy Logs at all.
      console.log(
              `[auth] Tokens saved to ${TOKENS_FILE} (obtained_at=${stored.obtained_at}, expires_in=${stored.expires_in}s)`
            );
    } catch (err) {
          console.error(`[auth] Failed to write tokens to ${TOKENS_FILE}:`, err);
          throw new OAuthError(`Failed to write ${TOKENS_FILE}: ${(err as Error).message}`, err);
    }
}

/** Status of stored tokens, safe to expose (never includes token values). */
export interface AuthStatus {
    authenticated: boolean;
    obtained_at?: string;
    expires_at?: string;
    access_token_expired?: boolean;
    message: string;
}

/** Reads and validates tokens from tokens.json. */
export async function loadStoredTokens(): Promise<StoredTokens> {
    let raw: string;
    try {
          raw = await (await import("node:fs/promises")).readFile(TOKENS_FILE, "utf8");
    } catch (err) {
          // ENOENT (file genuinely doesn't exist, e.g. never authenticated, or the
      // volume was reset) is the expected case. Anything else -- permissions,
      // a transient disk error, etc. -- gets logged so it isn't silently
      // indistinguishable from "just never logged in."
      const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
                  console.error(`[auth] Unexpected error reading ${TOKENS_FILE}:`, err);
          }
          throw new OAuthError(
                  `No tokens.json found at ${TOKENS_FILE}. Authenticate at /login first.`
                );
    }

  let stored: StoredTokens;
    try {
          stored = JSON.parse(raw) as StoredTokens;
          if (
                  typeof stored.access_token !== "string" ||
                  typeof stored.token_type !== "string" ||
                  typeof stored.obtained_at !== "string"
                ) {
                  throw new Error("missing fields");
          }
    } catch (err) {
          throw new OAuthError(
                  "tokens.json exists but is invalid. Re-authenticate at /login.",
                  err
                );
    }

  return stored;
}

/** True if the stored token is expired, or close enough to expiry to refresh proactively. */
function isExpiringSoon(stored: StoredTokens): boolean {
    const obtained = new Date(stored.obtained_at).getTime();
    const expiresAt = obtained + stored.expires_in * 1000;
    return Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Returns a valid access token + token type for calling the Fleet API,
 * transparently refreshing via the stored refresh token if the current
 * access token is expired or about to expire. Callers (tesla.ts) should
 * use this instead of reading tokens.json directly, so token expiry is
 * never their problem.
 *
 * Throws OAuthError if there are no stored tokens, or if the refresh
 * token itself has been rejected (expired, cycled out, or the user
 * changed their Tesla password) -- in which case a human needs to hit
 * /login again.
 */
export async function getValidAccessToken(
    config: AppConfig
  ): Promise<{ access_token: string; token_type: string }> {
    const stored = await loadStoredTokens();

  if (!isExpiringSoon(stored)) {
        return { access_token: stored.access_token, token_type: stored.token_type };
  }

  const refreshed = await refreshTokens(config, stored.refresh_token);
    await saveTokens(refreshed);
    return { access_token: refreshed.access_token, token_type: refreshed.token_type };
}

/** Reads tokens.json and reports authentication status without exposing tokens. */
export async function getAuthStatus(): Promise<AuthStatus> {
    let raw: string;
    try {
          raw = await (await import("node:fs/promises")).readFile(TOKENS_FILE, "utf8");
    } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
                  console.error(`[auth] Unexpected error reading ${TOKENS_FILE} in getAuthStatus:`, err);
          }
          return {
                  authenticated: false,
                  message: "No tokens.json found. Authenticate at /login.",
          };
    }

  let stored: StoredTokens;
    try {
          stored = JSON.parse(raw) as StoredTokens;
          if (typeof stored.access_token !== "string" || typeof stored.obtained_at !== "string") {
                  throw new Error("missing fields");
          }
    } catch {
          return {
                  authenticated: false,
                  message: "tokens.json exists but is invalid. Re-authenticate at /login.",
          };
    }

  const obtained = new Date(stored.obtained_at).getTime();
    const expiresAt = new Date(obtained + stored.expires_in * 1000);
    const expired = Date.now() >= expiresAt.getTime();

  return {
        authenticated: true,
        obtained_at: stored.obtained_at,
        expires_at: expiresAt.toISOString(),
        access_token_expired: expired,
        message: expired
          ? "Access token has expired. It will be refreshed automatically the next time an API call is made (see getValidAccessToken)."
                : "Authenticated. Access token is valid.",
  };
}
