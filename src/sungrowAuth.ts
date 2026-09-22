// Sungrow iSolarCloud OpenAPI OAuth 2.0 flow.
// Docs: https://developer-api.isolarcloud.com/
//
// NOTE: unlike Tesla's flow (see auth.ts), iSolarCloud does not pass the
// `state` query parameter back on redirect, so there is no CSRF state
// round-trip here. Acceptable for a single-operator internal tool; do not
// copy this pattern for a multi-tenant service.

import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import type { AppConfig } from "./config";

export class SungrowAuthError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
          super(message);
          this.name = "SungrowAuthError";
    }
}

/** Per-region iSolarCloud API host and authorization-page details. */
export interface SungrowRegionInfo {
    apiHost: string;
    authHost: string;
    cloudId: number;
}

const REGIONS: Record<string, SungrowRegionInfo> = {
    China: { apiHost: "https://gateway.isolarcloud.com", authHost: "web3.isolarcloud.com", cloudId: 1 },
    International: { apiHost: "https://gateway.isolarcloud.com.hk", authHost: "web3.isolarcloud.com.hk", cloudId: 2 },
    Europe: { apiHost: "https://gateway.isolarcloud.eu", authHost: "web3.isolarcloud.eu", cloudId: 3 },
    Australia: { apiHost: "https://augateway.isolarcloud.com", authHost: "auweb3.isolarcloud.com", cloudId: 7 },
    India: { apiHost: "https://gateway.isolarcloud.in", authHost: "web3.isolarcloud.in", cloudId: 9 },
};

/** Resolves the configured SUNGROW_REGION to its API/auth host details. Defaults to Australia. */
export function getRegionInfo(config: AppConfig): SungrowRegionInfo {
    const region = config.sungrowRegion ?? "Australia";
    const info = REGIONS[region];
    if (!info) {
          throw new SungrowAuthError(
                  `Unknown SUNGROW_REGION "${region}". Must be one of: ${Object.keys(REGIONS).join(", ")}.`
                );
    }
    return info;
}

interface SungrowCredentials {
    appKey: string;
    appSecret: string;
    appId: string;
    redirectUri: string;
}

function requireCredentials(config: AppConfig): SungrowCredentials {
    if (!config.sungrowAppKey || !config.sungrowAppSecret || !config.sungrowAppId || !config.sungrowRedirectUri) {
          throw new SungrowAuthError(
                  "Sungrow iSolarCloud is not configured yet. Set SUNGROW_APP_KEY, SUNGROW_APP_SECRET, " +
                    "SUNGROW_APP_ID, and SUNGROW_REDIRECT_URI once the developer app is approved."
                );
    }
    return {
          appKey: config.sungrowAppKey,
          appSecret: config.sungrowAppSecret,
          appId: config.sungrowAppId,
          redirectUri: config.sungrowRedirectUri,
    };
}

/** Builds the iSolarCloud authorization page URL to send the browser to. */
export function buildAuthorizeUrl(config: AppConfig): string {
    const { appId, redirectUri } = requireCredentials(config);
    const { authHost, cloudId } = getRegionInfo(config);
    return `https://${authHost}/#/authorized-app?cloudId=${cloudId}&applicationId=${appId}&redirectUrl=${encodeURIComponent(
          redirectUri
        )}`;
}

interface SungrowTokenResponse {
    access_token: string;
    refresh_token: string;
    expires_in: number;
}

function isTokenResponse(value: unknown): value is SungrowTokenResponse {
    const v = value as SungrowTokenResponse;
    return (
          typeof v === "object" &&
          v !== null &&
          typeof v.access_token === "string" &&
          typeof v.refresh_token === "string"
        );
}

export interface StoredSungrowTokens {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    obtained_at: string;
}

const TOKENS_DIR =
    process.env.TOKENS_DIR && process.env.TOKENS_DIR.trim() !== ""
    ? process.env.TOKENS_DIR.trim()
      : process.cwd();

export const SUNGROW_TOKENS_FILE = path.resolve(TOKENS_DIR, "sungrow_tokens.json");

const EXPIRY_BUFFER_MS = 5 * 60 * 1000;

/** Exchanges an authorization code for access and refresh tokens. */
export async function exchangeCodeForTokens(config: AppConfig, code: string): Promise<SungrowTokenResponse> {
    const { appKey, appSecret, redirectUri } = requireCredentials(config);
    const { apiHost } = getRegionInfo(config);
    const url = new URL("/openapi/apiManage/token", apiHost);

  let response: Response;
    try {
          response = await fetch(url, {
                  method: "POST",
                  headers: { "x-access-key": appSecret, "Content-Type": "application/json" },
                  body: JSON.stringify({
                            appkey: appKey,
                            code,
                            grant_type: "authorization_code",
                            redirect_uri: redirectUri,
                  }),
          });
    } catch (err) {
          throw new SungrowAuthError(`Could not reach iSolarCloud token endpoint at ${url.host}.`, err);
    }

  const bodyText = await response.text();
    let body: unknown;
    try {
          body = JSON.parse(bodyText);
    } catch {
          throw new SungrowAuthError(`iSolarCloud token endpoint returned non-JSON response: ${bodyText}`);
    }

  if (!isTokenResponse(body)) {
        throw new SungrowAuthError(`iSolarCloud token exchange failed. Response: ${bodyText}`);
  }
    return body;
}

