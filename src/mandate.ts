// Buyer mandates: what a human authorized their shopping agent to buy.
// A mandate's SHA-256 travels on every agent order as the PayPal custom_id, so a
// dispute can be traced back to the exact mandate version it was made under.
// The hash proves the document is unchanged; it does not by itself prove who
// accepted it. Acceptance, amendment and revocation are separate lifecycle events.

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
  // Item-level instructions ("whole bean, not ground"). Optional so that earlier
  // mandates keep their hash: an absent field is hashed as absent.
  instructions: z.array(z.string()).optional(),
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
    .filter((key) => (value as Record<string, unknown>)[key] !== undefined)
    .sort()
    .map((key) => `${canonicalJson(key)}: ${canonicalJson((value as Record<string, unknown>)[key])}`);
  return `{${entries.join(", ")}}`;
}

export function mandateHash(mandate: Mandate): string {
  const { sha256: _ignored, ...body } = mandate;
  return createHash("sha256").update(canonicalJson(body)).digest("hex");
}

// --- lifecycle -----------------------------------------------------------------

export const LifecycleEventSchema = z.object({
  event: z.enum(["accepted", "superseded", "revoked", "imported"]),
  at: z.string(),
  // How acceptance was captured, e.g. "witness-wallet+paypal-approval:<order id>".
  channel: z.string().optional(),
  // For "superseded": the hash of the version that replaced this one.
  by: z.string().optional(),
  // For "accepted": the PayPal order the buyer approved when accepting, which carries the mandate's hash.
  paypal_order: z.string().optional(),
});
export type LifecycleEvent = z.infer<typeof LifecycleEventSchema>;

export type MandateStatus = "in_force" | "not_yet_accepted" | "superseded" | "revoked" | "expired" | "unknown";

// Which state the mandate was in at a given moment. Only Witness's own recorded
// events count; a mandate's self-declared approved_at is not acceptance evidence.
export function mandateStatusAt(mandate: Mandate, events: LifecycleEvent[], at: string | undefined): { status: MandateStatus; detail: string } {
  if (!at) return { status: "unknown", detail: "Purchase time unavailable, so the mandate version in force cannot be established." };
  const when = new Date(at).getTime();
  const accepted = events.find((e) => e.event === "accepted");
  if (!accepted) return { status: "unknown", detail: "No recorded acceptance of this mandate by the buyer." };
  if (new Date(accepted.at).getTime() > when)
    return { status: "not_yet_accepted", detail: `Accepted ${accepted.at}, after the purchase at ${at}.` };
  const ended = events
    .filter((e) => (e.event === "revoked" || e.event === "superseded") && new Date(e.at).getTime() <= when)
    .sort((a, b) => a.at.localeCompare(b.at))[0];
  if (ended?.event === "revoked") return { status: "revoked", detail: `Revoked ${ended.at}, before the purchase at ${at}.` };
  if (ended?.event === "superseded")
    return { status: "superseded", detail: `Replaced by ${ended.by?.slice(0, 12)}… at ${ended.at}, before the purchase at ${at}.` };
  if (when > new Date(`${mandate.valid_until}T23:59:59Z`).getTime())
    return { status: "expired", detail: `Expired ${mandate.valid_until}, before the purchase at ${at}.` };
  return { status: "in_force", detail: `Accepted ${accepted.at}${accepted.channel ? ` via ${accepted.channel}` : ""}; in force at the purchase (${at}).` };
}

export class MandateStore {
  constructor(private readonly dir: string) {}

  private lifecyclePath(hash: string) {
    return join(this.dir, `${hash}.lifecycle.json`);
  }

  save(mandate: Mandate): string {
    const hash = mandateHash(mandate);
    mkdirSync(this.dir, { recursive: true });
    writeFileSync(join(this.dir, `${hash}.json`), JSON.stringify({ ...mandate, sha256: hash }, null, 2) + "\n");
    return hash;
  }

