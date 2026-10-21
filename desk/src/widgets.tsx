// The investigation page's widgets: the dispute picker, the case summary with its actions, what the
// buyer said, the mandate, the decision trace, the rules-only comparison, and what goes to PayPal. The
// summary speaks the merchant's language; the detail panels keep the audit trail, where every step says
// who did it - Claude, code, the merchant's policy or PayPal - and only what code checked is called checked.
import type { AgDefaultWidgetDefinition, AgWidgetField, AgWidgetsConfig } from "ag-studio";
import { createWidgets, type AgRegistry, type AgWidgetDefinition } from "ag-studio-react";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { ACTION_LABEL, onRefresh, sentence, sharedRows, type DisputeRow } from "./data";
import { execute, investigate, openDispute, selectDispute, useInvestigation, useSelectedDispute, type Finding, type InvestigationView, type Step } from "./deskState";

const INK = "#14243A";
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
// The question each finding answers, for lists of what is missing and for comparisons.
const FINDING_QUESTION: Record<string, string> = {
  authorization: "Did the buyer authorize the agent?",
  instruction_compliance: "Did the agent follow the buyer's instructions?",
  listing_match: "Did the merchant deliver what was listed?",
  fulfilment: "Was the order delivered?",
};
const STATUS_ANSWER: Record<string, string> = { established: "yes", contradicted: "no", unknown: "can't tell", not_applicable: "doesn't apply" };
const CLAIM_TYPE: Record<string, string> = {
  item_not_received: "item not received",
  not_as_described: "not as described",
  unauthorized: "an unauthorized purchase",
  other: "something else",
};
// Fact ids, as Claude cites them, in words: mandate.instructions[0] reads "mandate instruction 1".
const SOURCE_NOUN: Record<string, string> = {
  buyer_statements: "buyer's statement",
  seller_statements: "merchant's statement",
  "mandate.instructions": "mandate instruction",
  "dispute.items": "disputed item",
  shipment_tracking: "tracking record",
  "order.description": "order description",
  "dispute.amount": "disputed amount",
  "dispute.reason": "PayPal's reason",
  "mandate.scope": "mandate's spending scope",
};
const FINDING_NOUN: Record<string, string> = {
  authorization: "mandate check",
  instruction_compliance: "instructions comparison",
  listing_match: "listing comparison",
  fulfilment: "delivery record",
};
function sourceLabel(id: string): string {
  const [, finding] = /^finding\.(\w+)$/.exec(id) ?? [];
  if (finding) return FINDING_NOUN[finding] ?? finding;
  const [, rule] = /^mandate_checks\.(\w+)$/.exec(id) ?? [];
  if (rule) return `mandate ${rule.replaceAll("_", " ")} check`;
  const [, list, index] = /^(.+)\[(\d+)\]$/.exec(id) ?? [];
  if (list && index) return `${SOURCE_NOUN[list] ?? list} ${Number(index) + 1}`;
  return SOURCE_NOUN[id] ?? id;
}
// A gap is "<finding key>: <why it is unknown>", or a PayPal evidence request (src/decide.ts gapsOf).
function gapParts(gap: string): { question: string; detail: string } {
  const [, key, detail] = /^(\w+): ([\s\S]*)$/.exec(gap) ?? [];
  return key && detail && FINDING_QUESTION[key] ? { question: FINDING_QUESTION[key]!, detail } : { question: "PayPal's request", detail: gap };
}

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

// Times read one way everywhere, in the viewer's locale and time zone, including times inside text
// that code or Claude wrote. What goes to PayPal is shown verbatim.
const when = (iso: string) => new Date(iso).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const ISO_TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})/g;
const readable = (text: string) => text.replace(ISO_TIME, when);
const day = (date: string) => {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : parsed.toLocaleDateString(undefined, { dateStyle: "medium", timeZone: "UTC" });
};

// The queue's rows, shared with the queue page and reloaded on every refresh.
function useRows() {
  const [rows, setRows] = useState<DisputeRow[] | null>(null);
  useEffect(() => {
    const load = () => sharedRows().then(setRows, () => setRows([]));
    load();
    return onRefresh(load);
  }, []);
  return rows;
}

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

