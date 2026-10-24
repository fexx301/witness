// The model behind the desk's built-in AG Studio agents. Studio sends one turn as its own
// Responses-style items; this converts it to Claude's Messages API. Capped by the server: one
// model, bounded output, and only the tools Studio sends (Witness actions are never among them).

import type Anthropic from "@anthropic-ai/sdk";

interface StudioItem {
  type: string;
  role?: string;
  content?: { type: string; text?: string; refusal?: string }[];
  callId?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

export interface StudioTurn {
  input: StudioItem[];
  instructions?: string;
  tools?: { name: string; description: string; parameters: Record<string, unknown> }[];
  toolChoice?: "auto" | "none" | "required" | { name: string };
  responseFormat?: { type: "text" } | { type: "json"; name: string; schema: Record<string, unknown> };
}

const textOf = (item: StudioItem) => (item.content ?? []).map((c) => c.text ?? c.refusal ?? "").join("");

const parseArguments = (raw: string | undefined): Record<string, unknown> => {
  try {
    const value = JSON.parse(raw || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
};

export function toClaudeRequest(turn: StudioTurn) {
  const system: string[] = turn.instructions ? [turn.instructions] : [];
  const messages: Anthropic.MessageParam[] = [];
  // Claude needs alternating roles, so consecutive items of one role share a message.
  const push = (role: "user" | "assistant", block: Anthropic.ContentBlockParam) => {
    const last = messages.at(-1);
    if (last?.role === role && Array.isArray(last.content)) last.content.push(block);
    else messages.push({ role, content: [block] });
  };
  for (const item of turn.input) {
    if (item.type === "message" && item.role === "system") system.push(textOf(item));
    else if (item.type === "message" && (item.role === "user" || item.role === "assistant")) {
      const text = textOf(item);
      if (text) push(item.role, { type: "text", text });
    } else if (item.type === "function_call") push("assistant", { type: "tool_use", id: item.callId ?? "", name: item.name ?? "", input: parseArguments(item.arguments) });
    else if (item.type === "function_call_output") push("user", { type: "tool_result", tool_use_id: item.callId ?? "", content: item.output ?? "" });
    // Reasoning items are dropped: Claude's thinking signatures can't travel through Studio's items,
    // and a history without thinking blocks is valid.
  }
  // Forced tool use is rejected by current Claude models, so a required call becomes an instruction.
  const choice = turn.toolChoice;
  if (choice === "required") system.push("You must call one of the available tools in this turn.");
  else if (choice && typeof choice === "object") system.push(`You must call the ${choice.name} tool in this turn.`);
  return {
    system: system.join("\n\n") || undefined,
    messages,
    ...(turn.tools?.length
      ? {
          tools: turn.tools.map((t) => ({ name: t.name, description: t.description, input_schema: t.parameters as Anthropic.Tool.InputSchema })),
          tool_choice: { type: choice === "none" ? ("none" as const) : ("auto" as const) },
        }
      : {}),
    ...(turn.responseFormat?.type === "json"
      ? { output_config: { format: { type: "json_schema" as const, schema: turn.responseFormat.schema } } }
      : {}),
  };
}

// Dollars per million input and output tokens. An unknown model is charged at Opus rates, the highest.
const RATES: Record<string, [number, number]> = {
  "anthropic/claude-opus-5.5": [4, 20],
  "claude-opus-5-5": [4, 20],
  "claude-opus-5": [5, 25],
  "anthropic/claude-sonnet-5.5": [2, 10],
  "claude-sonnet-5-5": [2, 10],
  "anthropic/claude-haiku-5.5": [0.1, 0.5],
  "claude-haiku-5-5": [0.1, 0.5],
};

type Usage = { input_tokens: number; output_tokens: number; cache_creation_input_tokens?: number | null; cache_read_input_tokens?: number | null };
const costOf = (model: string, inputTokens: number, outputTokens: number) => {
  const [input, output] = RATES[model] ?? RATES["claude-opus-5-5"]!;
  return (inputTokens * input + outputTokens * output) / 1_000_000;
};
const usageCost = (model: string, usage: Usage) =>
  costOf(model, usage.input_tokens + (usage.cache_creation_input_tokens ?? 0) + (usage.cache_read_input_tokens ?? 0), usage.output_tokens);

// What the desk's chat may spend in one UTC day. AG Studio's agents run several turns in parallel, so each
// turn reserves its worst case before the call (its whole request as input, plus the output cap) and is
// refused if that doesn't fit; the reply's usage then replaces the reservation.
export interface Reservation {
  day: string;
  usd: number;
}
export class DailyBudget {
  private day = "";
  private spent = 0;

  constructor(private readonly limitUsd: number, private readonly today = () => new Date().toISOString().slice(0, 10)) {}

  private roll() {
    if (this.day !== this.today()) [this.day, this.spent] = [this.today(), 0];
  }

  remaining(): number {
    this.roll();
    return Math.max(0, this.limitUsd - this.spent);
  }

  reserve(model: string, maxInputTokens: number, maxOutputTokens: number): Reservation | null {
    this.roll();
    const usd = costOf(model, maxInputTokens, maxOutputTokens);
    if (this.spent + usd > this.limitUsd) return null;
    this.spent += usd;
    return { day: this.day, usd };
  }

  // Replaces a reservation with what the call cost: its usage, or nothing if it failed before a reply.
  settle(reservation: Reservation, model: string, usage?: Usage): number {
    this.roll();
    const cost = usage ? usageCost(model, usage) : 0;
    this.spent += cost - (reservation.day === this.day ? reservation.usd : 0);
    return cost;
  }
}
