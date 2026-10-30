// The evidence pack: one plain-text document that shows every finding, its status
// and sources, what is still missing, and the action taken.

import type { Claim } from "./claim.js";
import type { Assessment, Decision, Writing } from "./decide.js";
import type { EvidenceRequestStatus, Finding } from "./findings.js";
import type { Mandate, MandateCheck } from "./mandate.js";
import type { Tracking } from "./paypal/orders.js";

export interface PackInput {
  claim: Claim;
  mandate: Mandate | null;
  checks: MandateCheck[];
  tracking: Tracking[];
  findings: Finding[];
  requests: EvidenceRequestStatus[];
  assessment: Assessment;
  decision: Decision;
  writing: Writing;
  policyName: string;
  generatedAt: string;
}

const MARK: Record<Finding["status"], string> = {
  established: "ESTABLISHED",
  contradicted: "CONTRADICTED",
  unknown: "UNKNOWN",
  not_applicable: "N/A",
};

export function renderEvidencePack(input: PackInput): string {
  const { claim, mandate, checks, tracking, findings, requests, assessment, decision, writing, policyName, generatedAt } = input;
  const lines = [
    `WITNESS INVESTIGATION`,
    `Dispute ${claim.disputeId} · ${claim.reason} · ${claim.amount.value.toFixed(2)} ${claim.amount.currency}`,
    `Payment ${claim.captureId ?? "unknown"} · generated ${generatedAt}`,
    ``,
    `CLAIM (${assessment.claim_type})`,
    assessment.claim_summary,
    ...claim.buyerStatements.map((s, i) => `  buyer_statements[${i}]: "${s}"`),
    ``,
    `SHIPMENT`,
    ...(tracking.length ? tracking.map((t, i) => `  shipment_tracking[${i}]: ${t.trackingNumber} ${t.status}`) : [`  No shipment tracking on the order.`]),
  ];
  if (mandate) {
    lines.push(
      ``,
      `AGENT MANDATE (bound to the order by SHA-256 ${claim.mandateHash})`,
      `  Agent ${mandate.agent} · category ${mandate.scope.category} · cap $${mandate.scope.max_amount_usd} · valid until ${mandate.valid_until}`,
      ...(mandate.instructions ?? []).map((s, i) => `  mandate.instructions[${i}]: ${s}`),
      ...checks.map((c) => `  [${c.status.toUpperCase()}] ${c.rule}: ${c.detail}`),
    );
  } else if (claim.mandateHash) {
    lines.push(``, `AGENT MANDATE: the order names SHA-256 ${claim.mandateHash}, which Witness does not hold.`);
  }
  lines.push(``, `FINDINGS`);
  for (const f of findings) lines.push(`  [${MARK[f.status]}] ${f.key}: ${f.summary}${f.sources.length ? ` (sources: ${f.sources.join(", ")})` : ""}`);
  if (requests.length) {
    lines.push(``, `PAYPAL EVIDENCE REQUESTS`);
    for (const r of requests) lines.push(`  [${r.resolved ? "RESOLVED" : "UNRESOLVED"}] ${r.type}: ${r.detail}`);
  }
  lines.push(``, `DECISION: ${decision.action.toUpperCase()} (basis: ${decision.basis.replace("_", " ")}; policy: ${policyName})`, ...decision.why.map((w) => `  - ${w}`));
  if (decision.discrepancy) lines.push(`DISCREPANCY: ${decision.discrepancy}`);
  if (decision.gaps.length) lines.push(`MISSING`, ...decision.gaps.map((g) => `  - ${g}`));
  if (decision.action === "defend") lines.push(``, writing.evidenceNotes);
  if (writing.dropped.length) lines.push(``, `NOT SENT (cites no supplied fact)`, ...writing.dropped.map((s) => `  - ${s.text}`));
  return lines.join("\n") + "\n";
}

// cp1252 codes for the punctuation Claude tends to write; anything else outside Latin-1 prints as "?".
const WIN_ANSI: Record<string, number> = { "€": 0x80, "…": 0x85, "‘": 0x91, "’": 0x92, "“": 0x93, "”": 0x94, "•": 0x95, "–": 0x96, "—": 0x97 };
const pdfString = (s: string) =>
  [...s].map((ch) => {
    if (ch === "\\" || ch === "(" || ch === ")") return `\\${ch}`;
    const code = ch.codePointAt(0)!;
    if (code >= 0x20 && code < 0x7f) return ch;
    const win = code >= 0xa0 && code <= 0xff ? code : WIN_ANSI[ch];
    return win ? `\\${win.toString(8)}` : "?";
  }).join("");

// PayPal takes evidence files only as .jpg, .jpeg, .gif, .png or .pdf, so text goes as a plain Courier PDF.
// The PDF stays 7-bit ASCII (other characters as octal escapes): EvidenceFile data is a string sent as UTF-8,
// and ASCII keeps every byte offset in the xref equal to its string offset.
export function textPdf(text: string): string {
  const ROWS = 60;
  // Wrapped at a space within 95 columns, which is what 9pt Courier fits across the page.
  const lines = text.replace(/\r/g, "").replace(/\t/g, "    ").replace(/\n$/, "").split("\n")
    .flatMap((line) => (line.trimEnd().match(/.{1,95}(?=\s|$)|\S{1,95}/gu) ?? [""]).map((part, i) => (i ? part.trimStart() : part)));
  const pages: string[][] = [];
  for (let i = 0; i < lines.length || !pages.length; i += ROWS) pages.push(lines.slice(i, i + ROWS));
  const objects = ["<</Type/Catalog/Pages 2 0 R>>", "", "<</Type/Font/Subtype/Type1/BaseFont/Courier/Encoding/WinAnsiEncoding>>"];
  const kids: string[] = [];
  for (const page of pages) {
    const stream = `BT /F1 9 Tf 11 TL 36 770 Td ${page.map((line) => `(${pdfString(line)})'`).join(" ")} ET`;
    objects.push(`<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Resources<</Font<</F1 3 0 R>>>>/Contents ${objects.length + 2} 0 R>>`);
    kids.push(`${objects.length} 0 R`);
    objects.push(`<</Length ${stream.length}>>\nstream\n${stream}\nendstream`);
  }
  objects[1] = `<</Type/Pages/Kids[${kids.join(" ")}]/Count ${pages.length}>>`;
  let pdf = "%PDF-1.4\n";
  const offsets = objects.map((body, i) => {
    const at = pdf.length;
    pdf += `${i + 1} 0 obj\n${body}\nendobj\n`;
    return at;
  });
  const xref = pdf.length;
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("")}`;
  return pdf + `trailer\n<</Size ${objects.length + 1}/Root 1 0 R>>\nstartxref\n${xref}\n%%EOF\n`;
}
