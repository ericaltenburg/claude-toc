import { createConfig } from "../config.js";
import { dollars, thousands } from "../format.js";
import { createSpendLog } from "../spend.js";

function reportSection(title, tallies) {
  console.log(`\n${title}`);
  for (const tally of tallies) {
    console.log(
      `  ${String(tally.key).padEnd(40)} ${String(tally.calls).padStart(5)} calls  ` +
        `${thousands(tally.inputTokens).padStart(12)} in  ${thousands(tally.outputTokens).padStart(9)} out  ` +
        `${dollars(tally.cost).padStart(9)}${tally.unpriced ? `  (${tally.unpriced} unpriced)` : ""}`
    );
  }
}

export function main() {
  const config = createConfig();
  const spend = createSpendLog(config);
  const summary = spend.summarize();

  if (!summary.total.calls) {
    console.log(`No model calls recorded yet in ${config.spendLogPath}`);
    return 0;
  }

  console.log(
    `${summary.total.calls} model call(s): ${thousands(summary.total.inputTokens)} input tokens, ` +
      `${thousands(summary.total.outputTokens)} output tokens, ${dollars(summary.total.cost)} estimated`
  );
  console.log(
    `Rates are list prices per million tokens; edit ${config.modelRatesPath} to match your bill.`
  );
  console.log(`Billed to the AWS profile ${config.awsProfile} in ${config.awsRegion}.`);

  reportSection("By day", summary.byDay);
  reportSection("By model", summary.byModel);
  reportSection("By session", summary.bySession.slice(0, SESSIONS_WORTH_LISTING));
  return 0;
}

const SESSIONS_WORTH_LISTING = 20;
