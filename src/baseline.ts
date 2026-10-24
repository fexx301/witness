// The comparison for Witness's AI: what a competent rules-only tool does with the same facts.
// It routes on PayPal's reason, trusts the exact mandate checks and the tracking status, and
// writes template text. It checks the mandate's instructions against the terms the merchant's own
// listings use (blend, grind, ...), handling "not" and "never", which is as far as rules get without
// reading language. Like a rules engine, it passes what it finds nothing wrong with: an instruction
// that names no catalogue term goes unchecked, and it cannot read the buyer's or seller's words.

import { existsSync, readFileSync } from "node:fs";
import { z } from "zod";
import { claimTypeForReason, type Assessment, type AssessmentInput, type Assessor } from "./decide.js";

// The terms the merchant's listings use, by attribute, e.g. { "grind": ["whole bean", "ground"] }.
export const CatalogueSchema = z.object({ attributes: z.record(z.string(), z.array(z.string())) });
export type Catalogue = z.infer<typeof CatalogueSchema>;
export const loadCatalogue = (path: string): Catalogue =>
  existsSync(path) ? CatalogueSchema.parse(JSON.parse(readFileSync(path, "utf8"))) : { attributes: {} };

const NEGATORS = new Set(["never", "not", "no", "don't", "dont", "nothing", "without", "avoid"]);
const words = (s: string) => s.toLowerCase().replace(/-/g, " ").replace(/[^a-z0-9' ]+/g, " ").split(/\s+/).filter(Boolean);

// The catalogue terms a text names, longest first ("coarse ground" before "ground"), plurals included.
// A term is negated when a negator comes earlier in its clause ("so don't get it pre-ground").
export function catalogueTerms(catalogue: Catalogue, text: string): { attribute: string; term: string; negated: boolean }[] {
  const terms = Object.entries(catalogue.attributes)
    .flatMap(([attribute, values]) => values.map((term) => ({ attribute, term, parts: words(term) })))
    .sort((a, b) => b.parts.length - a.parts.length);
  const found: { attribute: string; term: string; negated: boolean }[] = [];
  for (const clause of text.split(/[,.;:!?]|\b(?:but|and|so)\b/i)) {
    const w = words(clause);
    const taken = w.map(() => false);
    for (const { attribute, term, parts } of terms)
      for (let i = 0; i + parts.length <= w.length; i++)
        if (parts.every((p, k) => !taken[i + k] && (w[i + k] === p || w[i + k] === `${p}s`))) {
          parts.forEach((_, k) => (taken[i + k] = true));
          found.push({ attribute, term, negated: w.slice(0, i).some((x) => NEGATORS.has(x)) });
        }
  }
  return found;
}

// A mismatch is an item term an instruction forbids, or another term for an attribute an instruction
// names (any of the terms it names for that attribute will do).
export function checkInstructions(catalogue: Catalogue, instructions: string[], item: string): { status: "match" | "mismatch"; explanation: string } {
  const itemTerms = new Map(catalogueTerms(catalogue, item).map((t) => [t.attribute, t.term]));
  const problems: string[] = [];
  const unchecked: string[] = [];
  for (const instruction of instructions) {
    const terms = catalogueTerms(catalogue, instruction);
    if (!terms.length) unchecked.push(instruction);
    const forbidden = terms.filter((t) => t.negated && itemTerms.get(t.attribute) === t.term).map((t) => t.term);
    const wanted = [...new Set(terms.filter((t) => !t.negated).map((t) => t.attribute))].filter((attribute) => {
      const has = itemTerms.get(attribute);
      return has !== undefined && !terms.some((t) => !t.negated && t.attribute === attribute && t.term === has);
    });
    if (forbidden.length || wanted.length)
      problems.push(`"${instruction}" rules out the item's ${[...new Set([...forbidden, ...wanted.map((a) => itemTerms.get(a))])].join(", ")}`);
  }
  const note = unchecked.length ? ` Not checked, no catalogue term: ${unchecked.map((s) => `"${s}"`).join(", ")}.` : "";
  return problems.length
    ? { status: "mismatch", explanation: `${problems.join("; ")}.${note}` }
    : { status: "match", explanation: `No catalogue term in the instructions conflicts with the item.${note}` };
}

export class RulesAssessor implements Assessor {
  readonly model = "rules-only baseline";

  constructor(private readonly catalogue: Catalogue = loadCatalogue("data/catalogue.json")) {}

  async assess({ claim, mandate, findings, orderDescription }: AssessmentInput): Promise<Assessment> {
    const authorized = findings.some((f) => f.key === "authorization" && f.status === "established");
    const delivered = findings.some((f) => f.key === "fulfilment" && f.status === "established");
    const instructions = mandate?.instructions ?? [];
    const item = orderDescription ?? claim.items[0]?.description ?? claim.items[0]?.name ?? "";
    const itemSource = orderDescription ? "order.description" : "dispute.items[0]";
    return {
      claim_type: claimTypeForReason(claim.reason),
      claim_summary: `PayPal reason: ${claim.reason}.`,
      agent_purchase: Boolean(mandate),
      instruction_compliance: mandate
        ? instructions.length
          ? { ...checkInstructions(this.catalogue, instructions, item), sources: [...instructions.map((_, i) => `mandate.instructions[${i}]`), itemSource] }
          : authorized
            ? { status: "match", explanation: "The purchase passes the mandate's exact checks.", sources: ["finding.authorization"] }
            : { status: "unclear", explanation: "The mandate's exact checks did not pass.", sources: [] }
        : claim.mandateHash
          ? { status: "unclear", explanation: "The order names a mandate Witness does not hold, so its instructions cannot be checked.", sources: [] }
          : { status: "not_applicable", explanation: "No mandate is bound to this order.", sources: [] },
      // Without reading the complaint, delivery is the only signal a rules tool has.
      listing_match: delivered
        ? { status: "match", explanation: "The order was delivered.", sources: ["finding.fulfilment"] }
        : { status: "unclear", explanation: "Delivery is not confirmed.", sources: [] },
      evidence_notes: [
        ...(authorized ? [{ text: "The purchase was inside the buyer's mandate.", sources: ["finding.authorization"] }] : []),
        ...(delivered ? [{ text: "The order was delivered.", sources: ["finding.fulfilment"] }] : []),
      ],
      buyer_message: [],
    };
  }
}
