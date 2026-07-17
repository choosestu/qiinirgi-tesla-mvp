// Tesla Fleet API client.
// Docs: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints

import tls from "node:tls";
import { Agent, type Dispatcher } from "undici";
import type { AppConfig } from "./config";
import { getValidAccessToken } from "./auth";

/**
 * Builds a fetch dispatcher that trusts the Vehicle Command Proxy's
 * self-signed TLS cert (see proxy/entrypoint.sh) in addition to the normal
 * system CA bundle, so pinning one extra cert doesn't break the ability to
 * still talk to real HTTPS endpoints. Cached per config so we don't rebuild
 * the TLS context on every command.
 * Returns undefined when no custom cert is configured (i.e. teslaCommandBase
 * points at the real Fleet API and ordinary HTTPS trust applies).
 */
let cachedCommandDispatcher: Dispatcher | undefined;
let cachedForCertValue: string | undefined;

function getCommandDispatcher(config: AppConfig): Dispatcher | undefined {
    if (!config.teslaCommandCaCertBase64) {
          return undefined;
    }
    if (cachedCommandDispatcher && cachedForCertValue === config.teslaCommandCaCertBase64) {
          return cachedCommandDispatcher;
    }
    const customCert = Buffer.from(config.teslaCommandCaCertBase64, "base64").toString("utf8");
    cachedCommandDispatcher = new Agent({
          connect: {
                  ca: [...tls.rootCertificates, customCert],
          },
    });
    cachedForCertValue = config.teslaCommandCaCertBase64;
    return cachedCommandDispatcher;
}

/** Standard Tesla API envelope for successful responses. */
interface TeslaApiResponse<T> {
    response: T;
    count?: number;
    pagination?: {
      previous?: string;
      next?: string;
      current?: number;
      per_page?: number;
      total?: number;
    };
}

/** Summary record from GET /api/1/vehicles. */
interface TeslaVehicleSummary {
    id: number;
    vin: string;
    state?: string;
}

/** Charge state nested inside vehicle_data. */
interface TeslaChargeState {
    battery_level: number;
    charge_port_latch: string;
    charging_state: string;
    charger_actual_current: number;
    charge_limit_soc: number;
}

/** Response body from GET /api/1/vehicles/{vin}/vehicle_data. */
interface TeslaVehicleData {
    id: number;
    vin: string;
    charge_state: TeslaChargeState;
}

/** Charging snapshot returned by GET /vehicle. */
export interface VehicleChargingStatus {
    vin: string;
    state_of_charge: number;
    plugged_in: boolean;
    charging_state: string;
    charging_current: number;
    charging_limit: number;
}

export class TeslaApiError extends Error {
    constructor(
          message: string,
          public readonly statusCode?: number,
          public readonly cause?: unknown
        ) {
          super(message);
          this.name = "TeslaApiError";
    }
}

function authHeader(tokenType: string, accessToken: string): string {
    return `${tokenType} ${accessToken}`;
}

async function parseJsonBody(response: Response): Promise<unknown> {
    const text = await response.text();
    if (text === "") {
          return null;
    }
    try {
          return JSON.parse(text);
    } catch {
          throw new TeslaApiError(
                  `Tesla API returned non-JSON response (HTTP ${response.status}): ${text}`,
                  response.status
                );
    }
}

function isVehicleList(value: unknown): value is TeslaApiResponse<TeslaVehicleSummary[]> {
    const v = value as TeslaApiResponse<TeslaVehicleSummary[]>;
    return (
          typeof v === "object" &&
          v !== null &&
          Array.isArray(v.response) &&
          v.response.every(
                  (item) =>
                            typeof item === "object" &&
                            item !== null &&
                            typeof item.vin === "string" &&
                            typeof item.id === "number"
                )
        );
}

