// Minimal PayPal REST client. Sandbox only: Witness never touches live funds.

import { randomUUID } from "node:crypto";

const SANDBOX_API = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    readonly status: number,
    readonly debugId: string | null,
    readonly issue: string | null,
    readonly body: unknown,
  ) {
    super(`PayPal ${status}${issue ? ` ${issue}` : ""}${debugId ? ` (debug_id ${debugId})` : ""}`);
  }
}

export interface PayPalCredentials {
  clientId: string;
  clientSecret: string;
  env: string;
}

export function credentialsFromEnv(env: NodeJS.ProcessEnv = process.env): PayPalCredentials {
  const clientId = env.PAYPAL_CLIENT_ID;
  const clientSecret = env.PAYPAL_CLIENT_SECRET;
  const mode = env.PAYPAL_ENV ?? "sandbox";
  if (!clientId || !clientSecret) throw new Error("PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required");
  if (mode !== "sandbox") throw new Error("Witness runs against the PayPal sandbox only (PAYPAL_ENV=sandbox)");
  return { clientId, clientSecret, env: mode };
}

export type Body =
  | { json: unknown }
  | { multipart: { input: unknown; files?: { name: string; filename: string; contentType: string; data: string }[] } };

export class PayPalClient {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly credentials: PayPalCredentials,
    private readonly fetchImpl: typeof fetch = fetch,
    private readonly baseUrl: string = SANDBOX_API,
  ) {}

  private async accessToken(): Promise<string> {
    if (this.token && Date.now() < this.token.expiresAt - 60_000) return this.token.value;
    const basic = Buffer.from(`${this.credentials.clientId}:${this.credentials.clientSecret}`).toString("base64");
    const response = await this.fetchImpl(`${this.baseUrl}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    if (!response.ok) throw new PayPalError(response.status, response.headers.get("paypal-debug-id"), "OAUTH_FAILED", null);
    const data = (await response.json()) as { access_token: string; expires_in: number };
    this.token = { value: data.access_token, expiresAt: Date.now() + data.expires_in * 1000 };
    return data.access_token;
  }

  async request<T>(method: string, path: string, body?: Body): Promise<{ data: T; debugId: string | null }> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "PayPal-Request-Id": randomUUID(),
      Prefer: "return=representation",
    };
    let payload: BodyInit | undefined;
    if (body && "json" in body) {
      headers["Content-Type"] = "application/json";
      payload = JSON.stringify(body.json);
    } else if (body && "multipart" in body) {
      const form = new FormData();
      form.set("input", new Blob([JSON.stringify(body.multipart.input)], { type: "application/json" }));
      for (const file of body.multipart.files ?? []) {
        form.set(file.name, new Blob([file.data], { type: file.contentType }), file.filename);
      }
      payload = form;
    }
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, { method, headers, body: payload });
    const debugId = response.headers.get("paypal-debug-id");
    const text = await response.text();
    const data = text ? JSON.parse(text) : {};
    if (!response.ok) {
      const issue = (data?.details?.[0]?.issue as string | undefined) ?? (data?.name as string | undefined) ?? null;
      throw new PayPalError(response.status, debugId, issue, data);
    }
    return { data: data as T, debugId };
  }
}
