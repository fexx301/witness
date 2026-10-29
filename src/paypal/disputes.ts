// PayPal Disputes API (v1). Only the fields Witness reads are typed.

import type { PayPalClient } from "./client.js";
import type { ReturnAddress } from "../policy.js";

export interface Money {
  currency_code: string;
  value: string;
}

export interface RawDispute {
  dispute_id: string;
  status: string;
  reason: string;
  dispute_life_cycle_stage: string;
  dispute_channel?: string;
  create_time?: string;
  seller_response_due_date?: string;
  dispute_amount: Money;
  disputed_transactions?: {
    seller_transaction_id?: string;
    buyer_transaction_id?: string;
    gross_amount?: Money;
    custom?: string;
    buyer?: { payer_id?: string };
    items?: { item_name?: string; item_description?: string; reason?: string; notes?: string }[];
  }[];
  messages?: { posted_by: string; time_posted: string; content: string }[];
  evidences?: { evidence_type: string; source: string; notes?: string; date?: string; dispute_life_cycle_stage?: string }[];
  allowed_response_options?: {
    accept_claim?: { accept_claim_types?: string[] };
    make_offer?: { offer_types?: string[] };
  };
  dispute_outcome?: { outcome_code?: string };
  links?: { rel: string; href: string; method: string }[];
}

export interface DisputeSummary {
  dispute_id: string;
  status: string;
  reason: string;
  dispute_life_cycle_stage?: string;
  dispute_amount: Money;
  create_time?: string;
}

export interface EvidenceFile {
  filename: string;
  contentType: string;
  data: string;
}

export class Disputes {
  constructor(private readonly client: PayPalClient) {}

  async list(pageSize = 20): Promise<DisputeSummary[]> {
    const { data } = await this.client.request<{ items?: DisputeSummary[] }>(
      "GET",
      `/v1/customer/disputes?page_size=${pageSize}`,
    );
    return data.items ?? [];
  }

  async get(id: string): Promise<RawDispute> {
    return (await this.client.request<RawDispute>("GET", `/v1/customer/disputes/${encodeURIComponent(id)}`)).data;
  }

  private files(files: EvidenceFile[]) {
    return files.map((file, index) => ({ name: `file${index + 1}`, ...file }));
  }

  provideEvidence(id: string, evidence: { evidenceType: string; notes: string }, files: EvidenceFile[]) {
    const item = { evidence_type: evidence.evidenceType, notes: evidence.notes };
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/provide-evidence`, {
      multipart: { input: { evidences: [item] }, files: this.files(files) },
    });
  }

  provideSupportingInfo(id: string, notes: string, files: EvidenceFile[]) {
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/provide-supporting-info`, {
      multipart: { input: { notes }, files: this.files(files) },
    });
  }

  sendMessage(id: string, message: string) {
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/send-message`, {
      multipart: { input: { message } },
    });
  }

  acceptClaim(id: string, note: string, acceptClaimType = "REFUND", returnAddress?: ReturnAddress) {
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/accept-claim`, {
      json: { note, accept_claim_type: acceptClaimType, ...(returnAddress ? { return_shipping_address: returnAddress } : {}) },
    });
  }

  makeOffer(id: string, note: string, offerType: string, amount: Money, returnAddress?: ReturnAddress) {
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/make-offer`, {
      json: { note, offer_type: offerType, offer_amount: amount, ...(returnAddress ? { return_shipping_address: returnAddress } : {}) },
    });
  }

  // Sandbox only: settles the case for the buyer or the seller. The outcome is the developer's choice, so it
  // shows the dispute lifecycle working, not that the evidence would win.
  adjudicate(id: string, outcome: "BUYER_FAVOR" | "SELLER_FAVOR") {
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/adjudicate`, { json: { adjudication_outcome: outcome } });
  }

  escalate(id: string, note: string) {
    return this.client.request("POST", `/v1/customer/disputes/${encodeURIComponent(id)}/escalate`, { json: { note } });
  }
}

export function availableActions(dispute: RawDispute): Set<string> {
  return new Set((dispute.links ?? []).map((link) => link.rel).filter((rel) => rel !== "self"));
}
