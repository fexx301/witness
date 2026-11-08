# Demo video: transcript

The text equivalent of the demo video, [youtu.be/xn7DwPP47fM](https://youtu.be/xn7DwPP47fM) (2:29). Each
section gives the start time, the narration as scripted, and the main text on screen. Everything shown runs on
the PayPal sandbox.

## 0:00 Same complaint, two disputes

> AI agents are starting to shop for people. When a purchase goes wrong, the merchant gets a dispute, and the
> dispute doesn't say whose mistake it was.
>
> Two buyers sent PayPal the same complaint, word for word. Wrong coffee. I told my shopping assistant to buy
> whole bean only, never ground. And this bag is ground.
>
> Both purchases were made by the buyer's AI agent. Same words. Should they get the same answer?

On screen: the buyer's complaint on two dispute cards, "PayPal sandbox · PP-R-UOF-10194383" and "PayPal
sandbox · PP-R-ZLP-10194382", each tagged "Bought by an AI agent", then "Same words. Same answer?"

## 0:28 What a rules-only tool does

> A rules-only tool checks the order against the instructions. In the first case the order says whole bean, so
> it defends. But that buyer is right, and the merchant is about to fight them.

On screen: the dispute queue. PP-R-UOF-10194383, rules-only "Defend", Witness "Offer a return";
PP-R-ZLP-10194382, rules-only "Refund", Witness "Refund". Caption: "The buyer is right. The rules-only tool
would fight them."

## 0:40 Witness asks whose mistake it was

> Witness asks a different question. Whose mistake was it?

## 0:45 Witness investigates in the desk

> In the Witness desk, the merchant opens the dispute and asks Witness to investigate. It reads the dispute from
> PayPal, and gathers the order, the tracking, and the buyer's mandate for their agent.

On screen: a recording of the desk opening PP-R-UOF-10194383 and running a live Claude investigation, labelled
"Live Claude run · sped up 5×".

## 0:59 Case 1: the merchant's mistake

> Code checks the mandate. The buyer accepted it, it was in force, the purchase is within budget, and the buyer
> approved it at PayPal.
>
> The agent ordered whole bean, as it was told. But the merchant's own packing log says ground was packed by
> mistake. The mistake is the merchant's, so Witness recommends a return.

On screen: "Code checks the mandate: ✓ Accepted ✓ In force at purchase ✓ Within the $40 budget ✓ Approved at
PayPal", then "Agent: followed the instructions ✓", "Merchant: packed ground by mistake ✗", "Whose mistake?
The merchant's."

## 1:20 Case 2: the agent's mistake

> The second case, same words. Here the agent ordered ground, and broke the buyer's instruction. The merchant
> delivered exactly what was ordered. So the merchant's own policy decides: refund.

On screen: PP-R-ZLP-10194382, "Agent: broke the buyer's instruction ✗", "Merchant: delivered what was ordered
✓", "Whose mistake? The agent's."

## 1:33 Ask in the chat

> You can also just ask. In the chat, AG Studio's own agent hands the case to Witness, which investigates it
> and answers. The AI agent made the mistake, not the merchant.

On screen: the desk chat, labelled "Live Claude run · sped up", showing "AG Studio's agent: Delegated to
Witness" and the reply "Whose mistake: the buyer's AI agent made it. The merchant did not. What the agent did:
It ordered "Decaf, ground, 340 g." That breaks the whole-bean instruction."

## 1:47 How Witness decides

> Claude reads the words and compares the instructions, the order and the listing. Every conclusion has to cite
> a fact. Code checks each citation, the mandate and the delivery, and decides by the reason PayPal records.

On screen: the desk's decision trace. Claude: "Contradicted. The mandate says 'Whole bean, never ground.' The
agent ordered 'Decaf, ground, 340 g'." Code: "Every source Claude cited was supplied." Code: "Inside the mandate
in force when it was made. Recorded as delivered." PayPal reason: merchandise or service not as described.
Merchant policy: "Decision: Refund".

## 2:01 Sent to PayPal, and PayPal's own record

> Then a person reviews it, and sends exactly that. This refund went to PayPal in the sandbox, and the case
> closed in the buyer's favour.
>
> On PayPal's side, the case page shows the refund, and Witness's explanation, word for word.

On screen: the desk's Execute button, then "✓ Sent to PayPal" and "✓ Resolved, buyer favour". Then PayPal's
sandbox case page for the merchant: "Case closed", "This case was closed in the buyer's favor", "You refunded
$16.00 USD", and the merchant's message beginning "Witness: Agent instruction violation, not a merchant
fulfilment failure", with "Full refund of $16.00 USD was sent." The committed records of this case are in
[examples/PP-R-ZLP-10194382](../examples/PP-R-ZLP-10194382).

## 2:17 End card

> Claude reads. Code decides. A person sends. Witness, for merchants whose buyers shop with AI agents.

On screen: "Try it: witness-desk.duckdns.org" and "Code: github.com/fexx301/witness".
