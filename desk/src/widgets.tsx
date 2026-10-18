// The investigation page's widgets: the dispute picker, what the buyer said, the mandate, the
// decision trace, the rules-only comparison, what goes to PayPal, and the actions. Every step says
// who did it - Claude, code, the merchant's policy or PayPal - in words as well as colour, and only
// what code actually checked is called checked.
import type { AgDefaultWidgetDefinition, AgWidgetsConfig } from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { useEffect, useState, type ReactNode } from "react";
import { loadRows, onRefresh, type DisputeRow } from "./data";
import { execute, investigate, openDispute, useInvestigation, useSelectedDispute, type Finding, type InvestigationView, type Step } from "./deskState";

const INK = "#14213D";
const MUTED = "#5B6578";
const LINE = "#E3E6EB";

type Tone = { label: string; fg: string; bg: string };
const ACTOR = {
  claude: { label: "Claude", fg: "#8A4B0F", bg: "#FDF1E4" },
  code: { label: "Code", fg: "#0F5E57", bg: "#E5F3F1" },
  policy: { label: "Merchant policy", fg: "#4B3778", bg: "#EFEAF7" },
  paypal: { label: "PayPal", fg: "#1D3C78", bg: "#E8EEF9" },
} satisfies Record<string, Tone>;
const GOOD = { fg: "#1F6B3A", bg: "#E7F4EC" };
const BAD = { fg: "#8A1C1C", bg: "#FBEAEA" };
const NEUTRAL = { fg: MUTED, bg: "#EEF0F3" };
const STATUS: Record<string, Tone> = {
  established: { label: "Established", ...GOOD },
  contradicted: { label: "Contradicted", ...BAD },
  unknown: { label: "Unknown", ...NEUTRAL },
  not_applicable: { label: "Not applicable", ...NEUTRAL },
  pass: { label: "Pass", ...GOOD },
  fail: { label: "Fail", ...BAD },
};
const ACTION_LABEL: Record<string, string> = {
  refund: "Refund",
  defend: "Defend",
  propose_return: "Offer a return",
  request_evidence: "Ask for evidence",
  review: "Send to a person",
};
const FINDING_LABEL: Record<string, string> = {
  authorization: "Buyer authorized the agent",
  instruction_compliance: "Agent followed the buyer's instructions",
  listing_match: "Merchant delivered as listed",
  fulfilment: "Delivered",
};
const STEP_LABEL: Record<string, string> = {
  provide_evidence: "Submit evidence",
  provide_supporting_info: "Submit supporting information",
  send_message: "Message the buyer",
  escalate: "Escalate to PayPal",
  accept_claim: "Accept the claim",
  make_offer: "Make an offer",
  none: "Nothing to send",
};

function Chip({ tone }: { tone: Tone }) {
  return (
    <span style={{ display: "inline-block", padding: "1px 8px", borderRadius: 999, fontSize: 11, fontWeight: 600, color: tone.fg, background: tone.bg, whiteSpace: "nowrap" }}>
      {tone.label}
    </span>
  );
}

function Frame({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div style={{ height: "100%", overflow: "auto", padding: "12px 14px", boxSizing: "border-box", fontFamily: "Inter, Arial, sans-serif", fontSize: 13, lineHeight: 1.45, color: INK }}>
      <h3 style={{ margin: "0 0 10px", fontSize: 14, fontWeight: 700 }}>{title}</h3>
      {children}
    </div>
  );
}

const Muted = ({ children }: { children: ReactNode }) => <p style={{ margin: "4px 0", color: MUTED }}>{children}</p>;

// The open investigation, or why there is none yet.
function WithView({ title, children }: { title: string; children: (view: InvestigationView) => ReactNode }) {
  const disputeId = useSelectedDispute();
  const loaded = useInvestigation(disputeId);
  let body: ReactNode;
  if (loaded.state === "none") body = <Muted>Pick a dispute to see its investigation.</Muted>;
  else if (loaded.state === "loading") body = <Muted>Loading…</Muted>;
  else if (loaded.state === "missing") body = <Muted>Not investigated yet. Use Investigate above.</Muted>;
  else if (loaded.state === "error") body = <Muted>Could not load the investigation: {loaded.message}</Muted>;
  else body = children(loaded.view);
  return <Frame title={title}>{body}</Frame>;
}

const finding = (view: InvestigationView, key: string): Finding | undefined => view.reviewed.findings.find((f) => f.key === key);
const stepText = (step: Step) => step.notes ?? step.message ?? step.note ?? step.reason ?? "";