function isVehicleData(value: unknown): value is TeslaApiResponse<TeslaVehicleData> {
    const v = value as TeslaApiResponse<TeslaVehicleData>;
    const response = v.response;
    const charge = response?.charge_state;
    return (
          typeof v === "object" &&
          v !== null &&
          typeof response === "object" &&
          response !== null &&
          typeof response.vin === "string" &&
          typeof charge === "object" &&
          charge !== null &&
          typeof charge.battery_level === "number" &&
          typeof charge.charge_port_latch === "string" &&
          typeof charge.charging_state === "string" &&
          typeof charge.charger_actual_current === "number" &&
          typeof charge.charge_limit_soc === "number"
        );
}

async function fleetGet(
    config: AppConfig,
    path: string,
    accessToken: string,
    tokenType: string
  ): Promise<Response> {
    const url = new URL(path, config.teslaApiBase);

  try {
        return await fetch(url, {
                method: "GET",
                headers: {
                          Authorization: authHeader(tokenType, accessToken),
                          Accept: "application/json",
                },
        });
  } catch (err) {
        throw new TeslaApiError(
                `Could not reach Tesla Fleet API at ${url.host}. Check your network connection.`,
                undefined,
                err
              );
  }
}

/** Lists vehicles on the authenticated account. */
export async function listVehicles(config: AppConfig): Promise<TeslaVehicleSummary[]> {
    const { access_token, token_type } = await getValidAccessToken(config);
    const response = await fleetGet(config, "/api/1/vehicles", access_token, token_type);
    const body = await parseJsonBody(response);

  if (!response.ok) {
        throw new TeslaApiError(
                `Tesla vehicle list failed (HTTP ${response.status}): ${JSON.stringify(body)}`,
                response.status
              );
  }

  if (!isVehicleList(body)) {
        throw new TeslaApiError("Tesla vehicle list response has an unexpected shape.");
  }

  return body.response;
}

/** Fetches live vehicle data for a VIN via GET /api/1/vehicles/{vin}/vehicle_data. */
export async function getVehicleData(
    config: AppConfig,
    vin: string
  ): Promise<TeslaVehicleData> {
    const { access_token, token_type } = await getValidAccessToken(config);
    const response = await fleetGet(
          config,
          `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`,
          access_token,
          token_type
        );
    const body = await parseJsonBody(response);

  if (!response.ok) {
        throw new TeslaApiError(
                `Tesla vehicle_data failed for VIN ${vin} (HTTP ${response.status}): ${JSON.stringify(body)}`,
                response.status
              );
  }

  if (!isVehicleData(body)) {
        throw new TeslaApiError(
                `Tesla vehicle_data response for VIN ${vin} is missing charge_state fields.`
              );
  }

  return body.response;
}

function mapChargeState(vin: string, charge: TeslaChargeState): VehicleChargingStatus {
    return {
          vin,
          state_of_charge: charge.battery_level,
          plugged_in: charge.charge_port_latch === "Engaged",
          charging_state: charge.charging_state,
          charging_current: charge.charger_actual_current,
          charging_limit: charge.charge_limit_soc,
    };
}

/**
 * Returns charging status for the account's first vehicle.
 * Uses the official Fleet API list + vehicle_data endpoints (live vehicle call).
 */
export async function getVehicleChargingStatus(
    config: AppConfig
  ): Promise<VehicleChargingStatus> {
    const vehicles = await listVehicles(config);

  if (vehicles.length === 0) {
        throw new TeslaApiError("No vehicles found on this Tesla account.");
  }

  const vin = vehicles[0].vin;
    const data = await getVehicleData(config, vin);
    return mapChargeState(data.vin, data.charge_state);
}

// ---------------------------------------------------------------------------
// Vehicle commands (milestone 4)
// Docs: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-commands
// ---------------------------------------------------------------------------

/** Result envelope returned by Tesla command endpoints. */
interface TeslaCommandResult {
    result: boolean;
    reason: string;
}

/** Outcome of a charging command, returned to API clients. */
export interface ChargeCommandOutcome {
    command: "charge_start" | "charge_stop" | "set_charging_amps";
    vin: string;
    result: boolean;
    reason: string;
}

