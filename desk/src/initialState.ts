// The desk's starting layout. Page 1 was built by AG Studio's own agents from a written brief, exported
// with getState(), then hand-tuned (layout, columns, chart legend); page 2 holds the investigation widgets.
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
            cols: ["disputeId", "responseDue", "reason", "amountUsd", "baselineDecision", "witnessDecision", "paypalStatus", "sentToPayPal"].map((field) => ({
              id: `disputes.${field}`,
            })),
          },
        },
        "w-decisions-by-reason": {
          type: "bar-chart-stacked",
          format: { title: { enabled: true, text: "Witness decisions by reason" }, style: { theme: { common: { legend: { enabled: true, position: "bottom" } } } } },
          dataMapping: { categoryKey: [{ id: "disputes.reason" }], valueKey: count, legendKey: [{ id: "disputes.witnessDecision" }] },
        },
      },
      widgetLayout: {
        "w-open-disputes": { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 7 },
        "w-bought-by-ai-agent": { xTrack: 6, yTrack: 0, xSpan: 6, ySpan: 7 },
        "w-awaiting-our-response": { xTrack: 12, yTrack: 0, xSpan: 6, ySpan: 7 },
        "w-sent-to-paypal": { xTrack: 18, yTrack: 0, xSpan: 6, ySpan: 7 },
        "w-dispute-queue": { xTrack: 0, yTrack: 7, xSpan: 24, ySpan: 25 },
        "w-decisions-by-reason": { xTrack: 0, yTrack: 32, xSpan: 24, ySpan: 13 },
      },
      filter: {
        widget: {
          "w-open-disputes": [{ field: { id: "disputes.outcome" }, model: { operator: "isBlank" } }],
          "w-bought-by-ai-agent": [{ field: { id: "disputes.buyer" }, model: { operator: "equals", value: "AI agent" } }],
          "w-awaiting-our-response": [{ field: { id: "disputes.paypalStatus" }, model: { operator: "equals", value: "Waiting for seller response" } }],
          "w-sent-to-paypal": [{ field: { id: "disputes.sentToPayPal" }, model: { operator: "equals", value: "Yes" } }],
          "w-decisions-by-reason": [{ field: { id: "disputes.witnessDecision" }, model: { operator: "notEqual", value: "Not investigated" } }],
        },
      },
    },
    {
      id: "investigation",
      widgets: {
        "w-picker": { type: "witness-picker" },
        "w-case": { type: "witness-case" },
        "w-claim": { type: "witness-claim" },
        "w-baseline": { type: "witness-baseline" },
        "w-mandate": { type: "witness-mandate" },
        "w-trace": { type: "witness-trace" },
        "w-outgoing": { type: "witness-outgoing" },
      },
      widgetLayout: {
        "w-picker": { xTrack: 0, yTrack: 0, xSpan: 6, ySpan: 48 },
        "w-case": { xTrack: 6, yTrack: 0, xSpan: 18, ySpan: 24 },
        "w-claim": { xTrack: 6, yTrack: 24, xSpan: 6, ySpan: 24 },
        "w-mandate": { xTrack: 12, yTrack: 24, xSpan: 6, ySpan: 24 },
        "w-outgoing": { xTrack: 18, yTrack: 24, xSpan: 6, ySpan: 24 },
        "w-trace": { xTrack: 0, yTrack: 48, xSpan: 16, ySpan: 34 },
        "w-baseline": { xTrack: 16, yTrack: 48, xSpan: 8, ySpan: 34 },
      },
    },
  ],
  selectedPageId: "queue",
  // The chat stays open, narrower: the queue and the case come first.
  panels: { ai: { width: 300 } },
  version: "3.0.0",
};
