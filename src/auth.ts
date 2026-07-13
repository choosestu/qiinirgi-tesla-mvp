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

export const TOKENS_FILE = path.resolve(process.cwd(), "tokens.json");

// In-memory store of issued state values (CSRF protection).
// Fine for a single-instance MVP; states expire after 10 minutes.
const pendingStates = new Map<string, number>();
const STATE_TTL_MS = 10 * 60 * 1000;

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

/** Persists tokens to tokens.json in the project root. */
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
  } catch (err) {
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
  } catch {
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

/** Reads tokens.json and reports authentication status without exposing tokens. */
export async function getAuthStatus(): Promise<AuthStatus> {
  let raw: string;
  try {
    raw = await (await import("node:fs/promises")).readFile(TOKENS_FILE, "utf8");
  } catch {
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
      ? "Access token has expired. Token refresh is not implemented yet (milestone 3); re-authenticate at /login."
      : "Authenticated. Access token is valid.",
  };
}
