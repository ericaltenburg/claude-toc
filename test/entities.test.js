import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";

import { entitiesIn, lookupForm } from "../src/index/entities.js";
import { openIndex } from "../src/index/open.js";
import { createSearch } from "../src/search/search.js";
import {
  appendPrompts,
  corpusEnv,
  REPO_ROOT,
  tempCorpus,
  topicPath,
  writeTopic,
} from "./support/corpus.js";

const NY = "America/New_York";

// --- Finding entities in a fact ---

const valuesOf = (text, kind) =>
  entitiesIn(text)
    .filter((entity) => entity.kind === kind)
    .map((entity) => entity.value);

test("each kind of identifier is found in a fact line", () => {
  const cases = [
    ["ticket", "LIVE-53452 was split into two CRs", ["LIVE-53452"]],
    ["ticket", "MCM-155302452 is the parent change", ["MCM-155302452"]],
    ["cr", "raised CR-294186991 for review", ["CR-294186991"]],
    ["account", "Gamma account is 852857243702, Beta is 136113532390", ["852857243702", "136113532390"]],
    [
      "arn",
      "role arn:aws:iam::043780567021:role/AlohaQueryRole-prod was trusted",
      ["arn:aws:iam::043780567021:role/AlohaQueryRole-prod"],
    ],
    ["arn", "topic arn:aws:sns:eu-west-1:657037413469:DataDeletion.", ["arn:aws:sns:eu-west-1:657037413469:DataDeletion"]],
    ["sha", "amended into commit 4fbfe0a on mainline", ["4fbfe0a"]],
    ["sha", "the full hash e41c2dc9a0b1f2e3d4c5b6a79880716253443526", ["e41c2dc9a0b1f2e3d4c5b6a79880716253443526"]],
    ["url", "see https://w.amazon.com/bin/view/Runbook/, then", ["w.amazon.com/bin/view/Runbook"]],
    ["url", "documented at w.amazon.com/bin/view/Runbook", ["w.amazon.com/bin/view/Runbook"]],
    ["path", "the fix is in lib/config-resources.ts:463", ["lib/config-resources.ts"]],
    ["path", "written to ~/.claude/settings.json.", ["~/.claude/settings.json"]],
    ["path", "scripts live under /Volumes/workplace/cds-cicd-v2/", ["/Volumes/workplace/cds-cicd-v2"]],
    ["path", "only docs/adr/0013 changed", ["docs/adr/0013"]],
  ];

  for (const [kind, text, expected] of cases) {
    assert.deepEqual(valuesOf(text, kind), expected, text);
  }
});

test("a ticket or CR id inside a URL is found as well as the URL", () => {
  const entities = entitiesIn("reviewed at https://code.amazon.com/reviews/CR-295954845");

  assert.deepEqual(
    entities.map(({ kind, value }) => `${kind} ${value}`).sort(),
    ["cr CR-295954845", "url code.amazon.com/reviews/CR-295954845"]
  );
});

test("an account inside an ARN is found as an account too", () => {
  assert.deepEqual(valuesOf("user arn:aws:iam::907112582401:user/Shop", "account"), [
    "907112582401",
  ]);
});

test("a CR id is its own kind, not a ticket, and is stored upper-case", () => {
  assert.deepEqual(valuesOf("cr-294186991 again", "cr"), ["CR-294186991"]);
  assert.deepEqual(valuesOf("CR-294186991 again", "ticket"), []);
});

test("look-alikes of a ticket are not tickets", () => {
  for (const text of [
    "UTF-8 encoded",
    "verified with SHA-256",
    "timestamps are ISO-8601",
    "the HTTP-400 outage",
    "per ADR-0017",
    "deployed to us-east-1 and eu-south-2",
    "the EC2-2023 image",
    "pre-2024 guidance",
    "vpc-01234567 and sg-0123456",
    "Sev-2 and COVID-19",
  ]) {
    assert.deepEqual(valuesOf(text, "ticket"), [], text);
  }
});

