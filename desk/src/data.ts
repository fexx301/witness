// The queue's data: one row per PayPal dispute, from the Witness server, as an AG Studio source whose
// fields are declared here once (saved dashboards refer to them by id). Anything that changes a
// dispute (an investigation, an execution) asks for a refresh, which reloads the source.
import type { AgDataSourceDefinition, AgFieldDefinition } from "ag-studio";

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

export async function loadRows(): Promise<DisputeRow[]> {
  const response = await fetch("/api/disputes");
  const body = await response.json();
  if (!response.ok) throw new Error(body.error ?? `Witness server returned ${response.status}`);
  return body.rows as DisputeRow[];
}

const text = (id: keyof DisputeRow, name: string): AgFieldDefinition => ({ id, name, format: "textFormat" });
const when = (id: keyof DisputeRow, name: string): AgFieldDefinition => ({ id, name, format: "dateTimeFormat" });
const DATE_FIELDS = new Set<string>(["responseDue", "openedAt", "investigatedAt"]);

export const witnessSource: AgDataSourceDefinition<"row"> = {
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
    data: (await (shared ??= loadRows().catch((error) => ((shared = null), Promise.reject(error))))).map((row) =>
      Object.fromEntries(
        fieldIds.map((id) => {
          const value = row[id as keyof DisputeRow];
          return [id, DATE_FIELDS.has(id) ? (value ? new Date(value as string) : null) : value];
        }),
      ),
    ),
  }),
};
