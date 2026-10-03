// witness list | inspect <dispute-id> | run <dispute-id> [--execute] | import-mandate <file>

import { existsSync, readFileSync } from "node:fs";
import { normalizeDispute } from "./claim.js";
import { ClaudeAssessor } from "./decide.js";
import { MandateSchema, MandateStore } from "./mandate.js";
import { PayPalClient, credentialsFromEnv } from "./paypal/client.js";
import { Disputes } from "./paypal/disputes.js";
import { Orders } from "./paypal/orders.js";
import { processDispute } from "./witness.js";

if (existsSync(".env")) process.loadEnvFile(".env");

const [command, arg, ...flags] = process.argv.slice(2);
const mandates = new MandateStore("data/mandates");

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
        { ...paypal(), mandates, assessor: new ClaudeAssessor(), runsDir: "data/runs" },
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
      const hash = mandates.save(MandateSchema.parse(JSON.parse(readFileSync(arg, "utf8"))));
      console.log(`stored mandate ${hash}`);
      return;
    }
    default:
      console.log("usage: witness list | inspect <dispute-id> | run <dispute-id> [--execute] | import-mandate <file.json>");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
