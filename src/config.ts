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
          /**
           * Base64-encoded PEM certificate for the Vehicle Command Proxy's self-signed
   * TLS cert (see proxy/entrypoint.sh). The proxy always speaks TLS but has no
           * publicly-trusted certificate, so this lets tesla.ts pin that one specific
           * cert as trusted, in addition to the normal system CA bundle. Leave unset
           * when teslaCommandBase is the real Fleet API (normal HTTPS trust applies).
           */
  teslaCommandCaCertBase64?: string;
          /**
           * Shared secret the local Sungrow bridge (running on the home network, see
           * src/solar.ts) must present as a Bearer token when posting readings to
           * POST /solar/reading. Left unset, that endpoint refuses all readings --
           * there is no local bridge running yet, so this can stay unconfigured
           * until one exists.
           */
  localBridgeApiKey?: string;
          /**
           * Battery state of charge (0-100) below which available solar surplus is
           * reserved for the home battery rather than diverted to EV charging.
           * Tunable per household; defaults to a conservative 90%.
           */
  batteryReserveSocPercent: number;
          /**
           * Assumed AC voltage used to convert between watts (what the Sungrow
           * inverter reports) and amps (what Tesla's charging API expects).
           * 240 is standard for Australian single-phase homes; override for
           * three-phase installs.
           */
  assumedVoltageV: number;
          /**
           * Small buffer (in watts) required above the charging threshold before
           * starting/increasing charging, to avoid rapidly toggling on and off
           * around the boundary as a cloud passes over.
           */
  surplusBufferW: number;
          /**
           * iSolarCloud OpenAPI credentials (see sungrowAuth.ts). Issued by the
           * iSolarCloud Developer Portal (developer-api.isolarcloud.com) when you
           * create an app there. All left unset until Sungrow approves the app --
           * the cloud-polling path stays inactive until then.
           */
  sungrowAppKey?: string;
          sungrowAppSecret?: string;
          sungrowAppId?: string;
          /**
           * Which iSolarCloud regional server the account lives on. Must match the
           * region shown in the developer portal / the account's home region.
           * One of: China, International, Europe, Australia, India.
           */
  sungrowRegion?: string;
          /**
           * Must exactly match the redirect/callback URL configured for the app in
           * the iSolarCloud Developer Portal, e.g.
           * https://<this-app>/sungrow/callback
           */
  sungrowRedirectUri?: string;
          /**
           * Optional override of which iSolarCloud plant (power station) to poll.
           * Left unset, the first plant returned for the authorized account is used
           * automatically -- fine for a single-plant account like Brett's.
           */
  sungrowPlantId?: string;
          /**
           * How often (ms) the server polls iSolarCloud for a fresh reading.
           * iSolarCloud's own data refreshes roughly every 5 minutes, but polling
           * often picks up each refresh soon after it lands. The gateway allows
           * ~10 req/s, so 15 s (2 calls/poll) is well within limits. Tesla is only
           * called when the decision would change (see server.ts). Defaults to 15 s.
           */
  sungrowPollIntervalMs: number;
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

function optionalOrUndefined(name: string): string | undefined {
          const value = process.env[name];
          return value && value.trim() !== "" ? value.trim() : undefined;
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
                      teslaCommandCaCertBase64: optionalOrUndefined("TESLA_COMMAND_CA_CERT_BASE64"),
                      localBridgeApiKey: optionalOrUndefined("LOCAL_BRIDGE_API_KEY"),
                      batteryReserveSocPercent: Number(optional("BATTERY_RESERVE_SOC_PERCENT", "90")),
                      assumedVoltageV: Number(optional("ASSUMED_VOLTAGE_V", "240")),
                      surplusBufferW: Number(optional("SURPLUS_BUFFER_W", "200")),
                      sungrowAppKey: optionalOrUndefined("SUNGROW_APP_KEY"),
                      sungrowAppSecret: optionalOrUndefined("SUNGROW_APP_SECRET"),
                      sungrowAppId: optionalOrUndefined("SUNGROW_APP_ID"),
                      sungrowRegion: optionalOrUndefined("SUNGROW_REGION"),
                      sungrowRedirectUri: optionalOrUndefined("SUNGROW_REDIRECT_URI"),
                      sungrowPlantId: optionalOrUndefined("SUNGROW_PLANT_ID"),
                      sungrowPollIntervalMs: Number(optional("SUNGROW_POLL_INTERVAL_MS", "15000")),
          };
}
