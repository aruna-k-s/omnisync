import { metrics, type Counter, type Histogram, type Meter } from "@opentelemetry/api";
import { SECONDS_BUCKETS, pick, safely, validSeconds } from "./safe.js";

const METHODS = ["GET", "POST", "PUT", "DELETE", "OPTIONS", "HEAD"] as const;
const MAX_ROUTES = 64;
/** A route template as Fastify spells it: path segments and `:param` names. Anything else is not trusted as a label. */
const ROUTE = /^\/[A-Za-z0-9/_:.*-]{0,99}$/;

export interface HttpResult {
  /** The route template (`/v1/documents/:id/grants`), never the URL. Undefined when no route matched. */
  readonly route: string | undefined;
  readonly method: string;
  readonly status: number;
  readonly seconds: number;
}

export class ControlPlaneMetrics {
  readonly #meter: Meter;
  #http: Histogram | undefined;
  #logins: Counter | undefined;
  #issued: Counter | undefined;
  #limited: Counter | undefined;
  readonly #routes = new Set<string>();

  constructor(meter?: Meter) {
    this.#meter = meter ?? metrics.getMeter("omnisync");
    safely(() => {
      this.#http = this.#meter.createHistogram("omnisync_http_request_seconds", {
        description: "Control plane request time by route template, method and status class",
        advice: { explicitBucketBoundaries: SECONDS_BUCKETS },
      });
    });
    safely(() => {
      this.#logins = this.#meter.createCounter("omnisync_logins_total", { description: "Results of the OIDC callback route" });
    });
    safely(() => {
      this.#issued = this.#meter.createCounter("omnisync_certificates_issued_total", { description: "Successful certificate issuances" });
    });
    safely(() => {
      this.#limited = this.#meter.createCounter("omnisync_rate_limited_total", { description: "Requests answered 429, by route" });
    });
  }

  /** Records one finished request. Counters are derived here from route and status, so no controller changes. */
  request(r: HttpResult): void {
    if (!validSeconds(r.seconds)) return;
    safely(() => {
      const route = this.#routeLabel(r.route);
      const method = pick(METHODS, r.method);
      const ok = Number.isInteger(r.status) && r.status >= 200 && r.status <= 599;
      const statusClass = ok ? `${Math.floor(r.status / 100)}xx` : "other";
      this.#http?.record(r.seconds, { route, method, status_class: statusClass });
      if (r.route === "/v1/auth/callback" && method === "GET" && ok) {
        this.#logins?.add(1, { outcome: r.status < 400 ? "ok" : "failed" });
      }
      if (r.route === "/v1/certificates" && method === "POST" && ok && r.status < 300) this.#issued?.add(1);
      if (r.status === 429) this.#limited?.add(1, { route });
    });
  }

  /** Route templates are bounded twice: by shape, and by how many distinct ones are ever reported. */
  #routeLabel(route: string | undefined): string {
    if (route === undefined || !ROUTE.test(route)) return "unmatched";
    if (!this.#routes.has(route)) {
      if (this.#routes.size >= MAX_ROUTES) return "other";
      this.#routes.add(route);
    }
    return route;
  }
}
