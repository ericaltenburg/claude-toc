import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";

import { openIndex, SCHEMA_VERSION } from "../src/search-index.js";
import { createStateStore } from "../src/state.js";
import {
  AFTERNOON_ON_27_AUGUST_IN_NEW_YORK,
  LATE_ON_26_AUGUST_IN_NEW_YORK,
  appendPrompts,
  appendSessions,
  promptRecord,
  tempCorpus,
  topicPath,
  writeTopic,
} from "./support/corpus.js";

const NY = "America/New_York";

const plain = (row) => (row ? { ...row } : row);

function indexOf(config) {
  return openIndex(config, { timeZone: NY });
}

function withCorpus(run) {
  const config = tempCorpus();
  const index = indexOf(config);
  try {
    return run(config, index);
  } finally {
    index.close();
  }
}

const FACTS = {
  Context: [
    "- Variants are keyed by show id [session:316972f2, 2026-05-12]",
    "- Project uses the Brazil build system [session:316972f2, 2026-05-12]",
  ],
  Decisions: ["- Will store variants in DynamoDB [session:316972f2, 2026-05-12]"],
};

test("indexes every topic file and every fact in it", () => {
  withCorpus((config, index) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });

    index.refresh();

    assert.deepEqual(
      index.db.prepare("select id from topics order by id").all().map((r) => r.id),
      ["alarm_tuning", "broadcast_variants"]
    );
    assert.equal(index.db.prepare("select count(*) c from facts").get().c, 4);
  });
});

test("stores each fact with its topic, section, session and date", () => {
  withCorpus((config, index) => {
    writeTopic(config, "broadcast_variants", FACTS);

    index.refresh();

    const fact = index.db
      .prepare("select topic, section, text, session, date from facts where section = 'Decisions'")
      .get();
    assert.deepEqual(plain(fact), {
      topic: "broadcast_variants",
      section: "Decisions",
      text: "Will store variants in DynamoDB",
      session: "316972f2",
      date: "2026-05-12",
    });
  });
});

test("indexes a fact from the older date-only format with a null session", () => {
  withCorpus((config, index) => {
    writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });

    index.refresh();

    const fact = index.db.prepare("select text, session, date from facts").get();
    assert.deepEqual(plain(fact), {
      text: "Catch-all alarm is noisy",
      session: null,
      date: "2026-04-24",
    });
  });
});

test("retains a fact matching neither format with a null date rather than dropping it", () => {
  withCorpus((config, index) => {
    writeTopic(config, "alarm_tuning", {
      Context: ["- Alarm fired 07:25-08:03 UTC only, cause unknown"],
    });

    index.refresh();

    const fact = index.db.prepare("select text, session, date from facts").get();
    assert.deepEqual(plain(fact), {
      text: "Alarm fired 07:25-08:03 UTC only, cause unknown",
      session: null,
      date: null,
    });
  });
});

test("carries a topic's summary and keywords over from the table of contents", () => {
  withCorpus((config, index) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeToc(config, {
      broadcast_variants: {
        keywords: ["broadcast", "variants"],
        summary: "How variants are stored",
      },
    });

    index.refresh();

    const topic = index.db.prepare("select summary, keywords from topics").get();
    assert.equal(topic.summary, "How variants are stored");
    assert.equal(topic.keywords, "broadcast variants");
  });
});

test("indexes a topic file that the table of contents does not mention", () => {
  withCorpus((config, index) => {
    writeTopic(config, "orphan_topic", FACTS);

    index.refresh();

    assert.equal(index.db.prepare("select count(*) c from topics").get().c, 1);
  });
});

test("ignores a merged topic tombstone", () => {
  withCorpus((config, index) => {
    writeTopic(config, "loser.merged", FACTS);
    writeTopic(config, "winner", FACTS);

    index.refresh();

    assert.deepEqual(
      index.db.prepare("select id from topics").all().map((r) => r.id),
      ["winner"]
    );
  });
});

