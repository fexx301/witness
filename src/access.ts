// Who is asking. On a hosted desk the API listens on loopback behind a reverse proxy, so the bound address
// says nothing about the visitor: every proxied request carries X-Forwarded-For, and only a direct request
// from this machine counts as local. Also: which browser requests are same-origin, what visitors may see,
// and the numeric limits read from the environment.

import type { IncomingHttpHeaders } from "node:http";

const LOOPBACK = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

export function isLocalRequest(headers: IncomingHttpHeaders, remoteAddress: string | undefined): boolean {
  return !headers["x-forwarded-for"] && !headers.forwarded && LOOPBACK.has(remoteAddress ?? "");
}

// A number of uses per UTC day.
export class DailyCount {
  private day = "";
  private used = 0;
  constructor(private readonly limit: number, private readonly today = () => new Date().toISOString().slice(0, 10)) {}

  take(): boolean {
    if (this.day !== this.today()) [this.day, this.used] = [this.today(), 0];
    if (this.used >= this.limit) return false;
    this.used += 1;
    return true;
  }
}

// A browser request from another site is refused: a page elsewhere must not drive this desk's POSTs.
// Browsers say where a request came from (Sec-Fetch-Site, else Origin); a request with neither header
// comes from a script or the CLI, not a browser, so there is no visitor to forge it for.
export function sameOriginRequest(headers: IncomingHttpHeaders, allowedOrigins: string[]): boolean {
  const site = headers["sec-fetch-site"];
  if (site) return site === "same-origin" || site === "none";
  const origin = headers.origin;
  return !origin || allowedOrigins.includes(origin);
}

// PayPal payer IDs (13 capitals and digits) are replaced before a visitor sees a record. Merchant IDs
// have the same shape and are replaced too.
const PAYER_ID = /\b(?=[A-Z0-9]{13}\b)(?=[A-Z0-9]*[A-Z])(?=[A-Z0-9]*\d)[A-Z0-9]{13}\b/g;
export const redactPayerIds = <T>(value: T): T => JSON.parse(JSON.stringify(value).replace(PAYER_ID, "[PayPal account]")) as T;

// A numeric setting from the environment. A typo must stop the server, not quietly become NaN, which
// would turn a spending limit into no limit.
export function envNumber(env: NodeJS.ProcessEnv, name: string, fallback: number, { min = 0, integer = false } = {}): number {
  const raw = env[name];
  const value = raw === undefined || raw.trim() === "" ? fallback : Number(raw);
  if (!Number.isFinite(value) || value < min || (integer && !Number.isInteger(value)))
    throw new Error(`${name} must be ${integer ? "a whole number" : "a number"} of at least ${min}, not "${raw}".`);
  return value;
}
