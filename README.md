# Witness

**Agent purchases have no witness. Now they do.**

Witness answers PayPal disputes with evidence, including the new kind nobody can answer yet:
*"my AI agent bought this."* When a buyer's shopping agent pays, the buyer's signed mandate
(spending cap, merchants, category, expiry) is bound to the PayPal order by its SHA-256. When a
dispute arrives, Witness reads the buyer's claim, checks the purchase against the mandate, and either
files the evidence through the PayPal Disputes API or refunds when the agent overstepped.

Built for the PayPal AI Hackathon 2026. Sandbox only: Witness refuses to run against live PayPal.

## How a dispute is handled

1. **Read**: the dispute, the buyer's own words, and which responses PayPal allows right now.
2. **Gather**: the capture, the order, shipment tracking, and the mandate bound to the order.
3. **Check**: amount, merchant, validity and mandate integrity are checked by code, not by the model.
4. **Assess**: Claude reads the claim against those facts (structured output).
5. **Decide**: failed mandate checks always mean refund; unclear cases go to a person.
6. **Act**: provide evidence, add supporting info, message and escalate, or accept the claim. This is dry-run by default.
7. **Record**: every run writes its facts, decision, evidence pack and PayPal debug IDs to `data/runs/`.

## Run it

```bash
npm install
cp .env.example .env    # PayPal sandbox app credentials + ANTHROPIC_API_KEY
npm run witness -- list
npm run witness -- inspect <dispute-id>
npm run witness -- run <dispute-id>            # dry run: shows what it would do
npm run witness -- run <dispute-id> --execute  # acts on the sandbox dispute
npm test
```

## Status

M1 (thin path) is in progress. The sandbox capabilities Witness relies on were verified first: vaulted
agent payments with no buyer present, dispute ingestion with the buyer's text, evidence submission,
escalation, refunds, and sandbox adjudication to `RESOLVED_SELLER_FAVOUR`.

## License

MIT
