// Runs the predeclared A11 comparison. The rules-only baseline is free; Witness calls Claude once per case,
// so it runs only with --witness. Results go to eval/results/<time>.json.
//   npx tsx eval/run.ts              baseline only
//   npx tsx eval/run.ts --witness    baseline and Witness (about $0.05 a case on Opus)
//   add --demo to run the Act 1 set (eval/demo-cases.ts) instead of the 18 cases

import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RulesAssessor } from "../src/baseline.js";
import { ClaudeAssessor, type Assessor } from "../src/decide.js";
import { CASES } from "./cases.js";
import { DEMO_CASES } from "./demo-cases.js";
import { caseStore, runCase, type CaseResult } from "./harness.js";

// The baseline needs no keys, so a fresh clone can run it.
if (existsSync(".env")) process.loadEnvFile(".env");
const withWitness = process.argv.includes("--witness");
const demo = process.argv.includes("--demo");
const cases = demo ? DEMO_CASES : CASES;
const assessors: Assessor[] = [new RulesAssessor(), ...(withWitness ? [new ClaudeAssessor()] : [])];

const scratch = mkdtempSync(join(tmpdir(), "witness-eval-"));
const store = caseStore(join(scratch, "mandates"), cases);
const results: CaseResult[] = [];
for (const c of cases)
  for (const assessor of assessors) {
    const result = await runCase(c, assessor, store, join(scratch, "runs")).catch(
      (error: Error): CaseResult => ({
        case: c.id, assessor: assessor.model, expected: c.expected, action: "review", correct: false, discrepancy: null, dropped: 0, findings: {}, seconds: 0,
        error: error.message.replace(/sk-[A-Za-z0-9_-]+/g, "[key]").slice(0, 300),
      }),
    );
    results.push(result);
    console.log(`${c.id} ${result.assessor.padEnd(28)} expected ${c.expected.padEnd(16)} got ${result.action.padEnd(16)} ${result.correct ? "ok" : "WRONG"}${result.error ? ` (${result.error})` : ""}`);
  }

const summary = Object.fromEntries(
  [...new Set(results.map((r) => r.assessor))].map((name) => {
    const mine = results.filter((r) => r.assessor === name);
    return [name, {
      correct: mine.filter((r) => r.correct).length,
      cases: mine.length,
      errors: mine.filter((r) => r.error).length,
      droppedStatements: mine.reduce((sum, r) => sum + r.dropped, 0),
      discrepanciesFlaggedWhereExpected: cases.filter((c) => c.expectDiscrepancy).filter((c) => mine.find((r) => r.case === c.id)?.discrepancy).length,
    }];
  }),
);
console.log(JSON.stringify(summary, null, 1));
mkdirSync("eval/results", { recursive: true });
const file = `eval/results/${new Date().toISOString().replace(/[:.]/g, "-")}${withWitness ? "" : "-baseline"}${demo ? "-demo" : ""}.json`;
writeFileSync(file, JSON.stringify({ ranAt: new Date().toISOString(), summary, results }, null, 2) + "\n");
console.log(`wrote ${file}`);
