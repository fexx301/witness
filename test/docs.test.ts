// Keeps what README.md and AGENTS.md promise in step with the committed artifacts: eval reports, test names,
// test count, links and the default model. Reads files only; it runs nothing and writes nothing.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { claudeClient } from "../src/decide.js";

const root = join(import.meta.dirname, "..");
const read = (path: string) => readFileSync(join(root, path), "utf8");
const readme = read("README.md");
const agents = read("AGENTS.md");
type Summary = Record<string, { correct: number; cases: number }>;
const report = (file: string) => JSON.parse(read(file)) as { summary: Summary; results: { case: string; assessor: string; correct: boolean }[] };
const BASELINE = "rules-only baseline";

describe("docs match the committed artifacts", () => {
  it("each row of the Results table matches its linked report", () => {
    const section = readme.slice(readme.indexOf("## Results"), readme.indexOf("**What this measures.**"));
    const rows = section.split("\n").filter((line) => / of \d+/.test(line));
    expect(rows.length).toBe(5);
    let last = "";
    for (const row of rows) {
      const [, correct, cases] = row.match(/(\d+) of (\d+)/)!;
      last = row.match(/\]\((eval\/results\/[^)]+\.json)\)/)?.[1] ?? last;
      const summary = report(last).summary;
      const key = row.includes("Rules-only") ? BASELINE : Object.keys(summary).find((k) => k !== BASELINE)!;
      expect({ row: row.slice(0, 60), correct: summary[key]!.correct, cases: summary[key]!.cases }).toEqual({ row: row.slice(0, 60), correct: Number(correct), cases: Number(cases) });
    }
  });

  it("the documented baseline output matches the current baseline reports", () => {
    const eighteen = report("eval/results/2026-10-24T09-59-16-096Z-baseline.json");
    const demo = report("eval/results/2026-10-24T10-18-50-673Z-demo.json");
    {
      const doc = agents;
      // The eval prints its summary as indented JSON, one field per line, so the docs quote the lines.
      for (const r of [eighteen, demo]) {
        expect(doc).toContain(`"correct": ${r.summary[BASELINE]!.correct},`);
        expect(doc).toContain(`"cases": ${r.summary[BASELINE]!.cases},`);
      }
    }
    const misses = (r: ReturnType<typeof report>) => r.results.filter((x) => x.assessor === BASELINE && !x.correct).map((x) => x.case);
    expect(misses(eighteen)).toEqual(["A4", "A8"]);
    expect(misses(demo)).toEqual(["D1", "D3"]);
    expect(agents).toContain("A4 and A8 of the 18, D1 and D3\n  of the 5");
  });

  it("every test name the README cites exists", () => {
    const tests = read("test/witness.test.ts");
    const from = readme.indexOf("## Where each claim is checked");
    const section = readme.slice(from, readme.indexOf("\n## ", from + 1));
    const names = [...section.matchAll(/"([^"]{20,})"/g)].map((m) => m[1]);
    expect(names.length).toBe(7);
    for (const name of names) expect(tests, name).toContain(name);
  });

  it("the documented test count matches the test files", () => {
    const files = readdirSync(join(root, "test")).filter((f) => f.endsWith(".test.ts"));
    const count = files.reduce((n, f) => n + (read(`test/${f}`).match(/^\s*it\(/gm)?.length ?? 0), 0);
    for (const doc of [readme, agents]) expect(doc).toContain(`Tests  ${count} passed (${count})`);
  });

  it("relative links in the docs resolve", () => {
    const docs = ["README.md", "AGENTS.md", "docs/video-transcript.md", "deploy/README.md", "examples/PP-R-ZLP-10194382/README.md"];
    for (const doc of docs) {
      for (const [, target = ""] of read(doc).matchAll(/\]\(([^)]+)\)/g)) {
        if (/^(https?:|#|mailto:)/.test(target)) continue;
        const path = join(root, dirname(doc), target.split("#")[0] ?? "");
        expect(existsSync(path), `${doc} -> ${target}`).toBe(true);
      }
    }
  });

  it(".env.example names the default model", () => {
    expect(read(".env.example")).toContain(`WITNESS_MODEL=${claudeClient({}).model}`);
  });
});
