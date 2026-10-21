import Anthropic from "@anthropic-ai/sdk";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeSteps, planSteps } from "../src/act.js";
import { RulesAssessor } from "../src/baseline.js";
import { cachedClaims, disputeRows, investigate, investigationView } from "../src/desk.js";
import { DailyBudget, toClaudeRequest } from "../src/studioLlm.js";
import { normalizeDispute, type Claim } from "../src/claim.js";
import { checkStatements, ClaudeAssessor, claimTypeForReason, comparisonFinding, decide, type Assessment, type Assessor, type Decision, type Writing } from "../src/decide.js";
import { authorizationFinding, fulfilmentFinding, resolveEvidenceRequests, type Finding } from "../src/findings.js";
import { checkMandate, checkPayPalApproval, mandateHash, mandateStatusAt, MandateSchema, MandateStore, type LifecycleEvent } from "../src/mandate.js";
import { completeAcceptance, firstOrderProblem } from "../src/accept.js";
import { agentPurchase, recordShipment } from "../src/agentBuy.js";
import { CONSERVATIVE_POLICY, type MerchantPolicy } from "../src/policy.js";
import { PayPalClient, PayPalError } from "../src/paypal/client.js";
import { Disputes, type RawDispute } from "../src/paypal/disputes.js";
import { Orders, trackingFromOrder, type Order } from "../src/paypal/orders.js";
import { ExecutionRefused, executeReviewed, processDispute } from "../src/witness.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const legacyMandate = MandateSchema.parse(fixture("mandate.json"));
const BOUND_HASH = "8771f25b0c9b5bd37771550ce13d5040353585c27447cf76307190759fb83a21";

// A demo merchant that has opted into automatic refunds for these cases.
const DEMO_POLICY: MerchantPolicy = {
  name: "demo merchant",
  agentInstructionMismatch: "refund",
  listingMismatch: "propose_return",
  confirmedNonDelivery: "refund",
  unauthorizedCharge: "refund",
};

const accepted: LifecycleEvent[] = [{ event: "accepted", at: "2026-10-01T00:00:00Z", channel: "witness-wallet" }];
const purchase = { amountUsd: 18, merchantId: "7ZCSEN3JAJJPG", purchasedAt: "2026-10-02T01:56:49Z" };
const mandateWithMerchant = { ...legacyMandate, scope: { ...legacyMandate.scope, merchants: ["7ZCSEN3JAJJPG"] } };

const finding = (key: Finding["key"], status: Finding["status"]): Finding => ({ key, status, summary: `${key} ${status}`, sources: [`src.${key}`] });
const findings = (overrides: Partial<Record<Finding["key"], Finding["status"]>>): Finding[] =>
  (["authorization", "instruction_compliance", "listing_match", "fulfilment"] as const).map((key) => finding(key, overrides[key] ?? "unknown"));

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  claim_type: "not_as_described",
  claim_summary: "The buyer says the agent bought a blend they did not authorize.",
  agent_purchase: true,
  instruction_compliance: { status: "match", explanation: "Whole bean, as instructed.", sources: ["mandate.instructions[0]"] },
  listing_match: { status: "unclear", explanation: "Nothing shows what was delivered.", sources: [] },
  evidence_notes: [{ text: "The purchase was made inside the buyer's mandate.", sources: ["finding.authorization"] }],
  buyer_message: [{ text: "We have reviewed the delivery record.", sources: ["finding.fulfilment"] }],
  ...overrides,
});

describe("mandate", () => {
  it("hashes exactly like the mandate bound to the real sandbox order, with instructions optional", () => {
    expect(mandateHash(legacyMandate)).toBe(BOUND_HASH);
    expect(mandateHash({ ...legacyMandate, instructions: ["whole bean"] })).not.toBe(BOUND_HASH);
  });

  it("judges revocation at purchase time, not dispute time", () => {
    const revokedAfter: LifecycleEvent[] = [...accepted, { event: "revoked", at: "2026-10-05T00:00:00Z" }];
    const revokedBefore: LifecycleEvent[] = [...accepted, { event: "revoked", at: "2026-10-01T12:00:00Z" }];
    expect(mandateStatusAt(legacyMandate, revokedAfter, purchase.purchasedAt).status).toBe("in_force");
    expect(mandateStatusAt(legacyMandate, revokedBefore, purchase.purchasedAt).status).toBe("revoked");
    expect(mandateStatusAt(legacyMandate, [{ event: "imported", at: "2026-10-01T00:00:00Z" }], purchase.purchasedAt).status).toBe("unknown");
    expect(mandateStatusAt(legacyMandate, [{ event: "accepted", at: "2026-10-03T00:00:00Z" }], purchase.purchasedAt).status).toBe("not_yet_accepted");
    expect(mandateStatusAt(legacyMandate, accepted, "2027-02-01T00:00:00Z").status).toBe("expired");
  });

  it("establishes authorization only when every exact check passes", () => {
    const ok = authorizationFinding(mandateWithMerchant, checkMandate(mandateWithMerchant, mandateHash(mandateWithMerchant), purchase, accepted));
    expect(ok.status).toBe("established");
    const noAcceptance = authorizationFinding(legacyMandate, checkMandate(legacyMandate, BOUND_HASH, purchase, []));
    expect(noAcceptance.status).toBe("unknown");
    const overCap = authorizationFinding(legacyMandate, checkMandate(legacyMandate, BOUND_HASH, { ...purchase, amountUsd: 55 }, accepted));
    expect(overCap.status).toBe("contradicted");
    const tampered = checkMandate({ ...legacyMandate, scope: { ...legacyMandate.scope, max_amount_usd: "400.00" } }, BOUND_HASH, purchase, accepted);
    expect(tampered.find((c) => c.rule === "integrity")?.status).toBe("fail");
    expect(authorizationFinding(null, []).status).toBe("unknown");
  });

  it("stores mandates and lifecycle events by hash only", () => {
    const store = new MandateStore(mkdtempSync(join(tmpdir(), "witness-mandates-")));
    expect(store.save(legacyMandate)).toBe(BOUND_HASH);
    store.record(BOUND_HASH, accepted[0]!);
    expect(store.lifecycle(BOUND_HASH)).toHaveLength(1);
    expect(store.find("../../etc/passwd")).toBeNull();
  });
});

