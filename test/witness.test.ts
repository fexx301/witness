import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeSteps, planSteps } from "../src/act.js";
import { normalizeDispute, type Claim } from "../src/claim.js";
import { checkStatements, claimTypeForReason, comparisonFinding, decide, type Assessment, type Assessor, type Decision, type Writing } from "../src/decide.js";
import { authorizationFinding, fulfilmentFinding, resolveEvidenceRequests, type Finding } from "../src/findings.js";
import { checkMandate, mandateHash, mandateStatusAt, MandateSchema, MandateStore, type LifecycleEvent } from "../src/mandate.js";
import { CONSERVATIVE_POLICY, type MerchantPolicy } from "../src/policy.js";
import { PayPalClient, PayPalError } from "../src/paypal/client.js";
import { Disputes, type RawDispute } from "../src/paypal/disputes.js";
import { Orders, trackingFromOrder, type Order } from "../src/paypal/orders.js";
import { processDispute } from "../src/witness.js";

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
    const facts = { "shipment_tracking[0]": { status: "DELIVERED" } };
    const { sent, dropped } = checkStatements(
      [
        { text: "Delivered on Oct 2.", sources: ["shipment_tracking[0]"] },
        { text: "Signed for by the buyer.", sources: ["made.up[1]"] },
        { text: "A repeat customer.", sources: [] },
        { text: "Delivered and signed.", sources: ["shipment_tracking[0]", "made.up[2]"] },
      ],
      facts,
    );
    expect(sent.map((s) => s.text)).toEqual(["Delivered on Oct 2."]);
    expect(dropped).toHaveLength(3);
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
    expect(trackingFromOrder(fixture<Order>("order-inr.json"))).toEqual([{ trackingNumber: "9400111899223197428490", status: "SHIPPED" }]);
  });
});

// A fake PayPal serving the recorded fixtures and recording every write.
function fakePayPal(trackerStatus = "SHIPPED") {
  const writes: { path: string; contentType: string }[] = [];
  const order = fixture<Order>("order-inr.json");
  order.purchase_units[0]!.shipping!.trackers![0]!.status = trackerStatus;
  const routes: Record<string, unknown> = {
    "/v1/customer/disputes/PP-R-SSN-10190213": {
      ...fixture<RawDispute>("dispute-inr-resolved.json"),
      status: "WAITING_FOR_SELLER_RESPONSE",
      links: [{ rel: "provide_evidence", href: "", method: "POST" }],
    },
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
  return { client: new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" }, fetchImpl), writes };
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