/** Refreshes a stored refresh token for a new access token (iSolarCloud rotates it on use). */
export async function refreshTokens(config: AppConfig, refreshToken: string): Promise<SungrowTokenResponse> {
    const { appKey, appSecret } = requireCredentials(config);
    const { apiHost } = getRegionInfo(config);
    const url = new URL("/openapi/apiManage/refreshToken", apiHost);

  let response: Response;
    try {
          response = await fetch(url, {
                  method: "POST",
                  headers: { "x-access-key": appSecret, "Content-Type": "application/json" },
                  body: JSON.stringify({ appkey: appKey, refresh_token: refreshToken }),
          });
    } catch (err) {
          throw new SungrowAuthError(
                  `Could not reach iSolarCloud token endpoint at ${url.host} to refresh tokens.`,
                  err
                );
    }

  const bodyText = await response.text();
    let body: unknown;
    try {
          body = JSON.parse(bodyText);
    } catch {
          throw new SungrowAuthError(`iSolarCloud token endpoint returned non-JSON response during refresh: ${bodyText}`);
    }

  if (!isTokenResponse(body)) {
        throw new SungrowAuthError(
                `iSolarCloud token refresh failed. The refresh token may no longer be valid -- ` +
                  `re-authorize at /sungrow/login. Response: ${bodyText}`
              );
  }
    return body;
}

/** Persists tokens to sungrow_tokens.json in TOKENS_DIR. */
export async function saveTokens(tokens: SungrowTokenResponse): Promise<void> {
    const stored: StoredSungrowTokens = {
          access_token: tokens.access_token,
          refresh_token: tokens.refresh_token,
          expires_in: tokens.expires_in,
          obtained_at: new Date().toISOString(),
    };
    try {
          await writeFile(SUNGROW_TOKENS_FILE, JSON.stringify(stored, null, 2) + "\n", "utf8");
          console.log(
                  `[sungrowAuth] Tokens saved to ${SUNGROW_TOKENS_FILE} (obtained_at=${stored.obtained_at})`
                );
    } catch (err) {
          console.error(`[sungrowAuth] Failed to write tokens to ${SUNGROW_TOKENS_FILE}:`, err);
          throw new SungrowAuthError(`Failed to write ${SUNGROW_TOKENS_FILE}: ${(err as Error).message}`, err);
    }
}

/** Reads and validates tokens from sungrow_tokens.json. */
export async function loadStoredTokens(): Promise<StoredSungrowTokens> {
    let raw: string;
    try {
          raw = await readFile(SUNGROW_TOKENS_FILE, "utf8");
    } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
                  console.error(`[sungrowAuth] Unexpected error reading ${SUNGROW_TOKENS_FILE}:`, err);
          }
          throw new SungrowAuthError(
                  `No sungrow_tokens.json found at ${SUNGROW_TOKENS_FILE}. Authorize at /sungrow/login first.`
                );
    }

  let stored: StoredSungrowTokens;
    try {
          stored = JSON.parse(raw) as StoredSungrowTokens;
          if (typeof stored.access_token !== "string" || typeof stored.obtained_at !== "string") {
                  throw new Error("missing fields");
          }
    } catch (err) {
          throw new SungrowAuthError("sungrow_tokens.json exists but is invalid. Re-authorize at /sungrow/login.", err);
    }

  return stored;
}

function isExpiringSoon(stored: StoredSungrowTokens): boolean {
    const obtained = new Date(stored.obtained_at).getTime();
    const expiresAt = obtained + stored.expires_in * 1000;
    return Date.now() >= expiresAt - EXPIRY_BUFFER_MS;
}

/**
 * Returns a valid access token, transparently refreshing via the stored
 * refresh token if the current one is expired or about to expire.
 */
export async function getValidAccessToken(config: AppConfig): Promise<string> {
    const stored = await loadStoredTokens();
    if (!isExpiringSoon(stored)) {
          return stored.access_token;
    }
    const refreshed = await refreshTokens(config, stored.refresh_token);
    await saveTokens(refreshed);
    return refreshed.access_token;
}

export interface SungrowAuthStatus {
    authenticated: boolean;
    obtained_at?: string;
    expires_at?: string;
    access_token_expired?: boolean;
    message: string;
}

/** Reads sungrow_tokens.json and reports authentication status without exposing tokens. */
export async function getAuthStatus(): Promise<SungrowAuthStatus> {
    let raw: string;
    try {
          raw = await readFile(SUNGROW_TOKENS_FILE, "utf8");
    } catch (err) {
          const code = (err as NodeJS.ErrnoException)?.code;
          if (code !== "ENOENT") {
                  console.error(`[sungrowAuth] Unexpected error reading ${SUNGROW_TOKENS_FILE} in getAuthStatus:`, err);
          }
          return { authenticated: false, message: "No sungrow_tokens.json found. Authorize at /sungrow/login." };
    }

  let stored: StoredSungrowTokens;
    try {
          stored = JSON.parse(raw) as StoredSungrowTokens;
          if (typeof stored.access_token !== "string" || typeof stored.obtained_at !== "string") {
                  throw new Error("missing fields");
          }
    } catch {
          return {
                  authenticated: false,
                  message: "sungrow_tokens.json exists but is invalid. Re-authorize at /sungrow/login.",
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
          ? "Access token has expired. It will be refreshed automatically on the next call."
                : "Authenticated. Access token is valid.",
  };
}