test("indexes every prompt in the log with its local date and time", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [
      { display: "first prompt", timestamp: LATE_ON_26_AUGUST_IN_NEW_YORK },
      { display: "/toc-search variants", timestamp: AFTERNOON_ON_27_AUGUST_IN_NEW_YORK },
    ]);

    index.refresh();

    const prompts = index.db
      .prepare("select text, local_date, local_time, is_command, project, session from prompts order by ts")
      .all();
    assert.equal(prompts.length, 2);
    assert.deepEqual(plain(prompts[0]), {
      text: "first prompt",
      local_date: "2026-08-26",
      local_time: "23:30:00",
      is_command: 0,
      project: "/some/project",
      session: "4cc461d6-2d88-4426-966c-ba2081ca75bb",
    });
    assert.equal(prompts[1].local_date, "2026-08-27");
    assert.equal(prompts[1].is_command, 1);
  });
});

test("indexes logged sessions with their transcript and project", () => {
  withCorpus((config, index) => {
    appendSessions(config, [
      {
        session_id: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
        transcript: "/transcripts/14f63e34.jsonl",
        cwd: "/some/project",
        started: "2026-04-24T04:29:00Z",
      },
    ]);

    index.refresh();

    assert.deepEqual(
      plain(index.db.prepare("select session_id, transcript_path, project, started_at from sessions").get()),
      {
        session_id: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
        transcript_path: "/transcripts/14f63e34.jsonl",
        project: "/some/project",
        started_at: "2026-04-24T04:29:00Z",
      }
    );
  });
});

test("finds a fact through the inflections of a query term", () => {
  withCorpus((config, index) => {
    writeTopic(config, "broadcast_variants", {
      Context: ["- The poller consolidates pipelines nightly [2026-05-12]"],
    });

    index.refresh();

    const hits = index.db
      .prepare("select f.text from facts_fts join facts f on f.id = facts_fts.rowid where facts_fts match ?")
      .all("consolidate");
    assert.equal(hits.length, 1);
  });
});

test("a three-letter query does not match the inside of a url", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [{ display: "see https://code.amazon.com/packages/Foo for the model" }]);

    index.refresh();

    const matches = (query) =>
      index.db.prepare("select count(*) c from prompts_fts where prompts_fts match ?").get(query).c;
    assert.equal(matches("tps"), 0);
    assert.equal(matches("ht"), 0);
    assert.equal(matches("amazon"), 1);
  });
});

test("reparses nothing when no topic file has changed", () => {
  withCorpus((config, index) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
    index.refresh();

    const second = index.refresh();

    assert.equal(second.topicsParsed, 0);
    assert.equal(index.db.prepare("select count(*) c from facts").get().c, 4);
  });
});

test("reparses only the topic file whose modification time changed", () => {
  withCorpus((config, index) => {
    writeTopic(config, "broadcast_variants", FACTS);
    writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
    index.refresh();

    touch(config, "alarm_tuning");
    const second = index.refresh();

    assert.equal(second.topicsParsed, 1);
    assert.equal(index.db.prepare("select count(*) c from facts").get().c, 4);
  });
});

test("reparses a topic file whose size changed but whose modification time did not", () => {
  withCorpus((config, index) => {
    writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
    index.refresh();
    const { mtime } = statSync(topicPath(config, "alarm_tuning"));

    writeTopic(config, "alarm_tuning", {
      Context: ["- Catch-all alarm is noisy [2026-04-24]", "- And it pages at night [2026-04-25]"],
    });
    utimesSync(topicPath(config, "alarm_tuning"), mtime, mtime);
    const second = index.refresh();

    assert.equal(second.topicsParsed, 1);
    assert.equal(index.db.prepare("select count(*) c from facts").get().c, 2);
  });
});

