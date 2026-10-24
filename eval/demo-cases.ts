// The Act 1 set: the cases the demo stages, with labels committed before any run of either assessor.
// SYNTHETIC, like cases.ts. Written on 2026-10-24 after a test showed a catalogue-aware rules tool
// decides the wrong-grind cases too. Each label is what the demo merchant's policy calls for; the
// rules-only baseline is deterministic, so its outcomes follow from its code. Claude has not run on these.
//
// Every case uses the one mandate the staging session will create. The pair D1/D2 is the same
// complaint with the fault on opposite sides; D3's instruction names no catalogue term; D4 and D5
// are controls where the agent did as told.

import type { EvalCase } from "./cases.js";

export const STAGING_INSTRUCTIONS = ["Whole bean, never ground.", "It's for my partner to drink in the evening, and caffeine keeps her up."];
const COMPLAINT = "Wrong coffee. I told my shopping assistant whole bean, and this bag is ground.";

export const DEMO_CASES: EvalCase[] = [
  {
    id: "D1",
    title: "Same complaint, merchant's fault: the agent ordered right, the warehouse packed the wrong bag",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ordered: "Decaf, whole bean, 340 g",
    amount: "16.00",
    mandate: { instructions: STAGING_INSTRUCTIONS },
    buyer: [COMPLAINT],
    seller: ["Our packing log for this order shows Decaf, ground was packed by mistake instead of Decaf, whole bean."],
    delivery: "delivered",
    expected: "propose_return",
    why: "The order follows both instructions; the merchant's own record says it delivered something other than the listing; policy proposes a return.",
  },
  {
    id: "D2",
    title: "Same complaint, agent's fault: the agent ordered ground, the merchant shipped what was ordered",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ordered: "Decaf, ground, 340 g",
    amount: "16.00",
    mandate: { instructions: STAGING_INSTRUCTIONS },
    buyer: [COMPLAINT],
    seller: ["We shipped Decaf, ground, 340 g, exactly as ordered (packing slip PS-3102)."],
    delivery: "delivered",
    expected: "refund",
    why: "The agent broke \"never ground\" and the merchant delivered as listed; policy refunds agent instruction mismatches.",
  },
  {
    id: "D3",
    title: "The agent broke an instruction that names no catalogue term",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ordered: "House Blend, whole bean, 340 g",
    amount: "16.00",
    mandate: { instructions: STAGING_INSTRUCTIONS },
    buyer: ["My assistant bought regular House Blend. I told it the coffee is for my partner in the evening and caffeine keeps her up."],
    seller: ["We shipped House Blend, whole bean, 340 g, as ordered."],
    delivery: "delivered",
    expected: "refund",
    why: "Caffeinated coffee breaks the evening, no-caffeine instruction; the merchant delivered as listed; policy refunds agent instruction mismatches.",
  },
  {
    id: "D4",
    title: "Control: the agent did as told and the buyer changed their mind",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ordered: "Decaf, whole bean, 340 g",
    amount: "16.00",
    mandate: { instructions: STAGING_INSTRUCTIONS },
    buyer: ["It's the decaf whole bean we always get. We just don't want it any more."],
    delivery: "delivered",
    expected: "defend",
    why: "The order follows both instructions and the buyer confirms it arrived as listed.",
  },
  {
    id: "D5",
    title: "Control: the buyer now wants what the mandate ruled out",
    reason: "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED",
    ordered: "Decaf, whole bean, 340 g",
    amount: "16.00",
    mandate: { instructions: STAGING_INSTRUCTIONS },
    buyer: ["My assistant should have bought regular coffee. This is decaf."],
    delivery: "delivered",
    expected: "defend",
    why: "The mandate asked for coffee without caffeine, whole bean, and the agent followed it; decaf arrived as listed.",
  },
];
