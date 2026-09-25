// Sungrow iSolarCloud plant-data client.
//
// Fetches real-time plant readings via iSolarCloud's OpenAPI and maps them
// onto the app's inverter-agnostic SolarReading shape (see solar.ts). Point
// IDs below are iSolarCloud plant-level "measure point" IDs, checked against
// Brett's live plant (1124803) and his iSolarCloud app. Plant-level values
// from /openapi/platform/getPowerStationRealTimeData are already in W; SOC
// (p83252) is a 0-1 fraction.
//
// Battery charge/discharge power isn't reported at plant level; it comes from
// the hybrid inverter's device-level points instead (see getInverterReadings).

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
    ps_id: string | number;
    ps_name: string;
}

// NOTE: OAuth-authorized apps must use the /openapi/platform/* endpoints,
// which authenticate via the Bearer access token + x-access-key headers set
// in callSungrowApi. The older /openapi/getPowerStationList-style endpoints
// belong to the username/password API and require a session `token` from
// /openapi/login in the request body -- calling them with an OAuth token
// fails with "er_missing_parameter:token".

/** Lists the solar plants ("power stations") visible to this authorized account. */
export async function getPlants(config: AppConfig): Promise<SungrowPlant[]> {
    const envelope = await callSungrowApi(config, "/openapi/platform/queryPowerStationList", {
          page: 1,
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
    return String(plants[0].ps_id);
}

// Fallback measure-point IDs to try, in order, for each field. Different
// inverter/battery models populate different subsets of these.
const SOLAR_PRODUCTION_POINTS = ["p83033"]; // plant power, W
const HOME_LOAD_POINTS = ["p83106"]; // load power, W
const BATTERY_SOC_POINTS = ["p83252"]; // battery level, 0-1 fraction
// Display-only: today's generation (Wh), reported as kWh on SolarReading.
const SOLAR_GENERATION_TODAY_POINT = "p83022";

// TEMPORARY: extra power/SOC-related points requested only so they show up in
// the [sungrow-raw] log for verifying the mappings above. Remove once verified.
const DIAGNOSTIC_POINT_IDS = [
    "83002", "83032", "83033", "83046", "83052", "83067", "83106",
    "83238", "83252", "83326", "83328", "83329", "83330",
];

type PointMap =Record<string, string | number | null | undefined>;

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

type PointDict = { point_id: string | number; point_name?: string; point_unit?: string }[];

/** Formats raw points as "p123=value unit (name)" for the [sungrow-raw] log. */
function formatRawPoints(points: PointMap, pointDict: PointDict | undefined): string {
    const names = new Map((pointDict ?? []).map((d) => [`p${d.point_id}`, d]));
    return Object.entries(points)
          .filter(([k]) => /^p\d+$/.test(k))
          .map(([k, v]) => {
                  const meta = names.get(k);
                  return `${k}=${v}${meta?.point_unit ? " " + meta.point_unit : ""}${meta?.point_name ? ` (${meta.point_name})` : ""}`;
          })
          .join("; ");
}

/** Like readPoint, but returns null instead of throwing (for display-only fields). */
function readOptionalPoint(points: PointMap, key: string): number | null {
    const raw = points[key];
    if (raw === null || raw === undefined || raw === "") return null;
    const value = typeof raw === "number" ? raw : Number(raw);
    return Number.isNaN(value) ? null : value;
}

/**
 * Fetches the current real-time reading for the resolved plant and maps it
 * onto the app's SolarReading shape.
 */
export async function getRealtimeReading(config: AppConfig): Promise<SolarReading> {
    const psId = await resolvePlantId(config);
    const pointIds = [
          ...SOLAR_PRODUCTION_POINTS,
          ...HOME_LOAD_POINTS,
          ...BATTERY_SOC_POINTS,
          SOLAR_GENERATION_TODAY_POINT,
    ].map((p) => p.replace(/^p/, ""));
    const envelope = await callSungrowApi(config, "/openapi/platform/getPowerStationRealTimeData", {
          ps_id_list: [psId],
          point_id_list: [...new Set([...pointIds, ...DIAGNOSTIC_POINT_IDS])],
          is_get_point_dict: "1",
    });

  const data = envelope.result_data as
        | { device_point_list?: (PointMap & { ps_id?: string | number })[]; point_dict?: PointDict }
        | undefined;
    const points = data?.device_point_list?.find((p) => String(p.ps_id) === psId) ?? data?.device_point_list?.[0];
    if (!points) {
          throw new SungrowApiError(
                  `iSolarCloud real-time data response for plant ${psId} had no device_point_list data.`
                );
    }

  // TEMPORARY: dump every raw point with its name/unit so the mapping can be
  // cross-checked against Brett's iSolarCloud app. Remove once verified.
  console.log(`[sungrow-raw] plant ${psId} @ ${new Date().toISOString()}: ${formatRawPoints(points, data?.point_dict)}`);

  const inverter = await getInverterReadings(config, psId);
    const generationTodayWh = readOptionalPoint(points, SOLAR_GENERATION_TODAY_POINT);

  return {
        solarProductionW: readPoint(points, SOLAR_PRODUCTION_POINTS, "solarProductionW"),
        homeLoadW: readPoint(points, HOME_LOAD_POINTS, "homeLoadW"),
        batterySocPercent: readPoint(points, BATTERY_SOC_POINTS, "batterySocPercent") * 100,
        batteryPowerW: inverter.batteryPowerW,
        gridImportW: inverter.gridImportW,
        gridExportW: inverter.gridExportW,
        solarGenerationTodayKWh: generationTodayWh === null ? null : generationTodayWh / 1000,
        readingTakenAt: new Date().toISOString(),
  };
}

// Battery charge/discharge power and grid flow aren't reported at plant
// level, only by the hybrid inverter (device_type 14, e.g. Brett's SH10RT),
// each as non-negative W points. Verified against Brett's plant: solar =
// load + export + battery charging balanced to within 1 W, and battery
// V x A matched p13126.
const HYBRID_INVERTER_DEVICE_TYPE = 14;
const BATTERY_CHARGING_POWER_POINT = "13126"; // W
const BATTERY_DISCHARGING_POWER_POINT = "13150"; // W
const GRID_IMPORT_POWER_POINT = "13149"; // W
const GRID_EXPORT_POWER_POINT = "13121"; // W

// Device ps_keys don't change, so the inverter lookup is cached per plant.
const inverterPsKeyCache = new Map<string, string>();

async function resolveInverterPsKey(config: AppConfig, psId: string): Promise<string> {
    const cached = inverterPsKeyCache.get(psId);
    if (cached) return cached;
    const envelope = await callSungrowApi(config, "/openapi/platform/getDeviceListByPsId", {
          ps_id: psId,
          page: 1,
          size: 100,
    });
    const devices =
          (envelope.result_data as { pageList?: { ps_key?: string; device_type?: number }[] } | undefined)?.pageList ?? [];
    const inverter = devices.find((d) => d.device_type === HYBRID_INVERTER_DEVICE_TYPE && d.ps_key);
    if (!inverter?.ps_key) {
          throw new SungrowApiError(`No hybrid inverter (device_type ${HYBRID_INVERTER_DEVICE_TYPE}) found on plant ${psId}.`);
    }
    inverterPsKeyCache.set(psId, inverter.ps_key);
    return inverter.ps_key;
}

interface InverterReadings {
    batteryPowerW: number | null;
    gridImportW: number | null;
    gridExportW: number | null;
}

/**
 * Reads battery power (+ charging, - discharging) and grid import/export
 * from the hybrid inverter's device-level points in a single call. Any
 * value that can't be read is null. Null battery power is safe:
 * decideChargingAction then assumes a below-reserve battery claims all surplus.
 */
async function getInverterReadings(config: AppConfig, psId: string): Promise<InverterReadings> {
    try {
          const psKey = await resolveInverterPsKey(config, psId);
          const envelope = await callSungrowApi(config, "/openapi/platform/getDeviceRealTimeData", {
                  device_type: HYBRID_INVERTER_DEVICE_TYPE,
                  ps_key_list: [psKey],
                  point_id_list: [
                            BATTERY_CHARGING_POWER_POINT,
                            BATTERY_DISCHARGING_POWER_POINT,
                            GRID_IMPORT_POWER_POINT,
                            GRID_EXPORT_POWER_POINT,
                  ],
                  is_get_point_dict: "1",
          });
          const data = envelope.result_data as
                  | { device_point_list?: { device_point?: PointMap }[]; point_dict?: PointDict }
                  | undefined;
          const points = data?.device_point_list?.[0]?.device_point;
          if (!points) {
                  throw new SungrowApiError(`Inverter ${psKey} real-time response had no device_point data.`);
          }
          console.log(`[sungrow-raw] inverter ${psKey}: ${formatRawPoints(points, data?.point_dict)}`);
          const chargingW = readOptionalPoint(points, `p${BATTERY_CHARGING_POWER_POINT}`);
          const dischargingW = readOptionalPoint(points, `p${BATTERY_DISCHARGING_POWER_POINT}`);
          return {
                  batteryPowerW: chargingW === null || dischargingW === null ? null : chargingW - dischargingW,
                  gridImportW: readOptionalPoint(points, `p${GRID_IMPORT_POWER_POINT}`),
                  gridExportW: readOptionalPoint(points, `p${GRID_EXPORT_POWER_POINT}`),
          };
    } catch (err) {
          console.error(
                  "[sungrow-poll] Could not read inverter points; battery power and grid flow unknown:",
                  err instanceof Error ? err.message : err
                );
          return { batteryPowerW: null, gridImportW: null, gridExportW: null };
    }
}