test("picks up a fact hand-edited in a topic file", () => {
  withCorpus((config, index) => {
    writeTopic(config, "alarm_tuning", { Context: ["- Threshold is 10 [2026-04-24]"] });
    index.refresh();

    writeTopic(config, "alarm_tuning", { Context: ["- Threshold is 25, corrected [2026-04-24]"] });
    touch(config, "alarm_tuning");
    index.refresh();

    assert.deepEqual(
      index.db.prepare("select text from facts").all().map((r) => r.text),
      ["Threshold is 25, corrected"]
    );
    assert.equal(
      index.db.prepare("select count(*) c from facts_fts where facts_fts match 'threshold'").get().c,
      1
    );
  });
});

test("drops the facts of a topic file that has been deleted", () => {
  withCorpus((config, index) => {
    writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
    index.refresh();

    rmSync(topicPath(config, "alarm_tuning"));
    index.refresh();

    assert.equal(index.db.prepare("select count(*) c from topics").get().c, 0);
    assert.equal(index.db.prepare("select count(*) c from facts").get().c, 0);
    assert.equal(index.db.prepare("select count(*) c from facts_fts").get().c, 0);
  });
});

test("reads only the prompts written past the recorded offset", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [{ display: "first prompt" }]);
    index.refresh();

    assert.equal(index.refresh().promptsIndexed, 0);

    appendPrompts(config, [{ display: "second prompt" }]);
    const third = index.refresh();

    assert.equal(third.promptsIndexed, 1);
    assert.equal(index.db.prepare("select count(*) c from prompts").get().c, 2);
  });
});

test("leaves a half-written last line for the next refresh", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [{ display: "first prompt" }]);
    const partial = JSON.stringify(promptRecord({ display: "second prompt" }));
    appendFileSync(config.promptLog, partial.slice(0, 20));
    index.refresh();

    assert.equal(index.db.prepare("select count(*) c from prompts").get().c, 1);

    appendFileSync(config.promptLog, `${partial.slice(20)}\n`);
    index.refresh();

    assert.deepEqual(
      index.db.prepare("select text from prompts order by id").all().map((r) => r.text),
      ["first prompt", "second prompt"]
    );
  });
});

test("skips a malformed prompt log line without aborting the refresh", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [
      { display: "first prompt" },
      "{ truncated json",
      { display: "third prompt" },
    ]);

    index.refresh();

    assert.deepEqual(
      index.db.prepare("select text from prompts order by id").all().map((r) => r.text),
      ["first prompt", "third prompt"]
    );
  });
});

test("re-reads the whole prompt log when it has been truncated", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [{ display: "first prompt" }, { display: "second prompt" }]);
    index.refresh();

    writeFileSync(config.promptLog, "");
    appendPrompts(config, [{ display: "only prompt" }]);
    index.refresh();

    assert.deepEqual(
      index.db.prepare("select text from prompts").all().map((r) => r.text),
      ["only prompt"]
    );
  });
});

test("re-reads the whole prompt log when it has been emptied and then refilled", () => {
  withCorpus((config, index) => {
    appendPrompts(config, [{ display: "first prompt" }, { display: "second prompt" }]);
    index.refresh();

    writeFileSync(config.promptLog, "");
    index.refresh();
    assert.equal(index.db.prepare("select count(*) c from prompts").get().c, 0);

    appendPrompts(config, [
      { display: "one prompt" },
      { display: "two prompt" },
      { display: "three prompt" },
    ]);
    index.refresh();

    assert.deepEqual(
      index.db.prepare("select text from prompts order by id").all().map((r) => r.text),
      ["one prompt", "two prompt", "three prompt"]
    );
  });
});

test("records when a session was extracted and which topic it fed", () => {
  withCorpus((config, index) => {
    appendSessions(config, [
      {
        session_id: "14f63e34-0576-408d-b1ed-1c85e704c1f3",
        transcript: "/transcripts/14f63e34.jsonl",
        cwd: "/some/project",
        started: "2026-04-24T04:29:00Z",
      },
    ]);
    createStateStore(config).recordExtraction("14f63e34-0576-408d-b1ed-1c85e704c1f3", {
      result: { topic: { id: "broadcast_variants" } },
    });

    index.refresh();

    const session = index.db.prepare("select topic, extracted_at from sessions").get();
    assert.equal(session.topic, "broadcast_variants");
    assert.match(session.extracted_at, /^\d{4}-\d{2}-\d{2}T/);
  });
});

