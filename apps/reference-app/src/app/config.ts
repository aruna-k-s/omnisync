/** `config.json` next to `index.html`: where the control plane (login, enrollment) and the gateway (sync) are. */
export interface AppConfig {
  controlPlane: string;
  gateway: string;
}

const HOST = "[A-Za-z0-9.-]+(:[0-9]{1,5})?";

export function parseConfig(v: unknown): AppConfig {
  const o = typeof v === "object" && v !== null ? (v as { controlPlane?: unknown; gateway?: unknown }) : {};
  if (typeof o.controlPlane !== "string" || typeof o.gateway !== "string") throw new Error("config.json needs controlPlane and gateway");
  const controlPlane = o.controlPlane.replace(/\/+$/, "");
  const gateway = o.gateway.replace(/\/+$/, "");
  if (controlPlane !== "" && !new RegExp(`^https?://${HOST}$`).test(controlPlane)) throw new Error("controlPlane must be an origin such as https://cp.example.com");
  if (!new RegExp(`^wss?://${HOST}$`).test(gateway)) throw new Error("gateway must be a WebSocket origin such as wss://sync.example.com");
  return { controlPlane, gateway };
}
