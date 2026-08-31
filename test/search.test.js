import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, writeFileSync, existsSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createSearch, ftsQuery, parseArgs } from "../src/search.js";
import { createStateStore } from "../src/state.js";
import {
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  LATE_ON_26_AUGUST_IN_NEW_YORK,
  appendPrompts,
  appendSessions,
  REPO_ROOT,
  tempCorpus,
  writeTopic,
} from "./support/corpus.js";

const NY = "America/New_York";

const FACT_WITHOUT_A_SESSION_ID = "- Catch-all alarm is noisy [2026-04-24]";

const FACTS = {
  Context: [
    "- Variants are keyed by show id [session:316972f2, 2026-05-12]",
    "- The poller consolidates pipelines nightly [session:316972f2, 2026-05-12]",
  ],
  Decisions: ["- Will store variants in DynamoDB [session:316972f2, 2026-05-12]"],
};

function withSearch(run, options = {}) {
  const config = tempCorpus();
  const search = createSearch(config, { timeZone: NY, ...options });
  try {
    return run(config, search);
  } finally {
    search.close();
  }
}

const TWO_PROJECTS = [
  { display: "variants here", project: "/work/alcs" },
  { display: "variants there", project: "/work/other" },
];

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

    const rankedByBm25ShorterFactFirst = result.facts.rows.map((row) => ({ ...row }));
    assert.deepEqual(
      rankedByBm25ShorterFactFirst,
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
    assert.equal(
      result.facts.rows.some((row) => row.text.includes("how do variants work")),
      false,
      "a prompt must never appear among the facts"
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

test("an overview reports how many topics matched, not how many it showed", () => {
  withSearch((config, search) => {
    for (let i = 0; i < 25; i++) {
      writeTopic(config, `topic_${i}`, { Context: [`- Variants matter here [2026-05-12]`] });
    }

    const result = search.search({ query: "variants", mode: "overview" });

    assert.equal(result.overview.rows.length, 20);
    assert.equal(result.overview.total, 25);
  });
});

test("an overview honours a smaller limit and still reports the total", () => {
  withSearch((config, search) => {
    for (let i = 0; i < 25; i++) {
      writeTopic(config, `topic_${i}`, { Context: [`- Variants matter here [2026-05-12]`] });
    }

    const result = search.search({ query: "variants", mode: "overview", limit: 5 });

    assert.equal(result.overview.rows.length, 5);
    assert.equal(result.overview.total, 25);
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
      { display: "wire up the retry", timestamp: LATE_ON_26_AUGUST_IN_NEW_YORK },
      { display: "now ship it", timestamp: AFTERNOON_ON_27_AUGUST_IN_NEW_YORK },
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

    const result = search.search({ query: "variants", mode: "facts" });

    assert.equal(result.facts.rows.length, 2, "search must refresh before it queries");
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

test("a sql drilldown Claude ran itself is not logged as someone asking", () => {
  withSearch((config, search) => {
    search.sql("select text from facts", [], { source: "automatic" });

    assert.equal(logLines(config)[0].source, "automatic");
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

test("the flags that govern automatic scoping parse", () => {
  assert.equal(parseArgs(["--source", "automatic", "variants"]).source, "automatic");
  assert.equal(parseArgs(["--all-projects", "variants"]).allProjects, true);
  assert.equal(parseArgs(["variants"]).allProjects, undefined);
  assert.throws(() => parseArgs(["--source", "guessed", "variants"]), /--source/);
  assert.throws(() => parseArgs(["--source"]), /--source/, "a flag with no value is not explicit");
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

test("a fact carrying no session id stays visible to its topic's project", () => {
  withSearch((config, search) => {
    writeTopic(config, "alarm_tuning", { Context: [FACT_WITHOUT_A_SESSION_ID] });
    writeTopic(config, "other_topic", { Context: ["- Alarm noise elsewhere [2026-04-24]"] });
    appendSessions(config, [
      {
        session_id: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
        transcript: "/t/14f63e34.jsonl",
        cwd: "/work/aldis",
        started: "2026-04-24T04:29:00Z",
      },
    ]);
    createStateStore(config).recordExtraction("14f63e34-0576-408d-b1ed-1c85e704c1f3", {
      result: { topic: { id: "alarm_tuning" } },
    });

    const scoped = search.search({ query: "alarm", mode: "facts", project: "/work/aldis" });

    assert.deepEqual(
      scoped.facts.rows.map((row) => row.topic),
      ["alarm_tuning"],
      "kept because its topic was fed by that project, and not put in every project"
    );
  });
});

// --- Automatic searches scope themselves ---

test("a search on Claude's own judgement is scoped to the current project unasked", () => {
  withSearch(
    (config, search) => {
      appendPrompts(config, TWO_PROJECTS);

      const result = search.search({ query: "variants", mode: "prompts", source: "automatic" });

      assert.deepEqual(
        result.prompts.rows.map((row) => row.text),
        ["variants here"],
        "scoping is the command's job, not something Claude has to remember"
      );
    },
    { currentProject: "/work/alcs" }
  );
});

test("a search the user asked for spans every project even from inside one", () => {
  withSearch(
    (config, search) => {
      appendPrompts(config, TWO_PROJECTS);

      const result = search.search({ query: "variants", mode: "prompts" });

      assert.equal(result.prompts.rows.length, 2, "cross-project questions are the typed ones");
    },
    { currentProject: "/work/alcs" }
  );
});

test("an automatic search keeps the project it was handed", () => {
  withSearch(
    (config, search) => {
      appendPrompts(config, TWO_PROJECTS);

      const result = search.search({
        query: "variants",
        mode: "prompts",
        source: "automatic",
        project: "/work/other",
      });

      assert.deepEqual(
        result.prompts.rows.map((row) => row.text),
        ["variants there"]
      );
    },
    { currentProject: "/work/alcs" }
  );
});

test("an automatic search can be widened past the current project on purpose", () => {
  withSearch(
    (config, search) => {
      appendPrompts(config, TWO_PROJECTS);

      const result = search.search({
        query: "variants",
        mode: "prompts",
        source: "automatic",
        allProjects: true,
      });

      assert.equal(result.prompts.rows.length, 2);
      assert.deepEqual(logLines(config)[0].project, undefined);
      assert.equal(logLines(config)[0].allProjects, true, "a widened search says so in the log");
    },
    { currentProject: "/work/alcs" }
  );
});

test("the log records the project an automatic search scoped itself to", () => {
  withSearch(
    (config, search) => {
      search.search({ query: "variants", source: "automatic" });

      assert.deepEqual(logLines(config)[0].project, "/work/alcs");
    },
    { currentProject: "/work/alcs" }
  );
});

test("a session started in a subdirectory still counts as this project", () => {
  withSearch(
    (config, search) => {
      appendPrompts(config, [
        { display: "variants in a subdirectory", project: "/work/alcs/src/poller" },
        { display: "variants next door", project: "/work/alcs-old" },
        { display: "variants further up", project: "/work" },
      ]);

      const result = search.search({ query: "variants", mode: "prompts", source: "automatic" });

      assert.deepEqual(
        result.prompts.rows.map((row) => row.text),
        ["variants in a subdirectory"],
        "under the project counts; a prefix sibling and the directory above it do not"
      );
    },
    { currentProject: "/work/alcs" }
  );
});

test("the project is matched through a symlink rather than by spelling", () => {
  const real = mkdtempSync(join(tmpdir(), "claude-toc-project-"));
  const linked = `${real}-link`;
  symlinkSync(real, linked);

  withSearch(
    (config, search) => {
      appendPrompts(config, [{ display: "variants under the real path", project: real }]);

      const result = search.search({ query: "variants", mode: "prompts", source: "automatic" });

      assert.equal(result.prompts.rows.length, 1, "the same directory by another name");
    },
    { currentProject: linked }
  );
});

test("a project given by hand also covers what is under it", () => {
  withSearch((config, search) => {
    appendPrompts(config, [
      { display: "variants in a subdirectory", project: "/work/alcs/src" },
      { display: "variants next door", project: "/work/other" },
    ]);

    const result = search.search({ query: "variants", mode: "prompts", project: "/work/alcs" });

    assert.deepEqual(
      result.prompts.rows.map((row) => row.text),
      ["variants in a subdirectory"]
    );
  });
});

test("a widened search is only logged as widened when there was scoping to undo", () => {
  withSearch(
    (config, search) => {
      search.search({ query: "variants", allProjects: true });

      assert.equal(
        logLines(config)[0].allProjects,
        undefined,
        "an explicit search was never scoped, so nothing was widened"
      );
    },
    { currentProject: "/work/alcs" }
  );
});

test("an automatic sql query is logged as unscoped, since nothing can bound it", () => {
  withSearch(
    (config, search) => {
      search.sql("select text from facts", [], { source: "automatic" });

      const line = logLines(config)[0];
      assert.equal(line.source, "automatic");
      assert.equal(line.allProjects, true);
      assert.equal(line.project, undefined);
    },
    { currentProject: "/work/alcs" }
  );
});

test("an unrecognised source is refused, so the log stays evidence", () => {
  withSearch((_config, search) => {
    assert.throws(() => search.search({ query: "variants", source: "guessed" }), /source/i);
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
      },
      "surfacing refreshes like any other read, so project and transcript are filled in"
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