describe("PayPal approval of a mandate", () => {
  const approval = { orderId: "56268850E1823301N", status: "COMPLETED", customId: BOUND_HASH, payerId: "P69H9YR3CJHFL", approvedAt: "2026-10-02T01:56:35Z", vaultId: "99s59502mc171043h" };
  const check = (overrides: Partial<typeof approval> | null, payer = "P69H9YR3CJHFL", at = "2026-10-02T01:56:49Z") =>
    checkPayPalApproval(overrides && { ...approval, ...overrides }, BOUND_HASH, payer, at).status;

  it("passes only for this mandate, the disputing buyer's account, before the purchase", () => {
    expect(check({})).toBe("pass");
    expect(check({ customId: "0".repeat(64) })).toBe("fail");
    expect(check({}, "SOMEONEELSE")).toBe("fail");
    expect(check({ approvedAt: "2026-10-03T00:00:00Z" })).toBe("fail");
  });

  it("is unknown, never a pass, when PayPal's record is missing or incomplete", () => {
    expect(check(null)).toBe("unknown");
    expect(check({ status: "APPROVED" })).toBe("unknown");
    expect(check({}, "")).toBe("unknown");
    expect(check({ approvedAt: undefined })).toBe("unknown");
    // An agent's own charge carries the hash and the buyer's account, but saves no PayPal.
    expect(check({ vaultId: undefined })).toBe("unknown");
  });
});

describe("mandate acceptance", () => {
  // A fake PayPal for the buyer's return from approval: the capture, then the order as PayPal reports it.
  const paypalFor = (order: Partial<Order>) => {
    const captures: string[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      if (init?.method === "POST") return captures.push(path), new Response(JSON.stringify({}));
      return new Response(JSON.stringify({ ...fixture<Order>("order-inr.json"), ...order }));
    }) as typeof fetch;
    return { client: new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" }, fetchImpl), captures };
  };

  it("records the acceptance once, linked to the PayPal order the buyer approved", async () => {
    const store = new MandateStore(mkdtempSync(join(tmpdir(), "witness-mandates-")));
    store.save(legacyMandate);
    const { client, captures } = paypalFor({});
    const first = await completeAcceptance(client, store, "56268850E1823301N");
    expect(first).toMatchObject({ hash: BOUND_HASH, at: "2026-10-02T01:56:35Z", vaultId: "99s59502mc171043h", alreadyRecorded: false });
    expect(captures).toEqual(["/v2/checkout/orders/56268850E1823301N/capture"]);
    expect((await completeAcceptance(client, store, "56268850E1823301N")).alreadyRecorded).toBe(true);
    expect(store.lifecycle(BOUND_HASH)).toEqual([expect.objectContaining({ event: "accepted", paypal_order: "56268850E1823301N" })]);
  });

  it("records nothing for an unapproved payment or a mandate Witness does not hold", async () => {
    const store = new MandateStore(mkdtempSync(join(tmpdir(), "witness-mandates-")));
    await expect(completeAcceptance(paypalFor({}).client, store, "56268850E1823301N")).rejects.toThrow(/no mandate/);
    store.save(legacyMandate);
    await expect(completeAcceptance(paypalFor({ status: "APPROVED" }).client, store, "56268850E1823301N")).rejects.toThrow(/not an approved payment/);
    await expect(completeAcceptance(paypalFor({ payment_source: {} }).client, store, "1T90859763303551K")).rejects.toThrow(/not an acceptance/);
    expect(store.lifecycle(BOUND_HASH)).toEqual([]);
  });

  it("only offers a first order the mandate itself allows", () => {
    expect(firstOrderProblem(legacyMandate, { item: "House Blend, whole bean", amount: "16.00" })).toBeNull();
    expect(firstOrderProblem(legacyMandate, { item: "House Blend", amount: "999.00" })).toMatch(/cap/);
    expect(firstOrderProblem(legacyMandate, { item: "House Blend", amount: "16" })).toMatch(/16.00/);
    expect(firstOrderProblem(legacyMandate, { item: " ", amount: "16.00" })).toMatch(/item/);
  });
});

