// Load script for the OmniSync control plane's HTTP surface (spec: docs/specs/load.md).
//
//   K6_BASE_URL=https://api.example.com \
//   K6_SESSION_TOKEN=... K6_ADMIN_TOKEN=... \
//   k6 run deploy/load/control-plane.k6.js
//
// Read-only: it calls GET routes only. It never issues a certificate, creates a document, changes a grant, or touches
// the OIDC and device-login routes, so a run leaves no state behind. Tokens come from the environment; they are not
// printed, tagged or written to the summary. Point it at a test deployment, not at production.
//
// Nothing has executed this script yet. CI checks that it parses (`k6 inspect`) and keeps its shape.
import http from "k6/http";
import { check } from "k6";

const BASE = (__ENV.K6_BASE_URL || "").replace(/\/+$/, "");
const SESSION = __ENV.K6_SESSION_TOKEN || "";
const ADMIN = __ENV.K6_ADMIN_TOKEN || "";
const RATE = Number(__ENV.K6_RATE || 50);
const DURATION = __ENV.K6_DURATION || "2m";

function scenario(exec, rate) {
  return { executor: "constant-arrival-rate", exec, rate, timeUnit: "1s", duration: DURATION, preAllocatedVUs: 20, maxVUs: 200 };
}

export const options = {
  scenarios: {
    health: scenario("health", RATE),
    me: scenario("me", Math.max(1, Math.floor(RATE / 2))),
    admin_lists: scenario("adminLists", Math.max(1, Math.floor(RATE / 10))),
  },
  thresholds: {
    // 429 is the control plane's own rate limit doing its job; it is counted apart, not as a failure.
    "http_req_failed{scenario:health}": ["rate<0.01"],
    "http_req_failed{scenario:me}": ["rate<0.01"],
    "http_req_failed{scenario:admin_lists}": ["rate<0.01"],
    "http_req_duration{scenario:health}": ["p(95)<300"],
    "http_req_duration{scenario:me}": ["p(95)<300"],
    "http_req_duration{scenario:admin_lists}": ["p(95)<300"],
  },
  // Do not record URLs with identifiers or tokens as tags.
  systemTags: ["scenario", "status", "method", "name"],
  summaryTrendStats: ["avg", "med", "p(90)", "p(95)", "p(99)", "max"],
};

export function setup() {
  if (!/^https?:\/\/[^/\s]+/.test(BASE)) throw new Error("set K6_BASE_URL to the control plane's base URL");
  if (!SESSION) throw new Error("set K6_SESSION_TOKEN to a session token for the me scenario");
  if (!ADMIN) throw new Error("set K6_ADMIN_TOKEN to an organisation admin's session token for the admin_lists scenario");
}

const get = (path, token) =>
  http.get(`${BASE}${path}`, {
    headers: token ? { authorization: `Bearer ${token}` } : {},
    tags: { name: path },
    responseCallback: http.expectedStatuses({ min: 200, max: 299 }, 429),
  });

export function health() {
  const r = get("/healthz");
  check(r, { "healthz is ok": (x) => x.status === 200 || x.status === 429 });
}

export function me() {
  const r = get("/v1/me", SESSION);
  check(r, { "me is ok": (x) => x.status === 200 || x.status === 429 });
}

export function adminLists() {
  for (const path of ["/v1/admin/documents", "/v1/admin/principals"]) {
    const r = get(path, ADMIN);
    check(r, { [`${path} is ok`]: (x) => x.status === 200 || x.status === 429 });
  }
}
