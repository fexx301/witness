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
