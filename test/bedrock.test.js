import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";

import { createModelCall, BEDROCK_MESSAGES_VERSION } from "../src/bedrock.js";
import { createSpendLog } from "../src/spend.js";
import { tempCorpus } from "./support/corpus.js";

const MODEL = "global.anthropic.claude-sonnet-5";

const AN_ANSWER = {
  content: [{ type: "text", text: '{"topic": {"id": "alcs_broadcast_variants"}}' }],
  stop_reason: "end_turn",
  usage: { input_tokens: 57131, output_tokens: 812 },
};

function fakeAws(answer = AN_ANSWER) {
  const invocations = [];
  const run = (command, args) => {
    const request = JSON.parse(readFileSync(bodyPathIn(args), "utf-8"));
    invocations.push({ command, args, request });
    writeAnswer(args, answer);
    return "";
  };
  return { invocations, run };
}

function bodyPathIn(args) {
  return args[args.indexOf("--body") + 1].replace("fileb://", "");
}

function writeAnswer(args, answer) {
  const responsePath = args[args.length - 1];
  writeFileSync(responsePath, JSON.stringify(answer));
}

function flagValue(args, flag) {
  return args[args.indexOf(flag) + 1];
}

test("a model call goes to Bedrock under the configured profile and region", () => {
  const config = tempCorpus();
  const aws = fakeAws();

  const text = createModelCall(config, { run: aws.run })({ prompt: "extract this", model: MODEL });

  const [{ command, args, request }] = aws.invocations;
  assert.equal(command, "aws");
  assert.deepEqual(args.slice(0, 2), ["bedrock-runtime", "invoke-model"]);
  assert.equal(flagValue(args, "--profile"), config.awsProfile);
  assert.equal(flagValue(args, "--region"), config.awsRegion);
  assert.equal(flagValue(args, "--model-id"), MODEL);
  assert.equal(request.anthropic_version, BEDROCK_MESSAGES_VERSION);
  assert.deepEqual(request.messages, [{ role: "user", content: "extract this" }]);
  assert.equal(text, '{"topic": {"id": "alcs_broadcast_variants"}}');
});

test("a model call leaves no request or response file behind", () => {
  const config = tempCorpus();
  const aws = fakeAws();

  createModelCall(config, { run: aws.run })({ prompt: "extract this", model: MODEL });

  assert.deepEqual(readdirSync(config.extractorDir), []);
});

test("a failed call still cleans up, and reports nothing as spent", () => {
  const config = tempCorpus();
  const spend = createSpendLog(config);
  const callModel = createModelCall(config, {
    run: () => {
      throw new Error("ThrottlingException");
    },
    onUsage: (usage) => spend.record(usage),
  });

  assert.throws(() => callModel({ prompt: "extract this", model: MODEL }), /Throttling/);
  assert.deepEqual(readdirSync(config.extractorDir), []);
  assert.equal(existsSync(config.spendLogPath), false);
});

test("every call is recorded in the spend log with its session and tokens", () => {
  const config = tempCorpus();
  const spend = createSpendLog(config);
  const aws = fakeAws();
  const callModel = createModelCall(config, {
    run: aws.run,
    onUsage: (usage) => spend.record(usage),
  });

  callModel({ prompt: "extract this", model: MODEL, sessionId: "316972f2" });

  const [call] = spend.calls();
  assert.equal(call.model, MODEL);
  assert.equal(call.session, "316972f2");
  assert.equal(call.inputTokens, 57131);
  assert.equal(call.outputTokens, 812);
  assert.equal(call.stopReason, "end_turn");
});
