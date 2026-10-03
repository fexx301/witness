import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { executeSteps, planSteps } from "../src/act.js";
import { normalizeDispute } from "../src/claim.js";
import { decide, type Assessment, type Assessor } from "../src/decide.js";
import { checkMandate, mandateHash, MandateSchema, MandateStore } from "../src/mandate.js";
import { PayPalClient, PayPalError } from "../src/paypal/client.js";
import { Disputes, type RawDispute } from "../src/paypal/disputes.js";
import { Orders, trackingFromOrder, type Order } from "../src/paypal/orders.js";
import { processDispute } from "../src/witness.js";

const fixture = <T>(name: string): T => JSON.parse(readFileSync(new URL(`./fixtures/${name}`, import.meta.url), "utf8")) as T;
const mandate = MandateSchema.parse(fixture("mandate.json"));
const BOUND_HASH = "8771f25b0c9b5bd37771550ce13d5040353585c27447cf76307190759fb83a21";

const assessment = (overrides: Partial<Assessment> = {}): Assessment => ({
  claim_type: "not_as_described",
  claim_summary: "The buyer says the agent bought a blend they did not authorize.",
  agent_purchase: true,
  category_fit: "within",
  recommendation: "defend",
  reasoning: ["The order is coffee beans, inside the mandate's category."],
  evidence_notes: "The purchase was made inside the buyer's signed agent mandate.",
  buyer_message: "Your assistant bought within the limits you set.",
  confidence: "high",
  ...overrides,
});

describe("mandate", () => {
  it("hashes exactly like the mandate bound to the real sandbox order", () => {
    expect(mandateHash(mandate)).toBe(BOUND_HASH);
    expect(mandate.sha256).toBe(BOUND_HASH);
  });

  it("checks amount, integrity and validity deterministically", () => {
    const ok = checkMandate(mandate, BOUND_HASH, { amountUsd: 25, merchantId: "7ZCSEN3JAJJPG", purchasedAt: "2026-10-02T01:56:00Z" });
    expect(ok.find((c) => c.rule === "amount")?.status).toBe("pass");
    expect(ok.find((c) => c.rule === "integrity")?.status).toBe("pass");
    expect(ok.find((c) => c.rule === "validity")?.status).toBe("pass");
    expect(ok.find((c) => c.rule === "merchant")?.status).toBe("unknown");

    const over = checkMandate(mandate, BOUND_HASH, { amountUsd: 41, purchasedAt: "2027-01-02T00:00:00Z" });
    expect(over.find((c) => c.rule === "amount")?.status).toBe("fail");
    expect(over.find((c) => c.rule === "validity")?.status).toBe("fail");

    const tampered = checkMandate({ ...mandate, scope: { ...mandate.scope, max_amount_usd: "400.00" } }, BOUND_HASH, { amountUsd: 25 });
    expect(tampered.find((c) => c.rule === "integrity")?.status).toBe("fail");
  });

  it("stores and finds mandates by hash only", () => {
    const store = new MandateStore(mkdtempSync(join(tmpdir(), "witness-mandates-")));
    expect(store.save(mandate)).toBe(BOUND_HASH);
    expect(store.find(BOUND_HASH)?.agent).toBe(mandate.agent);
    expect(store.find("../../etc/passwd")).toBeNull();
  });
});

describe("claim", () => {
  it("reads the buyer's own words, the bound mandate hash and the allowed actions", () => {
    const claim = normalizeDispute(fixture<RawDispute>("dispute-snad-agent.json"));
    expect(claim.reason).toBe("MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED");
    expect(claim.captureId).toBe("61A930077R170051R");
    expect(claim.mandateHash).toMatch(/^[0-9a-f]{64}$/);
    expect(claim.buyerStatements.join(" ")).toContain("I only authorized my usual blend");
    expect(claim.sellerStatements.length).toBeGreaterThan(0);
  });

  it("reads tracking from the order", () => {
    expect(trackingFromOrder(fixture<Order>("order-inr.json"))).toEqual([
      { trackingNumber: "9400111899223197428490", status: "SHIPPED" },
    ]);
  });
});

describe("decide", () => {
  it("refunds whenever a deterministic mandate check fails, whatever the model says", () => {
    const checks = checkMandate(mandate, BOUND_HASH, { amountUsd: 55 });
    expect(decide(assessment({ recommendation: "defend" }), mandate, checks).action).toBe("refund");
  });

  it("refunds a purchase outside the mandate's category", () => {
    const checks = checkMandate(mandate, BOUND_HASH, { amountUsd: 18 });
    expect(decide(assessment({ category_fit: "outside" }), mandate, checks).action).toBe("refund");
  });

  it("hands unclear or unbacked agent cases to a person", () => {
    const checks = checkMandate(mandate, BOUND_HASH, { amountUsd: 18 });
    expect(decide(assessment({ category_fit: "unclear" }), mandate, checks).action).toBe("needs_human");
    expect(decide(assessment({ category_fit: "not_applicable" }), null, []).action).toBe("needs_human");
    expect(decide(assessment({ agent_purchase: false, confidence: "low" }), null, []).action).toBe("needs_human");
  });

  it("defends a non-agent claim the model is confident about", () => {
    expect(decide(assessment({ agent_purchase: false, category_fit: "not_applicable" }), null, []).action).toBe("defend");
  });
});