// Why nothing is sent, in one line.
function nothingSent(view: InvestigationView): string {
  const { decision, claim, steps } = view.reviewed;
  if (claim.outcome) return "The dispute is resolved; there is nothing to send.";
  if (decision.action === "request_evidence") return "Nothing is sent yet: Witness needs more evidence first.";
  if (decision.action === "review") return "Nothing is sent: this case goes to a person to review.";
  return steps[0]?.reason ?? "This decision sends nothing to PayPal.";
}

function Picker() {
  const rows = useRows();
  const selected = useSelectedDispute();
  // Scrolls a newly selected dispute into view once, not on every refresh.
  const shown = useRef<string | null>(null);
  // The page opens on a dispute, the first still open if there is one, not on empty panels.
  useEffect(() => {
    if (rows?.length && !selected) selectDispute((rows.find((row) => !row.outcome) ?? rows[0]!).disputeId);
  }, [rows, selected]);
  return (
    <Frame title="Disputes">
      {rows === null && <Muted>Loading…</Muted>}
      {rows?.length === 0 && <Muted>No disputes.</Muted>}
      {rows?.map((row) => (
        <button
          key={row.disputeId}
          ref={(button) => {
            if (button && row.disputeId === selected && shown.current !== selected) {
              shown.current = selected;
              button.scrollIntoView({ block: "nearest" });
            }
          }}
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
          <span style={{ display: "block", color: MUTED }}>
            {row.reason} · ${row.amountUsd.toFixed(2)}
          </span>
          <span style={{ display: "block", color: MUTED }}>
            {!row.outcome && row.responseDue ? `Respond by ${when(row.responseDue)}` : sentence(row.outcome || row.paypalStatus)} · Witness:{" "}
            {ACTION_LABEL[row.witnessDecision] ?? row.witnessDecision}
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
            <Chip tone={ACTOR.claude} /> Claude's summary, not checked by code: {readable(view.reviewed.assessment.claim_summary)}
          </p>
          {view.reviewed.decision.discrepancy && (
            <p style={{ margin: "8px 0 0", padding: "6px 8px", borderRadius: 6, background: BAD.bg, color: BAD.fg }}>{readable(view.reviewed.decision.discrepancy)}</p>
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
              {view.mandate.agent} may buy <strong>{view.mandate.scope.category}</strong>, up to ${view.mandate.scope.max_amount_usd}, until {day(view.mandate.valid_until)}.
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
                <Chip tone={STATUS[check.status] ?? { label: check.status, ...NEUTRAL }} /> {check.rule === "paypal_approval" && <Chip tone={ACTOR.paypal} />}{" "}
                {readable(check.detail)}
              </p>
            ))}
            {!view.reviewed.checks.some((check) => check.rule === "paypal_approval") && (
              <Muted>The buyer's acceptance is recorded by Witness only; it is not linked to a PayPal approval.</Muted>
            )}
          </>
        ) : (
          <Muted>
            {view.reviewed.claim.mandateHash
              ? `This order names mandate ${view.reviewed.claim.mandateHash.slice(0, 12)}…, but Witness does not hold it, so the agent's authorization is unknown.`
              : "No mandate is linked to this order, so the agent's authorization is unknown."}
          </Muted>
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
        <Chip tone={STATUS[f.status] ?? { label: f.status, ...NEUTRAL }} /> {readable(f.summary)}
      </TraceStep>
      {f.status !== "not_applicable" && (
        <TraceStep actor={ACTOR.code} title="Code checked Claude's sources">
          {cited ? `Every source Claude cited was supplied: ${f.sources.map(sourceLabel).join(", ")}.` : "A source was missing or was not a supplied fact, so this comparison is not used."}
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
              Claude reads this as {CLAIM_TYPE[reviewed.assessment.claim_type] ?? reviewed.assessment.claim_type}. PayPal's stated reason decides how the case is handled.
            </TraceStep>
            {authorization && (
              <TraceStep actor={ACTOR.code} title="Code checked the mandate">
                <Chip tone={STATUS[authorization.status] ?? { label: authorization.status, ...NEUTRAL }} /> {readable(authorization.summary)}
              </TraceStep>
            )}
            <ComparisonStep view={view} findingKey="instruction_compliance" title="Claude compared the instructions with what the agent bought" />
            <ComparisonStep view={view} findingKey="listing_match" title="Claude compared the listing with what was delivered" />
            {fulfilment && (
              <TraceStep actor={ACTOR.code} title="Code read the delivery record">
                <Chip tone={STATUS[fulfilment.status] ?? { label: fulfilment.status, ...NEUTRAL }} /> {readable(fulfilment.summary)}
              </TraceStep>
            )}
            <TraceStep actor={ACTOR.code} title="Code checked what Claude wrote for PayPal">
              {reviewed.writing.dropped.length ? `${reviewed.writing.dropped.length} statement(s) cited no supplied fact and will not be sent.` : "Every statement cites supplied facts."}
            </TraceStep>
            <TraceStep actor={ACTOR.policy} title={`Decision: ${ACTION_LABEL[reviewed.decision.action] ?? reviewed.decision.action}`}>
              {readable(reviewed.decision.why.at(-1) ?? "")}
              {reviewed.decision.gaps.length > 0 && <Muted>Missing: {reviewed.decision.gaps.map((gap) => gapParts(gap).question).join(" ")}</Muted>}
            </TraceStep>
            {!executed && view.lastSent && (
              <TraceStep actor={ACTOR.paypal} title="Sent to PayPal from an earlier investigation">
                {view.lastSent.results.filter((r) => r.step !== "none").map((r, index) => (
                  <div key={index}>
                    {STEP_LABEL[r.step] ?? r.step}: done {when(view.lastSent!.ranAt)}
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
                  : nothingSent(view)}
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
                  <strong>{FINDING_QUESTION[f.key] ?? f.key}</strong> Rules-only: {STATUS_ANSWER[view.baseline!.findings.find((b) => b.key === f.key)?.status ?? ""] ?? "not checked"}. Witness:{" "}
                  {STATUS_ANSWER[f.status] ?? f.status}.
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
            {steps.length === 0 && <Muted>{nothingSent(view)}</Muted>}
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

// The send button says what it sends.
function reviewLabel(steps: Step[]): string {
  const [first] = steps;
  if (!first) return "Nothing to send";
  if (first.kind === "accept_claim") return first.acceptClaimType === "REFUND_WITH_RETURN" ? "Review refund with return…" : "Review refund…";
  if (first.kind === "make_offer") return "Review return offer…";
  if (first.kind === "provide_evidence" || first.kind === "provide_supporting_info") return "Review evidence for PayPal…";
  if (first.kind === "send_message") return steps.some((s) => s.kind === "escalate") ? "Review message and escalation…" : "Review message to buyer…";
  return `Review: ${STEP_LABEL[first.kind] ?? first.kind}…`;
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

// The case summary: what Witness recommends and why, the facts behind it, and the one next action.
const RECOMMENDATION: Record<string, string> = {
  refund: "Refund",
  propose_return: "Offer a return and refund",
  defend: "Defend",
  request_evidence: "Ask for evidence",
  review: "Send to a person",
};
const POLICY_VERB: Record<string, string> = { refund: "refund", propose_return: "offer a return", review: "send the case to a person" };
// For each PayPal reason, the findings that trigger the merchant's policy, in the order src/decide.ts checks them.
const POLICY_TRIGGERS: Record<string, [string, string][]> = {
  MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED: [
    ["listing_match", "the merchant delivered something other than the listing"],
    ["instruction_compliance", "the agent broke the buyer's instructions and the merchant delivered what was ordered"],
  ],
  MERCHANDISE_OR_SERVICE_NOT_RECEIVED: [["fulfilment", "the order was not delivered"]],
  UNAUTHORISED: [
    ["authorization", "the purchase broke the buyer's mandate"],
    ["instruction_compliance", "the agent broke the buyer's instructions"],
  ],
};

function decisionReason(view: InvestigationView): string {
  const { decision, claim } = view.reviewed;
  if (decision.basis === "merchant_policy") {
    const trigger = POLICY_TRIGGERS[claim.reason]?.find(([key]) => finding(view, key)?.status === "contradicted");
    return `Your policy is to ${POLICY_VERB[decision.action] ?? decision.action} when ${trigger?.[1] ?? "this happens"}.`;
  }
  if (decision.basis === "facts") return "The records support your side of this dispute.";
  if (decision.action === "review") return "Witness does not handle this kind of claim on its own.";
  return "Witness can't decide yet: some of the facts below are not established.";
}

// The four facts, in the order the purchase happened: authorized, bought, delivered as listed, delivered.
const FACT_ORDER = ["authorization", "instruction_compliance", "listing_match", "fulfilment"];
const FACT: Record<string, Partial<Record<string, string>>> = {
  authorization: { established: "The buyer authorized this purchase", contradicted: "The purchase broke the buyer's mandate" },
  instruction_compliance: {
    established: "The agent followed the buyer's instructions",
    contradicted: "The agent broke the buyer's instructions",
    unknown: "Can't tell whether the agent followed the buyer's instructions",
  },
  listing_match: { established: "The merchant delivered what was ordered", contradicted: "The merchant delivered something other than the listing", unknown: "Can't tell what was delivered" },
  fulfilment: { established: "Delivered", contradicted: "Not delivered", unknown: "Delivery is not confirmed" },
};
const FOUND_BY: Record<string, Tone> = { authorization: ACTOR.code, instruction_compliance: ACTOR.claude, listing_match: ACTOR.claude, fulfilment: ACTOR.code };
const MARK: Record<string, { symbol: string; fg: string }> = {
  established: { symbol: "✓", fg: GOOD.fg },
  contradicted: { symbol: "✗", fg: BAD.fg },
  unknown: { symbol: "?", fg: MUTED },
};

// One fact in words; the finding's own text and its sources open underneath. What went wrong starts open.
function Fact({ view, findingKey }: { view: InvestigationView; findingKey: string }) {
  const f = finding(view, findingKey);
  if (!f || f.status === "not_applicable") return null;
  const unheld = view.reviewed.claim.mandateHash ? "Witness does not hold the mandate this order names" : "No mandate is linked to this order";
  const text = findingKey === "authorization" && f.status === "unknown" ? unheld : (FACT[findingKey]?.[f.status] ?? f.summary);
  const mark = MARK[f.status] ?? MARK.unknown!;
  return (
    <details open={f.status === "contradicted"} style={{ margin: "0 0 6px" }}>
      <summary style={{ cursor: "pointer" }}>
        <span aria-hidden style={{ display: "inline-block", width: 14, fontWeight: 700, color: mark.fg }}>
          {mark.symbol}
        </span>{" "}
        {text} <Chip tone={FOUND_BY[findingKey] ?? ACTOR.code} />
      </summary>
      <div style={{ margin: "4px 0 0 18px" }}>
        {readable(f.summary)}
        {f.sources.length > 0 && <Muted>Sources: {f.sources.map(sourceLabel).join(", ")}.</Muted>}
      </div>
    </details>
  );
}

function Case() {
  const disputeId = useSelectedDispute();
  const loaded = useInvestigation(disputeId);
  const row = useRows()?.find((r) => r.disputeId === disputeId);
  const [busy, setBusy] = useState<null | "investigating" | "sending">(null);
  const [confirming, setConfirming] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  useEffect(() => {
    setConfirming(false);
    setMessage(null);
  }, [disputeId]);
  if (!disputeId) return <Frame title="Case">{<Muted>Pick a dispute.</Muted>}</Frame>;

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
  const amount = row ? `$${row.amountUsd.toFixed(2)}` : view ? `$${view.reviewed.claim.amount.value.toFixed(2)}` : "";
  const action = view?.reviewed.decision.action;
  const rules = view?.baseline?.decision.action;

  return (
    <Frame title={disputeId}>
      <p style={{ margin: "-6px 0 10px", color: MUTED }}>
        {[row?.reason, amount].filter(Boolean).join(" · ")}
        {row && (!row.outcome && row.responseDue ? <strong style={{ color: INK }}> · Respond by {when(row.responseDue)}</strong> : ` · PayPal: ${sentence(row.outcome || row.paypalStatus)}`)}
      </p>
      {loaded.state === "loading" && <Muted>Loading…</Muted>}
      {loaded.state === "missing" && <Muted>Not investigated yet.</Muted>}
      {loaded.state === "error" && <Muted>Could not load the investigation: {loaded.message}</Muted>}
      <div style={{ display: "grid", gridTemplateColumns: "minmax(0, 5fr) minmax(0, 6fr)", gap: 20 }}>
        <section>
          {view && action && (
            <>
              <p style={{ margin: "0 0 4px", color: MUTED, fontSize: 12 }}>Witness recommends</p>
              <p style={{ margin: "0 0 6px", fontSize: 22, fontWeight: 700, lineHeight: 1.2 }}>
                {RECOMMENDATION[action] ?? action}
                {action === "refund" || action === "propose_return" ? ` ${amount}` : ""}
              </p>
              <p style={{ margin: "0 0 4px" }}>{decisionReason(view)}</p>
              {view.reviewed.decision.basis === "merchant_policy" && <Muted>Policy: {view.reviewed.policy}</Muted>}
              {rules && rules !== action && (
                <p style={{ margin: "6px 0 0" }}>
                  A rules-only tool would have chosen <strong>{ACTION_LABEL[rules] ?? rules}</strong>: it can't read the buyer's words or compare their instructions with what was bought.
                </p>
              )}
            </>
          )}
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap", margin: "12px 0 4px" }}>
            {view && (
              <ActionButton primary disabled={!canSend || busy !== null} onClick={() => setConfirming(true)}>
                {view.executed ? "Sent to PayPal" : reviewLabel(sendable)}
              </ActionButton>
            )}
            <ActionButton disabled={busy !== null} onClick={() => run("investigating", async () => (await investigate(disputeId), "Investigation finished."))}>
              {busy === "investigating" ? "Investigating… (about 20 s)" : view ? "Investigate again" : "Investigate"}
            </ActionButton>
          </div>
          {view && <Muted>Investigated {when(view.reviewed.ranAt)}</Muted>}
          {view && !canSend && !view.executed && <Muted>{nothingSent(view)}</Muted>}
          {view?.executed && <Muted>Sent to PayPal {when(view.executed.ranAt)}.</Muted>}
          {view && !view.executed && view.lastSent && <Muted>An earlier investigation was sent to PayPal {when(view.lastSent.ranAt)}.</Muted>}
        </section>
        {view && (
          <section>
            <p style={{ margin: "0 0 6px", fontWeight: 600 }}>What Witness found</p>
            {FACT_ORDER.map((key) => (
              <Fact key={key} view={view} findingKey={key} />
            ))}
          </section>
        )}
      </div>
      {confirming && view && (
        <div role="dialog" aria-label="Confirm sending to PayPal" style={{ marginTop: 10, padding: 10, borderRadius: 6, border: "1px solid #2457D6", background: "#EEF3FD" }}>
          <p style={{ margin: "0 0 6px" }}>
            This sends exactly the reviewed investigation to PayPal. No new AI assessment is made. It will:
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

const WIDGET_IDS = ["witness-picker", "witness-case", "witness-claim", "witness-baseline", "witness-mandate", "witness-trace", "witness-outgoing"] as const;
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
  define("witness-case", "Case", Case, 18, 22),
  define("witness-claim", "The claim", Claim, 8, 16),
  define("witness-baseline", "Rules-only vs Witness", Baseline, 8, 16),
  define("witness-mandate", "The buyer's mandate", Mandate, 8, 16),
  define("witness-trace", "How Witness decided", Trace, 14, 30),
  define("witness-outgoing", "What goes to PayPal", Outgoing, 10, 30),
];

export interface WitnessRegistry extends AgRegistry {
  widgets: readonly (AgDefaultWidgetDefinition | AgWidgetDefinition<WitnessWidgetId>)[];
}

// In the queue grid, a dispute's ID opens its investigation.
function DisputeLink({ value }: { value?: unknown }) {
  const id = String(value ?? "");
  return (
    <button
      onClick={() => openDispute(id)}
      title={`Open ${id}`}
      style={{ padding: 0, border: "none", background: "none", color: "#2457D6", font: "inherit", textDecoration: "underline", cursor: "pointer" }}
    >
      {id}
    </button>
  );
}

export const widgets = (defaults: AgWidgetsConfig) =>
  createWidgets<WitnessRegistry>({
    additionalTypes: DEFINITIONS,
    menu: [...defaults.menu, { label: "Witness", widgetIds: WIDGET_IDS }],
    // AG Studio's types narrow overrides to never once custom widgets are registered; the runtime takes them.
    overrides: [{ id: "grid", options: { createCellRenderer: (field: AgWidgetField) => ("fieldId" in field && field.fieldId === "disputes.disputeId" ? DisputeLink : undefined) } }] as never[],
  });
