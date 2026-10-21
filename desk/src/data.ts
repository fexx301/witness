// The queue's data: one row per PayPal dispute, from the Witness server, as an AG Studio source whose
// fields are declared here once (saved dashboards refer to them by id). Anything that changes a
// dispute (an investigation, an execution) asks for a refresh, which reloads the source.
import type { AgDataSourceDefinition, AgFieldDefinition } from "ag-studio";
import type { WitnessRegistry } from "./widgets";

export interface DisputeRow {
  disputeId: string;
  reason: string;
  amountUsd: number;
  paypalStatus: string;
  stage: string;
  outcome: string;
  buyer: string;
  witnessDecision: string;
  baselineDecision: string;
  sentToPayPal: string;
  responseDue: string;
  openedAt: string;
  investigatedAt: string;
}

const refreshes = new EventTarget();
// Every widget queries the source; they share one load until something asks for a refresh.
let shared: Promise<DisputeRow[]> | null = null;
export const requestRefresh = () => {
  shared = null;
  refreshes.dispatchEvent(new Event("refresh"));
};
export const onRefresh = (listener: () => void) => {
  refreshes.addEventListener("refresh", listener);
  return () => refreshes.removeEventListener("refresh", listener);
};

// The rows every widget and the picker share until the next refresh.
export const sharedRows = () => (shared ??= loadRows().catch((error) => ((shared = null), Promise.reject(error))));

export async function loadRows(): Promise<DisputeRow[]> {
  const response = await fetch("/api/disputes");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Witness server returned ${response.status}`);
  return body.rows as DisputeRow[];
}

export const ACTION_LABEL: Record<string, string> = {
  refund: "Refund",
  defend: "Defend",
  propose_return: "Offer a return",
  request_evidence: "Ask for evidence",
  review: "Send to a person",
  "not investigated": "Not investigated",
};
// PayPal's codes in words: WAITING_FOR_SELLER_RESPONSE reads "Waiting for seller response".
export const sentence = (code: string) => code.charAt(0) + code.slice(1).toLowerCase().replaceAll("_", " ");
const action = (code: string) => ACTION_LABEL[code] ?? code;
// What the queue shows; the server's rows keep the codes.
const DISPLAY: Partial<Record<string, (value: string) => string>> = {
  paypalStatus: sentence,
  stage: sentence,
  outcome: sentence,
  witnessDecision: action,
  baselineDecision: action,
};

const text = (id: keyof DisputeRow, name: string): AgFieldDefinition<WitnessRegistry> => ({ id, name, format: "textFormat" });
const when = (id: keyof DisputeRow, name: string): AgFieldDefinition<WitnessRegistry> => ({ id, name, format: "dateTimeFormat" });
const DATE_FIELDS = new Set<string>(["responseDue", "openedAt", "investigatedAt"]);

export const witnessSource: AgDataSourceDefinition<"row", WitnessRegistry> = {
  id: "witness",
  name: "Witness",
  dataShape: "row",
  tables: [
    {
      id: "disputes",
      name: "Disputes",
      fields: [
        text("disputeId", "Dispute"),
        text("reason", "Reason"),
        { id: "amountUsd", name: "Amount", format: "currencyFormat" },
        text("paypalStatus", "PayPal status"),
        text("stage", "Stage"),
        text("outcome", "Outcome"),
        text("buyer", "Bought by"),
        text("witnessDecision", "Witness decision"),
        text("baselineDecision", "Rules-only decision"),
        text("sentToPayPal", "Sent to PayPal"),
        when("responseDue", "Response due"),
        when("openedAt", "Opened"),
        when("investigatedAt", "Investigated"),
      ],
    },
  ],
  getData: async (_tableId, fieldIds) => ({
    data: (await sharedRows()).map((row) =>
      Object.fromEntries(
        fieldIds.map((id) => {
          const value = row[id as keyof DisputeRow];
          return [id, DATE_FIELDS.has(id) ? (value ? new Date(value as string) : null) : (DISPLAY[id]?.(value as string) ?? value)];
        }),
      ),
    ),
  }),
};
