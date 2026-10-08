import { readFileSync } from "node:fs";
import { generateKeyPair, hexToBytes } from "@omnisync/protocol";
import { signerFromKeyPair } from "@omnisync/crypto";
import { MemoryIdentityStore, PgDocumentStore, PgIdentityStore, migrate, type IdentityStore } from "@omnisync/store";
import { exportLedger } from "@omnisync/gateway";
import { ControlPlaneMetrics, parseTelemetryConfig, setupTelemetry } from "@omnisync/telemetry";
import { createControlPlane } from "./app.js";
import { parseTrustProxy, type LedgerAdminConfig } from "./config.js";

/**
 * Configuration comes from the environment; nothing secret is logged.
 *   OMNISYNC_OIDC_ISSUER, OMNISYNC_OIDC_CLIENT_ID, OMNISYNC_OIDC_CLIENT_SECRET (optional), OMNISYNC_OIDC_REDIRECT_URI
 *   OMNISYNC_ISSUER_KEY_FILE   file containing the issuer's 32-byte seed as hex
 *   OMNISYNC_SESSION_SECRET    hex, at least 32 bytes
 *   OMNISYNC_ADMIN_EMAILS      comma separated
 *   DATABASE_URL               PostgreSQL; without it an in-memory store is used (dev only)
 *   OMNISYNC_RETURN_TO         comma separated URLs a single-page app may be sent back to after login (e.g. the console)
 *   OMNISYNC_DEVICE_VERIFICATION_URL
 *                              turns on device-code login (command line, build agents); the web page where a person approves
 *                              a device. Must also be listed in OMNISYNC_RETURN_TO
 *   OMNISYNC_TRUST_PROXY       how many proxies (1-5) or which proxy addresses/CIDRs to believe about the client address. Set it behind an
 *                              ingress: otherwise every client shares the ingress controller's rate-limit bucket. Default: none
 *   OMNISYNC_TENANT, OMNISYNC_LEDGER_PUBLIC_KEY (hex)
 *                              with DATABASE_URL: enable the admin API's ledger routes (trust keys and export)
 *   OMNISYNC_METRICS_PORT / OMNISYNC_METRICS_HOST
 *                              serve Prometheus /metrics on its own port (never PORT); host defaults to 127.0.0.1
 */
function need(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing environment variable ${name}`);
  return v;
}

const port = Number(process.env["PORT"] ?? 8081);
// Checked with the other settings, before anything listens.
const telemetryConfig = parseTelemetryConfig(process.env, { appPort: port });
const issuerKey = generateKeyPair(hexToBytes(readFileSync(need("OMNISYNC_ISSUER_KEY_FILE"), "utf8").trim()));
let identity: IdentityStore = new MemoryIdentityStore();
let ledger: LedgerAdminConfig | undefined;
const dbUrl = process.env["DATABASE_URL"];
if (dbUrl) {
  const docs = new PgDocumentStore({ connectionString: dbUrl });
  await migrate(docs.pool);
  identity = new PgIdentityStore(docs.pool);
  const tenant = process.env["OMNISYNC_TENANT"];
  const ledgerKey = process.env["OMNISYNC_LEDGER_PUBLIC_KEY"];
  if (tenant && ledgerKey) {
    const ledgerPublicKey = hexToBytes(ledgerKey);
    if (ledgerPublicKey.length !== 32) throw new Error("OMNISYNC_LEDGER_PUBLIC_KEY must be 32 bytes of hex");
    ledger = { tenant, issuers: [issuerKey.publicKey], ledgerKeys: [ledgerPublicKey], export: (write) => exportLedger({ docs, identity, tenant }, write) };
  }
} else {
  console.warn("DATABASE_URL not set: identity data is in memory and will be lost on restart");
}

const telemetry = await setupTelemetry(telemetryConfig, {
  service: "omnisync-control-plane",
  log: (event, fields) => console.warn(JSON.stringify({ event, ...fields })),
});
const clientSecret = process.env["OMNISYNC_OIDC_CLIENT_SECRET"];
const deviceVerificationUrl = process.env["OMNISYNC_DEVICE_VERIFICATION_URL"];
const app = await createControlPlane(
  {
    oidc: {
      issuerUrl: need("OMNISYNC_OIDC_ISSUER"),
      clientId: need("OMNISYNC_OIDC_CLIENT_ID"),
      ...(clientSecret ? { clientSecret } : {}),
      redirectUri: need("OMNISYNC_OIDC_REDIRECT_URI"),
    },
    issuer: signerFromKeyPair(issuerKey),
    sessionSecret: hexToBytes(need("OMNISYNC_SESSION_SECRET")),
    trustProxy: parseTrustProxy(process.env["OMNISYNC_TRUST_PROXY"]),
    adminEmails: (process.env["OMNISYNC_ADMIN_EMAILS"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    returnTo: (process.env["OMNISYNC_RETURN_TO"] ?? "").split(",").map((s) => s.trim()).filter(Boolean),
    ...(deviceVerificationUrl ? { deviceLogin: { verificationUrl: deviceVerificationUrl } } : {}),
    ...(ledger ? { ledger } : {}),
  },
  { identity, metrics: new ControlPlaneMetrics(telemetry.meter) },
);
await app.listen(port, "0.0.0.0");
console.warn(`control plane listening on :${port}; trust anchor (issuer public key): ${Buffer.from(issuerKey.publicKey).toString("hex")}`);