describe("findings", () => {
  it("never treats shipped, or an absent record, as delivered or as not delivered", () => {
    expect(fulfilmentFinding([{ trackingNumber: "1", status: "DELIVERED" }]).status).toBe("established");
    expect(fulfilmentFinding([{ trackingNumber: "1", status: "SHIPPED" }]).status).toBe("unknown");
    expect(fulfilmentFinding([]).status).toBe("unknown");
    expect(fulfilmentFinding([{ trackingNumber: "1", status: "SHIPPED", carrierStatus: "RETURNED_TO_SENDER" }]).status).toBe("contradicted");
  });

  it("treats PayPal evidence requests as requirements to check, not facts", () => {
    const claim = { ...normalizeDispute(fixture<RawDispute>("dispute-snad-agent.json")), evidenceRequests: [{ type: "PROOF_OF_REFUND" }] };
    const capture = fixture<{ id: string; status: string; amount: { currency_code: string; value: string } }>("capture-inr.json");
    const [request] = resolveEvidenceRequests(claim, fulfilmentFinding([]), capture);
    expect(request?.resolved).toBe(false);
    const [refunded] = resolveEvidenceRequests(claim, fulfilmentFinding([]), { ...capture, status: "REFUNDED" });
    expect(refunded?.resolved).toBe(true);
    // An unresolved refund request does not turn into a refund.
    const decision = decide("unauthorized", findings({}), [request!], DEMO_POLICY);
    expect(decision.action).toBe("request_evidence");
    expect(decision.gaps.join(" ")).toContain("PROOF_OF_REFUND");
  });

  it("sends only statements whose every citation is a supplied fact", () => {
    const facts = { "shipment_tracking[0]": { status: "DELIVERED" }, "order.description": null };
    const { sent, dropped } = checkStatements(
      [
        { text: "Delivered on Oct 2.", sources: ["shipment_tracking[0]"] },
        { text: "The listing promised whole bean.", sources: ["order.description"] },
        { text: "Signed for by the buyer.", sources: ["made.up[1]"] },
        { text: "A repeat customer.", sources: [] },
        { text: "Delivered and signed.", sources: ["shipment_tracking[0]", "made.up[2]"] },
      ],
      facts,
    );
    expect(sent.map((s) => s.text)).toEqual(["Delivered on Oct 2."]);
    expect(dropped).toHaveLength(4);
  });

  it("downgrades a model comparison that cites no supplied fact", () => {
    const facts = { "mandate.instructions[0]": "whole bean" };
    const cited = comparisonFinding("instruction_compliance", { status: "mismatch", explanation: "ground, not whole bean", sources: ["mandate.instructions[0]"] }, facts);
    expect(cited.status).toBe("contradicted");
    const uncited = comparisonFinding("instruction_compliance", { status: "mismatch", explanation: "ground", sources: ["made.up[3]"] }, facts);
    expect(uncited.status).toBe("unknown");
    expect(uncited.summary).toContain("Not used");
    const mixed = comparisonFinding("instruction_compliance", { status: "mismatch", explanation: "ground", sources: ["mandate.instructions[0]", "made.up[3]"] }, facts);
    expect(mixed.status).toBe("unknown");
  });
});

describe("decide: the presentation cases", () => {
  it("case 1: an authorized purchase of the instructed item is defended", () => {
    const d = decide("unauthorized", findings({ authorization: "established", instruction_compliance: "established" }), [], DEMO_POLICY);
    expect(d).toMatchObject({ action: "defend", basis: "facts" });
  });

  it("case 2: within budget but the wrong variant is an agent violation, and merchant policy decides", () => {
    const f = findings({ authorization: "established", instruction_compliance: "contradicted", listing_match: "established", fulfilment: "established" });
    const demo = decide("not_as_described", f, [], DEMO_POLICY);
    expect(demo).toMatchObject({ action: "refund", basis: "merchant_policy" });
    expect(demo.why[0]).toContain("not a merchant fulfilment failure");
    expect(decide("not_as_described", f, [], CONSERVATIVE_POLICY).action).toBe("review");
  });

  it("case 3: incomplete evidence asks for evidence instead of acting", () => {
    const d = decide("unauthorized", findings({ authorization: "unknown" }), [], DEMO_POLICY);
    expect(d.action).toBe("request_evidence");
    expect(d.gaps.some((g) => g.startsWith("authorization"))).toBe(true);
  });
});

