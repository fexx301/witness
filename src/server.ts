// Witness's HTTP API for the investigation desk. The PayPal and model keys stay here; the desk only
// calls /api. Investigations are dry runs. Acting on a dispute is a separate, human request that
// sends exactly a reviewed investigation, and it is never offered to the desk's AI as a tool.

import type Anthropic from "@anthropic-ai/sdk";
import { existsSync } from "node:fs";
import { acceptPage, acceptedPage, completeAcceptance, errorPage, firstOrderProblem, startAcceptance } from "./accept.js";
import { DailyCount, envNumber, isLocalRequest, redactIdentities, sameOriginRequest } from "./access.js";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ClaudeAssessor, claudeClient } from "./decide.js";
import { cachedClaims, investigate, investigationView, readClaims, rowsFor } from "./desk.js";
import { MandateStore } from "./mandate.js";
import { askRecords, BudgetExhausted, recordsToolkit, type RecordsToolkit } from "./paypalRecords.js";
import { PayPalClient, credentialsFromEnv } from "./paypal/client.js";
import { Disputes } from "./paypal/disputes.js";
import { Orders } from "./paypal/orders.js";
import { loadPolicy } from "./policy.js";
import { DailyBudget, toClaudeRequest, type StudioTurn } from "./studioLlm.js";
import { ExecutionRefused, executeReviewed, reviewedRecord, type Deps } from "./witness.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const DISPUTE_ID = /^PP-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/;
const RAN_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
// Each desk chat turn is bounded, whatever the browser sends: one model, capped output and request size,
// and a daily spending budget. OpenRouter reserves credit for every parallel turn's maximum output.
const LLM_MAX_TOKENS = 8_000;
const LLM_MAX_REQUEST_BYTES = 2_000_000;
const llmBudget = new DailyBudget(envNumber(process.env, "WITNESS_DESK_AI_DAILY_USD", 1));
// Each investigation is one Claude call (about $0.05 on Opus), so visitors get a daily number of them.
const visitorInvestigations = new DailyCount(envNumber(process.env, "WITNESS_VISITOR_INVESTIGATIONS_PER_DAY", 10, { integer: true }));

const host = process.env.WITNESS_HOST ?? "127.0.0.1";
const port = envNumber(process.env, "WITNESS_PORT", 8790, { min: 1, integer: true });
// Anyone who can reach a hosted desk could press Execute, or start PayPal orders from the acceptance
// page, so both are for this machine only unless a flag says otherwise. Judged per request: behind a
// reverse proxy the server is bound to loopback but its visitors are not local.
const executeAllowed = (req: IncomingMessage) => process.env.WITNESS_ALLOW_EXECUTE === "1" || isLocalRequest(req.headers, req.socket.remoteAddress);

// Where PayPal sends the buyer back after approving; fixed, never taken from the request's Host header.
const origin = process.env.WITNESS_PUBLIC_URL ?? `http://${host}:${port}`;
// The sites a browser may POST from: the hosted desk, this server, and the desk's dev server.
const allowedOrigins = [new URL(origin).origin, `http://${host}:${port}`, `http://localhost:${port}`, "http://localhost:5173", "http://127.0.0.1:5173"];
// Visitors to a hosted desk see records with PayPal account IDs and emails replaced.
const forViewer = <T>(req: IncomingMessage, body: T): T => (isLocalRequest(req.headers, req.socket.remoteAddress) ? body : redactIdentities(body));

const client = new PayPalClient(credentialsFromEnv());
const deps = (): Deps => ({
  disputes: new Disputes(client),
  orders: new Orders(client),
  mandates: new MandateStore("data/mandates"),
  assessor: new ClaudeAssessor(),
  policy: loadPolicy("data/policy.json"),
  runsDir: "data/runs",
});
// Built on first use, so the server starts even if the toolkit can't.
let toolkit: RecordsToolkit | undefined;
// Reading every dispute from PayPal takes seconds, so the queue shows the last read while a newer one loads.
const queue = cachedClaims(() => readClaims(deps()), 10_000);

async function readBody(req: IncomingMessage, limit: number): Promise<string | null> {
  let raw = "";
  for await (const chunk of req) {
    raw += chunk;
    if (raw.length > limit) return null;
  }
  return raw;
}

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const html = (res: ServerResponse, status: number, body: string) => {
  res.writeHead(status, { "content-type": "text/html; charset=utf-8" });
  res.end(body);
};

const HASH_PATH = /^\/accept\/([0-9a-f]{64})$/;

