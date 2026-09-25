// Sungrow iSolarCloud plant-data client.
//
// Fetches real-time plant readings via iSolarCloud's OpenAPI and maps them
// onto the app's inverter-agnostic SolarReading shape (see solar.ts). Point
// IDs below are iSolarCloud plant-level "measure point" IDs, checked against
// Brett's live plant (1124803) and his iSolarCloud app. Plant-level values
// from /openapi/platform/getPowerStationRealTimeData are already in W; SOC
// (p83252) is a 0-1 fraction.
//
// Battery charge/discharge power is not mapped yet: no plant-level point has
// returned a value for it, so batteryPowerW is null until a device-level
// point is identified (see probeBatteryPowerOnce).

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

/**
 * Fetches the current real-time reading for the resolved plant and maps it
 * onto the app's SolarReading shape.
 */
export async function getRealtimeReading(config: AppConfig): Promise<SolarReading> {
    const psId = await resolvePlantId(config);
    await probeBatteryPowerOnce(config, psId);
    const pointIds = [
          ...SOLAR_PRODUCTION_POINTS,
          ...HOME_LOAD_POINTS,
          ...BATTERY_SOC_POINTS,
    ].map((p) => p.replace(/^p/, ""));
    const envelope = await callSungrowApi(config, "/openapi/platform/getPowerStationRealTimeData", {
          ps_id_list: [psId],
          point_id_list: [...new Set([...pointIds, ...DIAGNOSTIC_POINT_IDS])],
          is_get_point_dict: "1",
    });

  const data = envelope.result_data as
        | {
                device_point_list?: (PointMap & { ps_id?: string | number })[];
                point_dict?: { point_id: string | number; point_name?: string; point_unit?: string }[];
          }
        | undefined;
    const points = data?.device_point_list?.find((p) => String(p.ps_id) === psId) ?? data?.device_point_list?.[0];
    if (!points) {
          throw new SungrowApiError(
                  `iSolarCloud real-time data response for plant ${psId} had no device_point_list data.`
                );
    }

  // TEMPORARY: dump every raw point with its name/unit so the mapping can be
  // cross-checked against Brett's iSolarCloud app. Remove once verified.
  const names = new Map((data?.point_dict ?? []).map((d) => [`p${d.point_id}`, d]));
    const raw = Object.entries(points)
          .filter(([k]) => /^p\d+$/.test(k))
          .map(([k, v]) => {
                  const meta = names.get(k);
                  return `${k}=${v}${meta?.point_unit ? " " + meta.point_unit : ""}${meta?.point_name ? ` (${meta.point_name})` : ""}`;
          });
    console.log(`[sungrow-raw] plant ${psId} @ ${new Date().toISOString()}: ${raw.join("; ")}`);

  return {
        solarProductionW: readPoint(points, SOLAR_PRODUCTION_POINTS, "solarProductionW"),
        homeLoadW: readPoint(points, HOME_LOAD_POINTS, "homeLoadW"),
        batterySocPercent: readPoint(points, BATTERY_SOC_POINTS, "batterySocPercent") * 100,
        batteryPowerW: null,
        readingTakenAt: new Date().toISOString(),
  };
}

// TEMPORARY battery-power investigation. Plant-level points never report
// battery charge/discharge power for Brett's plant, so this lists the plant's
// devices and asks each hybrid inverter (device_type 14) / battery
// (device_type 43) for its device-level points, logging everything returned
// as [sungrow-probe]. Runs once per process, read-only. Remove once a battery
// power point is identified.
const DEVICE_PROBE_POINTS: Record<number, string[]> = {
    // Hybrid inverter: 13126 battery charging power, 13150 battery discharging
    // power, 13141 battery level, 13119 load power, plus neighbours.
    14: Array.from({ length: 60 }, (_, i) => String(13101 + i)),
    43: Array.from({ length: 30 }, (_, i) => String(58601 + i)),
};

let batteryProbeStarted = false;

export async function probeBatteryPowerOnce(config: AppConfig, psId: string): Promise<void> {
    if (batteryProbeStarted) return;
    batteryProbeStarted = true;
    try {
          const list = await callSungrowApi(config, "/openapi/platform/getDeviceListByPsId", {
                  ps_id: psId,
                  page: 1,
                  size: 100,
          });
          const devices =
                  (list.result_data as { pageList?: { ps_key?: string; device_type?: number; device_name?: string; device_model_code?: string }[] } | undefined)
                    ?.pageList ?? [];
          console.log(
                  `[sungrow-probe] devices: ` +
                    devices.map((d) => `${d.device_name} type=${d.device_type} model=${d.device_model_code} ps_key=${d.ps_key}`).join(" | ")
                );

      for (const device of devices) {
              const pointIds = device.device_type !== undefined ? DEVICE_PROBE_POINTS[device.device_type] : undefined;
              if (!pointIds || !device.ps_key) continue;
              try {
                        const rt = await callSungrowApi(config, "/openapi/platform/getDeviceRealTimeData", {
                                    device_type: device.device_type,
                                    ps_key_list: [device.ps_key],
                                    point_id_list: pointIds,
                                    is_get_point_dict: "1",
                        });
                        const data = rt.result_data as
                          | { device_point_list?: { device_point?: PointMap }[]; point_dict?: { point_id: string | number; point_name?: string; point_unit?: string }[] }
                          | undefined;
                        const names = new Map((data?.point_dict ?? []).map((d) => [`p${d.point_id}`, d]));
                        for (const entry of data?.device_point_list ?? []) {
                                    const raw = Object.entries(entry.device_point ?? {})
                                      .filter(([k, v]) => /^p\d+$/.test(k) && v !== null && v !== undefined && v !== "")
                                      .map(([k, v]) => {
                                                    const meta = names.get(k);
                                                    return `${k}=${v}${meta?.point_unit ? " " + meta.point_unit : ""}${meta?.point_name ? ` (${meta.point_name})` : ""}`;
                                      });
                                    console.log(`[sungrow-probe] ${device.ps_key} (type ${device.device_type}): ${raw.join("; ") || "no non-null points"}`);
                        }
                        if (!data?.device_point_list?.length) {
                                    console.log(`[sungrow-probe] ${device.ps_key}: empty response ${JSON.stringify(rt.result_data)}`);
                        }
              } catch (err) {
                        console.log(`[sungrow-probe] ${device.ps_key} realtime failed: ${err instanceof Error ? err.message : err}`);
              }
      }
    } catch (err) {
          console.log(`[sungrow-probe] device list failed: ${err instanceof Error ? err.message : err}`);
    }
}
