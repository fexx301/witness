// The merchant's own rules for who bears a loss. Witness establishes what happened;
// the merchant's policy, not the model, decides whether that obliges a refund.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const Choice = z.enum(["refund", "propose_return", "review"]);

// Where a returned item goes, in PayPal's address fields. PayPal requires it for a return.
export const ReturnAddressSchema = z.object({
  address_line_1: z.string().min(1),
  address_line_2: z.string().optional(),
  admin_area_2: z.string().min(1),
  admin_area_1: z.string().optional(),
  postal_code: z.string().min(1),
  country_code: z.string().length(2),
});
export type ReturnAddress = z.infer<typeof ReturnAddressSchema>;

export const MerchantPolicySchema = z.object({
  name: z.string(),
  // The agent bought something the buyer's instructions excluded, and the merchant
  // delivered exactly what was ordered. A goodwill choice, not a merchant failure.
  agentInstructionMismatch: Choice,
  // The merchant delivered something other than the listing.
  listingMismatch: Choice,
  // Fulfilment records confirm the item was not delivered.
  confirmedNonDelivery: z.enum(["refund", "review"]),
  // The charge fell outside the mandate in force at purchase time.
  unauthorizedCharge: z.enum(["refund", "review"]),
  returnAddress: ReturnAddressSchema.optional(),
});
export type MerchantPolicy = z.infer<typeof MerchantPolicySchema>;
export type PolicyChoice = z.infer<typeof Choice>;

// Without a merchant policy, nothing is refunded automatically.
export const CONSERVATIVE_POLICY: MerchantPolicy = {
  name: "conservative (no policy configured)",
  agentInstructionMismatch: "review",
  listingMismatch: "review",
  confirmedNonDelivery: "review",
  unauthorizedCharge: "review",
};

export function loadPolicy(path: string): MerchantPolicy {
  if (!existsSync(path)) return CONSERVATIVE_POLICY;
  return MerchantPolicySchema.parse(JSON.parse(readFileSync(path, "utf8")));
}
