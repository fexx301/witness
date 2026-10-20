// Orders and payments lookups Witness uses to assemble evidence.

import type { PayPalClient } from "./client.js";

export interface Capture {
  id: string;
  status: string;
  create_time?: string;
  amount: { currency_code: string; value: string };
  custom_id?: string;
  supplementary_data?: { related_ids?: { order_id?: string } };
  payee?: { merchant_id?: string; email_address?: string };
}

export interface Order {
  id: string;
  status?: string;
  create_time?: string;
  payer?: { payer_id?: string };
  payment_source?: { paypal?: { attributes?: { vault?: { id?: string; status?: string } } } };
  purchase_units: {
    description?: string;
    custom_id?: string;
    payments?: { captures?: { id: string; status: string; create_time?: string }[] };
    payee?: { merchant_id?: string; display_data?: { brand_name?: string } };
    shipping?: {
      address?: { admin_area_2?: string; admin_area_1?: string; country_code?: string };
      trackers?: { id: string; status: string }[];
    };
  }[];
}

export interface Tracking {
  carrier?: string;
  // "<capture id>-<tracking number>", the id both the order and the v1 tracking API use.
  trackerId?: string;
  trackingNumber: string;
  // PayPal tracker status set by the merchant: SHIPPED, ON_HOLD, DELIVERED, CANCELLED.
  status: string;
  // A carrier's own confirmation, when one is available (e.g. LOST, RETURNED_TO_SENDER).
  carrierStatus?: string;
}

export class Orders {
  constructor(private readonly client: PayPalClient) {}

  async capture(id: string): Promise<Capture> {
    return (await this.client.request<Capture>("GET", `/v2/payments/captures/${encodeURIComponent(id)}`)).data;
  }

  async order(id: string): Promise<Order> {
    return (await this.client.request<Order>("GET", `/v2/checkout/orders/${encodeURIComponent(id)}`)).data;
  }

  // Orders v2 trackers can only say SHIPPED or CANCELLED; the v1 tracking API also records DELIVERED.
  async tracker(id: string): Promise<{ status?: string; carrier?: string }> {
    return (await this.client.request<{ status?: string; carrier?: string }>("GET", `/v1/shipping/trackers/${encodeURIComponent(id)}`)).data;
  }
}

// PayPal tracker ids have the form "<capture id>-<tracking number>".
export function trackingFromOrder(order: Order): Tracking[] {
  return order.purchase_units.flatMap((unit) =>
    (unit.shipping?.trackers ?? []).map((tracker) => ({
      trackerId: tracker.id,
      trackingNumber: tracker.id.includes("-") ? tracker.id.slice(tracker.id.indexOf("-") + 1) : tracker.id,
      status: tracker.status,
    })),
  );
}