describe("decide: regressions", () => {
  it("a valid mandate and the right item never defend a confirmed non-delivery", () => {
    const f = findings({ authorization: "established", instruction_compliance: "established", listing_match: "established", fulfilment: "contradicted" });
    const d = decide("item_not_received", f, [], DEMO_POLICY);
    expect(d.action).not.toBe("defend");
    expect(d).toMatchObject({ action: "refund", basis: "merchant_policy" });
    expect(decide("item_not_received", f, [], CONSERVATIVE_POLICY).action).toBe("review");
  });

  it("unconfirmed delivery is a gap, never silently a refund or a defence", () => {
    const f = findings({ authorization: "established", instruction_compliance: "established", fulfilment: "unknown" });
    const d = decide("item_not_received", f, [], DEMO_POLICY);
    expect(d.action).toBe("request_evidence");
    expect(d.gaps.some((g) => g.startsWith("fulfilment"))).toBe(true);
  });

  it("an agent violation with unknown delivery contents is not refunded automatically", () => {
    const d = decide("not_as_described", findings({ instruction_compliance: "contradicted", listing_match: "unknown" }), [], DEMO_POLICY);
    expect(d.action).toBe("request_evidence");
  });

  it("the merchant shipping something other than the listing follows listing policy", () => {
    expect(decide("not_as_described", findings({ listing_match: "contradicted" }), [], DEMO_POLICY).action).toBe("propose_return");
  });
});

describe("claim type", () => {
  it("routes on PayPal's stated reason, not on Claude's reading", () => {
    expect(claimTypeForReason("MERCHANDISE_OR_SERVICE_NOT_RECEIVED")).toBe("item_not_received");
    expect(claimTypeForReason("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED")).toBe("not_as_described");
    expect(claimTypeForReason("UNAUTHORISED")).toBe("unauthorized");
    expect(claimTypeForReason("DUPLICATE_TRANSACTION")).toBe("other");
  });
});

describe("rules-only baseline", () => {
  it("defends an authorized, delivered purchase whatever the buyer says the agent got wrong", async () => {
    const claim = normalizeDispute(fixture<RawDispute>("dispute-snad-agent.json"));
    const established = [finding("authorization", "established"), finding("fulfilment", "established")];
    const facts = { "finding.authorization": {}, "finding.fulfilment": {} };
    const a = await new RulesAssessor().assess({ claim, mandate: legacyMandate, findings: established, tracking: [] });
    expect(a.claim_type).toBe("not_as_described");
    const f = [established[0]!, comparisonFinding("instruction_compliance", a.instruction_compliance, facts), comparisonFinding("listing_match", a.listing_match, facts), established[1]!];
    expect(decide(a.claim_type, f, [], DEMO_POLICY).action).toBe("defend");
    expect(checkStatements(a.evidence_notes, facts).dropped).toHaveLength(0);
  });
});

describe("desk model endpoint", () => {
  it("turns Studio's items into alternating Claude messages, dropping reasoning and forced tool use", () => {
    const request = toClaudeRequest({
      instructions: "You build dashboards.",
      input: [
        { type: "message", role: "system", content: [{ type: "text", text: "Dashboard: disputes." }] },
        { type: "message", role: "user", content: [{ type: "text", text: "Investigate PP-R-YUX-10193379" }] },
        { type: "reasoning" },
        { type: "message", role: "assistant", content: [{ type: "text", text: "Delegating." }] },
        { type: "function_call", callId: "call_1", name: "delegate_to", arguments: '{"agent":"witness"}' },
        { type: "function_call_output", callId: "call_1", output: "REFUND (merchant policy)" },
      ],
      tools: [{ name: "delegate_to", description: "Hand work to another agent.", parameters: { type: "object", properties: {} } }],
      toolChoice: "required",
      responseFormat: { type: "text" },
    });
    expect(request.messages.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
    expect(request.messages[1]!.content).toEqual([
      { type: "text", text: "Delegating." },
      { type: "tool_use", id: "call_1", name: "delegate_to", input: { agent: "witness" } },
    ]);
    expect(request.messages[2]!.content).toEqual([{ type: "tool_result", tool_use_id: "call_1", content: "REFUND (merchant policy)" }]);
    expect(request.system).toContain("Dashboard: disputes.");
    expect(request.system).toContain("You must call one of the available tools");
    expect(request.tool_choice).toEqual({ type: "auto" });
    expect("output_config" in request).toBe(false);
  });
});

describe("desk AI budget", () => {
  it("charges each turn at its model's rates, stops at the daily limit, and resets the next day", () => {
    let day = "2026-10-18";
    const budget = new DailyBudget(0.1, () => day);
    expect(budget.charge("anthropic/claude-opus-5.5", { input_tokens: 10_000, output_tokens: 1_000 })).toBeCloseTo(0.06);
    expect(budget.remaining()).toBeCloseTo(0.04);
    budget.charge("some/unknown-model", { input_tokens: 10_000, output_tokens: 1_000 });
    expect(budget.remaining()).toBe(0);
    day = "2026-10-19";
    expect(budget.remaining()).toBeCloseTo(0.1);
  });
});

describe("model provider", () => {
  it("uses OpenRouter's Anthropic-compatible endpoint when only an OpenRouter key is set", () => {
    const saved = { ...process.env };
    try {
      for (const name of ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "WITNESS_MODEL"]) delete process.env[name];
      process.env.OPENROUTER_API_KEY = "sk-or-test";
      const assessor = new ClaudeAssessor();
      expect(assessor.model).toBe("anthropic/claude-opus-5.5");
      expect((assessor as unknown as { client: Anthropic }).client.baseURL).toBe("https://openrouter.ai/api");
    } finally {
      process.env = saved;
    }
  });

  it("sends Anthropic's server-side fallback only to Anthropic itself", async () => {
    const bodies: Record<string, unknown>[] = [];
    const fetchImpl = (async (_url: string | URL, init?: RequestInit) => {
      bodies.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ type: "error", error: { type: "invalid_request_error", message: "stop here" } }), { status: 400 });
    }) as typeof fetch;
    const input = { claim: normalizeDispute(fixture<RawDispute>("dispute-snad-agent.json")), mandate: null, findings: [], tracking: [] };
    for (const baseURL of ["https://openrouter.ai/api", "https://api.anthropic.com"]) {
      const client = new Anthropic({ baseURL, apiKey: "test", fetch: fetchImpl, maxRetries: 0 });
      await expect(new ClaudeAssessor({ model: "m", client }).assess(input)).rejects.toThrow();
    }
    expect(bodies.map((body) => "fallbacks" in body)).toEqual([false, true]);
  });
});

