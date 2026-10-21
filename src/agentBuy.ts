// The reference shopping agent, for staging demo cases in the sandbox: it charges the buyer's saved PayPal
// with no buyer present, binding the mandate's hash to the order as custom_id, as a real agent would. It
// buys whatever it is told to, including the wrong variant, because that is what the demo disputes are about.
// The merchant's side, shipping and delivery, is recorded separately.

import { AMOUNT } from "./accept.js";
import type { PayPalClient } from "./paypal/client.js";

export interface AgentPurchase {
  orderId: string;
  captureId: string;
  capturedAt?: string;
}

interface CreatedOrder {
  id: string;
  status: string;
  purchase_units?: { payments?: { captures?: { id: string; status: string; create_time?: string }[] } }[];
}

export async function agentPurchase(client: PayPalClient, mandateHash: string, vaultId: string, item: string, amount: string): Promise<AgentPurchase> {
  if (!/^[0-9a-f]{64}$/.test(mandateHash)) throw new Error("The mandate hash must be 64 hex characters.");
  if (!AMOUNT.test(amount) || Number(amount) <= 0) throw new Error("The amount must look like 16.00.");
  if (!item.trim() || item.length > 127) throw new Error("Name the item (up to 127 characters).");
  const created = (
    await client.request<CreatedOrder>("POST", "/v2/checkout/orders", {
      json: {
        intent: "CAPTURE",
        purchase_units: [
          { description: item, custom_id: mandateHash, invoice_id: `witness-agent-${Date.now()}`, amount: { currency_code: "USD", value: amount } },
        ],
        payment_source: { paypal: { vault_id: vaultId } },
      },
    })
  ).data;
  // A saved-PayPal charge usually completes on creation; otherwise capture it.
  const order = created.status === "COMPLETED" ? created : (await client.request<CreatedOrder>("POST", `/v2/checkout/orders/${created.id}/capture`, { json: {} })).data;
  const capture = order.purchase_units?.[0]?.payments?.captures?.[0];
  if (order.status !== "COMPLETED" || !capture) throw new Error(`PayPal order ${created.id} is ${order.status}, not paid.`);
  return { orderId: created.id, captureId: capture.id, capturedAt: capture.create_time };
}

// The merchant ships, and optionally records delivery. Orders v2 trackers can only say SHIPPED; the v1
// tracking API records DELIVERED, which is what Witness reads.
export async function recordShipment(client: PayPalClient, purchase: AgentPurchase, delivered: boolean, trackingNumber = `9400111899223${String(Date.now()).slice(-9)}`) {
  await client.request("POST", `/v2/checkout/orders/${purchase.orderId}/track`, {
    json: { capture_id: purchase.captureId, tracking_number: trackingNumber, carrier: "USPS", notify_payer: false },
  });
  if (delivered)
    await client.request("PUT", `/v1/shipping/trackers/${purchase.captureId}-${trackingNumber}`, {
      json: { transaction_id: purchase.captureId, tracking_number: trackingNumber, status: "DELIVERED", carrier: "USPS" },
    });
  return { trackingNumber, status: delivered ? "DELIVERED" : "SHIPPED" };
}