function Picker() {
  const [rows, setRows] = useState<DisputeRow[] | null>(null);
  const selected = useSelectedDispute();
  useEffect(() => {
    const load = () => loadRows().then(setRows, () => setRows([]));
    load();
    return onRefresh(load);
  }, []);
  return (
    <Frame title="Disputes">
      {rows === null && <Muted>Loading…</Muted>}
      {rows?.length === 0 && <Muted>No disputes.</Muted>}
      {rows?.map((row) => (
        <button
          key={row.disputeId}
          onClick={() => openDispute(row.disputeId)}
          aria-pressed={row.disputeId === selected}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            margin: "0 0 6px",
            padding: "6px 8px",
            border: `1px solid ${row.disputeId === selected ? "#2457D6" : LINE}`,
            borderRadius: 6,
            background: row.disputeId === selected ? "#EEF3FD" : "#FDFDFB",
            color: INK,
            font: "inherit",
            cursor: "pointer",
          }}
        >
          <strong>{row.disputeId}</strong>
          <br />
          <span style={{ color: MUTED }}>
            {row.reason} · ${row.amountUsd.toFixed(2)} · {row.paypalStatus.toLowerCase().replaceAll("_", " ")} · Witness: {ACTION_LABEL[row.witnessDecision] ?? row.witnessDecision}
          </span>
        </button>
      ))}
    </Frame>
  );
}

function Claim() {
  return (
    <WithView title="The claim">
      {(view) => (
        <>
          <p style={{ margin: "0 0 6px" }}>
            <Chip tone={ACTOR.code} /> PayPal reason: <strong>{view.reviewed.claim.reason.toLowerCase().replaceAll("_", " ")}</strong>, ${view.reviewed.claim.amount.value.toFixed(2)}
          </p>
          <p style={{ margin: "8px 0 4px", fontWeight: 600 }}>The buyer's own words</p>
          {view.reviewed.claim.buyerStatements.map((statement, index) => (
            <blockquote key={index} style={{ margin: "0 0 6px", padding: "4px 8px", borderLeft: `3px solid ${LINE}`, color: INK }}>
              “{statement}”
            </blockquote>
          ))}
          <p style={{ margin: "8px 0 4px" }}>
            <Chip tone={ACTOR.claude} /> Claude's summary, not checked by code: {view.reviewed.assessment.claim_summary}
          </p>
          {view.reviewed.decision.discrepancy && (
            <p style={{ margin: "8px 0 0", padding: "6px 8px", borderRadius: 6, background: BAD.bg, color: BAD.fg }}>{view.reviewed.decision.discrepancy}</p>
          )}
        </>
      )}
    </WithView>
  );
}

function Mandate() {
  return (
    <WithView title="The buyer's mandate">
      {(view) =>
        view.mandate ? (
          <>
            <p style={{ margin: "0 0 6px" }}>
              {view.mandate.agent} may buy <strong>{view.mandate.scope.category}</strong>, up to ${view.mandate.scope.max_amount_usd}, until {view.mandate.valid_until}.
            </p>
            {view.mandate.instructions?.length ? (
              <>
                <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>Item instructions</p>
                <ul style={{ margin: "0 0 6px", paddingLeft: 18 }}>
                  {view.mandate.instructions.map((instruction) => (
                    <li key={instruction}>{instruction}</li>
                  ))}
                </ul>
              </>
            ) : null}
            <p style={{ margin: "6px 0 2px", fontWeight: 600 }}>
              <Chip tone={ACTOR.code} /> Checks at purchase time
            </p>
            {view.reviewed.checks.map((check) => (
              <p key={check.rule} style={{ margin: "2px 0" }}>
                <Chip tone={STATUS[check.status] ?? { label: check.status, ...NEUTRAL }} /> {check.detail}
              </p>
            ))}
          </>
        ) : (
          <Muted>No mandate is bound to this order, so the purchase is treated as the buyer's own.</Muted>
        )
      }
    </WithView>
  );
}

function TraceStep({ actor, title, children }: { actor: Tone; title: string; children?: ReactNode }) {
  return (
    <li style={{ margin: "0 0 10px", paddingLeft: 10, borderLeft: `3px solid ${actor.fg}` }}>
      <div>
        <Chip tone={actor} /> <strong>{title}</strong>
      </div>
      {children && <div style={{ marginTop: 3 }}>{children}</div>}
    </li>
  );
}