async function handle(req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? "/", "http://desk");
  if (req.method === "POST") {
    if (!sameOriginRequest(req.headers, allowedOrigins)) return json(res, 403, { error: "Requests from other sites are refused." });
    // JSON can't be sent cross-site without the browser asking first, which this server never allows.
    if (url.pathname.startsWith("/api/") && !(req.headers["content-type"] ?? "").startsWith("application/json"))
      return json(res, 415, { error: "Send JSON." });
  }

  if (req.method === "GET" && url.pathname === "/api/disputes") return json(res, 200, { rows: rowsFor(await queue.get(), deps().runsDir) });

  if (req.method === "GET" && url.pathname === "/api/investigation") {
    const disputeId = url.searchParams.get("id") ?? "";
    const ranAt = url.searchParams.get("ranAt") ?? undefined;
    if (!DISPUTE_ID.test(disputeId) || (ranAt && !RAN_AT.test(ranAt))) return json(res, 400, { error: "Unknown dispute or investigation." });
    const view = investigationView("data/runs", disputeId, ranAt, new MandateStore("data/mandates"));
    return view ? json(res, 200, forViewer(req, view)) : json(res, 404, { error: "No investigation yet for this dispute." });
  }

  if (req.method === "POST" && url.pathname === "/api/investigate") {
    const raw = await readBody(req, 4096);
    if (raw === null) return json(res, 413, { error: "Request too large." });
    const { disputeId } = JSON.parse(raw || "{}") as { disputeId?: unknown };
    if (typeof disputeId !== "string" || !DISPUTE_ID.test(disputeId)) return json(res, 400, { error: "disputeId must look like PP-R-ABC-123." });
    if (!isLocalRequest(req.headers, req.socket.remoteAddress) && !visitorInvestigations.take())
      return json(res, 429, { error: "Today's investigations for visitors are used up. The existing investigations are still here to read." });
    const { witness, baseline } = await investigate(deps(), disputeId);
    // The desk reloads the queue next, so it should show PayPal as it is now.
    await queue.refresh().catch(() => {});
    return json(res, 200, forViewer(req, {
      disputeId: witness.disputeId,
      ranAt: witness.ranAt,
      status: witness.claim.status,
      outcome: witness.claim.outcome ?? null,
      model: witness.model,
      policy: witness.policy,
      decision: witness.decision,
      baselineDecision: baseline.decision.action,
      findings: witness.findings,
      evidenceNotes: witness.writing.evidenceNotes,
      notSent: witness.writing.dropped,
      planned: witness.steps.map((s) => s.kind),
    }));
  }

  if (req.method === "POST" && url.pathname === "/api/execute") {
    if (!executeAllowed(req)) return json(res, 403, { error: "Executing decisions is turned off on this server." });
    const raw = await readBody(req, 4096);
    if (raw === null) return json(res, 413, { error: "Request too large." });
    const { disputeId, ranAt } = JSON.parse(raw || "{}") as { disputeId?: unknown; ranAt?: unknown };
    if (typeof disputeId !== "string" || !DISPUTE_ID.test(disputeId) || typeof ranAt !== "string" || !RAN_AT.test(ranAt))
      return json(res, 400, { error: "Name the dispute and the reviewed investigation (ranAt)." });
    const reviewed = reviewedRecord("data/runs", disputeId, ranAt);
    if (!reviewed) return json(res, 404, { error: "That reviewed investigation does not exist." });
    try {
      const executed = await executeReviewed(deps(), reviewed);
      await queue.refresh().catch(() => {});
      return json(res, 200, { ranAt: executed.ranAt, reviewedRanAt: executed.reviewedRanAt, steps: executed.steps.map((s) => s.kind), results: executed.results });
    } catch (error) {
      if (error instanceof ExecutionRefused) return json(res, 409, { error: error.message });
      throw error;
    }
  }

  // The buyer's side: read and accept a mandate, then approve the first payment at PayPal.
  const acceptHash = HASH_PATH.exec(url.pathname)?.[1];
  if (acceptHash || url.pathname === "/accept/return") {
    if (!executeAllowed(req)) return html(res, 403, errorPage("Accepting mandates is turned off on this server."));
    const mandates = new MandateStore("data/mandates");
    if (req.method === "GET" && url.pathname === "/accept/return") {
      const orderId = url.searchParams.get("token") ?? "";
      if (!/^[A-Z0-9]{10,20}$/.test(orderId)) return html(res, 400, errorPage("PayPal did not return an order."));
      const accepted = await completeAcceptance(client, mandates, orderId);
      console.log(`mandate ${accepted.hash.slice(0, 12)}… accepted via PayPal order ${accepted.orderId}; agent vault ${accepted.vaultId}`);
      return html(res, 200, acceptedPage(accepted));
    }
    const mandate = mandates.find(acceptHash);
    if (!mandate || !acceptHash) return html(res, 404, errorPage("Witness holds no such mandate."));
    if (req.method === "GET") {
      const first = { item: url.searchParams.get("item") ?? "", amount: url.searchParams.get("amount") ?? "" };
      return html(res, 200, acceptPage(mandate, acceptHash, first, firstOrderProblem(mandate, first), url.searchParams.has("cancelled")));
    }
    if (req.method === "POST") {
      const raw = await readBody(req, 4096);
      if (raw === null) return html(res, 413, errorPage("Request too large."));
      const form = new URLSearchParams(raw);
      const first = { item: form.get("item") ?? "", amount: form.get("amount") ?? "" };
      const problem = firstOrderProblem(mandate, first);
      if (problem) return html(res, 400, acceptPage(mandate, acceptHash, first, problem, false));
      res.writeHead(303, { location: await startAcceptance(client, acceptHash, first, origin) });
      return res.end();
    }
  }

  // PayPal's Agent Toolkit, read-only, for the desk's PayPal records agent. Its turns share the desk's AI budget.
  if (req.method === "POST" && url.pathname === "/api/paypal-records") {
    const raw = await readBody(req, 4096);
    if (raw === null) return json(res, 413, { error: "Request too large." });
    const { question } = JSON.parse(raw || "{}") as { question?: unknown };
    if (typeof question !== "string" || !question.trim() || question.length > 1000) return json(res, 400, { error: "Ask a question of up to 1,000 characters." });
    const { client: claude, deskModel: model } = claudeClient();
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    try {
      toolkit ??= recordsToolkit(credentialsFromEnv());
      const answer = await askRecords({ claude, model, toolkit, budget: llmBudget, signal: abort.signal }, question.trim());
      return json(res, 200, forViewer(req, answer));
    } catch (error) {
      if (error instanceof BudgetExhausted) return json(res, 429, { error: `${error.message} Witness investigations still work.` });
      throw error;
    }
  }

  if (req.method === "POST" && url.pathname === "/api/llm") {
    const raw = await readBody(req, LLM_MAX_REQUEST_BYTES);
    if (raw === null) return json(res, 413, { error: "Request too large." });
    const turn = JSON.parse(raw) as StudioTurn;
    if (!Array.isArray(turn.input)) return json(res, 400, { error: "A Studio turn needs an input list." });
    const { client: claude, deskModel: model } = claudeClient();
    // Reserved before the call, at a generous upper bound: one input token per byte of the request, plus the
    // output cap. No retries, so one turn is one call.
    const reservation = llmBudget.reserve(model, Buffer.byteLength(raw), LLM_MAX_TOKENS);
    if (!reservation) return json(res, 429, { error: "The desk's AI budget for today is used up. Witness investigations still work." });
    // Closing the chat in the desk aborts the browser request, which cancels this call too.
    const abort = new AbortController();
    res.on("close", () => abort.abort());
    let reply: Anthropic.Message;
    try {
      reply = await claude.messages.create({ model, max_tokens: LLM_MAX_TOKENS, ...toClaudeRequest(turn) }, { signal: abort.signal, maxRetries: 0 });
    } catch (error) {
      llmBudget.settle(reservation, model);
      throw error;
    }
    const cost = llmBudget.settle(reservation, model, reply.usage);
    console.log(`desk AI turn: $${cost.toFixed(4)}, $${llmBudget.remaining().toFixed(2)} left today`);
    return json(res, 200, {
      id: reply.id,
      model: reply.model,
      stopReason: reply.stop_reason,
      usage: reply.usage,
      content: reply.content.filter((block) => block.type === "text" || block.type === "tool_use"),
    });
  }

  json(res, 404, { error: "Not found." });
}

const server = createServer((req, res) => {
  handle(req, res).catch((error) => json(res, 500, { error: error instanceof Error ? error.message : String(error) }));
});
// Most often an earlier Witness server still running, which the desk would otherwise keep talking to.
server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code !== "EADDRINUSE") throw error;
  console.error(`Port ${port} is already in use, probably by an earlier Witness server. Stop it with: kill $(lsof -ti tcp:${port}) (or set WITNESS_PORT).`);
  process.exit(1);
});
server.listen(port, host, () => {
  console.log(`Witness API on http://${host}:${port}; execute and accept ${process.env.WITNESS_ALLOW_EXECUTE === "1" ? "allowed for everyone" : "local only"}`);
  // So the first visitor does not wait on PayPal.
  queue.get().catch((error: Error) => console.error(`could not read the dispute queue: ${error.message}`));
});
