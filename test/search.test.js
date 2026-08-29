import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { join } from "node:path";

import { createSearch, ftsQuery, parseArgs } from "../src/search.js";
import {
  appendPrompts,
  appendSessions,
  REPO_ROOT,
  tempCorpus,
  writeTopic,
} from "./support/corpus.js";

const NY = "America/New_York";

const FACTS = {
  Context: [
    "- Variants are keyed by show id [session:316972f2, 2026-05-12]",
    "- The poller consolidates pipelines nightly [session:316972f2, 2026-05-12]",
  ],
  Decisions: ["- Will store variants in DynamoDB [session:316972f2, 2026-05-12]"],
};

function withSearch(run) {
  const config = tempCorpus();
  const search = createSearch(config, { timeZone: NY });
  try {
    return run(config, search);
  } finally {
    search.close();
  }
}

function logLines(config) {
  if (!existsSync(config.searchLogPath)) return [];
  return readFileSync(config.searchLogPath, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

// --- Result shape ---

test("a question returns ranked facts, each with its topic, section and date", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    const result = search.search({ query: "variants", mode: "facts" });

    // Ranked, so the order is bm25's: the shorter fact carrying the term wins.
    assert.deepEqual(
      result.facts.rows.map((row) => ({ ...row })),
      [
        {
          topic: "broadcast_variants",
          section: "Decisions",
          text: "Will store variants in DynamoDB",
          session: "316972f2",
          date: "2026-05-12",
          line: 8,
        },
        {
          topic: "broadcast_variants",
          section: "Context",
          text: "Variants are keyed by show id",
          session: "316972f2",
          date: "2026-05-12",
          line: 4,
        },
      ]
    );
  });
});

test("facts and prompts come back as separate result classes", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    appendPrompts(config, [{ display: "how do variants work again?" }]);

    const result = search.search({ query: "variants" });

    assert.equal(result.facts.rows.length, 2);
    assert.equal(result.prompts.rows.length, 1);
    assert.equal(result.prompts.rows[0].text, "how do variants work again?");
    // The prompt is nowhere in the fact list: nothing blends the two.
    assert.equal(
      result.facts.rows.some((row) => row.text.includes("how do variants work")),
      false
    );
  });
});

test("the default result shape is about twenty facts and ten prompts", () => {
  withSearch((config, search) => {
    writeTopic(config, "big_topic", {
      Context: Array.from(
        { length: 30 },
        (_, i) => `- Variants fact number ${i} [session:316972f2, 2026-05-12]`
      ),
    });
    appendPrompts(config, Array.from({ length: 15 }, () => ({ display: "variants question" })));

    const result = search.search({ query: "variants" });

    assert.equal(result.facts.rows.length, 20);
    assert.equal(result.facts.total, 30);
    assert.equal(result.prompts.rows.length, 10);
    assert.equal(result.prompts.total, 15);
  });
});

test("overview mode returns topic names with hit counts and no fact text", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeTopic(config, "variant_backfill", {
      Context: ["- Backfill replays variants for a day [2026-06-01]"],
    });

    const result = search.search({ query: "variants", mode: "overview" });

    assert.deepEqual(
      result.overview.rows.map(({ topic, hits }) => ({ topic, hits })),
      [
        { topic: "broadcast_variants", hits: 2 },
        { topic: "variant_backfill", hits: 1 },
      ]
    );
    assert.equal(result.facts, null);
    for (const row of result.overview.rows) {
      assert.equal("text" in row, false);
    }
  });
});

// --- Temporal questions ---

test("a temporal question returns the right day's material", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", {
      Context: [
        "- Yesterday's finding about variants [session:316972f2, 2026-08-26]",
        "- Today's finding about variants [session:316972f2, 2026-08-27]",
      ],
    });
    appendPrompts(config, [
      // 23:30 on 26 August in New York, already the 27th in UTC.
      { display: "wire up the retry", timestamp: Date.parse("2026-08-27T03:30:00Z") },
      { display: "now ship it", timestamp: Date.parse("2026-08-27T15:00:00Z") },
    ]);

    const result = search.search({ query: "", date: "2026-08-26" });

    assert.deepEqual(
      result.facts.rows.map((row) => row.text),
      ["Yesterday's finding about variants"]
    );
    assert.deepEqual(
      result.prompts.rows.map((row) => row.text),
      ["wire up the retry"]
    );
  });
});

test("a dateless keyword question is unaffected by the date filters", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    const result = search.search({ query: "dynamodb", mode: "facts" });

    assert.deepEqual(
      result.facts.rows.map((row) => row.text),
      ["Will store variants in DynamoDB"]
    );
  });
});

// --- Refresh on the read path ---

test("refresh runs before the query, so a just-written fact is found", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    // No explicit refresh call anywhere in this test.
    const result = search.search({ query: "variants", mode: "facts" });

    assert.equal(result.facts.rows.length, 2);
  });
});