describe("planning", () => {
  const files = [{ filename: "witness.txt", contentType: "text/plain", data: "pack" }];

  it("uses whichever response PayPal offers right now", () => {
    const claim = normalizeDispute(fixture<RawDispute>("dispute-snad-agent.json"));
    const withEvidence = { ...claim, actions: new Set(["provide_evidence", "accept_claim"]) };
    expect(planSteps(withEvidence, { action: "defend", why: [] }, assessment(), files).map((s) => s.kind)).toEqual(["provide_evidence"]);
    expect(planSteps(withEvidence, { action: "refund", why: ["outside mandate"] }, assessment(), files).map((s) => s.kind)).toEqual(["accept_claim"]);

    const inquiry = { ...claim, stage: "INQUIRY", actions: new Set(["send_message", "escalate", "accept_claim"]) };
    expect(planSteps(inquiry, { action: "defend", why: [] }, assessment(), files).map((s) => s.kind)).toEqual(["send_message", "escalate"]);

    const reviewOnly = { ...claim, actions: new Set(["provide_supporting_info"]) };
    expect(planSteps(reviewOnly, { action: "defend", why: [] }, assessment(), files).map((s) => s.kind)).toEqual(["provide_supporting_info"]);
    expect(planSteps(reviewOnly, { action: "refund", why: [] }, assessment(), files)[0]?.kind).toBe("none");
  });
});

// A fake PayPal that serves the recorded fixtures and records every write.
function fakePayPal() {
  const writes: { method: string; path: string; contentType: string | null }[] = [];
  const routes: Record<string, unknown> = {
    "/v1/customer/disputes/PP-R-SSN-10190213": { ...fixture<RawDispute>("dispute-inr-resolved.json"), status: "WAITING_FOR_SELLER_RESPONSE", links: [{ rel: "provide_evidence", href: "", method: "POST" }] },
    "/v2/payments/captures/9E839789UG349854R": fixture("capture-inr.json"),
    "/v2/checkout/orders/56268850E1823301N": fixture("order-inr.json"),
  };
  const fetchImpl = (async (url: string | URL, init?: RequestInit) => {
    const path = new URL(String(url)).pathname;
    if (path === "/v1/oauth2/token") return new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }));
    if (init?.method === "POST") {
      writes.push({ method: "POST", path, contentType: init.body instanceof FormData ? "multipart" : "json" });
      return new Response(JSON.stringify({}), { headers: { "paypal-debug-id": "dbg1" } });
    }
    const body = routes[path];
    return body
      ? new Response(JSON.stringify(body))
      : new Response(JSON.stringify({ name: "RESOURCE_NOT_FOUND", details: [{ issue: "INVALID_RESOURCE_ID" }] }), { status: 404 });
  }) as typeof fetch;
  const client = new PayPalClient({ clientId: "id", clientSecret: "secret", env: "sandbox" }, fetchImpl);
  return { client, writes };
}

describe("pipeline", () => {
  it("assesses a real dispute shape and submits evidence only when told to", async () => {
    const { client, writes } = fakePayPal();
    const store = new MandateStore(mkdtempSync(join(tmpdir(), "witness-m-")));
    store.save(mandate);
    const runsDir = mkdtempSync(join(tmpdir(), "witness-runs-"));
    const seen: string[] = [];
    const assessor: Assessor = {
      model: "fake",
      assess: async (input) => {
        seen.push(...input.tracking.map((t) => t.trackingNumber));
        return assessment({ claim_type: "item_not_received", agent_purchase: true, category_fit: "within" });
      },
    };
    const deps = { disputes: new Disputes(client), orders: new Orders(client), mandates: store, assessor, runsDir, now: () => new Date("2026-10-03T10:00:00Z") };

    const dry = await processDispute(deps, "PP-R-SSN-10190213", { execute: false });
    expect(writes).toHaveLength(0);
    expect(dry.mandateBound).toBe(true);
    expect(dry.checks.every((c) => c.status !== "fail")).toBe(true);
    expect(dry.decision.action).toBe("defend");
    expect(dry.steps.map((s) => s.kind)).toEqual(["provide_evidence"]);
    expect(dry.evidencePack).toContain("9400111899223197428490");
    expect(seen).toContain("9400111899223197428490");

    const live = await processDispute(deps, "PP-R-SSN-10190213", { execute: true });
    expect(live.results).toEqual([{ step: "provide_evidence", ok: true, debugId: "dbg1" }]);
    expect(writes).toEqual([{ method: "POST", path: "/v1/customer/disputes/PP-R-SSN-10190213/provide-evidence", contentType: "multipart" }]);
    expect(readdirSync(runsDir).length).toBe(2);
  });

  it("surfaces PayPal errors with issue and debug id, and stops later steps", async () => {
    const fetchImpl = (async (url: string | URL) =>
      String(url).endsWith("/v1/oauth2/token")
        ? new Response(JSON.stringify({ access_token: "t", expires_in: 3600 }))
        : new Response(JSON.stringify({ details: [{ issue: "ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE" }] }), {
            status: 422,
            headers: { "paypal-debug-id": "dbg9" },
          })) as typeof fetch;
    const disputes = new Disputes(new PayPalClient({ clientId: "i", clientSecret: "s", env: "sandbox" }, fetchImpl));
    await expect(disputes.get("X")).rejects.toBeInstanceOf(PayPalError);
    const results = await executeSteps(disputes, "X", [
      { kind: "send_message", message: "hi" },
      { kind: "escalate", note: "n" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0]?.error).toContain("ACTION_NOT_ALLOWED_IN_CURRENT_DISPUTE_STATE");
  });
});
