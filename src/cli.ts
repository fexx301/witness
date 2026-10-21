// witness list | inspect <dispute-id> | run <dispute-id> [--execute] | import-mandate <file>
//         | agent-buy <mandate-hash> --vault <id> --item "<item>" --amount 16.00 [--ship shipped|delivered]

import { existsSync, readFileSync } from "node:fs";
import { agentPurchase, recordShipment } from "./agentBuy.js";
import { normalizeDispute } from "./claim.js";
import { ClaudeAssessor } from "./decide.js";
import { MandateSchema, MandateStore } from "./mandate.js";
import { PayPalClient, credentialsFromEnv } from "./paypal/client.js";
import { Disputes } from "./paypal/disputes.js";
import { Orders } from "./paypal/orders.js";
import { loadPolicy } from "./policy.js";
import { processDispute } from "./witness.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const [command, arg, ...flags] = process.argv.slice(2);
const mandates = new MandateStore("data/mandates");
const flag = (name: string) => (flags.includes(name) ? flags[flags.indexOf(name) + 1] : undefined);

function paypal() {
  const client = new PayPalClient(credentialsFromEnv());
  return { disputes: new Disputes(client), orders: new Orders(client) };
}

async function main() {
  switch (command) {
    case "list": {
      for (const d of await paypal().disputes.list())
        console.log(`${d.dispute_id}  ${d.status.padEnd(28)} ${d.reason.padEnd(40)} ${d.dispute_amount.value} ${d.dispute_amount.currency_code}`);
      return;
    }
    case "inspect": {
      if (!arg) throw new Error("usage: witness inspect <dispute-id>");
      const claim = normalizeDispute(await paypal().disputes.get(arg));
      console.log(JSON.stringify({ ...claim, actions: [...claim.actions], mandateKnown: Boolean(mandates.find(claim.mandateHash)) }, null, 2));
      return;
    }
    case "run": {
      if (!arg) throw new Error("usage: witness run <dispute-id> [--execute]");
      const execute = flags.includes("--execute");
      const record = await processDispute(
        { ...paypal(), mandates, assessor: new ClaudeAssessor(), policy: loadPolicy("data/policy.json"), runsDir: "data/runs" },
        arg,
        { execute },
      );
      console.log(record.evidencePack);
      console.log(`Planned: ${record.steps.map((s) => s.kind).join(" → ")}`);
      if (execute) for (const r of record.results) console.log(`  ${r.ok ? "OK " : "ERR"} ${r.step}${r.debugId ? ` (debug_id ${r.debugId})` : ""}${r.error ? ` ${r.error}` : ""}`);
      else console.log("Dry run: nothing was sent to PayPal. Re-run with --execute to act.");
      return;
    }
    case "import-mandate": {
      if (!arg) throw new Error("usage: witness import-mandate <file.json>");
      // Importing is not acceptance: the buyer's acceptance must be recorded separately.
      const hash = mandates.save(MandateSchema.parse(JSON.parse(readFileSync(arg, "utf8"))));
      mandates.record(hash, { event: "imported", at: new Date().toISOString() });
      console.log(`stored mandate ${hash} (imported; buyer acceptance not recorded)`);
      return;
    }
    case "agent-buy": {
      const [vault, item, amount, ship] = [flag("--vault"), flag("--item"), flag("--amount"), flag("--ship")];
      if (!arg || !vault || !item || !amount || (ship && ship !== "shipped" && ship !== "delivered"))
        throw new Error('usage: witness agent-buy <mandate-hash> --vault <id> --item "<item>" --amount 16.00 [--ship shipped|delivered]');
      if (!mandates.find(arg)) throw new Error(`Witness holds no mandate ${arg.slice(0, 12)}…; import or accept one first.`);
      const client = new PayPalClient(credentialsFromEnv());
      const purchase = await agentPurchase(client, arg, vault, item, amount);
      console.log(`agent bought "${item}" for $${amount}: order ${purchase.orderId}, capture ${purchase.captureId} at ${purchase.capturedAt}`);
      if (ship) {
        const shipment = await recordShipment(client, purchase, ship === "delivered");
        console.log(`merchant recorded USPS ${shipment.trackingNumber} as ${shipment.status}`);
      }
      return;
    }
    default:
      console.log('usage: witness list | inspect <dispute-id> | run <dispute-id> [--execute] | import-mandate <file.json> | agent-buy <mandate-hash> --vault <id> --item "<item>" --amount 16.00 [--ship shipped|delivered]');
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