test("a hand-edit between two searches is picked up by the second", () => {
  withSearch((config, search) => {
    writeTopic(config, "alarm_tuning", { Context: ["- Threshold is 10 [2026-04-24]"] });
    assert.equal(search.search({ query: "threshold", mode: "facts" }).facts.rows[0].text,
      "Threshold is 10");

    writeTopic(config, "alarm_tuning", { Context: ["- Threshold is 25, corrected [2026-04-24]"] });
    const second = search.search({ query: "threshold", mode: "facts" });

    assert.deepEqual(
      second.facts.rows.map((row) => row.text),
      ["Threshold is 25, corrected"]
    );
  });
});

// --- The search log ---

test("every search appends a timestamp, the query and a row count to the log", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    search.search({ query: "variants", mode: "facts" });
    search.search({ query: "nothing here matches", mode: "facts" });

    const lines = logLines(config);
    assert.equal(lines.length, 2);
    assert.match(lines[0].ts, /^\d{4}-\d{2}-\d{2}T.*Z$/);
    assert.equal(lines[0].query, "variants");
    assert.equal(lines[0].rows, 2);
    assert.equal(lines[1].query, "nothing here matches");
    assert.equal(lines[1].rows, 0);
  });
});

test("the log records whether a search was automatic or explicit", () => {
  withSearch((config, search) => {
    search.search({ query: "variants", source: "automatic", project: "/some/project" });
    search.search({ query: "variants" });

    assert.deepEqual(
      logLines(config).map((line) => line.source),
      ["automatic", "explicit"]
    );
  });
});

test("a raw sql search is logged too", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    const rows = search.sql("select text from facts order by line");

    assert.equal(rows.length, 3);
    assert.equal(logLines(config)[0].rows, 3);
    assert.match(logLines(config)[0].query, /^select text from facts/);
  });
});

// --- Read-only access ---

test("the sql escape hatch refuses anything that is not a read", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    search.refresh();

    for (const statement of [
      "delete from facts",
      "update facts set text = 'x'",
      "drop table facts",
      "insert into facts(topic, section, text) values ('a','b','c')",
      "pragma journal_mode = delete",
    ]) {
      assert.throws(() => search.sql(statement), /read-only/i, statement);
    }
    assert.equal(search.sql("select count(*) c from facts")[0].c, 3);
  });
});

test("read-only database access is pre-authorised in settings", () => {
  const settings = JSON.parse(
    readFileSync(join(REPO_ROOT, ".claude", "settings.json"), "utf-8")
  );
  assert.ok(
    settings.permissions.allow.includes("Bash($CLAUDE_TOC_HOME/bin/toc-search:*)"),
    "the read path's command must be pre-authorised, or automatic search stalls on a prompt"
  );
});

// --- Regression guards against the real tokeniser ---

test("a three-letter query does not match a prompt containing a url", () => {
  withSearch((config, search) => {
    appendPrompts(config, [{ display: "see https://code.amazon.com/packages/Foo for the model" }]);

    assert.equal(search.search({ query: "tps", mode: "prompts" }).prompts.rows.length, 0);
    assert.equal(search.search({ query: "amazon", mode: "prompts" }).prompts.rows.length, 1);
  });
});

test("a two-letter query does not match a word that merely contains it", () => {
  withSearch((config, search) => {
    appendPrompts(config, [{ display: "see https://code.amazon.com/packages/Foo for the model" }]);
    writeTopic(config, "alarm_tuning", { Context: ["- The alarm is noisy [2026-04-24]"] });

    assert.equal(search.search({ query: "ht", mode: "prompts" }).prompts.rows.length, 0);
    assert.equal(search.search({ query: "la", mode: "facts" }).facts.rows.length, 0);
  });
});

test("a term is found through its inflections", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    assert.equal(search.search({ query: "consolidate", mode: "facts" }).facts.rows.length, 1);
  });
});

test("a whole question is reduced to searchable terms rather than failing", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);

    const result = search.search({
      query: 'what did we decide about "broadcast" variants?',
      mode: "facts",
    });

    assert.ok(result.facts.rows.length > 0);
  });
});

test("a limit that is not a positive whole number is refused, not passed to sqlite", () => {
  for (const limit of ["all", "0", "-3", "2.5", undefined]) {
    assert.throws(
      () => parseArgs(["--limit", ...(limit === undefined ? [] : [limit]), "variants"]),
      /positive whole number/,
      String(limit)
    );
  }
  assert.equal(parseArgs(["--limit", "5", "variants"]).limit, 5);
});