describe("planning", () => {
  const files = [{ filename: "witness.txt", contentType: "text/plain", data: "pack" }];
  const decision = (action: Decision["action"]): Decision => ({ action, basis: "facts", why: ["because"], gaps: ["fulfilment: unknown"] });
  const claim = (over: Partial<Claim>): Claim => ({ ...normalizeDispute(fixture<RawDispute>("dispute-snad-agent.json")), ...over });
  const writing: Writing = { evidenceNotes: "notes", buyerMessage: "Thank you.", dropped: [] };

  it("uses only the response PayPal offers right now", () => {
    const evidence = claim({ actions: new Set(["provide_evidence", "accept_claim"]), acceptClaimTypes: ["REFUND", "REFUND_WITH_RETURN"] });
    expect(planSteps(evidence, decision("defend"), writing, files).map((s) => s.kind)).toEqual(["provide_evidence"]);
    expect(planSteps(evidence, decision("refund"), writing, files).map((s) => s.kind)).toEqual(["accept_claim"]);
    expect(planSteps(evidence, decision("propose_return"), writing, files)[0]).toMatchObject({ kind: "accept_claim", acceptClaimType: "REFUND_WITH_RETURN" });

    const inquiry = claim({ stage: "INQUIRY", actions: new Set(["send_message", "escalate", "make_offer"]), offerTypes: ["REFUND_WITH_RETURN"] });
    expect(planSteps(inquiry, decision("defend"), writing, files).map((s) => s.kind)).toEqual(["send_message", "escalate"]);
    expect(planSteps(inquiry, decision("propose_return"), writing, files).map((s) => s.kind)).toEqual(["make_offer"]);

    const reviewOnly = claim({ actions: new Set(["provide_supporting_info"]) });
    expect(planSteps(reviewOnly, decision("refund"), writing, files)[0]?.kind).toBe("none");
    expect(planSteps(reviewOnly, decision("request_evidence"), writing, files)[0]).toMatchObject({ kind: "none" });
  });
});

describe("claim", () => {
  it("reads the buyer's words, the bound mandate hash, and PayPal's evidence requests", () => {
    const raw = fixture<RawDispute>("dispute-snad-agent.json");
    const claim = normalizeDispute({
      ...raw,
      // Constructed: the recorded fixture was captured after the request was answered.
      evidences: [...(raw.evidences ?? []), { evidence_type: "PROOF_OF_REFUND", source: "REQUESTED_FROM_SELLER", date: "2026-10-02T07:24:00Z" }],
    });
    expect(claim.captureId).toBe("61A930077R170051R");
    expect(claim.mandateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.buyerStatements.join(" ")).toContain("I only authorized my usual blend");
    expect(claim.evidenceRequests).toEqual([{ type: "PROOF_OF_REFUND", requestedAt: "2026-10-02T07:24:00Z" }]);
  });

  it("reads tracking from the order", () => {
    expect(trackingFromOrder(fixture<Order>("order-inr.json"))).toEqual([
      { trackerId: "9E839789UG349854R-9400111899223197428490", trackingNumber: "9400111899223197428490", status: "SHIPPED" },
    ]);
  });
});

