// Builds each predeclared case into the PayPal responses Witness would read, and runs it through the real
// pipeline as a dry run. Each case and assessor gets its own runs folder, so records never overwrite.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { Assessor, Decision } from "../src/decide.js";
import { mandateHash, MandateSchema, MandateStore, type Mandate } from "../src/mandate.js";
import type { MerchantPolicy } from "../src/policy.js";
import { PayPalClient } from "../src/paypal/client.js";
import { Disputes } from "../src/paypal/disputes.js";
import { Orders } from "../src/paypal/orders.js";
import { processDispute } from "../src/witness.js";
import { ACCEPTED, PURCHASED_AT, type EvalCase } from "./cases.js";

export const EVAL_POLICY: MerchantPolicy = {
  name: "demo merchant (synthetic eval)",
  agentInstructionMismatch: "refund",
  listingMismatch: "propose_return",
  confirmedNonDelivery: "refund",
  unauthorizedCharge: "refund",
};

const MERCHANT = "7ZCSEN3JAJJPG";
const BUYER = { email: "buyer@example.com", payer_id: "EVALBUYER01", name: "Test Buyer" };

// Each recorded acceptance is linked to the PayPal order the buyer approved when accepting, as on the
// acceptance page; casePayPal serves that order. The predeclared cases themselves are unchanged.
const approvalOrder = (c: EvalCase) => `EVALAPPROVAL${c.id}`;

// One mandate per case, so each case's lifecycle stands alone.
export function caseMandate(c: EvalCase): Mandate | null {
  if (!c.mandate) return null;
  return MandateSchema.parse({
    kind: "witness.mandate.v1",
    principal: "synthetic buyer",
    agent: "witness-reference-shopper",
    scope: { max_amount_usd: c.mandate.cap ?? "40.00", merchants: [MERCHANT], category: "coffee beans" },
    instructions: c.mandate.instructions,
    valid_until: "2026-12-31",
    approved_at: `2026-10-01T09:00:00+00:00 (eval ${c.id})`,
  });
}

export function caseStore(dir: string, cases: EvalCase[]): MandateStore {
  const store = new MandateStore(dir);
  for (const c of cases) {
    const mandate = caseMandate(c);
    if (!mandate) continue;
    const hash = store.save(mandate);
    if (!store.lifecycle(hash).length)
      for (const event of c.mandate!.lifecycle ?? ACCEPTED) store.record(hash, event.event === "accepted" ? { ...event, paypal_order: approvalOrder(c) } : event);
  }
  return store;
}