test("ftsQuery quotes each term and passes an explicit expression through", () => {
  assert.equal(ftsQuery("broadcast variants"), '"broadcast" OR "variants"');
  assert.equal(ftsQuery("what did we decide"), '"decide"');
  assert.equal(ftsQuery("variant*"), "variant*");
  assert.equal(ftsQuery("   "), null);
});

// --- Project scoping ---

test("a search can be scoped to one project", () => {
  withSearch((config, search) => {
    appendPrompts(config, [
      { display: "variants here", project: "/work/alcs" },
      { display: "variants there", project: "/work/other" },
    ]);

    const result = search.search({ query: "variants", mode: "prompts", project: "/work/alcs" });

    assert.deepEqual(
      result.prompts.rows.map((row) => row.text),
      ["variants here"]
    );
  });
});

test("an unscoped search spans every project", () => {
  withSearch((config, search) => {
    appendPrompts(config, [
      { display: "variants here", project: "/work/alcs" },
      { display: "variants there", project: "/work/other" },
    ]);

    assert.equal(search.search({ query: "variants", mode: "prompts" }).prompts.rows.length, 2);
  });
});

test("facts are scoped by the project of the session that produced them", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    appendSessions(config, [
      {
        session_id: "316972f2-1111-2222-3333-444455556666",
        transcript: "/t/316972f2.jsonl",
        cwd: "/work/alcs",
        started: "2026-05-12T04:29:00Z",
      },
    ]);

    assert.equal(
      search.search({ query: "variants", mode: "facts", project: "/work/alcs" }).facts.rows.length,
      2
    );
    assert.equal(
      search.search({ query: "variants", mode: "facts", project: "/work/other" }).facts.rows.length,
      0
    );
  });
});

// --- Quarantined sessions ---

test("a quarantined session can be surfaced on request", () => {
  withSearch((config, search) => {
    writeFileSync(
      config.statePath,
      JSON.stringify({
        version: 1,
        processed: {},
        quarantined: {
          "14f63e34-0576-408d-b1ed-1c85e704c1f3": {
            ts: "2026-08-28T10:00:00Z",
            attempts: 3,
            error: "model returned no parsable facts",
          },
        },
      })
    );
    appendSessions(config, [
      {
        session_id: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
        transcript: "/t/14f63e34.jsonl",
        cwd: "/work/alcs",
        started: "2026-08-28T04:29:00Z",
      },
    ]);
    search.refresh();

    const rows = search.quarantined();

    assert.equal(rows.length, 1);
    assert.deepEqual(
      { ...rows[0] },
      {
        sessionId: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
        ts: "2026-08-28T10:00:00Z",
        attempts: 3,
        error: "model returned no parsable facts",
        project: "/work/alcs",
        transcriptPath: "/t/14f63e34.jsonl",
      }
    );
  });
});

test("nothing quarantined surfaces as an empty list, not an error", () => {
  withSearch((_config, search) => {
    assert.deepEqual(search.quarantined(), []);
  });
});

// --- Smoke queries ---

test("smoke queries run and assert non-empty results", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeSmokeQueries(config, [
      { query: "variants", mode: "facts", expectTopic: "broadcast_variants" },
      { query: "dynamodb", mode: "facts" },
    ]);

    const report = search.smoke();

    assert.equal(report.passed, true);
    assert.equal(report.results.length, 2);
    assert.ok(report.results.every((result) => result.rows > 0 && result.passed));
  });
});

test("a smoke run is logged under its own source, not as someone asking", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeSmokeQueries(config, [{ query: "variants", mode: "facts" }]);

    search.smoke();

    assert.deepEqual(
      logLines(config).map((line) => line.source),
      ["smoke"]
    );
  });
});

test("a smoke query that returns nothing fails the run", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeSmokeQueries(config, [{ query: "kinesis", mode: "facts" }]);

    const report = search.smoke();

    assert.equal(report.passed, false);
    assert.equal(report.results[0].reason, "no rows");
  });
});

test("a smoke query whose named topic does not come back fails the run", () => {
  withSearch((config, search) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeSmokeQueries(config, [{ query: "variants", mode: "facts", expectTopic: "alarm_tuning" }]);

    const report = search.smoke();

    assert.equal(report.passed, false);
    assert.match(report.results[0].reason, /alarm_tuning/);
  });
});

test("a missing smoke query file fails rather than passing silently", () => {
  withSearch((_config, search) => {
    const report = search.smoke();

    assert.equal(report.passed, false);
    assert.match(report.reason, /no smoke queries/i);
  });
});

test("smoke queries live with the corpus, not in this repository", () => {
  const config = tempCorpus();
  assert.ok(config.smokeQueriesPath.startsWith(config.corpusDir));
  assert.equal(existsSync(join(REPO_ROOT, "smoke-queries.json")), false);
});

function writeSmokeQueries(config, queries) {
  writeFileSync(config.smokeQueriesPath, JSON.stringify({ queries }, null, 2));
}
