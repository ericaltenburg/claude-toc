import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";

import { localDateParts } from "./parse.js";

export const LIST_RATES_PER_MILLION_TOKENS = {
  "global.anthropic.claude-sonnet-5": { input: 3, output: 15 },
  "global.anthropic.claude-opus-5": { input: 15, output: 75 },
};

export function createSpendLog(config, { timeZone, now = () => Date.now() } = {}) {
  function record({ model, sessionId = null, inputTokens = 0, outputTokens = 0, stopReason = null }) {
    const at = now();
    mkdirSync(config.corpusDir, { recursive: true });
    appendFileSync(
      config.spendLogPath,
      JSON.stringify({
        ts: new Date(at).toISOString(),
        localDate: localDateParts(at, timeZone).date,
        session: sessionId,
        model,
        inputTokens,
        outputTokens,
        stopReason,
      }) + "\n"
    );
  }

  function calls() {
    if (!existsSync(config.spendLogPath)) return [];
    return readFileSync(config.spendLogPath, "utf-8")
      .split("\n")
      .filter((line) => line.trim())
      .map(parsedOrNull)
      .filter(Boolean);
  }

  function rates() {
    if (!existsSync(config.modelRatesPath)) return LIST_RATES_PER_MILLION_TOKENS;
    try {
      return { ...LIST_RATES_PER_MILLION_TOKENS, ...JSON.parse(readFileSync(config.modelRatesPath, "utf-8")) };
    } catch {
      return LIST_RATES_PER_MILLION_TOKENS;
    }
  }

  return { record, calls, rates, summarize: () => summarizeSpend(calls(), rates()) };
}

function parsedOrNull(line) {
  try {
    const call = JSON.parse(line);
    return call && typeof call === "object" ? call : null;
  } catch {
    return null;
  }
}

export const UNDATED = "undated";

const A_MILLION = 1_000_000;

export function estimatedCost(call, rates) {
  const rate = rates[call.model];
  if (!rate) return null;
  return (
    ((call.inputTokens ?? 0) * rate.input + (call.outputTokens ?? 0) * rate.output) / A_MILLION
  );
}

export function summarizeSpend(calls, rates = LIST_RATES_PER_MILLION_TOKENS) {
  const total = emptyTally();
  const byDay = new Map();
  const byModel = new Map();
  const bySession = new Map();

  for (const call of calls) {
    for (const tally of [
      total,
      tallyFor(byDay, call.localDate ?? UNDATED),
      tallyFor(byModel, call.model ?? "unknown"),
      tallyFor(bySession, call.session ?? "unattributed"),
    ]) {
      addTo(tally, call, rates);
    }
  }

  return { total, byDay: sortedTallies(byDay), byModel: sortedTallies(byModel), bySession: sortedTallies(bySession) };
}

function emptyTally() {
  return { calls: 0, inputTokens: 0, outputTokens: 0, cost: 0, unpriced: 0 };
}

function tallyFor(tallies, key) {
  const existing = tallies.get(key);
  if (existing) return existing;
  const fresh = { key, ...emptyTally() };
  tallies.set(key, fresh);
  return fresh;
}

function addTo(tally, call, rates) {
  const cost = estimatedCost(call, rates);
  tally.calls++;
  tally.inputTokens += call.inputTokens ?? 0;
  tally.outputTokens += call.outputTokens ?? 0;
  if (cost === null) tally.unpriced++;
  else tally.cost += cost;
}

function sortedTallies(tallies) {
  return [...tallies.values()].sort((a, b) => b.cost - a.cost || String(a.key).localeCompare(String(b.key)));
}
