// The desk's agents: Witness, which only investigates, and AG Studio's five built-in agents on Claude.
import { createAiHarness, directLlmRunner, type AgAiAgentRunContext, type AgAiAgentRunner, type AgAiEvent, type AgAiHarnessSetup, type AgAiRunInput } from "ag-studio";
import { requestRefresh } from "./data";
import { openDispute } from "./deskState";
import { witnessLlmAdapter } from "./llmAdapter";

const DISPUTE_ID = /PP-[A-Z0-9]+(?:-[A-Z0-9]+){1,4}/;

interface Investigation {
  disputeId: string;
  status: string;
  outcome: string | null;
  planned: string[];
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
  const lines = [
    `Decision for ${r.disputeId}: ${r.decision.action.toUpperCase()} (${r.decision.basis.replace("_", " ")})`,
    `PayPal status now: ${r.status}${r.outcome ? `, outcome ${r.outcome}` : ""}. Planned PayPal response: ${r.planned.join(", ") || "none"}.`,
    "",
  ];
  for (const f of r.findings) lines.push(`- ${LABEL[f.key] ?? f.key}: ${f.status}. ${f.summary}`);
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

type WitnessParams = { disputeId?: string } | undefined;

// When another agent delegated the investigation, Studio reads the summary it receives back from a
// complete_task call recorded in this run, so the call and its result are emitted as events.
function* reportToDelegator<P>(input: AgAiRunInput, ctx: AgAiAgentRunContext<P>, summary: string): Generator<AgAiEvent> {
  if (!ctx.completeTask) return;
  const toolCallId = `${input.runId}-complete`;
  yield { type: "TOOL_CALL_START", toolCallId, toolCallName: ctx.completeTask.name };
  yield { type: "TOOL_CALL_ARGS", toolCallId, delta: JSON.stringify({ summary }) };
  yield { type: "TOOL_CALL_END", toolCallId };
  yield { type: "TOOL_CALL_RESULT", messageId: `${toolCallId}-result`, toolCallId, content: JSON.stringify({ summary }), role: "tool" };
}

// Owns its loop, with no model on the desk side: it asks the Witness server to investigate. It can
// only investigate; acting on a dispute stays a human decision outside the chat.
const witness: AgAiAgentRunner<WitnessParams> = {
  id: "witness",
  name: "Witness",
  description: "Investigates a PayPal dispute: what the buyer approved, what the agent bought, and what the merchant delivered. Give it the dispute ID.",
  schema: (s) => s.object({ disputeId: s.string().optional() }),
  run: async function* (input, ctx) {
    yield { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId };
    const last = [...input.messages].reverse().find((m) => m.role === "user");
    const id = ctx.params?.disputeId?.match(DISPUTE_ID)?.[0] ?? (last?.role === "user" ? last.content.match(DISPUTE_ID)?.[0] : undefined);
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
        const summary = describe(body as Investigation);
        yield* say(`${input.runId}-result`, summary);
        yield* reportToDelegator(input, ctx, summary);
        requestRefresh();
        openDispute(id);
      } catch (error) {
        if (!ctx.signal?.aborted) yield { type: "RUN_ERROR", message: error instanceof Error ? error.message : String(error) };
        return;
      }
    }
    yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
  },
};

type RecordsParams = { question?: string } | undefined;

// PayPal's own Agent Toolkit, read-only, through the Witness server: it looks up the merchant's PayPal records
// and answers. Like Witness, it can't change anything on PayPal.
const records: AgAiAgentRunner<RecordsParams> = {
  id: "paypal_records",
  name: "PayPal records",
  description:
    "Answers questions from the merchant's PayPal records with PayPal's Agent Toolkit, read-only: disputes, orders, shipment tracking, transactions and refunds. It can't change anything. Give it the question, with any IDs.",
  schema: (s) => s.object({ question: s.string().optional() }),
  run: async function* (input, ctx) {
    yield { type: "RUN_STARTED", threadId: input.threadId, runId: input.runId };
    const last = [...input.messages].reverse().find((m) => m.role === "user");
    const question = ctx.params?.question ?? (last?.role === "user" ? last.content : undefined);
    if (!question?.trim()) {
      yield* say(`${input.runId}-ask`, "What should I look up in PayPal? For example, the tracking for a dispute's payment, or an order's status.");
    } else {
      yield* say(`${input.runId}-progress`, "Looking it up in PayPal with PayPal's Agent Toolkit, read-only…");
      try {
        const response = await fetch("/api/paypal-records", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ question }),
          signal: ctx.signal,
        });
        const body = await response.json();
        if (!response.ok) throw new Error(body.error ?? `Witness server returned ${response.status}`);
        const { answer, lookups } = body as { answer: string; lookups: { tool: string; ok: boolean }[] };
        const used = lookups.map((l) => `${l.tool}${l.ok ? "" : " (failed)"}`).join(", ") || "none";
        const summary = `${answer}\n\nPayPal lookups (read-only): ${used}.`;
        yield* say(`${input.runId}-result`, summary);
        yield* reportToDelegator(input, ctx, summary);
      } catch (error) {
        if (!ctx.signal?.aborted) yield { type: "RUN_ERROR", message: error instanceof Error ? error.message : String(error) };
        return;
      }
    }
    yield { type: "RUN_FINISHED", threadId: input.threadId, runId: input.runId };
  },
};

// Shown in an empty chat, so a first-time reader knows what to ask. Each one is a paid desk AI turn.
const PROMPT_STARTERS = [
  { label: "What needs a response?", prompt: "Which disputes are still open, and what did Witness decide for each? Use the queue." },
  { label: "Where rules and Witness disagree", prompt: "List the disputes where the rules-only decision differs from Witness's decision, with both decisions and the dispute reason." },
  { label: "Investigate the open dispute", prompt: "Find the newest open dispute in the queue and have Witness investigate it." },
  { label: "Chart the queue", prompt: "Add a column chart to this page showing how many disputes each Witness decision covers." },
  { label: "Ask PayPal's records", prompt: "Find the newest open dispute in the queue, then ask the PayPal records agent what PayPal's shipment tracking says for its payment." },
];

// AG's five built-in agents run on Claude through the Witness server. The lead can hand a dispute to Witness,
// and a question about PayPal's records to the PayPal records agent. Neither takes an action on PayPal.
export const ai: AgAiHarnessSetup = ({ api }) =>
  createAiHarness(api, ({ builtIn, tools }) => {
    const lead = directLlmRunner({
      ...builtIn.lead,
      adapter: witnessLlmAdapter,
      instructions: (ctx, params) =>
        `${builtIn.lead.instructions?.(ctx, params) ?? ""}\n\nWhen the user asks about a PayPal dispute, delegate it to the witness agent with its dispute ID, then report Witness's findings and decision as given. Witness only investigates; it never acts on PayPal. When the user asks about PayPal records beyond the queue (an order, its shipment tracking, transactions or refunds), delegate the question to the paypal_records agent with any IDs it needs; it only reads.`,
      tools: (ctx, params) => [
        ...(builtIn.lead.tools?.(ctx, params) ?? []).filter((tool) => tool.name !== "delegate_to"),
        tools.delegateTo(["data", "page", "planning", "widget", "witness", "paypal_records"]),
      ],
    });
    const others = (["data", "page", "planning", "widget"] as const).map((id) => directLlmRunner({ ...builtIn[id], adapter: witnessLlmAdapter }));
    return { agents: [lead, ...others, witness, records], primary: "lead", promptStarters: PROMPT_STARTERS };
  });
