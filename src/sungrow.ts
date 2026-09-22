// Sungrow iSolarCloud plant-data client.
//
// Fetches real-time plant readings via iSolarCloud's OpenAPI and maps them
// onto the app's inverter-agnostic SolarReading shape (see solar.ts). Point
// IDs below are iSolarCloud "measure point" IDs for common hybrid inverter +
// battery setups; different models expose different subsets, so each field
// tries a short list of known point IDs in order and uses the first one
// present in the response.
//
// UNVERIFIED until tested against Brett's real plant: the exact point IDs
// his inverter model reports, and the sign convention his model uses for
// battery power (Sungrow's OpenAPI generally reports positive = charging,
// negative = discharging, matching SolarReading's convention, but this
// should be confirmed against a live reading before relying on it for
// charging decisions).

import type { AppConfig } from "./config";
import type { SolarReading } from "./solar";
import { getRegionInfo } from "./sungrowAuth";
import { getValidAccessToken } from "./sungrowAuth";

export class SungrowApiError extends Error {
    constructor(message: string, public readonly cause?: unknown) {
          super(message);
          this.name = "SungrowApiError";
    }
}

interface SungrowApiEnvelope {
    req_serial_num?: string;
    result_code?: string;
    result_msg?: string;
    result_data?: unknown;
}

async function callSungrowApi(
    config: AppConfig,
    endpointPath: string,
    body: Record<string, unknown>
  ): Promise<SungrowApiEnvelope> {
    if (!config.sungrowAppKey || !config.sungrowAppSecret) {
          throw new SungrowApiError("Sungrow iSolarCloud is not configured (missing app key/secret).");
    }
    const { apiHost } = getRegionInfo(config);
    const accessToken = await getValidAccessToken(config);
    const url = new URL(endpointPath, apiHost);

  let response: Response;
    try {
          response = await fetch(url, {
                  method: "POST",
                  headers: {
                            "x-access-key": config.sungrowAppSecret,
                            "Authorization": `Bearer ${accessToken}`,
                            "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ appkey: config.sungrowAppKey, lang: "_en_US", ...body }),
          });
    } catch (err) {
          throw new SungrowApiError(`Could not reach iSolarCloud API at ${url.host}${endpointPath}.`, err);
    }

  const bodyText = await response.text();
    let parsed: SungrowApiEnvelope;
    try {
          parsed = JSON.parse(bodyText) as SungrowApiEnvelope;
    } catch {
          throw new SungrowApiError(`iSolarCloud API returned non-JSON response from ${endpointPath}: ${bodyText}`);
    }

  if (parsed.result_code && parsed.result_code !== "1") {
        if (parsed.result_code === "E998" || parsed.result_code === "E999") {
                throw new SungrowApiError(
                          `iSolarCloud rate limit hit (${parsed.result_code}): ${parsed.result_msg ?? "no message"}. Back off before retrying.`
                        );
        }
        throw new SungrowApiError(
                `iSolarCloud API error ${parsed.result_code} from ${endpointPath}: ${parsed.result_msg ?? "no message"}`
              );
  }

  return parsed;
}

interface SungrowPlant {
    ps_id: string;
    ps_name: string;
}

/** Lists the solar plants ("power stations") visible to this authorized account. */
export async function getPlants(config: AppConfig): Promise<SungrowPlant[]> {
    const envelope = await callSungrowApi(config, "/openapi/getPowerStationList", {
          curPage: 1,
          size: 50,
    });
    const data = envelope.result_data as { pageList?: SungrowPlant[] } | undefined;
    return data?.pageList ?? [];
}

/**
 * Resolves which plant to read from: an explicit SUNGROW_PLANT_ID override
 * if set, otherwise the first (and presumably only, for a single-home setup
 * like Brett's) plant visible to the authorized account.
 */
export async function resolvePlantId(config: AppConfig): Promise<string> {
    if (config.sungrowPlantId) {
          return config.sungrowPlantId;
    }
    const plants = await getPlants(config);
    if (plants.length === 0) {
          throw new SungrowApiError(
                  "No plants are visible to this iSolarCloud app. Make sure Brett has shared his plant with " +
                    "the app (Power Station Sharing) in the iSolarCloud console."
                );
    }
    return plants[0].ps_id;
}

// Fallback measure-point IDs to try, in order, for each field. Different
// inverter/battery models populate different subsets of these.
const SOLAR_PRODUCTION_POINTS = ["p83022", "p83006"];
const HOME_LOAD_POINTS = ["p83128", "p83052"];
const BATTERY_SOC_POINTS = ["p83023", "p83106"];
const BATTERY_POWER_POINTS = ["p83024", "p83107"];

type PointMap = Record<string, string | number | null | undefined>;

function readPoint(points: PointMap, candidates: string[], fieldName: string): number {
    for (const key of candidates) {
          const raw = points[key];
          if (raw === null || raw === undefined) continue;
          const value = typeof raw === "number" ? raw : Number(raw);
          if (!Number.isNaN(value)) {
                  return value;
          }
    }
    throw new SungrowApiError(
          `None of the expected measure points (${candidates.join(", ")}) for "${fieldName}" were present in the ` +
            `iSolarCloud response. This inverter model may report different point IDs; check the raw response.`
        );
}

/**
 * Fetches the current real-time reading for the resolved plant and maps it
 * onto the app's SolarReading shape.
 */
export async function getRealtimeReading(config: AppConfig): Promise<SolarReading> {
    const psId = await resolvePlantId(config);
    const envelope = await callSungrowApi(config, "/openapi/getPowerStationRealTimeData", {
          ps_id: psId,
    });

  const data = envelope.result_data as { device_point?: PointMap } | undefined;
    const points = data?.device_point;
    if (!points) {
          throw new SungrowApiError(
                  `iSolarCloud real-time data response for plant ${psId} had no device_point data.`
                );
    }

  return {
        solarProductionW: readPoint(points, SOLAR_PRODUCTION_POINTS, "solarProductionW") * 1000,
        homeLoadW: readPoint(points, HOME_LOAD_POINTS, "homeLoadW") * 1000,
        batterySocPercent: readPoint(points, BATTERY_SOC_POINTS, "batterySocPercent"),
        batteryPowerW: readPoint(points, BATTERY_POWER_POINTS, "batteryPowerW") * 1000,
        readingTakenAt: new Date().toISOString(),
  };
}
