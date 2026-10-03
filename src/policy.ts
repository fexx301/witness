// The merchant's own rules for who bears a loss. Witness establishes what happened;
// the merchant's policy, not the model, decides whether that obliges a refund.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";

const Choice = z.enum(["refund", "propose_return", "review"]);

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
