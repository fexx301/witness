// Who is asking. On a hosted desk the API listens on loopback behind a reverse proxy, so the bound address
// says nothing about the visitor: every proxied request carries X-Forwarded-For, and only a direct request
// from this machine counts as local.

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