  record(hash: string, event: LifecycleEvent): void {
    const events = this.lifecycle(hash);
    events.push(LifecycleEventSchema.parse(event));
    writeFileSync(this.lifecyclePath(hash), JSON.stringify(events, null, 2) + "\n");
  }

  lifecycle(hash: string): LifecycleEvent[] {
    const path = this.lifecyclePath(hash);
    return existsSync(path) ? z.array(LifecycleEventSchema).parse(JSON.parse(readFileSync(path, "utf8"))) : [];
  }

  find(hash: string | undefined): Mandate | null {
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) return null;
    const path = join(this.dir, `${hash}.json`);
    if (!existsSync(path)) return null;
    return MandateSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  }
}

// --- deterministic checks --------------------------------------------------------

export type CheckStatus = "pass" | "fail" | "unknown";
export interface MandateCheck {
  rule: "integrity" | "amount" | "merchant" | "in_force" | "paypal_approval";
  status: CheckStatus;
  detail: string;
}

export interface PurchaseFacts {
  amountUsd: number;
  merchantId?: string;
  merchantName?: string;
  purchasedAt?: string;
}

// Everything checkable exactly is checked here. Whether the item matches the
// buyer's instructions is a judgement the model makes, with sources.
export function checkMandate(mandate: Mandate, boundHash: string, purchase: PurchaseFacts, events: LifecycleEvent[]): MandateCheck[] {
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

  const state = mandateStatusAt(mandate, events, purchase.purchasedAt);
  checks.push({
    rule: "in_force",
    status: state.status === "in_force" ? "pass" : state.status === "unknown" ? "unknown" : "fail",
    detail: state.detail,
  });
  return checks;
}

// PayPal's own record of the payment the buyer approved when accepting the mandate.
export interface PayPalApproval {
  orderId: string;
  status?: string;
  customId?: string;
  payerId?: string;
  approvedAt?: string;
  vaultId?: string;
}

// PayPal never shows the buyer a mandate's terms, so acceptance is captured by Witness. When the buyer
// accepted by approving a PayPal payment that carries the mandate's hash, PayPal's record of that approval
// is checked: this mandate, the disputing buyer's own account, before the purchase.
export function checkPayPalApproval(approval: PayPalApproval | null, boundHash: string, buyerPayerId: string | undefined, purchasedAt: string | undefined): MandateCheck {
  const rule = "paypal_approval";
  if (!approval) return { rule, status: "unknown", detail: "The PayPal approval linked to the buyer's acceptance could not be read." };
  const order = `PayPal order ${approval.orderId}`;
  if (approval.status !== "COMPLETED") return { rule, status: "unknown", detail: `${order} is ${approval.status ?? "in an unknown state"}, not an approved payment.` };
  if (approval.customId !== boundHash)
    return { rule, status: "fail", detail: `${order} carries mandate ${approval.customId?.slice(0, 12) ?? "none"}…, not this one.` };
  if (!buyerPayerId || !approval.payerId) return { rule, status: "unknown", detail: `${order} cannot be compared with the disputing buyer's PayPal account.` };
  if (approval.payerId !== buyerPayerId)
    return { rule, status: "fail", detail: `${order} was approved by PayPal account ${approval.payerId}, not the disputing buyer's ${buyerPayerId}.` };
  if (!approval.approvedAt || !purchasedAt) return { rule, status: "unknown", detail: `${order} or the purchase has no time to compare.` };
  if (new Date(approval.approvedAt).getTime() > new Date(purchasedAt).getTime())
    return { rule, status: "fail", detail: `${order} was approved at ${approval.approvedAt}, after the purchase at ${purchasedAt}.` };
  return {
    rule,
    status: "pass",
    detail: `PayPal confirms the buyer's own account approved ${order.replace("PayPal ", "")}, carrying this mandate, at ${approval.approvedAt}${approval.vaultId ? `, saving PayPal for the agent` : ""}.`,
  };
}
