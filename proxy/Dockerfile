# Tesla Vehicle Command Proxy.
#
# Modern (2021+) Tesla vehicles reject unsigned REST commands sent to the
# Fleet API. This proxy signs commands (charge_start/charge_stop/
# set_charging_amps) with our virtual key before forwarding them, using
# Tesla's own vehicle-command SDK. See src/virtualKey.ts and
# src/scripts/register-partner-account.ts in the repo root for the rest of
# the virtual-key setup (public key hosting + Tesla registration).
#
# Docs: https://github.com/teslamotors/vehicle-command
#
# This is deployed as its own Railway service (root directory = proxy/),
# reachable from the main app service only over Railway's private network.
# It always speaks TLS (the upstream tool has no option to disable it), using
# a self-signed cert we generate once; the main app trusts that one specific
# cert via TESLA_COMMAND_CA_CERT_BASE64.

FROM golang:1.23-alpine AS build
RUN apk add --no-cache git
WORKDIR /src
RUN git clone --depth 1 https://github.com/teslamotors/vehicle-command.git .
RUN go build -o /out/tesla-http-proxy ./cmd/tesla-http-proxy

FROM alpine:3.20
RUN apk add --no-cache ca-certificates
COPY --from=build /out/tesla-http-proxy /usr/local/bin/tesla-http-proxy
COPY entrypoint.sh /entrypoint.sh
RUN chmod +x /entrypoint.sh
EXPOSE 4443
ENTRYPOINT ["/entrypoint.sh"]
