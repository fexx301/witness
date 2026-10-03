// Buyer mandates: what a human authorized their shopping agent to buy.
// A mandate's SHA-256 travels on every agent order as the PayPal custom_id, so a
// dispute can be traced back to the exact authorization it was made under.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";

export const MandateSchema = z.object({
  kind: z.string(),
  principal: z.string(),
  agent: z.string(),
  scope: z.object({
    max_amount_usd: z.string(),
    merchants: z.array(z.string()),
    category: z.string(),
  }),
  valid_until: z.string(),
  approved_at: z.string(),
  sha256: z.string().optional(),
});
export type Mandate = z.infer<typeof MandateSchema>;

// Canonical form: keys sorted, separators ", " and ": ", non-ASCII escaped. This
// matches Python's json.dumps(sort_keys=True), which produced the first mandates.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value).replace(/[\u007f-￿]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
  }
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(", ")}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((key) => `${canonicalJson(key)}: ${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(", ")}}`;
}

export function mandateHash(mandate: Mandate): string {
  const { sha256: _ignored, ...body } = mandate;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

export class MandateStore {
  constructor(private readonly dir: string) {}

  save(mandate: Mandate): string {
    const hash = mandateHash(mandate);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${hash}.json`), JSON.stringify({ ...mandate, sha256: hash }, null, 2) + "\n");
    return hash;
  }

  find(hash: string | undefined): Mandate | null {
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
    const path = join(this.dir, `${hash}.json`);
    if (!existsSync(path)) return null;
    return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
}

export type CheckStatus = "pass" | "fail" | "unknown";
export interface MandateCheck {
  rule: "integrity" | "amount" | "merchant" | "validity";
  status: CheckStatus;
  detail: string;
}

export interface PurchaseFacts {
  amountUsd: number;
  merchantId?: string;
  merchantName?: string;
  purchasedAt?: string;
}

// Deterministic checks. Category fit ("is this the coffee they meant?") is a
// judgement the AI makes; everything that can be checked exactly is checked here.
export function checkMandate(mandate: Mandate, boundHash: string, purchase: PurchaseFacts): MandateCheck[] {
  const checks: MandateCheck[] = [];
  const actual = mandateHash(mandate);
  checks.push(
    actual === boundHash
      ? { rule: "integrity", status: "pass", detail: "Mandate content matches the hash bound to the order." }
      : { rule: "integrity", status: "fail", detail: `Mandate content hashes to ${actual.slice(0, 12)}…, not the order's ${boundHash.slice(0, 12)}…` },
  );

  const cap = Number(mandate.scope.max_amount_usd);
  checks.push(
    Number.isFinite(cap) && purchase.amountUsd <= cap
      ? { rule: "amount", status: "pass", detail: `$${purchase.amountUsd.toFixed(2)} is within the $${cap.toFixed(2)} cap.` }
      : { rule: "amount", status: "fail", detail: `$${purchase.amountUsd.toFixed(2)} exceeds the $${mandate.scope.max_amount_usd} cap.` },
  );

  const allowed = mandate.scope.merchants.map((m) => m.toLowerCase());
  const candidates = [purchase.merchantId, purchase.merchantName].filter(Boolean).map((m) => m!.toLowerCase());
  checks.push(
    candidates.some((c) => allowed.includes(c))
      ? { rule: "merchant", status: "pass", detail: "Merchant is named in the mandate." }
      : {
          rule: "merchant",
          status: "unknown",
          detail: `Mandate names ${mandate.scope.merchants.join(", ")}; the order's merchant is ${purchase.merchantName ?? "?"} (${purchase.merchantId ?? "?"}).`,
        },
  );

  if (purchase.purchasedAt) {
    const within = new Date(purchase.purchasedAt) <= new Date(`${mandate.valid_until}T23:59:59Z`);
    checks.push(
      within
        ? { rule: "validity", status: "pass", detail: `Purchased ${purchase.purchasedAt.slice(0, 10)}, before the mandate expired on ${mandate.valid_until}.` }
        : { rule: "validity", status: "fail", detail: `Purchased ${purchase.purchasedAt.slice(0, 10)}, after the mandate expired on ${mandate.valid_until}.` },
    );
  } else {
    checks.push({ rule: "validity", status: "unknown", detail: "Purchase time unavailable." });
  }
  return checks;
}
