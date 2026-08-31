import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const BEDROCK_MESSAGES_VERSION = "bedrock-2023-05-31";
export const FACTS_FIT_IN_OUTPUT_TOKENS = 8192;

const CALL_TIMEOUT_MS = 300_000;
const RESPONSE_LIMIT = 2 * 1024 * 1024;

export function createModelCall(
  config,
  { run = execFileSync, onUsage = () => {}, maxOutputTokens = FACTS_FIT_IN_OUTPUT_TOKENS } = {}
) {
  return function callBedrock({ prompt, model, sessionId = null }) {
    mkdirSync(config.extractorDir, { recursive: true });
    const call = randomUUID();
    const requestPath = join(config.extractorDir, `${call}.request.json`);
    const responsePath = join(config.extractorDir, `${call}.response.json`);

    writeFileSync(
      requestPath,
      JSON.stringify({
        anthropic_version: BEDROCK_MESSAGES_VERSION,
        max_tokens: maxOutputTokens,
        messages: [{ role: "user", content: prompt }],
      })
    );

    try {
      run(
        "aws",
        [
          "bedrock-runtime",
          "invoke-model",
          "--profile",
          config.awsProfile,
          "--region",
          config.awsRegion,
          "--model-id",
          model,
          "--content-type",
          "application/json",
          "--body",
          `fileb://${requestPath}`,
          responsePath,
        ],
        { encoding: "utf-8", timeout: CALL_TIMEOUT_MS, maxBuffer: RESPONSE_LIMIT }
      );

      const answer = JSON.parse(readFileSync(responsePath, "utf-8"));
      onUsage({
        model,
        sessionId,
        stopReason: answer.stop_reason ?? null,
        inputTokens: answer.usage?.input_tokens ?? 0,
        outputTokens: answer.usage?.output_tokens ?? 0,
      });
      return textOf(answer);
    } finally {
      rmSync(requestPath, { force: true });
      rmSync(responsePath, { force: true });
    }
  };
}

function textOf(answer) {
  const blocks = Array.isArray(answer?.content) ? answer.content : [];
  return blocks
    .map((block) => (typeof block?.text === "string" ? block.text : ""))
    .join("")
    .trim();
}
