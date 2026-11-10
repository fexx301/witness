# For AI agents reviewing this repository

Start with "For judges: five minutes" in `README.md`. Everything below runs with no keys, on Node 22.

## Quick check (under a minute, no network after `npm ci`)

```bash
npm ci                         # about 10 s
npm run typecheck              # about 1 s, prints nothing after the header
npm test                       # about 3 s, ends "Tests  75 passed (75)"
npx tsx eval/run.ts            # about 1 s, rules-only baseline on 18 cases: summary lines "correct": 16, and "cases": 18,
npx tsx eval/run.ts --demo     # about 1 s, rules-only baseline on 5 demo cases: "correct": 3, and "cases": 5,
```

- Each step exits 0 on success. The eval exits 0 whatever the score, and 1 only if a case errors: read the
  JSON summary it prints (`correct`, `cases`, `errors`) for the result.
- Each eval run writes a new, untracked report to `eval/results/<time>-baseline*.json` (machine-readable: a
  `summary` per assessor and one `results` entry per case). `git clean -f eval/results` removes them.
- The committed reports behind every number in "Results" are in `eval/results/`; the table links each one.

## Do not run

`npx tsx eval/run.ts --witness` (calls Claude and costs money; with no key it stops, exits 1 and writes
nothing), `npm run witness -- run <id> --execute`,
`agent-buy`, `seller-note`, `import-mandate`, the sandbox `adjudicate` call (all act on a PayPal sandbox
account), and repeated chat or POST `/api/investigate` on the hosted desk (they spend a daily budget that
human judges share).

## The hosted desk, read-only, as JSON

The hosted desk's API answers visitors' reads with no key and spends nothing. Account IDs are replaced for
visitors.

```bash
curl -s https://witness-desk.duckdns.org/api/disputes
# {"rows":[...]}: one row per sandbox dispute with disputeId, reason, paypalStatus, outcome,
# witnessDecision, baselineDecision, sentToPayPal. PP-R-ZLP-10194382: witnessDecision "refund",
# paypalStatus "RESOLVED", outcome "RESOLVED_BUYER_FAVOUR".

curl -s "https://witness-desk.duckdns.org/api/investigation?id=PP-R-ZLP-10194382"
# {"reviewed": {...}, "mandate": {...}, "baseline": {...}, "executed": ..., "lastSent": ...}
# reviewed.decision.action is "refund", reviewed.decision.basis "merchant_policy",
# reviewed.model "anthropic/claude-opus-5.5"; reviewed.findings, .assessment and .steps hold the reasoning.
```

`reviewed` is the latest investigation of that dispute: a visitor's fresh run replaces it, so its wording can
change. The committed copy that a person reviewed and sent is `examples/PP-R-ZLP-10194382/1-investigation.json`.

## Evidence for each judging criterion

The event's five criteria, and where this repository gives evidence for each:

| Criterion | Evidence |
|---|---|
| Technological Implementation | "PayPal APIs Witness uses" and "AI and other tools Witness uses" in `README.md`, with code links; `src/paypal/`, `src/decide.ts`; 75 tests (`test/`); CI (`.github/workflows/ci.yml`); a sandbox case sent and resolved (`examples/PP-R-ZLP-10194382/`) |
| Design | "The investigation desk" in `README.md`, `assets/desk-investigation.png`, `assets/desk-queue.png`, the hosted desk and its JSON API above, `desk/src/` |
| Potential Impact | Who it is for and the problem, in the opening of `README.md`; "Why a merchant would refund the agent's mistake", stated as a hypothesis; "Results" and its limits |
| Innovation/Idea | "How it works" and "How Witness investigates a dispute" in `README.md`; the last point of "What Witness does not claim" names existing approaches and what Witness adds |
| Presentation | The video and `docs/video-transcript.md`; "For judges: five minutes"; "One case, end to end" |

## Where to find things

- The demo video as text (narration and on-screen text, by chapter): `docs/video-transcript.md`.
- Results, with model, dates, baseline versions and what they measure: "Results" in `README.md`.
- Each claim mapped to its code and tests: "Where each claim is checked" in `README.md`.
- One sandbox dispute end to end, as committed records: `examples/PP-R-ZLP-10194382/`.
- Which PayPal APIs it calls, and where: "PayPal APIs Witness uses" in `README.md`.
- What the project does not claim: "What Witness does not claim" in `README.md`.
