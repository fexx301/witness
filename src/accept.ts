// Buyer acceptance of a mandate. PayPal's approval page shows the buyer only the payment, never a
// mandate's terms, so the buyer reads and accepts the terms here and then approves, at PayPal, a first
// payment that carries the mandate's hash and saves PayPal for the agent. Witness records the acceptance
// with that PayPal order, and later checks PayPal's own record of it (checkPayPalApproval).

import { readFileSync } from "node:fs";
import type { PayPalClient } from "./paypal/client.js";
import type { Order } from "./paypal/orders.js";
import type { Mandate, MandateStore } from "./mandate.js";

export const AMOUNT = /^\d{1,4}\.\d{2}$/;
// The sandbox merchant's name, as the buyer also sees it at PayPal.
const MERCHANT_NAME = "Witness test merchant";

export interface FirstOrder {
  item: string;
  amount: string;
}

// The first order must be one the mandate itself would allow.
export function firstOrderProblem(mandate: Mandate, first: FirstOrder): string | null {
  if (!first.item.trim() || first.item.length > 127) return "Name the first item (up to 127 characters).";
  if (!AMOUNT.test(first.amount) || Number(first.amount) <= 0) return "The amount must look like 16.00.";
  if (Number(first.amount) > Number(mandate.scope.max_amount_usd)) return `The amount is over the mandate's $${mandate.scope.max_amount_usd} cap.`;
  return null;
}

// Creates the PayPal order the buyer approves; returns PayPal's approval link.
export async function startAcceptance(client: PayPalClient, hash: string, first: FirstOrder, origin: string): Promise<string> {
  const { data } = await client.request<{ id: string; links?: { rel: string; href: string }[] }>("POST", "/v2/checkout/orders", {
    json: {
      intent: "CAPTURE",
      purchase_units: [{ description: first.item, custom_id: hash, amount: { currency_code: "USD", value: first.amount } }],
      payment_source: {
        paypal: {
          attributes: { vault: { store_in_vault: "ON_SUCCESS", usage_type: "MERCHANT", customer_type: "CONSUMER" } },
          experience_context: {
            return_url: `${origin}/accept/return`,
            cancel_url: `${origin}/accept/${hash}?item=${encodeURIComponent(first.item)}&amount=${first.amount}&cancelled=1`,
            user_action: "PAY_NOW",
            brand_name: MERCHANT_NAME,
          },
        },
      },
    },
  });
  const approve = data.links?.find((link) => link.rel === "payer-action")?.href;
  if (!approve) throw new Error(`PayPal returned no approval link for order ${data.id}.`);
  return approve;
}

export interface Accepted {
  hash: string;
  orderId: string;
  at: string;
  vaultId: string;
  alreadyRecorded: boolean;
}

// After the buyer approves at PayPal: capture the first payment and record the acceptance against PayPal's
// order. Returning to this page twice records the acceptance once.
export async function completeAcceptance(client: PayPalClient, mandates: MandateStore, orderId: string): Promise<Accepted> {
  const path = `/v2/checkout/orders/${encodeURIComponent(orderId)}`;
  await client.request("POST", `${path}/capture`, { json: {} }).catch(() => null);
  const order = (await client.request<Order>("GET", path)).data;
  const hash = order.purchase_units[0]?.custom_id ?? "";
  const capturedAt = order.purchase_units[0]?.payments?.captures?.[0]?.create_time;
  if (order.status !== "COMPLETED" || !capturedAt) throw new Error(`PayPal order ${order.id} is ${order.status ?? "unknown"}, not an approved payment.`);
  if (!mandates.find(hash)) throw new Error(`PayPal order ${order.id} carries no mandate Witness holds.`);
  const vaultId = order.payment_source?.paypal?.attributes?.vault?.id;
  // An agent's own charge carries the hash too, but never saves PayPal; only the buyer's approval does.
  if (!vaultId) throw new Error(`PayPal order ${order.id} did not save PayPal for the agent, so it is not an acceptance.`);
  const alreadyRecorded = mandates.lifecycle(hash).some((e) => e.event === "accepted" && e.paypal_order === order.id);
  if (!alreadyRecorded)
    mandates.record(hash, { event: "accepted", at: capturedAt, channel: `Witness acceptance page, then PayPal approval of order ${order.id}`, paypal_order: order.id });
  return { hash, orderId: order.id, at: capturedAt, vaultId, alreadyRecorded };
}