/** Charging current bounds accepted by this service. */
export const MIN_CHARGING_AMPS = 5;
export const MAX_CHARGING_AMPS = 32;

function isCommandResult(value: unknown): value is TeslaApiResponse<TeslaCommandResult> {
    const v = value as TeslaApiResponse<TeslaCommandResult>;
    return (
          typeof v === "object" &&
          v !== null &&
          typeof v.response === "object" &&
          v.response !== null &&
          typeof v.response.result === "boolean"
        );
}

async function fleetPost(
    config: AppConfig,
    path: string,
    accessToken: string,
    tokenType: string,
    body?: Record<string, unknown>
  ): Promise<Response> {
    // Commands go to the command base URL, which should be a Vehicle Command
  // Proxy for modern vehicles (unsigned REST commands are rejected by 2021+ vehicles).
  const url = new URL(path, config.teslaCommandBase);
    const dispatcher = getCommandDispatcher(config);

  try {
        return await fetch(url, {
                method: "POST",
                headers: {
                          Authorization: authHeader(tokenType, accessToken),
                          "Content-Type": "application/json",
                          Accept: "application/json",
                },
                body: body === undefined ? undefined : JSON.stringify(body),
                ...(dispatcher ? { dispatcher } : {}),
        } as RequestInit);
  } catch (err) {
        throw new TeslaApiError(
                `Could not reach Tesla command endpoint at ${url.host}. ` +
                  `If TESLA_COMMAND_BASE points at a Vehicle Command Proxy, verify it is running.`,
                undefined,
                err
              );
  }
}

async function sendChargeCommand(
    config: AppConfig,
    command: ChargeCommandOutcome["command"],
    body?: Record<string, unknown>
  ): Promise<ChargeCommandOutcome> {
    const vehicles = await listVehicles(config);
    if (vehicles.length === 0) {
          throw new TeslaApiError("No vehicles found on this Tesla account.");
    }
    const vin = vehicles[0].vin;

  const { access_token, token_type } = await getValidAccessToken(config);
    const response = await fleetPost(
          config,
          `/api/1/vehicles/${encodeURIComponent(vin)}/command/${command}`,
          access_token,
          token_type,
          body
        );
    const parsed = await parseJsonBody(response);

  if (!response.ok) {
        throw new TeslaApiError(
                `Tesla ${command} failed for VIN ${vin} (HTTP ${response.status}): ${JSON.stringify(parsed)}. ` +
                  `Note: modern vehicles reject unsigned commands; commands must be routed ` +
                  `through a Vehicle Command Proxy with your virtual key installed.`,
                response.status
              );
  }

  if (!isCommandResult(parsed)) {
        throw new TeslaApiError(
                `Tesla ${command} response has an unexpected shape: ${JSON.stringify(parsed)}`
              );
  }

  return {
        command,
        vin,
        result: parsed.response.result,
        reason: parsed.response.reason ?? "",
  };
}

/** Starts charging the account's first vehicle. */
export async function startCharging(config: AppConfig): Promise<ChargeCommandOutcome> {
    return sendChargeCommand(config, "charge_start");
}

/** Stops charging the account's first vehicle. */
export async function stopCharging(config: AppConfig): Promise<ChargeCommandOutcome> {
    return sendChargeCommand(config, "charge_stop");
}

/**
 * Sets the charging current in amps.
 * amps must be an integer between MIN_CHARGING_AMPS and MAX_CHARGING_AMPS inclusive.
 */
export async function setChargingAmps(
    config: AppConfig,
    amps: number
  ): Promise<ChargeCommandOutcome> {
    if (!Number.isInteger(amps) || amps < MIN_CHARGING_AMPS || amps > MAX_CHARGING_AMPS) {
          throw new TeslaApiError(
                  `Invalid charging amps ${amps}: must be an integer between ${MIN_CHARGING_AMPS} and ${MAX_CHARGING_AMPS}.`,
                  400
                );
    }
    return sendChargeCommand(config, "set_charging_amps", { charging_amps: amps });
}