// A fake PayPal serving the recorded fixtures and recording every write. As in the real API,
// the order's tracker says SHIPPED and only the v1 tracking API can say DELIVERED.
function fakePayPal(trackerStatus: string | null = "SHIPPED") {
  const writes: { path: string; contentType: string }[] = [];
  const order = fixture<Order>("order-inr.json");
  const routes: Record<string, unknown> = {
    ...(trackerStatus ? { "/v1/shipping/trackers/9E839789UG349854R-9400111899223197428490": { status: trackerStatus, carrier: "USPS" } } : {}),
    "/v1/customer/disputes/PP-R-SSN-10190213": {
      ...fixture<RawDispute>("dispute-inr-resolved.json"),
      // An open dispute: the recorded fixture's outcome is dropped along with its resolved status.
      status: "WAITING_FOR_SELLER_RESPONSE",
      dispute_outcome: undefined,
      links: [{ rel: "provide_evidence", href: "", method: "POST" }],
    },
    "/v1/customer/disputes": { items: [{ dispute_id: "PP-R-SSN-10190213", status: "WAITING_FOR_SELLER_RESPONSE", reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED", dispute_amount: { currency_code: "USD", value: "25.00" } }] },
    "/v2/payments/captures/9E839789UG349854R": fixture("capture-inr.json"),
    "/v2/checkout/orders/56268850E1823301N": order,
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    if (init?.method === "POST") {
      writes.push({ path, contentType: init.body instanceof FormData ? "multipart" : "json" });
      return new Response(JSON.stringify({}), { headers: { "paypal-debug-id": "dbg1" } });
    }
    const body = routes[path];
    return body ? new Response(JSON.stringify(body)) : new Response(JSON.stringify({ details: [{ issue: "INVALID_RESOURCE_ID" }] }), { status: 404 });
  }) as typeof fetch;
  return { client: new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" }, fetchImpl), writes, routes };
}

const notReceived: Assessor = {
  model: "fake",
  assess: async () =>
    assessment({
      claim_type: "item_not_received",
      agent_purchase: false,
      instruction_compliance: { status: "not_applicable", explanation: "No agent instructions apply.", sources: [] },
    }),
};

describe("pipeline", () => {
  const deps = (client: PayPalClient, runsDir: string) => ({
    disputes: new Disputes(client),
    orders: new Orders(client),
    mandates: new MandateStore(mkdtempSync(join(tmpdir(), "witness-m-"))),
    assessor: notReceived,
    policy: DEMO_POLICY,
    runsDir,
    now: () => new Date("2026-10-03T10:00:00Z"),
  });

  it("asks for evidence when the parcel is only shipped, and sends nothing even with --execute", async () => {
    const { client, writes } = fakePayPal("SHIPPED");
    const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"));
    const record = await processDispute(deps(client, runsDir), "PP-R-SSN-10190213", { execute: true });
    expect(record.decision.action).toBe("request_evidence");
    expect(record.evidencePack).toContain("[UNKNOWN] fulfilment");
    expect(writes).toHaveLength(0);
  });

  it("checks PayPal's record of the approval linked to the buyer's acceptance", async () => {
    const { client } = fakePayPal("DELIVERED");
    const pipeline = deps(client, mkdtempSync(join(tmpdir(), "witness-runs-")));
    pipeline.mandates.save(legacyMandate);
    pipeline.mandates.record(BOUND_HASH, { event: "accepted", at: "2026-10-02T01:56:35Z", paypal_order: "56268850E1823301N" });
    const record = await processDispute(pipeline, "PP-R-SSN-10190213", { execute: false });
    expect(record.checks.find((c) => c.rule === "paypal_approval")).toMatchObject({ status: "pass" });
  });

  it("keeps the order's tracker status when the v1 tracking lookup fails", async () => {
    const { client } = fakePayPal(null);
    const record = await processDispute(deps(client, mkdtempSync(join(tmpdir(), "witness-runs-"))), "PP-R-SSN-10190213", { execute: false });
    expect(record.tracking[0]).toMatchObject({ status: "SHIPPED" });
    expect(record.decision.action).toBe("request_evidence");
  });

  it("defends with evidence once delivery is recorded, and only when told to act", async () => {
    const { client, writes } = fakePayPal("DELIVERED");
    const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"));
    const dry = await processDispute(deps(client, runsDir), "PP-R-SSN-10190213", { execute: false });
    expect(dry.decision).toMatchObject({ action: "defend", basis: "facts" });
    expect(writes).toHaveLength(0);
    const live = await processDispute(deps(client, runsDir), "PP-R-SSN-10190213", { execute: true });
    expect(live.results).toEqual([{ step: "provide_evidence", ok: true, debugId: "dbg1" }]);
    expect(writes).toEqual([{ path: "/v1/customer/disputes/PP-R-SSN-10190213/provide-evidence", contentType: "multipart" }]);
    expect(readdirSync(runsDir)).toHaveLength(2);
  });

  it("submits only the evidence statements that cite supplied facts", async () => {
    const { client } = fakePayPal("DELIVERED");
    const writer: Assessor = {
      model: "fake",
      assess: async () =>
        assessment({
          claim_type: "item_not_received",
          evidence_notes: [
            { text: "Tracking shows the parcel delivered.", sources: ["shipment_tracking[0]"] },
            { text: "The buyer signed for it.", sources: ["signature[0]"] },
          ],
        }),
    };
    const record = await processDispute({ ...deps(client, mkdtempSync(join(tmpdir(), "witness-runs-"))), assessor: writer }, "PP-R-SSN-10190213", {
      execute: false,
    });
    expect(record.steps[0]).toMatchObject({ kind: "provide_evidence", notes: "Tracking shows the parcel delivered. (sources: shipment_tracking[0])" });
    expect(record.writing.dropped.map((s) => s.text)).toEqual(["The buyer signed for it."]);
    expect(record.evidencePack).toContain("NOT SENT");
  });

  it("answers PayPal's stated reason and flags Claude's different reading", async () => {
    const { client } = fakePayPal("DELIVERED");
    const misread: Assessor = { model: "fake", assess: async () => assessment({ claim_type: "not_as_described" }) };
    const record = await processDispute({ ...deps(client, mkdtempSync(join(tmpdir(), "witness-runs-"))), assessor: misread }, "PP-R-SSN-10190213", {
      execute: false,
    });
    expect(record.decision).toMatchObject({ action: "defend", basis: "facts" });
    expect(record.decision.discrepancy).toContain("MERCHANDISE_OR_SERVICE_NOT_RECEIVED");
    expect(record.evidencePack).toContain("DISCREPANCY:");
  });

  it("executes exactly the reviewed dry run, once, with no new assessment", async () => {
    const { client, writes } = fakePayPal("DELIVERED");
    const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"));
    const reviewed = await processDispute(deps(client, runsDir), "PP-R-SSN-10190213", { execute: false });
    const noModel: Assessor = { model: "fake", assess: async () => { throw new Error("no model may be called when executing a review"); } };
    const executed = await executeReviewed({ ...deps(client, runsDir), assessor: noModel }, reviewed);
    expect(executed).toMatchObject({ executed: true, reviewedRanAt: reviewed.ranAt, decision: reviewed.decision });
    expect(executed.results).toEqual([{ step: "provide_evidence", ok: true, debugId: "dbg1" }]);
    expect(writes).toEqual([{ path: "/v1/customer/disputes/PP-R-SSN-10190213/provide-evidence", contentType: "multipart" }]);
    await expect(executeReviewed(deps(client, runsDir), reviewed)).rejects.toThrow(/already sent/);
    expect(writes).toHaveLength(1);
  });

  it("refuses to execute when the dispute changed since the review, or when the review is the baseline", async () => {
    const { client, writes, routes } = fakePayPal("DELIVERED");
    const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"));
    const reviewed = await processDispute(deps(client, runsDir), "PP-R-SSN-10190213", { execute: false });
    await expect(executeReviewed(deps(client, runsDir), { ...reviewed, model: "rules-only baseline" })).rejects.toBeInstanceOf(ExecutionRefused);
    const dispute = routes["/v1/customer/disputes/PP-R-SSN-10190213"] as RawDispute;
    routes["/v1/customer/disputes/PP-R-SSN-10190213"] = { ...dispute, dispute_life_cycle_stage: "ARBITRATION" };
    await expect(executeReviewed(deps(client, runsDir), reviewed)).rejects.toThrow(/changed since the review \(stage\)/);
    expect(writes).toHaveLength(0);
  });

  it("gives the desk one row per dispute, with Witness's and the baseline's decisions once investigated", async () => {
    const { client } = fakePayPal("DELIVERED");
    const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"));
    const before = await disputeRows(deps(client, runsDir));
    expect(before).toEqual([expect.objectContaining({ disputeId: "PP-R-SSN-10190213", reason: "Not received", amountUsd: 25, witnessDecision: "not investigated", sentToPayPal: "No" })]);
    const { witness } = await investigate(deps(client, runsDir), "PP-R-SSN-10190213");
    const [after] = await disputeRows(deps(client, runsDir));
    expect(after).toMatchObject({ witnessDecision: "defend", baselineDecision: "defend", investigatedAt: witness.ranAt });
    const view = investigationView(runsDir, "PP-R-SSN-10190213");
    expect(view).toMatchObject({ reviewed: { ranAt: witness.ranAt }, mandate: null, baseline: { decision: { action: "defend" } }, executed: null, lastSent: null });
    await executeReviewed(deps(client, runsDir), witness);
    expect(investigationView(runsDir, "PP-R-SSN-10190213", witness.ranAt)?.executed?.results).toEqual([{ step: "provide_evidence", ok: true, debugId: "dbg1" }]);
    // A newer review of the same dispute still shows what was sent before.
    const { witness: later } = await investigate({ ...deps(client, runsDir), now: () => new Date("2026-10-03T11:00:00Z") }, "PP-R-SSN-10190213");
    expect(investigationView(runsDir, "PP-R-SSN-10190213", later.ranAt)).toMatchObject({ executed: null, lastSent: { results: [{ step: "provide_evidence", ok: true }] } });
    expect((await disputeRows(deps(client, runsDir)))[0]).toMatchObject({ sentToPayPal: "Yes" });
  });

  it("surfaces PayPal errors with their issue and stops dependent steps", async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith("/v1/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        : new Response(JSON.stringify({ details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE" }] }), { status: 422 })) as typeof fetch;
    const disputes = new Disputes(new PayPalClient({ clientId: "i", clientSecret: "s", env: "sandbox" }, fetchImpl));
    await expect(disputes.get("X")).rejects.toBeInstanceOf(PayPalError);
    const results = await executeSteps(disputes, "X", [{ kind: "send_message", message: "hi" }, { kind: "escalate", note: "n" }]);
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toContain("ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE");
  });
});