test("look-alikes of a commit SHA are not SHAs", () => {
  for (const text of [
    "the deadbeef sentinel and a facade",
    "1234567 rows and 20260512",
    "session a478c127 was quarantined",
    "request 792c1426-7489-4a57-859c-f8b86df9fafd failed",
    "host dev-dsk-ealten-2a-46775444",
    "mask 0x7fffffff",
  ]) {
    assert.deepEqual(valuesOf(text, "sha"), [], text);
  }
});

test("look-alikes of an account are not accounts", () => {
  for (const text of ["deployment 1138256102624 ran", "ids 12345678901 and 1774279096774"]) {
    assert.deepEqual(valuesOf(text, "account"), [], text);
  }
});

test("look-alikes of a path are not paths", () => {
  for (const text of [
    "read/write access and and/or",
    "i3.xlarge/r5.large instances",
    "mirroring spend.js/spend.test.js",
    "missing tests/alarms work",
    "ownsHttpClient/Closeable/close()",
    "apis/${ApiId}/types/Query/fields/*",
    "GET /api/user/{accountId}/followers",
    "at .../coverage/index.html",
    "e.g./i.e. abbreviations",
    "a templated arn:aws:iam::{account}:role/Name",
  ]) {
    assert.deepEqual(valuesOf(text, "path"), [], text);
  }
});

test("a URL is not also a path, and a templated ARN is not an ARN", () => {
  assert.deepEqual(valuesOf("see https://docs.aws.amazon.com/flink/metrics.html", "path"), []);
  assert.deepEqual(valuesOf("arn:aws:iam::{account}:role/Name", "arn"), []);
});

test("an identifier mentioned twice in a fact is one entity", () => {
  assert.equal(entitiesIn("LIVE-53452 then LIVE-53452 again").length, 1);
});

test("a fact with no identifier has no entities", () => {
  assert.deepEqual(entitiesIn("Variants are keyed by show id"), []);
  assert.deepEqual(entitiesIn(""), []);
});

test("the lookup form drops a URL's scheme and a trailing slash", () => {
  assert.equal(lookupForm(" https://w.amazon.com/bin/view/Runbook/ "), "w.amazon.com/bin/view/Runbook");
  assert.equal(lookupForm("docs/agents/"), "docs/agents");
  assert.equal(lookupForm("live-53452"), "live-53452");
});

// --- The entities table ---

// The index hands out no connection (ADR 0017), so these read its tables through their own.
function withIndexAt(config, run) {
  const index = openIndex(config, { timeZone: NY });
  const db = new DatabaseSync(config.indexPath);
  try {
    return run(index, db);
  } finally {
    db.close();
    index.close();
  }
}

function withIndex(run) {
  const config = tempCorpus();
  return withIndexAt(config, (index, db) => run(config, index, db));
}

function entityRows(db) {
  return db
    .prepare(
      `select f.text as fact, e.kind as kind, e.value as value
         from entities e join facts f on f.id = e.fact_id order by e.kind, e.value`
    )
    .all()
    .map((row) => ({ ...row }));
}

function orphanedEntities(db) {
  return db
    .prepare("select count(*) c from entities where fact_id not in (select id from facts)")
    .get().c;
}

function touch(config, id) {
  const when = new Date(Date.now() + 2000);
  utimesSync(topicPath(config, id), when, when);
}

const TICKET_FACTS = {
  Context: [
    "- LIVE-53452 split the alarms out [session:316972f2, 2026-05-12]",
    "- Gamma account is 852857243702 [session:316972f2, 2026-05-12]",
  ],
  Decisions: ["- Raised CR-294186991 for LIVE-53452 [session:316972f2, 2026-05-12]"],
};

test("refresh records the identifiers each fact mentions", () => {
  withIndex((config, index, db) => {
    writeTopic(config, "alarm_tuning", TICKET_FACTS);

    index.refresh();

    assert.deepEqual(entityRows(db), [
      { fact: "Gamma account is 852857243702", kind: "account", value: "852857243702" },
      { fact: "Raised CR-294186991 for LIVE-53452", kind: "cr", value: "CR-294186991" },
      { fact: "LIVE-53452 split the alarms out", kind: "ticket", value: "LIVE-53452" },
      { fact: "Raised CR-294186991 for LIVE-53452", kind: "ticket", value: "LIVE-53452" },
    ]);
  });
});

