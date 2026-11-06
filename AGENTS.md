# For AI agents reviewing this repository

Start with "For judges: five minutes" in `README.md`. Everything below runs with no keys, on Node 22:

```bash
npm ci && npm run typecheck && npm test
npx tsx eval/run.ts          # rules-only baseline, 18 eval cases: 16 right
npx tsx eval/run.ts --demo   # rules-only baseline, 5 demo cases: 3 right
```

- Results, with model, dates, baseline versions and what they measure: "Results" in `README.md`.
- Each claim mapped to its code and tests: "Where each claim is checked" in `README.md`.
- One sandbox dispute end to end, as committed records: `examples/PP-R-ZLP-10194382/`.
- Which PayPal APIs it calls, and where: "PayPal APIs Witness uses" in `README.md`.
- What the project does not claim: "What Witness does not claim" in `README.md`.
