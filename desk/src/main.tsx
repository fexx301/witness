// The Witness investigation desk: AG Studio with a Witness agent in its chat.
import { AgStudioAiModule, AgStudioModuleRegistry, createAiHarness, enableStudioDevValidations, type AgAiAgentRunner, type AgAiEvent, type AgAiHarnessSetup } from "ag-studio";
import { AgStudio } from "ag-studio-react";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

if (import.meta.env.DEV) enableStudioDevValidations();
AgStudioModuleRegistry.registerModules([AgStudioAiModule]);

const data = {
  sources: [{ id: "disputes", data: [{ dispute: "PP-R-YUX-10193379", reason: "Not as described", amountUsd: 18, status: "Resolved" }] }],
};

const DISPUTE_ID = /PP-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}/;

interface Investigation {
  disputeId: string;
  model: string;
  policy: string;
  decision: { action: string; basis: string; gaps: string[]; discrepancy?: string };
  findings: { key: string; status: string; summary: string }[];
}

const LABEL: Record<string, string> = {
  authorization: "Buyer authorized the agent",
  instruction_compliance: "Agent followed the buyer's instructions",
  listing_match: "Merchant delivered as listed",
  fulfilment: "Delivered",
};

function describe(r: Investigation): string {
  const lines = [`Decision for ${r.disputeId}: ${r.decision.action.toUpperCase()} (${r.decision.basis.replace("_", " ")})`, ""];
  for (const f of r.findings) lines.push(`${LABEL[f.key] ?? f.key}: ${f.status}. ${f.summary}`);
  if (r.decision.discrepancy) lines.push("", `Discrepancy: ${r.decision.discrepancy}`);
  if (r.decision.gaps.length) lines.push("", "Missing:", ...r.decision.gaps.map((g) => `- ${g}`));
  lines.push("", `Dry run: nothing was sent to PayPal. Model: ${r.model}. Policy: ${r.policy}.`);
  return lines.join("\n");
}

function* say(messageId: string, text: string): Generator<AgAiEvent> {
  yield { type: "TEXT_MESSAGE_START", messageId, role: "assistant" };
  yield { type: "TEXT_MESSAGE_CONTENT", messageId, delta: text };
  yield { type: "TEXT_MESSAGE_END", messageId };
}

// Owns its loop, with no model on the desk side: it asks the Witness server to investigate. It can
// only investigate; acting on a dispute stays a human decision outside the chat.
const witness: AgAiAgentRunner = {
  id: "witness",
  name: "Witness",
  description: "Investigates a PayPal dispute: what the buyer approved, what the agent bought, and what the merchant delivered.",
  run: async function* (input, ctx) {
    yield { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId };
    const last = [...input.messages].reverse().find((m) => m.role === "user");
    const id = last?.role === "user" ? last.content.match(DISPUTE_ID)?.[0] : undefined;
    if (!id) {
      yield* say(`${input.runId}-ask`, "Give me a PayPal dispute ID to investigate, like PP-R-YUX-10193379.");
    } else {
      yield* say(`${input.runId}-progress`, `Investigating ${id}: reading the dispute, the order, tracking and the buyer's mandate. Claude is comparing them, which takes about 20 seconds…`);
      try {
        const response = await fetch("/api/investigate", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ disputeId: id }),
          signal: ctx.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Witness server returned ${response.status}`);
        yield* say(`${input.runId}-result`, describe(body as Investigation));
      } catch (error) {
        if (!ctx.signal?.aborted) yield { type: "RUN_ERROR", message: error instanceof Error ? error.message : String(error) };
        return;
      }
    }
    yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
  },
};

const ai: AgAiHarnessSetup = ({ api }) => createAiHarness(api, () => ({ agents: [witness], primary: "witness" }));

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AgStudio data={data} mode="edit" ai={ai} />
  </StrictMode>,
);