function ComparisonStep({ view, findingKey, title }: { view: InvestigationView; findingKey: string; title: string }) {
  const f = finding(view, findingKey);
  if (!f) return null;
  const cited = f.sources.length > 0 && !f.summary.startsWith("Not used");
  return (
    <>
      <TraceStep actor={ACTOR.claude} title={title}>
        <Chip tone={STATUS[f.status] ?? { label: f.status, ...NEUTRAL }} /> {f.summary}
      </TraceStep>
      {f.status !== "not_applicable" && (
        <TraceStep actor={ACTOR.code} title="Code checked Claude's citations">
          {cited ? `Every cited fact was supplied: ${f.sources.join(", ")}.` : "A citation was missing or not a supplied fact, so this comparison is not used."}
        </TraceStep>
      )}
    </>
  );
}

function Trace() {
  return (
    <WithView title="How Witness decided">
      {(view) => {
        const { reviewed, executed } = view;
        const authorization = finding(view, "authorization");
        const fulfilment = finding(view, "fulfilment");
        const sendable = reviewed.steps.filter((s) => s.kind !== "none");
        return (
          <ol style={{ listStyle: "none", margin: 0, padding: 0 }}>
            <TraceStep actor={ACTOR.claude} title="Claude read the buyer's words">
              Read as {reviewed.assessment.claim_type.replaceAll("_", " ")}. The case is routed on PayPal's stated reason.
            </TraceStep>
            {authorization && (
              <TraceStep actor={ACTOR.code} title="Code checked the mandate">
                <Chip tone={STATUS[authorization.status] ?? { label: authorization.status, ...NEUTRAL }} /> {authorization.summary}
              </TraceStep>
            )}
            <ComparisonStep view={view} findingKey="instruction_compliance" title="Claude compared the instructions with what the agent bought" />
            <ComparisonStep view={view} findingKey="listing_match" title="Claude compared the listing with what was delivered" />
            {fulfilment && (
              <TraceStep actor={ACTOR.code} title="Code read the delivery record">
                <Chip tone={STATUS[fulfilment.status] ?? { label: fulfilment.status, ...NEUTRAL }} /> {fulfilment.summary}
              </TraceStep>
            )}
            <TraceStep actor={ACTOR.code} title="Code checked what Claude wrote for PayPal">
              {reviewed.writing.dropped.length ? `${reviewed.writing.dropped.length} statement(s) cited no supplied fact and will not be sent.` : "Every statement cites supplied facts."}
            </TraceStep>
            <TraceStep actor={ACTOR.policy} title={`Decision: ${ACTION_LABEL[reviewed.decision.action] ?? reviewed.decision.action}`}>
              {reviewed.decision.why.at(-1)}
              {reviewed.decision.gaps.length > 0 && <Muted>Missing: {reviewed.decision.gaps.join("; ")}</Muted>}
            </TraceStep>
            {!executed && view.lastSent && (
              <TraceStep actor={ACTOR.paypal} title="Sent to PayPal from an earlier investigation">
                {view.lastSent.results.filter((r) => r.step !== "none").map((r, index) => (
                  <div key={index}>
                    {STEP_LABEL[r.step] ?? r.step}: done at {new Date(view.lastSent!.ranAt).toLocaleString()}
                    {r.debugId ? `, debug ID ${r.debugId}` : ""}
                  </div>
                ))}
              </TraceStep>
            )}
            <TraceStep actor={ACTOR.paypal} title={executed ? "Sent to PayPal" : "Planned for PayPal"}>
              {executed
                ? executed.results.map((r, index) => (
                    <div key={index}>
                      {STEP_LABEL[r.step] ?? r.step}: {r.ok ? "done" : `failed (${r.error})`}
                      {r.debugId ? `, debug ID ${r.debugId}` : ""}
                    </div>
                  ))
                : sendable.length
                  ? sendable.map((s, index) => <div key={index}>{STEP_LABEL[s.kind] ?? s.kind} (not sent yet)</div>)
                  : reviewed.steps[0]?.reason ?? "Nothing to send."}
            </TraceStep>
          </ol>
        );
      }}
    </WithView>
  );
}

