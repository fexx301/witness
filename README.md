# Witness

**When an AI purchase goes wrong, Witness connects what the buyer approved, what the agent bought, and
what the merchant delivered, then prepares the evidence or executes an authorized refund through PayPal.**

Shopping agents can now pay on a buyer's behalf. When one of those purchases is disputed, the merchant
has to work out three separate things: did the buyer authorize this agent to buy, did the agent buy what
it was told to, and did the merchant deliver what was ordered? A purchase can be within budget and still
violate the buyer's instructions. An authorized purchase can still never arrive. Witness keeps these
questions apart.

Built for the PayPal AI Hackathon 2026. Sandbox only: Witness refuses to run against live PayPal.

## How Witness investigates a dispute

1. **Read**: the PayPal dispute, the buyer's own words, PayPal's evidence requests, and which responses
   PayPal allows on the case right now.
2. **Gather**: the capture, the order, shipment tracking, and the buyer's mandate for their agent, which is
   bound to the order by its SHA-256 (carried in the PayPal `custom_id`).
3. **Establish facts in code**:
   - **authorization**: the mandate version in force *at purchase time* (accepted, not superseded,
     revoked or expired), the amount within its cap, the merchant named in it, the document unaltered;
   - **fulfilment**: only a delivered record establishes delivery. A shipped status, or a missing record,
     is unknown, not proof either way.
4. **Compare with Claude**: what the buyer instructed, what the agent bought, and what the listing
   promised. Every conclusion must cite the facts it rests on; a conclusion with a missing or unknown
   citation is treated as unknown. Claude also writes the notes PayPal receives and the message to the
   buyer, as separate statements that each cite their facts. Code sends only the statements whose every
   citation is a supplied fact; the rest are dropped, listed in the investigation file as not sent, and
   kept in the run record.
5. **Decide by the reason PayPal records for the dispute**, since that is what PayPal adjudicates on. If
   Claude reads the buyer's words as a different kind of claim, Witness shows the discrepancy and still
   answers PayPal's reason. Not-received claims turn on delivery, not-as-described claims on the listing
   and the instructions, unauthorized claims on the mandate. A valid mandate never on its own means
   "defend". Where Witness finds an *agent* instruction violation but the merchant delivered as listed,
   the merchant's own policy decides whether to refund, offer a return, or review. Anything unestablished
   becomes a visible gap and a request for evidence, never a silent refund.
6. **Act** only through the responses PayPal currently offers (provide evidence, supporting info, message
   and escalate, accept the claim, offer a return). Dry run by default.
7. **Record** every run: findings, sources, gaps, decision, evidence pack and PayPal debug IDs, in `data/runs/`.

## What Witness does not claim

- **A matching mandate hash proves the document is unchanged, not who accepted it.** Buyer acceptance is a
  separate recorded event; mandates imported without one are treated as unproven.
- **PayPal sandbox rulings are chosen by the developer** (`adjudicate` is a sandbox-only test call). They
  show Witness works across PayPal's full dispute lifecycle, not that its evidence wins disputes. Witness
  makes no claim about real recovery rates.
- Generic AI dispute response already exists (e.g. Chargeflow for PayPal), and signed agent mandates are
  the idea behind AP2. Witness's contribution is the investigation: tying an agent's mandate, the purchase
  and the fulfilment record together for one specific dispute, and knowing when it cannot justify acting.

## Run it

```bash
npm install
cp .env.example .env    # PayPal sandbox app credentials + ANTHROPIC_API_KEY (or OPENROUTER_API_KEY)
npm run witness -- list
npm run witness -- inspect <dispute-id>
npm run witness -- run <dispute-id>            # dry run: shows the investigation and planned response
npm run witness -- run <dispute-id> --execute  # acts on the sandbox dispute
npm test
```

Merchant policy lives in `data/policy.json`. Without one, Witness refunds nothing automatically.

## Status

Correctness pass done: claim-type rules, purchase-time mandate validity, PayPal evidence requests, and
merchant policy. Next: testing whether buyer approval of a mandate can be tied to PayPal's own checkout
approval, then item-level instructions in the demo, then the AG Studio investigation desk.

## License

MIT
