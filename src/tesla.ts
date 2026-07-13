// Tesla Fleet API client.
// Docs: https://developer.tesla.com/docs/fleet-api/endpoints/vehicle-endpoints

import type { AppConfig } from "./config";
import { loadStoredTokens } from "./auth";

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
  const tokens = await loadStoredTokens();
  const response = await fleetGet(
    config,
    "/api/1/vehicles",
    tokens.access_token,
    tokens.token_type
  );
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
  const tokens = await loadStoredTokens();
  const response = await fleetGet(
    config,
    `/api/1/vehicles/${encodeURIComponent(vin)}/vehicle_data`,
    tokens.access_token,
    tokens.token_type
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