function Baseline() {
  return (
    <WithView title="Rules-only vs Witness">
      {(view) => {
        const witness = view.reviewed.decision.action;
        const rules = view.baseline?.decision.action;
        if (!view.baseline || !rules) return <Muted>The rules-only comparison has not run for this investigation. Investigate again to run both.</Muted>;
        const differences = view.reviewed.findings.filter((f) => view.baseline!.findings.find((b) => b.key === f.key)?.status !== f.status);
        return (
          <>
            <div style={{ display: "flex", gap: 8, margin: "0 0 8px" }}>
              {[
                ["Rules-only tool", rules, NEUTRAL],
                ["Witness", witness, rules === witness ? NEUTRAL : { fg: "#1D3C78", bg: "#E8EEF9" }],
              ].map(([label, action, tone]) => (
                <div key={label as string} style={{ flex: 1, padding: 8, borderRadius: 6, background: (tone as typeof NEUTRAL).bg }}>
                  <div style={{ color: MUTED, fontSize: 11 }}>{label as string}</div>
                  <div style={{ fontSize: 16, fontWeight: 700, color: (tone as typeof NEUTRAL).fg }}>{ACTION_LABEL[action as string] ?? (action as string)}</div>
                </div>
              ))}
            </div>
            {rules === witness ? (
              <Muted>Same decision. Witness adds Claude's cited evidence to it.</Muted>
            ) : (
              differences.map((f) => (
                <p key={f.key} style={{ margin: "4px 0" }}>
                  <strong>{FINDING_LABEL[f.key] ?? f.key}</strong>: rules-only says {view.baseline!.findings.find((b) => b.key === f.key)?.status.replaceAll("_", " ")}, Witness says{" "}
                  {f.status.replaceAll("_", " ")}.
                </p>
              ))
            )}
          </>
        );
      }}
    </WithView>
  );
}

function Outgoing() {
  return (
    <WithView title="What goes to PayPal">
      {(view) => {
        const steps = (view.executed?.steps ?? view.reviewed.steps).filter((s) => s.kind !== "none");
        return (
          <>
            {steps.length === 0 && <Muted>{view.reviewed.steps[0]?.reason ?? "Nothing is sent for this decision."}</Muted>}
            {steps.map((step, index) => (
              <div key={index} style={{ margin: "0 0 8px" }}>
                <p style={{ margin: "0 0 2px", fontWeight: 600 }}>
                  {STEP_LABEL[step.kind] ?? step.kind}
                  {step.acceptClaimType ? ` (${step.acceptClaimType.toLowerCase().replaceAll("_", " ")})` : ""}
                </p>
                {stepText(step) && <pre style={{ margin: 0, padding: 8, borderRadius: 6, background: "#F4F5F7", whiteSpace: "pre-wrap", font: "12px/1.45 Inter, Arial, sans-serif" }}>{stepText(step)}</pre>}
              </div>
            ))}
            {view.reviewed.writing.dropped.length > 0 && (
              <>
                <p style={{ margin: "8px 0 2px", fontWeight: 600, color: BAD.fg }}>Not sent: cites no supplied fact</p>
                <ul style={{ margin: 0, paddingLeft: 18, color: MUTED }}>
                  {view.reviewed.writing.dropped.map((s, index) => (
                    <li key={index}>{s.text}</li>
                  ))}
                </ul>
              </>
            )}
          </>
        );
      }}
    </WithView>
  );
}

function ActionButton({ onClick, disabled, primary, children }: { onClick: () => void; disabled?: boolean; primary?: boolean; children: ReactNode }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "7px 14px",
        borderRadius: 6,
        border: `1px solid ${primary && !disabled ? "#2457D6" : LINE}`,
        background: disabled ? "#EEF0F3" : primary ? "#2457D6" : "#FDFDFB",
        color: disabled ? MUTED : primary ? "#FDFDFB" : INK,
        font: "600 13px Inter, Arial, sans-serif",
        cursor: disabled ? "not-allowed" : "pointer",
      }}
    >
      {children}
    </button>
  );
}

