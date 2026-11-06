# One sandbox dispute, end to end: PP-R-ZLP-10194382

The buyer's mandate told their shopping agent "Whole bean, never ground." The agent bought "Decaf, ground, 340 g",
the buyer disputed it as not as described, Witness found the agent at fault and the merchant's delivery as listed,
and the merchant's policy said refund. A person sent that refund from the desk, and PayPal closed the case.

| File | What it is |
|---|---|
| [mandate.json](mandate.json) | The buyer's mandate as stored. Its SHA-256 is the one carried in the order's `custom_id`. Accepted on 2026-10-24 on Witness's acceptance page, then approved by the buyer at PayPal (order 5YS322825N0823412). |
| [1-investigation.json](1-investigation.json) | The dry run a person reviewed (2026-10-29): the facts code established, Claude's findings with their citations, the decision, the planned step (`accept_claim`) and the text PayPal would receive. |
| [evidence-pack.pdf](evidence-pack.pdf) | That investigation's evidence pack, rendered as Witness renders evidence files for PayPal ([src/pack.ts](../../src/pack.ts)). Accepting a claim attaches no file, so this one was not sent; for a provide-evidence response it is the attachment. |
| [2-sent-to-paypal.json](2-sent-to-paypal.json) | The send, made from the desk on 2026-11-05: `reviewedRanAt` names the dry run above, and PayPal accepted `accept_claim` (debug_id f13281395a2b8). |
| [3-paypal-dispute-after.json](3-paypal-dispute-after.json) | The dispute as PayPal returned it afterwards: `RESOLVED`, outcome `RESOLVED_BUYER_FAVOUR`, reason `SELLER_ISSUED_REFUND`, $16.00 refunded. |

PayPal account IDs and email addresses in the three JSON records are replaced, as the hosted desk shows them to
visitors; "John Doe" and "Test Store" are PayPal's sandbox defaults. The mandate is unchanged, so its hash still
checks.

After the merchant accepted the claim, PayPal resolved the sandbox dispute without the sandbox adjudication call.
That shows the integration working end to end; it says nothing about whether Witness's reasoning would hold up
with a real merchant or buyer.