test("a rewritten topic file keeps the entities of the facts it still has, and only those", () => {
  withIndex((config, index, db) => {
    writeTopic(config, "alarm_tuning", TICKET_FACTS);
    index.refresh();

    writeTopic(config, "alarm_tuning", {
      Context: ["- Gamma account is 852857243702 [session:316972f2, 2026-05-12]"],
    });
    touch(config, "alarm_tuning");
    index.refresh();

    assert.deepEqual(entityRows(db), [
      { fact: "Gamma account is 852857243702", kind: "account", value: "852857243702" },
    ]);
    assert.equal(orphanedEntities(db), 0);
  });
});

test("a deleted topic file takes its facts' entities with it", () => {
  withIndex((config, index, db) => {
    writeTopic(config, "alarm_tuning", TICKET_FACTS);
    writeTopic(config, "other_topic", { Context: ["- MCM-155302452 is the parent [2026-05-12]"] });
    index.refresh();

    rmSync(topicPath(config, "alarm_tuning"));
    index.refresh();

    assert.deepEqual(
      entityRows(db).map((row) => row.value),
      ["MCM-155302452"]
    );
    assert.equal(orphanedEntities(db), 0);
  });
});

test("an index built before the entities table is rebuilt from markdown on its own", () => {
  const config = tempCorpus();
  writeTopic(config, "alarm_tuning", TICKET_FACTS);
  const before = openIndex(config, { timeZone: NY });
  before.refresh();
  before.close();

  const old = new DatabaseSync(config.indexPath);
  old.exec("drop table entities");
  old.exec("update meta set value = '1' where key = 'schema_version'");
  old.close();

  withIndexAt(config, (index, db) => {
    assert.equal(index.refresh().rebuilt, true);
    assert.equal(entityRows(db).length, 4);
  });
});

// --- Searching by entity ---

function withSearch(run) {
  const config = tempCorpus();
  const search = createSearch(config, { timeZone: NY });
  try {
    return run(config, search);
  } finally {
    search.close();
  }
}

function twoTopicsAboutOneTicket(config) {
  writeTopic(config, "alarm_tuning", {
    Context: [
      "- LIVE-53452 split the alarms out [session:316972f2, 2026-05-12]",
      "- LIVE-534521 is a different ticket [session:316972f2, 2026-05-12]",
      "- The alarms page at night [session:316972f2, 2026-05-12]",
    ],
  });
  writeTopic(config, "pipeline_consolidation", {
    Decisions: [
      "- Ship LIVE-53452 behind the bake step, commit 4fbfe0a [session:316972f2, 2026-05-13]",
      "- Docs at w.amazon.com/bin/view/Runbook [session:316972f2, 2026-05-13]",
    ],
  });
}

const textsOf = (section) => section.rows.map((row) => row.text);

test("an entity finds every fact that mentions it, in every topic, and no other", () => {
  withSearch((config, search) => {
    twoTopicsAboutOneTicket(config);

    const result = search.search({ entity: "LIVE-53452", mode: "facts" });

    assert.deepEqual(textsOf(result.facts), [
      "Ship LIVE-53452 behind the bake step, commit 4fbfe0a",
      "LIVE-53452 split the alarms out",
    ]);
  });
});

test("an entity is matched without regard to case, and a URL with or without its scheme", () => {
  withSearch((config, search) => {
    twoTopicsAboutOneTicket(config);

    const found = (entity) => textsOf(search.search({ entity, mode: "facts" }).facts);

    assert.equal(found("live-53452").length, 2);
    assert.deepEqual(found("4FBFE0A"), ["Ship LIVE-53452 behind the bake step, commit 4fbfe0a"]);
    assert.deepEqual(found("https://w.amazon.com/bin/view/Runbook/"), [
      "Docs at w.amazon.com/bin/view/Runbook",
    ]);
  });
});

