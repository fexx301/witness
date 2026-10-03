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
  create_time?: string;
  purchase_units: {
    description?: string;
    custom_id?: string;
    payee?: { merchant_id?: string; display_data?: { brand_name?: string } };
    shipping?: {
      address?: { admin_area_2?: string; admin_area_1?: string; country_code?: string };
      trackers?: { id: string; status: string }[];
    };
  }[];
}

export interface Tracking {
  carrier?: string;
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
}

// PayPal tracker ids have the form "<capture id>-<tracking number>".
export function trackingFromOrder(order: Order): Tracking[] {
  return order.purchase_units.flatMap((unit) =>
    (unit.shipping?.trackers ?? []).map((tracker) => ({
      trackingNumber: tracker.id.includes("-") ? tracker.id.slice(tracker.id.indexOf("-") + 1) : tracker.id,
      status: tracker.status,
    })),
  );
}
