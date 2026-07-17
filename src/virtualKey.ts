// Tesla Fleet API virtual key public key.
// Docs: https://developer.tesla.com/docs/fleet-api/virtual-keys/developer-guide
//
// This is the PUBLIC half of an EC (prime256v1 / secp256r1) key pair. It is
// safe to commit and serve publicly -- that is the whole point of a public
// key. It must remain reachable at:
//   https://<this-domain>/.well-known/appspecific/com.tesla.3p.public-key.pem
//
// The matching PRIVATE key is NOT in this repo. It was generated alongside
// this public key and must be kept secret; it will be needed later to run
// the Tesla Vehicle Command Proxy (https://github.com/teslamotors/vehicle-command),
// which signs commands sent to 2021+ vehicles. Losing the private key means
// generating a new pair and re-registering (and re-pairing on every vehicle).
export const TESLA_VIRTUAL_KEY_PUBLIC_PEM = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAET4sVtYDS04/N0u7v6bTfgx1TCHOB
iVPwwQY5ieWNvmuc4ulho/dXnx7qtQIy+iVsdnWOKrXA1l2oIFDf6jtglw==
-----END PUBLIC KEY-----
`;