describe("A11 eval harness", () => {
  it("builds every predeclared case into a dry run that reaches a decision, with no writes to PayPal", async () => {
    const { CASES } = await import("../eval/cases.js");
    const { caseStore, runCase } = await import("../eval/harness.js");
    const root = mkdtempSync(join(tmpdir(), "witness-eval-"));
    const store = caseStore(join(root, "mandates"), CASES);
    const results = await Promise.all(CASES.map((c) => runCase(c, new RulesAssessor(), store, join(root, "runs"))));
    expect(results.map((r) => r.case)).toEqual(CASES.map((c) => c.id));
    // The cases' exact facts reach the code checks: over the cap, revoked, and never accepted.
    const authorization = (id: string) => results.find((r) => r.case === id)!.findings.authorization;
    expect([authorization("C1"), authorization("C4"), authorization("C5"), authorization("C2")]).toEqual(["contradicted", "contradicted", "unknown", "established"]);
    expect(results.find((r) => r.case === "B1")!.findings.fulfilment).toBe("established");
    expect(results.find((r) => r.case === "B4")!.findings.fulfilment).toBe("contradicted");
  });
});

describe("hosted access", () => {
  it("treats only direct loopback requests as local; anything through a proxy is a visitor", async () => {
    const { isLocalRequest } = await import("../src/access.js");
    expect(isLocalRequest({}, "127.0.0.1")).toBe(true);
    expect(isLocalRequest({}, "::ffff:127.0.0.1")).toBe(true);
    expect(isLocalRequest({ "x-forwarded-for": "203.0.113.9" }, "127.0.0.1")).toBe(false);
    expect(isLocalRequest({ forwarded: "for=203.0.113.9" }, "::1")).toBe(false);
    expect(isLocalRequest({}, "203.0.113.9")).toBe(false);
  });

  it("allows a daily number of uses and resets the next day", async () => {
    const { DailyCount } = await import("../src/access.js");
    let day = "2026-10-20";
    const count = new DailyCount(2, () => day);
    expect([count.take(), count.take(), count.take()]).toEqual([true, true, false]);
    day = "2026-10-21";
    expect(count.take()).toBe(true);
  });
});

