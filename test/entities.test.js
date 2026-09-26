import { test } from "node:test";
import assert from "node:assert/strict";
import { rmSync, utimesSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";

import { entitiesIn, lookupForm } from "../src/index/entities.js";
import { openIndex } from "../src/index/open.js";
import { tempCorpus, topicPath, writeTopic } from "./support/corpus.js";

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