test("rebuilds from scratch when the stored schema version does not match", () => {
  const config = tempCorpus();
  writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
  appendPrompts(config, [{ display: "first prompt" }]);

  const first = indexOf(config);
  first.refresh();
  first.db.prepare("update meta set value = '0' where key = 'schema_version'").run();
  first.close();

  const second = indexOf(config);
  try {
    const stats = second.refresh();

    assert.equal(stats.rebuilt, true);
    assert.equal(second.db.prepare("select count(*) c from facts").get().c, 1);
    assert.equal(second.db.prepare("select count(*) c from prompts").get().c, 1);
    assert.equal(
      second.db.prepare("select value from meta where key = 'schema_version'").get().value,
      String(SCHEMA_VERSION)
    );
  } finally {
    second.close();
  }
});

test("keeps the index across openings without rebuilding it", () => {
  const config = tempCorpus();
  writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });

  const first = indexOf(config);
  first.refresh();
  first.close();

  const second = indexOf(config);
  try {
    const stats = second.refresh();

    assert.equal(stats.rebuilt, false);
    assert.equal(stats.topicsParsed, 0);
    assert.equal(second.db.prepare("select count(*) c from facts").get().c, 1);
  } finally {
    second.close();
  }
});

test("rebuilds from scratch when the index file is not a database at all", () => {
  const config = tempCorpus();
  writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
  writeFileSync(config.indexPath, "this is not a database");

  const index = indexOf(config);
  try {
    const stats = index.refresh();

    assert.equal(stats.rebuilt, true);
    assert.equal(index.db.prepare("select count(*) c from facts").get().c, 1);
  } finally {
    index.close();
  }
});

test("deleting the index and rebuilding it produces an equivalent index", () => {
  const config = tempCorpus();
  writeTopic(config, "broadcast_variants", FACTS);
  writeTopic(config, "alarm_tuning", { Context: ["- Catch-all alarm is noisy [2026-04-24]"] });
  appendPrompts(config, [{ display: "first prompt" }, { display: "/toc-search variants" }]);
  appendSessions(config, [
    { session_id: "14f63e34", transcript: "/t/14f63e34.jsonl", cwd: "/p", started: "2026-04-24" },
  ]);

  const first = indexOf(config);
  first.refresh();
  const before = dump(first);
  first.close();

  rmSync(config.indexPath);
  const second = indexOf(config);
  try {
    second.refresh();
    assert.deepEqual(dump(second), before);
  } finally {
    second.close();
  }
});

function dump(index) {
  const all = (sql) => index.db.prepare(sql).all().map(plain);
  return {
    topics: all("select id, summary, keywords from topics order by id"),
    facts: all("select topic, section, text, session, date, line from facts order by topic, line"),
    prompts: all("select ts, local_date, local_time, session, project, text, is_command from prompts order by ts"),
    sessions: all("select session_id, transcript_path, project, started_at from sessions order by session_id"),
    factHits: all("select rowid from facts_fts where facts_fts match 'variants' order by rowid").length,
    promptHits: all("select rowid from prompts_fts where prompts_fts match 'prompt' order by rowid").length,
  };
}

function touch(config, id) {
  const when = new Date(Date.now() + 2000);
  utimesSync(topicPath(config, id), when, when);
}

function writeToc(config, topics) {
  writeFileSync(
    config.tocPath,
    JSON.stringify(
      {
        version: 2,
        topics: Object.fromEntries(
          Object.entries(topics).map(([id, topic]) => [
            id,
            { file: `topics/${id}.md`, entries: 0, last_active: "2026-05-12T00:00:00Z", ...topic },
          ])
        ),
      },
      null,
      2
    )
  );
}
