# For AI agents reviewing this repository

Start with "For judges: five minutes" in `README.md`. Everything below runs with no keys, on Node 22:

```bash
npm ci && npm run typecheck && npm test
npx tsx eval/run.ts          # rules-only baseline, 18 eval cases: 16 right
npx tsx eval/run.ts --demo   # rules-only baseline, 5 demo cases: 3 right
```

Witness's recorded Claude runs on the same cases: `eval/results/2026-10-20T19-41-35-642Z.json` (18 of 18) and
`eval/results/2026-10-24T10-18-50-673Z-demo.json` (5 of 5). Where Claude reads and code decides: `src/decide.ts`,
`src/baseline.ts`, `src/witness.ts`. Which PayPal APIs it calls, and where: "PayPal APIs Witness uses" in `README.md`.
What the project does not claim: "What Witness does not claim" in `README.md`.