describe("reference shopping agent", () => {
  // A fake PayPal that records every write and completes a saved-PayPal charge on creation.
  const paypal = () => {
    const writes: { method: string; path: string; body: any }[] = [];
    const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
      const path = new URL(String(url)).pathname;
      if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
      writes.push({ method: init?.method ?? "GET", path, body: JSON.parse(String(init?.body ?? "{}")) });
      if (path === "/v2/checkout/orders")
        return new Response(JSON.stringify({ id: "ORDER1", status: "COMPLETED", purchase_units: [{ payments: { captures: [{ id: "CAP1", status: "COMPLETED", create_time: "2026-10-21T10:00:00Z" }] } }] }));
      return new Response(JSON.stringify({}));
    }) as typeof fetch;
    return { client: new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" }, fetchImpl), writes };
  };

  it("charges the saved PayPal with the mandate's hash bound to the order, then ships and records delivery", async () => {
    const { client, writes } = paypal();
    const purchase = await agentPurchase(client, BOUND_HASH, "99s59502mc171043h", "House Blend, ground, 340 g", "16.00");
    expect(purchase).toEqual({ orderId: "ORDER1", captureId: "CAP1", capturedAt: "2026-10-21T10:00:00Z" });
    expect(writes[0]!.body).toMatchObject({
      purchase_units: [{ description: "House Blend, ground, 340 g", custom_id: BOUND_HASH, amount: { value: "16.00" } }],
      payment_source: { paypal: { vault_id: "99s59502mc171043h" } },
    });
    await recordShipment(client, purchase, true, "9400111899223000000001");
    expect(writes.slice(1).map((w) => `${w.method} ${w.path}`)).toEqual([
      "POST /v2/checkout/orders/ORDER1/track",
      "PUT /v1/shipping/trackers/CAP1-9400111899223000000001",
    ]);
    expect(writes[2]!.body).toMatchObject({ status: "DELIVERED" });
  });

  it("refuses a malformed purchase before calling PayPal", async () => {
    const { client, writes } = paypal();
    await expect(agentPurchase(client, "not-a-hash", "v", "House Blend", "16.00")).rejects.toThrow(/64 hex/);
    await expect(agentPurchase(client, BOUND_HASH, "v", "House Blend", "16")).rejects.toThrow(/16.00/);
    expect(writes).toHaveLength(0);
  });
});

describe("dispute queue cache", () => {
  it("serves the last read at once and reads again in the background once it is stale", async () => {
    let clock = 0;
    let reads = 0;
    const claim = (status: string) => ({ disputeId: "PP-R-SSN-10190213", status }) as Claim;
    let pending: (() => void) | undefined;
    const read = () => {
      reads += 1;
      if (reads === 1) return Promise.resolve([claim("OPEN")]);
      return new Promise<Claim[]>((resolve) => (pending = () => resolve([claim("RESOLVED")])));
    };
    const claims = cachedClaims(read, 30_000, () => clock);
    expect((await claims())[0]!.status).toBe("OPEN");
    clock = 10_000;
    expect((await claims())[0]!.status).toBe("OPEN");
    expect(reads).toBe(1);
    clock = 40_000;
    expect((await claims())[0]!.status).toBe("OPEN");
    expect((await claims())[0]!.status).toBe("OPEN");
    expect(reads).toBe(2);
    pending!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect((await claims())[0]!.status).toBe("RESOLVED");
  });
});