const escape = (text: string) => text.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
const LOGO = readFileSync(new URL("../assets/witness-logo.svg", import.meta.url), "utf8");
const day = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });
};
const time = (iso: string) => new Date(iso).toLocaleString("en-US", { dateStyle: "medium", timeStyle: "short", timeZone: "UTC", timeZoneName: "short" });

function page(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(title)}</title><style>
body{margin:0;background:#FBFBF8;color:#14243A;font:16px/1.5 Inter,system-ui,sans-serif}
main{max-width:560px;margin:40px auto;padding:0 16px}
.card{background:#fff;border:1px solid #DADDE3;border-radius:6px;padding:20px}
button{background:#2457D6;color:#fff;border:0;border-radius:6px;padding:10px 16px;font:inherit;cursor:pointer}
.muted{color:#5B6475;font-size:14px}code{font-size:13px}header svg{display:block;height:32px;width:auto;margin-bottom:24px}</style></head>
<body><main><header>${LOGO}</header>${body}</main></body></html>`;
}

export function acceptPage(mandate: Mandate, hash: string, first: FirstOrder, problem: string | null, cancelled: boolean): string {
  // shortcut: assumes a one-merchant mandate names this merchant; check its PayPal ID once Witness serves several.
  const [only, ...others] = mandate.scope.merchants;
  const merchants = only && !others.length ? `<strong>${MERCHANT_NAME}</strong> <span class="muted">(PayPal merchant ${escape(only)})</span>` : `PayPal merchants ${escape(mandate.scope.merchants.join(", "))}`;
  const instructions = mandate.instructions?.length ? `<p><strong>Item instructions</strong></p><ul>${mandate.instructions.map((i) => `<li>${escape(i)}</li>`).join("")}</ul>` : "";
  const action = problem
    ? `<p><strong>${escape(problem)}</strong></p>`
    : `<form method="post" action="/accept/${hash}"><input type="hidden" name="item" value="${escape(first.item)}"><input type="hidden" name="amount" value="${escape(first.amount)}">
<button type="submit">Accept and pay $${escape(first.amount)} with PayPal</button></form>`;
  return page(
    "Accept a mandate",
    `<h1>Let your shopping agent buy for you</h1><div class="card">
<p>Your shopping agent (<code>${escape(mandate.agent)}</code>) may buy <strong>${escape(mandate.scope.category)}</strong> from ${merchants}, up to <strong>$${escape(mandate.scope.max_amount_usd)}</strong> an order, until ${escape(day(mandate.valid_until))}.</p>
${instructions}
<p>First order, which you pay now: <strong>${escape(first.item)}</strong>, $${escape(first.amount)}. Approving it at PayPal also saves PayPal so your agent can reorder within these terms without you present.</p>
${cancelled ? `<p class="muted">You cancelled at PayPal. Nothing was accepted.</p>` : ""}${action}
<p class="muted">PayPal will show you the payment, not these terms, so Witness records that you accepted them here, linked to your PayPal approval. Mandate <code>${hash.slice(0, 12)}…</code></p></div>`,
  );
}

export function acceptedPage(accepted: Accepted): string {
  return page(
    "Mandate accepted",
    `<h1>Accepted</h1><div class="card"><p>Your acceptance is recorded, linked to PayPal order <code>${escape(accepted.orderId)}</code>, approved ${escape(time(accepted.at))}.</p>
<p>PayPal is saved for your agent.</p>
<p class="muted">Mandate <code>${accepted.hash.slice(0, 12)}…</code>${accepted.alreadyRecorded ? " · already recorded" : ""}</p></div>`,
  );
}

export const errorPage = (message: string) => page("Witness", `<div class="card"><p>${escape(message)}</p></div>`);