test("an entity narrows query terms and the other filters rather than replacing them", () => {
  withSearch((config, search) => {
    twoTopicsAboutOneTicket(config);

    const withTerms = search.search({ query: "alarms", entity: "LIVE-53452", mode: "facts" });
    const inOneTopic = search.search({
      entity: "LIVE-53452",
      topic: "pipeline_consolidation",
      mode: "facts",
    });

    assert.deepEqual(textsOf(withTerms.facts), ["LIVE-53452 split the alarms out"]);
    assert.deepEqual(textsOf(inOneTopic.facts), [
      "Ship LIVE-53452 behind the bake step, commit 4fbfe0a",
    ]);
  });
});

test("an entity search returns no prompts rather than every prompt", () => {
  withSearch((config, search) => {
    twoTopicsAboutOneTicket(config);
    appendPrompts(config, [{ display: "what happened on LIVE-53452?" }, { display: "unrelated" }]);

    const result = search.search({ entity: "LIVE-53452" });

    assert.equal(result.facts.rows.length, 2);
    assert.equal(result.prompts, null);
  });
});

// The marker's session is SHA-shaped here, so it would be found as one if refresh read the
// line rather than the fact's text.
test("a superseded fact's entities come from its text, not its marker", () => {
  withSearch((config, search) => {
    writeTopic(config, "alarm_tuning", {
      Context: [
        "- LIVE-53452 alarms at 5% [session:316972f2, 2026-05-12] [superseded:ef56ab78a, 2026-09-20]",
        "- LIVE-53452 alarms at 2% [session:ef56ab78, 2026-09-20]",
      ],
    });

    const found = search.search({ entity: "LIVE-53452", mode: "facts" }).facts.rows;

    assert.deepEqual(
      found.map((row) => [row.text, row.superseded_date]),
      [
        ["LIVE-53452 alarms at 2%", null],
        ["LIVE-53452 alarms at 5%", "2026-09-20"],
      ]
    );
    assert.equal(search.search({ entity: "ef56ab78a", mode: "facts" }).facts.rows.length, 0);
  });
});

test("the search log records the entity searched for", () => {
  withSearch((config, search) => {
    twoTopicsAboutOneTicket(config);

    search.search({ entity: "LIVE-53452" });

    const line = JSON.parse(readFileSync(config.searchLogPath, "utf-8").trim());
    assert.equal(line.entity, "LIVE-53452");
    assert.equal(line.rows, 2);
  });
});

// --- From the command line ---

function runCli(config, args) {
  const env = corpusEnv(config);
  delete env.CLAUDE_PROJECT_DIR;
  return spawnSync(join(REPO_ROOT, "bin", "toc-search"), args, {
    encoding: "utf-8",
    timeout: 20_000,
    env,
  });
}

test("--entity on its own is a search, and its results carry the attribution note", () => {
  const config = tempCorpus();
  twoTopicsAboutOneTicket(config);

  const result = runCli(config, ["--entity", "live-53452"]);

  assert.equal(result.status, 0);
  assert.equal(result.stderr, "");
  assert.match(result.stdout, /^FACTS {2}2 of 2$/m);
  assert.equal(result.stdout.includes("LIVE-534521"), false);
  assert.equal(result.stdout.includes("PROMPTS"), false);
  assert.match(result.stdout, /dated evidence, not current truth/);
});

test("--json fact rows carry the entities each fact mentions", () => {
  const config = tempCorpus();
  twoTopicsAboutOneTicket(config);

  const parsed = JSON.parse(runCli(config, ["--json", "--entity", "4fbfe0a"]).stdout);

  assert.deepEqual(parsed.facts.rows[0].entities, [
    { kind: "ticket", value: "LIVE-53452" },
    { kind: "sha", value: "4fbfe0a" },
  ]);
  assert.match(parsed.attribution, /dated evidence, not current truth/);
});
