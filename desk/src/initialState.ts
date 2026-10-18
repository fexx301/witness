// The desk's starting layout. Page 1 was built by AG Studio's own agents from a written brief, then
// exported with getState(); page 2 holds the investigation widgets.
import type { AgReportState } from "ag-studio";
import type { WitnessRegistry } from "./widgets";

const count = [{ id: "disputes.disputeId", aggregation: "count" as const }];
const kpi = (text: string) => ({ type: "value" as const, format: { title: { enabled: true, text } }, dataMapping: { value: count } });

export const initialState: AgReportState<WitnessRegistry> = {
  pages: [
    {
      id: "queue",
      widgets: {
        "w-open-disputes": kpi("Open disputes"),
        "w-bought-by-ai-agent": kpi("Bought by an AI agent"),
        "w-awaiting-our-response": kpi("Awaiting our response"),
        "w-sent-to-paypal": kpi("Sent to PayPal"),
        "w-dispute-queue": {
          type: "grid",
          format: { title: { enabled: true, text: "Dispute queue" } },
          dataMapping: {
            cols: ["disputeId", "reason", "amountUsd", "paypalStatus", "buyer", "witnessDecision", "baselineDecision", "sentToPayPal", "responseDue"].map((field) => ({
              id: `disputes.${field}`,
            })),
          },
        },
        "w-decisions-by-reason": {
          type: "bar-chart-stacked",
          format: { title: { enabled: true, text: "Decisions by reason" } },
          dataMapping: { categoryKey: [{ id: "disputes.reason" }], valueKey: count, legendKey: [{ id: "disputes.witnessDecision" }] },
        },
      },
      widgetLayout: {
        "w-open-disputes": { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 10 },
        "w-bought-by-ai-agent": { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 10 },
        "w-awaiting-our-response": { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 10 },
        "w-sent-to-paypal": { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 10 },
        "w-dispute-queue": { xTrack: 0, yTrack: 10, xSpan: 16, ySpan: 40 },
        "w-decisions-by-reason": { xTrack: 16, yTrack: 10, xSpan: 8, ySpan: 40 },
      },
      filter: {
        widget: {
          "w-open-disputes": [{ field: { id: "disputes.outcome" }, model: { operator: "isBlank" } }],
          "w-bought-by-ai-agent": [{ field: { id: "disputes.buyer" }, model: { operator: "equals", value: "AI agent" } }],
          "w-awaiting-our-response": [{ field: { id: "disputes.paypalStatus" }, model: { operator: "equals", value: "WAITING_FOR_SELLER_RESPONSE" } }],
          "w-sent-to-paypal": [{ field: { id: "disputes.sentToPayPal" }, model: { operator: "equals", value: "Yes" } }],
        },
      },
    },
    {
      id: "investigation",
      widgets: {
        "w-picker": { type: "witness-picker" },
        "w-actions": { type: "witness-actions" },
        "w-claim": { type: "witness-claim" },
        "w-baseline": { type: "witness-baseline" },
        "w-mandate": { type: "witness-mandate" },
        "w-trace": { type: "witness-trace" },
        "w-outgoing": { type: "witness-outgoing" },
      },
      widgetLayout: {
        "w-picker": { xTrack: 0, yTrack: 0, xSpan: 9, ySpan: 14 },
        "w-actions": { xTrack: 9, yTrack: 0, xSpan: 15, ySpan: 14 },
        "w-claim": { xTrack: 0, yTrack: 14, xSpan: 8, ySpan: 18 },
        "w-baseline": { xTrack: 8, yTrack: 14, xSpan: 8, ySpan: 18 },
        "w-mandate": { xTrack: 16, yTrack: 14, xSpan: 8, ySpan: 18 },
        "w-trace": { xTrack: 0, yTrack: 32, xSpan: 14, ySpan: 34 },
        "w-outgoing": { xTrack: 14, yTrack: 32, xSpan: 10, ySpan: 34 },
      },
    },
  ],
  selectedPageId: "queue",
  version: "3.0.0",
};
