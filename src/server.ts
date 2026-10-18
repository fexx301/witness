// Witness's HTTP API for the investigation desk. The PayPal and model keys stay here; the desk
// only calls /api. Investigations are dry runs: acting on a dispute is never exposed to the desk's AI.

import { existsSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { ClaudeAssessor, claudeClient } from "./decide.js";
import { MandateStore } from "./mandate.js";
import { PayPalClient, credentialsFromEnv } from "./paypal/client.js";
import { Disputes } from "./paypal/disputes.js";
import { Orders } from "./paypal/orders.js";
import { loadPolicy } from "./policy.js";
import { toClaudeRequest, type StudioTurn } from "./studioLlm.js";
import { processDispute } from "./witness.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const DISPUTE_ID = /^PP-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/;
const client = new PayPalClient(credentialsFromEnv());

// Each desk chat turn is bounded, whatever the browser sends: one model, capped output and request size.
const LLM_MAX_TOKENS = 16_000;
const LLM_MAX_REQUEST_BYTES = 2_000_000;

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

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/investigate") {
      const raw = await readBody(req, 4096);
      if (raw === null) return json(res, 413, { error: "Request too large." });
      const { disputeId } = JSON.parse(raw || "{}") as { disputeId?: unknown };
      if (typeof disputeId !== "string" || !DISPUTE_ID.test(disputeId)) return json(res, 400, { error: "disputeId must look like PP-R-ABC-123." });
      const record = await processDispute(
        {
          disputes: new Disputes(client),
          orders: new Orders(client),
          mandates: new MandateStore("data/mandates"),
          assessor: new ClaudeAssessor(),
          policy: loadPolicy("data/policy.json"),
          runsDir: "data/runs",
        },
        disputeId,
        { execute: false },
      );
      return json(res, 200, {
        disputeId: record.disputeId,
        status: record.claim.status,
        outcome: record.claim.outcome ?? null,
        model: record.model,
        policy: record.policy,
        decision: record.decision,
        findings: record.findings,
        evidenceNotes: record.writing.evidenceNotes,
        notSent: record.writing.dropped,
        planned: record.steps.map((s) => s.kind),
      });
    }
    if (req.method === "POST" && req.url === "/api/llm") {
      const raw = await readBody(req, LLM_MAX_REQUEST_BYTES);
      if (raw === null) return json(res, 413, { error: "Request too large." });
      const turn = JSON.parse(raw) as StudioTurn;
      if (!Array.isArray(turn.input)) return json(res, 400, { error: "A Studio turn needs an input list." });
      const { client, model } = claudeClient();
      // Closing the chat in the desk aborts the browser request, which cancels this call too.
      const abort = new AbortController();
      res.on("close", () => abort.abort());
      const reply = await client.messages.create({ model, max_tokens: LLM_MAX_TOKENS, ...toClaudeRequest(turn) }, { signal: abort.signal });
      return json(res, 200, {
        id: reply.id,
        model: reply.model,
        stopReason: reply.stop_reason,
        usage: reply.usage,
        content: reply.content.filter((block) => block.type === "text" || block.type === "tool_use"),
      });
    }
    json(res, 404, { error: "Not found." });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.WITNESS_PORT ?? 8790);
server.listen(port, "127.0.0.1", () => console.log(`Witness API on http://127.0.0.1:${port}`));
