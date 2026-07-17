#!/bin/sh
# Writes secrets provided as base64 env vars to files, then starts the proxy.
# Base64 is used because Railway's variable editor does not reliably preserve
# newlines in multi-line PEM values.
set -e

mkdir -p /config

if [ -z "$TESLA_COMMAND_PRIVATE_KEY_BASE64" ]; then
  echo "FATAL: TESLA_COMMAND_PRIVATE_KEY_BASE64 is not set. This must be the" >&2
    echo "base64-encoded PEM private key generated for the Tesla virtual key" >&2
      echo "(see outputs/tesla-virtual-key-private.pem from the key-generation step)." >&2
        exit 1
        fi
        if [ -z "$PROXY_TLS_CERT_BASE64" ]; then
          echo "FATAL: PROXY_TLS_CERT_BASE64 is not set." >&2
            exit 1
            fi
            if [ -z "$PROXY_TLS_KEY_BASE64" ]; then
              echo "FATAL: PROXY_TLS_KEY_BASE64 is not set." >&2
                exit 1
                fi

                echo "$TESLA_COMMAND_PRIVATE_KEY_BASE64" | base64 -d > /config/fleet-key.pem
                echo "$PROXY_TLS_CERT_BASE64" | base64 -d > /config/tls-cert.pem
                echo "$PROXY_TLS_KEY_BASE64" | base64 -d > /config/tls-key.pem

                PORT="${PORT:-4443}"

                echo "Starting tesla-http-proxy on 0.0.0.0:$PORT"
                exec /usr/local/bin/tesla-http-proxy \
                  -tls-key /config/tls-key.pem \
                    -cert /config/tls-cert.pem \
                      -key-file /config/fleet-key.pem \
                        -host 0.0.0.0 \
                          -port "$PORT"
                          
