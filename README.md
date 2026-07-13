# qiinirgi-tesla-mvp

Tesla Fleet API proof of concept for intelligent EV charging.

**Current state (milestone 4):** Tesla OAuth, live vehicle charging status, and charging commands (start, stop, set current). No token refresh yet.

## Requirements

- Node.js 22+
- A Tesla developer account with a registered Fleet API application ([developer.tesla.com](https://developer.tesla.com))

## Tesla OAuth setup

1. Create an application at [developer.tesla.com/dashboard](https://developer.tesla.com/dashboard).
2. Note your **Client ID** and **Client Secret**.
3. Add your redirect URI to the app's **Allowed Redirect URIs**. It must match `TESLA_REDIRECT_URI` exactly (default: `https://qiinirgi.com/auth/tesla/callback`).
4. Under allowed scopes, enable at least: `openid`, `offline_access`, `vehicle_device_data`, `vehicle_charging_cmds`.

## Environment variables

Copy the example file and fill it in:

```bash
cp .env.example .env
```

| Variable | Description |
| --- | --- |
| `TESLA_CLIENT_ID` | Client ID from the Tesla developer dashboard (required) |
| `TESLA_CLIENT_SECRET` | Client secret from the dashboard (required) |
| `TESLA_REDIRECT_URI` | Must exactly match an allowed redirect URI on your Tesla app (required) |
| `TESLA_AUTH_BASE` | OAuth authorize base. Default `https://auth.tesla.com` |
| `TESLA_TOKEN_BASE` | Token exchange base. Tesla requires `https://fleet-auth.prd.vn.cloud.tesla.com` |
| `TESLA_API_BASE` | Your region's Fleet API base URL, used as token `audience`. Default is North America |
| `TESLA_COMMAND_BASE` | Where vehicle commands are sent. Point at a running [Vehicle Command Proxy](https://github.com/teslamotors/vehicle-command) for 2021+ vehicles. Defaults to `TESLA_API_BASE` |
| `PORT` | Server port. Default `3000` |

## Install and run

```bash
npm install
npm run dev        # development with auto-reload
# or
npm run build && npm start
```

## How to authenticate

1. Start the server.
2. Open `http://localhost:3000/login` in a browser.
3. You are redirected to Tesla's login page. Sign in with the Tesla account that owns the vehicle and approve the requested scopes.
4. Tesla redirects back to your `TESLA_REDIRECT_URI`. The callback handler exchanges the authorization code for tokens and writes them to `tokens.json` in the project root.

Note: Tesla redirects to the public `TESLA_REDIRECT_URI`. That URL must route to this server's callback handler (served on both `/callback` and `/auth/tesla/callback`), e.g. via your qiinirgi.com reverse proxy or a tunnel during local development.

## How to verify a successful login

- The callback response in the browser is:

```json
{ "status": "authenticated", "message": "Tokens saved to .../tokens.json", "expires_in": 28800 }
```

- `tokens.json` exists in the project root and contains `access_token`, `refresh_token`, `token_type`, `expires_in`, and `obtained_at`.
- `GET /auth/status` returns `"authenticated": true` with the token expiry time.

`tokens.json` contains live credentials for your Tesla account. It is gitignored; never commit it.

## Vehicle charging status

After authenticating, fetch live charging data for the first vehicle on the account:

```bash
curl http://localhost:3000/vehicle
```

Example response:

```json
{
  "vin": "5YJ3E1EA...",
  "state_of_charge": 72,
  "plugged_in": true,
  "charging_state": "Charging",
  "charging_current": 32,
  "charging_limit": 80
}
```

| Field | Source (Fleet API `charge_state`) |
| --- | --- |
| `vin` | Vehicle VIN |
| `state_of_charge` | `battery_level` (percent) |
| `plugged_in` | `true` when `charge_port_latch` is `"Engaged"` |
| `charging_state` | e.g. `Charging`, `Complete`, `Disconnected` |
| `charging_current` | `charger_actual_current` (amps) |
| `charging_limit` | `charge_limit_soc` (percent) |

This endpoint calls Tesla's official Fleet API:

1. `GET /api/1/vehicles` — list vehicles on the account
2. `GET /api/1/vehicles/{vin}/vehicle_data` — live call to the vehicle for charge state

Tesla recommends against polling `vehicle_data` frequently; it wakes the vehicle and is billed per call. For production streaming, use [Fleet Telemetry](https://developer.tesla.com/docs/fleet-api/fleet-telemetry).

If the access token has expired, re-authenticate at `/login` (token refresh is not implemented yet).

## Endpoints

| Route | Purpose |
| --- | --- |
| `GET /` | Health check, returns `{"status":"ok"}` |
| `GET /login` | Redirects to Tesla OAuth authorization page |
| `GET /callback` (also `GET /auth/tesla/callback`) | Exchanges code for tokens, saves `tokens.json` |
| `GET /auth/status` | Reports authentication status (token presence and expiry, no token values) |
| `GET /vehicle` | Live charging status for the first vehicle on the account |
| `POST /charge/start` | Start charging the account's first vehicle |
| `POST /charge/stop` | Stop charging |
| `POST /charge/current` | Set charging current. Body: `{"amps": 16}` (integer, 5 to 32) |

## Charging commands

All commands act on the first vehicle of the authenticated account and require a valid `tokens.json` (authenticate at `/login` first).

```bash
curl -X POST http://localhost:3000/charge/start
curl -X POST http://localhost:3000/charge/stop
curl -X POST http://localhost:3000/charge/current \
  -H "Content-Type: application/json" \
  -d '{"amps":16}'
```

Responses have the shape:

```json
{ "command": "set_charging_amps", "vin": "5YJ...", "result": true, "reason": "" }
```

`result: false` with a `reason` (for example `is_charging`, `disconnected`, `not_charging`) means Tesla accepted the request but the vehicle declined it; this is a vehicle state issue, not an API error.

**Important, 2021+ vehicles:** Tesla rejects unsigned REST commands for modern vehicles. You must run Tesla's [Vehicle Command Proxy](https://github.com/teslamotors/vehicle-command) with your application's virtual key installed on the vehicle, and set `TESLA_COMMAND_BASE` to the proxy's URL. Pre-2021 Model S/X and most business fleet vehicles work without the proxy.

## Project structure

```
src/
  server.ts   Express app entry point
  routes.ts   HTTP routes (health, login, callback, vehicle)
  config.ts   Environment configuration with validation
  auth.ts     Tesla OAuth 2.0 authorization code flow
  tesla.ts    Tesla Fleet API client (vehicle list, vehicle_data)
```