function Actions() {
  const disputeId = useSelectedDispute();
  const loaded = useInvestigation(disputeId);
  const [busy, setBusy] = useState<null | "investigating" | "sending">(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setConfirming(false);
    setMessage(null);
  }, [disputeId]);
  if (!disputeId) return <Frame title="Actions">{<Muted>Pick a dispute.</Muted>}</Frame>;

  const view = loaded.state === "ready" ? loaded.view : null;
  const sendable = view ? view.reviewed.steps.filter((s) => s.kind !== "none") : [];
  const canSend = Boolean(view && !view.executed && !view.reviewed.claim.outcome && sendable.length);
  const run = async (kind: "investigating" | "sending", work: () => Promise<string>) => {
    setBusy(kind);
    setMessage(null);
    try {
      setMessage(await work());
    } catch (error) {
      setMessage(error instanceof Error ? error.message : String(error));
    } finally {
      setBusy(null);
      setConfirming(false);
    }
  };

  return (
    <Frame title={`Actions for ${disputeId}`}>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <ActionButton disabled={busy !== null} onClick={() => run("investigating", async () => (await investigate(disputeId), "Investigation finished."))}>
          {busy === "investigating" ? "Investigating… (about 20 s)" : view ? "Investigate again" : "Investigate"}
        </ActionButton>
        <ActionButton primary disabled={!canSend || busy !== null} onClick={() => setConfirming(true)}>
          Execute decision…
        </ActionButton>
        {view && (
          <span style={{ color: MUTED }}>
            Reviewed investigation: {new Date(view.reviewed.ranAt).toLocaleString()} · {view.reviewed.claim.status.toLowerCase().replaceAll("_", " ")}
            {view.reviewed.claim.outcome ? `, ${view.reviewed.claim.outcome.toLowerCase().replaceAll("_", " ")}` : ""}
          </span>
        )}
      </div>
      {view && !canSend && !view.executed && <Muted>{view.reviewed.claim.outcome ? "The dispute is resolved; there is nothing to send." : (view.reviewed.steps[0]?.reason ?? "This decision sends nothing to PayPal.")}</Muted>}
      {view?.executed && <Muted>Already sent to PayPal at {new Date(view.executed.ranAt).toLocaleString()}.</Muted>}
      {view && !view.executed && view.lastSent && <Muted>An earlier investigation was sent to PayPal at {new Date(view.lastSent.ranAt).toLocaleString()}.</Muted>}
      {confirming && view && (
        <div role="dialog" aria-label="Confirm sending to PayPal" style={{ marginTop: 10, padding: 10, borderRadius: 6, border: "1px solid #2457D6", background: "#EEF3FD" }}>
          <p style={{ margin: "0 0 6px" }}>
            This sends exactly the reviewed investigation above to PayPal. No new AI assessment is made. It will:
          </p>
          <ul style={{ margin: "0 0 8px", paddingLeft: 18 }}>
            {sendable.map((s, index) => (
              <li key={index}>
                {STEP_LABEL[s.kind] ?? s.kind}
                {s.acceptClaimType ? ` (${s.acceptClaimType.toLowerCase().replaceAll("_", " ")})` : ""}
              </li>
            ))}
          </ul>
          <div style={{ display: "flex", gap: 8 }}>
            <ActionButton
              primary
              disabled={busy !== null}
              onClick={() =>
                run("sending", async () => {
                  const { results } = await execute(disputeId, view.reviewed.ranAt);
                  return results.map((r) => `${STEP_LABEL[r.step] ?? r.step}: ${r.ok ? "done" : `failed (${r.error})`}${r.debugId ? `, debug ID ${r.debugId}` : ""}`).join(" · ");
                })
              }
            >
              {busy === "sending" ? "Sending…" : "Send to PayPal"}
            </ActionButton>
            <ActionButton onClick={() => setConfirming(false)}>Cancel</ActionButton>
          </div>
        </div>
      )}
      {message && <p style={{ margin: "8px 0 0" }}>{message}</p>}
    </Frame>
  );
}

const WIDGET_IDS = ["witness-picker", "witness-actions", "witness-claim", "witness-baseline", "witness-mandate", "witness-trace", "witness-outgoing"] as const;
type WitnessWidgetId = (typeof WIDGET_IDS)[number];

const define = (id: WitnessWidgetId, label: string, comp: () => ReactNode, width: number, height: number): AgWidgetDefinition<WitnessWidgetId> => ({
  id,
  label,
  comp,
  form: () => [],
  defaultSize: { width, height },
  minSize: { width: 4, height: 6 },
  // No widget toolbar, so nobody removes an investigation panel by accident during a review.
  toolbar: [],
});

const DEFINITIONS = [
  define("witness-picker", "Disputes", Picker, 9, 12),
  define("witness-actions", "Actions", Actions, 15, 12),
  define("witness-claim", "The claim", Claim, 8, 16),
  define("witness-baseline", "Rules-only vs Witness", Baseline, 8, 16),
  define("witness-mandate", "The buyer's mandate", Mandate, 8, 16),
  define("witness-trace", "How Witness decided", Trace, 14, 30),
  define("witness-outgoing", "What goes to PayPal", Outgoing, 10, 30),
];

export interface WitnessRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgWidgetDefinition<WitnessWidgetId>)[];
}

export const widgets = (defaults: AgWidgetsConfig) =>
  createWidgets<WitnessRegistry>({
    additionalTypes: DEFINITIONS,
    menu: [...defaults.menu, { label: "Witness", widgetIds: WIDGET_IDS }],
  });