export function casePayPal(c: EvalCase): { client: PayPalClient; disputeId: string } {
  const n = c.id.replace(/\D/g, "").padStart(2, "0");
  const disputeId = `PP-R-EVAL-${c.id}`;
  const captureId = `EVALCAPTURE${c.id}${n}`;
  const orderId = `EVALORDER${c.id}${n}`;
  const trackerId = `${captureId}-94001118992231974285${n}`;
  const mandate = caseMandate(c);
  const [first = "", ...rest] = c.buyer;
  const dispute = {
    dispute_id: disputeId,
    create_time: "2026-10-12T09:00:00Z",
    reason: c.reason,
    status: "WAITING_FOR_SELLER_RESPONSE",
    dispute_life_cycle_stage: "INQUIRY",
    dispute_amount: { currency_code: "USD", value: c.amount },
    disputed_transactions: [
      {
        seller_transaction_id: captureId,
        custom: mandate ? mandateHash(mandate) : undefined,
        buyer: BUYER,
        items: [{ item_name: c.ordered, item_description: c.ordered, reason: c.reason, notes: first }],
      },
    ],
    messages: [
      ...rest.map((content) => ({ posted_by: "BUYER", time_posted: "2026-10-12T09:05:00Z", content })),
      ...(c.seller ?? []).map((content) => ({ posted_by: "SELLER", time_posted: "2026-10-12T10:00:00Z", content })),
    ],
    evidences: [],
    allowed_response_options: { accept_claim: { accept_claim_types: ["REFUND", "REFUND_WITH_RETURN"] } },
    links: ["provide_evidence", "accept_claim", "send_message"].map((rel) => ({ rel, href: "", method: "POST" })),
  };
  const capture = {
    id: captureId,
    status: "COMPLETED",
    create_time: PURCHASED_AT,
    amount: { currency_code: "USD", value: c.amount },
    custom_id: dispute.disputed_transactions[0]!.custom,
    supplementary_data: { related_ids: { order_id: orderId } },
    payee: { merchant_id: MERCHANT },
  };
  const trackerStatus = { delivered: "SHIPPED", shipped: "SHIPPED", cancelled: "CANCELLED", none: null }[c.delivery];
  const order = {
    id: orderId,
    status: "COMPLETED",
    create_time: PURCHASED_AT,
    purchase_units: [
      {
        description: c.ordered,
        custom_id: capture.custom_id,
        payee: { merchant_id: MERCHANT },
        shipping: { trackers: trackerStatus ? [{ id: trackerId, status: trackerStatus }] : [] },
      },
    ],
  };
  // The order the disputing buyer approved when accepting the mandate, captured at the acceptance time.
  const acceptedAt = (c.mandate?.lifecycle ?? ACCEPTED).filter((e) => e.event === "accepted").at(-1)?.at;
  const approval = {
    id: approvalOrder(c),
    status: "COMPLETED",
    payer: { payer_id: BUYER.payer_id },
    purchase_units: [{ custom_id: capture.custom_id, payments: { captures: [{ id: `${approvalOrder(c)}CAP`, status: "COMPLETED", create_time: acceptedAt }] } }],
    payment_source: { paypal: { attributes: { vault: { id: `EVALVAULT${c.id}`, status: "VAULTED" } } } },
  };
  // As in the real API, only the v1 tracking API can say DELIVERED.
  const routes: Record<string, unknown> = {
    ...(acceptedAt ? { [`/v2/checkout/orders/${approvalOrder(c)}`]: approval } : {}),
    [`/v1/customer/disputes/${disputeId}`]: dispute,
    [`/v2/payments/captures/${captureId}`]: capture,
    [`/v2/checkout/orders/${orderId}`]: order,
    ...(c.delivery === "delivered" ? { [`/v1/shipping/trackers/${trackerId}`]: { status: "DELIVERED", carrier: "USPS" } } : {}),
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    if (init?.method === "POST") throw new Error("The eval is a dry run: no writes to PayPal.");
    const body = routes[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ details: [{ issue: "INVALID_RESOURCE_ID" }] }), { status: 404 });
  }) as typeof fetch;
  return { client: new PayPalClient({ clientId: "eval", clientSecret: "eval", env: "sandbox" }, fetchImpl), disputeId };
}

export interface CaseResult {
  case: string;
  assessor: string;
  expected: string;
  action: Decision["action"];
  correct: boolean;
  discrepancy: string | null;
  // Statements the model wrote whose citations did not hold up, so code did not send them.
  dropped: number;
  findings: Record<string, string>;
  seconds: number;
  error?: string;
}

export async function runCase(c: EvalCase, assessor: Assessor, store: MandateStore, runsRoot: string): Promise<CaseResult> {
  const { client, disputeId } = casePayPal(c);
  const runsDir = join(runsRoot, c.id, assessor.model.replace(/[^a-z0-9.-]+/gi, "_"));
  mkdirSync(runsDir, { recursive: true });
  const started = Date.now();
  const record = await processDispute(
    { disputes: new Disputes(client), orders: new Orders(client), mandates: store, assessor, policy: EVAL_POLICY, runsDir, now: () => new Date("2026-10-12T12:00:00Z") },
    disputeId,
    { execute: false },
  );
  return {
    case: c.id,
    assessor: record.model,
    expected: c.expected,
    action: record.decision.action,
    correct: record.decision.action === c.expected,
    discrepancy: record.decision.discrepancy ?? null,
    dropped: record.writing.dropped.length,
    findings: Object.fromEntries(record.findings.map((f) => [f.key, f.status])),
    seconds: (Date.now() - started) / 1000,
  };
}
