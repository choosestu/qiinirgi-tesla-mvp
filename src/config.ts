// Environment configuration with validation.

export interface AppConfig {
  port: number;
  teslaClientId: string;
  teslaClientSecret: string;
  teslaRedirectUri: string;
  /** OAuth authorize base, e.g. https://auth.tesla.com */
  teslaAuthBase: string;
  /** Token exchange base. Per Tesla docs, /token calls MUST use fleet-auth.prd.vn.cloud.tesla.com */
  teslaTokenBase: string;
  /** Fleet API base URL for this region; used as the token `audience`. */
  teslaApiBase: string;
  /**
   * Base URL for vehicle commands. Modern (2021+) vehicles reject unsigned REST
   * commands, so this should point at a running Tesla Vehicle Command Proxy,
   * which exposes identical endpoints and signs commands with your virtual key.
   * Defaults to TESLA_API_BASE (sufficient for pre-2021 Model S/X and most business fleet vehicles).
   */
  teslaCommandBase: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value || value.trim() === "") {
    throw new ConfigError(
      `Missing required environment variable ${name}. Copy .env.example to .env and fill it in.`
    );
  }
  return value.trim();
}

function optional(name: string, fallback: string): string {
  const value = process.env[name];
  return value && value.trim() !== "" ? value.trim() : fallback;
}

/**
 * Reads and validates configuration from process.env.
 * Throws ConfigError with a clear message if a required variable is missing.
 */
export function loadConfig(): AppConfig {
  return {
    port: Number(optional("PORT", "3000")),
    teslaClientId: required("TESLA_CLIENT_ID"),
    teslaClientSecret: required("TESLA_CLIENT_SECRET"),
    teslaRedirectUri: required("TESLA_REDIRECT_URI"),
    teslaAuthBase: optional("TESLA_AUTH_BASE", "https://auth.tesla.com"),
    teslaTokenBase: optional("TESLA_TOKEN_BASE", "https://fleet-auth.prd.vn.cloud.tesla.com"),
    teslaApiBase: optional("TESLA_API_BASE", "https://fleet-api.prd.na.vn.cloud.tesla.com"),
    teslaCommandBase: optional(
      "TESLA_COMMAND_BASE",
      optional("TESLA_API_BASE", "https://fleet-api.prd.na.vn.cloud.tesla.com")
    ),
  };
}
