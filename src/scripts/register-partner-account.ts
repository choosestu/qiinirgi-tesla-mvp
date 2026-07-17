// One-time setup script: registers this app's domain and virtual-key public
// key with Tesla, via the Partner Account "register" endpoint.
//
// This MUST be run once (and again only if the domain or key ever changes)
// before Tesla will let any user pair the virtual key via the /_ak/ deep link.
// Docs: https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints#register
//
// Run from inside the deployed container (e.g. Railway's Console tab, which
// already has TESLA_CLIENT_ID / TESLA_CLIENT_SECRET / TESLA_API_BASE /
// TESLA_TOKEN_BASE set as real environment variables):
//
//   node dist/scripts/register-partner-account.js
//
// Optionally pass a domain to register a different one than the default:
//
//   node dist/scripts/register-partner-account.js some-other-domain.example.com
//
// This intentionally never runs as part of normal server startup -- it's a
// one-off administrative action, not something that should fire on every deploy.

import { loadConfig, type AppConfig } from "../config";

const DEFAULT_DOMAIN = "qiinirgi.up.railway.app";

interface PartnerTokenResponse {
    access_token: string;
    token_type: string;
    expires_in: number;
}

function isPartnerTokenResponse(value: unknown): value is PartnerTokenResponse {
    const v = value as PartnerTokenResponse;
    return typeof v === "object" && v !== null && typeof v.access_token === "string";
}

/**
 * Partner token: client_credentials grant, used to manage the app's own
 * account/devices rather than a specific user's.
 * Docs: https://developer.tesla.com/docs/fleet-api/authentication/partner-tokens
 */
async function getPartnerToken(config: AppConfig): Promise<string> {
    const url = new URL("/oauth2/v3/token", config.teslaTokenBase);

  const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
                grant_type: "client_credentials",
                client_id: config.teslaClientId,
                client_secret: config.teslaClientSecret,
                audience: config.teslaApiBase,
        }),
  });

  const bodyText = await response.text();

  if (!response.ok) {
        throw new Error(`Partner token request failed (HTTP ${response.status}): ${bodyText}`);
  }

  let body: unknown;
    try {
          body = JSON.parse(bodyText);
    } catch {
          throw new Error(`Partner token endpoint returned non-JSON response: ${bodyText}`);
    }

  if (!isPartnerTokenResponse(body)) {
        throw new Error(`Partner token response is missing access_token: ${bodyText}`);
  }

  return body.access_token;
}

/**
 * Registers the domain + hosted public key with Tesla.
 * Docs: https://developer.tesla.com/docs/fleet-api/endpoints/partner-endpoints#register
 *
 * Tesla fetches the public key itself from
 * https://<domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
 * during this call, so that route must already be live and returning the
 * correct key before this script runs.
 */
async function registerPartnerAccount(config: AppConfig, domain: string): Promise<void> {
    const partnerToken = await getPartnerToken(config);
    const url = new URL("/api/1/partner_accounts", config.teslaApiBase);

  const response = await fetch(url, {
        method: "POST",
        headers: {
                Authorization: `Bearer ${partnerToken}`,
                "Content-Type": "application/json",
        },
        body: JSON.stringify({ domain }),
  });

  const bodyText = await response.text();
    console.log(`register (HTTP ${response.status}): ${bodyText}`);

  if (!response.ok) {
        throw new Error(`Registering domain ${domain} failed (HTTP ${response.status}): ${bodyText}`);
  }

  // Confirm Tesla actually stored the key we think we hosted, using the same
  // partner token (this call also requires a partner token per Tesla's docs).
  const verifyUrl = new URL("/api/1/partner_accounts/public_key", config.teslaApiBase);
    verifyUrl.search = new URLSearchParams({ domain }).toString();

  const verifyResponse = await fetch(verifyUrl, {
        method: "GET",
        headers: { Authorization: `Bearer ${partnerToken}` },
  });
    const verifyBody = await verifyResponse.text();
    console.log(`verify public_key (HTTP ${verifyResponse.status}): ${verifyBody}`);
}

async function main(): Promise<void> {
    const domain = process.argv[2]?.trim() || DEFAULT_DOMAIN;
    console.log(`Registering partner account for domain: ${domain}`);

  const config = loadConfig();
    await registerPartnerAccount(config, domain);

  console.log("Done. If both calls above returned 2xx and the verify step echoed back a key, " +
                  "the /_ak/ virtual key pairing link should now work.");
}

main().catch((err) => {
    console.error("Registration failed:", err instanceof Error ? err.message : err);
    process.exitCode = 1;
});
