// AG Studio's built-in agents reach Claude through the Witness server (/api/llm), which holds the
// key and caps each turn. Claude's reply comes back whole and is replayed as AG-UI events.
import type { AgAiEvent, AgAiOutputItem, AgLlmAdapter, AgLlmResponse } from "ag-studio";

type Block = { type: "text"; text: string } | { type: "tool_use"; id: string; name: string; input: unknown };

interface Reply {
  id: string;
  model: string;
  stopReason: string | null;
  usage?: { input_tokens: number; output_tokens: number };
  content: Block[];
}

function toEvents(reply: Reply): AgAiEvent[] {
  return reply.content.flatMap((block, index): AgAiEvent[] =>
    block.type === "text"
      ? [
          { type: "TEXT_MESSAGE_START", messageId: `${reply.id}-${index}`, role: "assistant" },
          { type: "TEXT_MESSAGE_CONTENT", messageId: `${reply.id}-${index}`, delta: block.text },
          { type: "TEXT_MESSAGE_END", messageId: `${reply.id}-${index}` },
        ]
      : [
          { type: "TOOL_CALL_START", toolCallId: block.id, toolCallName: block.name },
          { type: "TOOL_CALL_ARGS", toolCallId: block.id, delta: JSON.stringify(block.input ?? {}) },
          { type: "TOOL_CALL_END", toolCallId: block.id },
        ],
  );
}

function toResponse(reply: Reply): AgLlmResponse {
  const output: AgAiOutputItem[] = reply.content.map((block, index): AgAiOutputItem =>
    block.type === "text"
      ? { id: `${reply.id}-${index}`, kind: "output", type: "message", role: "assistant", status: "completed", content: [{ type: "text", text: block.text, annotations: [] }] }
      : { id: block.id, kind: "output", type: "function_call", callId: block.id, name: block.name, arguments: JSON.stringify(block.input ?? {}), status: "completed" },
  );
  const truncated = reply.stopReason === "max_tokens";
  return {
    id: reply.id,
    createdAt: Date.now(),
    model: reply.model,
    output,
    status: truncated ? "incomplete" : "completed",
    ...(truncated ? { incompleteDetails: { reason: "max_output_tokens" as const } } : {}),
    ...(reply.usage ? { usage: { inputTokens: reply.usage.input_tokens, outputTokens: reply.usage.output_tokens } } : {}),
  };
}

export const witnessLlmAdapter: AgLlmAdapter = {
  executeTurn(request, options) {
    const reply = fetch("/api/llm", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(request),
      signal: options?.signal,
    }).then(async (response) => {
      const body = await response.json();
      if (!response.ok) throw new Error(body.error ?? `Witness server returned ${response.status}`);
      return body as Reply;
    });
    const message = (error: unknown) => (error instanceof Error ? error.message : String(error));
    return {
      stream: {
        async *[Symbol.asyncIterator]() {
          try {
            yield* toEvents(await reply);
          } catch (error) {
            yield { type: "RUN_ERROR", message: message(error) } satisfies AgAiEvent;
          }
        },
      },
      complete: reply.then(toResponse, (error) => ({ id: "failed", createdAt: Date.now(), output: [], status: "failed" as const, error: { code: "witness_llm", message: message(error) } })),
    };
  },
};
