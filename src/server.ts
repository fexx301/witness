// Witness's HTTP API for the investigation desk. The PayPal and model keys stay here; the desk
// only calls /api. Investigations are dry runs: acting on a dispute is never exposed to the desk's AI.

import { existsSync } from "node:fs";
import { createServer, type ServerResponse } from "node:http";
import { ClaudeAssessor } from "./decide.js";
import { MandateStore } from "./mandate.js";
import { PayPalClient, credentialsFromEnv } from "./paypal/client.js";
import { Disputes } from "./paypal/disputes.js";
import { Orders } from "./paypal/orders.js";
import { loadPolicy } from "./policy.js";
import { processDispute } from "./witness.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const DISPUTE_ID = /^PP-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}$/;
const client = new PayPalClient(credentialsFromEnv());

const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};

const server = createServer(async (req, res) => {
  try {
    if (req.method === "POST" && req.url === "/api/investigate") {
      let raw = "";
      for await (const chunk of req) {
        raw += chunk;
        if (raw.length > 4096) return json(res, 413, { error: "Request too large." });
      }
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
        model: record.model,
        policy: record.policy,
        decision: record.decision,
        findings: record.findings,
        evidenceNotes: record.writing.evidenceNotes,
        notSent: record.writing.dropped,
        planned: record.steps.map((s) => s.kind),
      });
    }
    json(res, 404, { error: "Not found." });
  } catch (error) {
    json(res, 500, { error: error instanceof Error ? error.message : String(error) });
  }
});

const port = Number(process.env.WITNESS_PORT ?? 8790);
server.listen(port, "127.0.0.1", () => console.log(`Witness API on http://127.0.0.1:${port}`));
