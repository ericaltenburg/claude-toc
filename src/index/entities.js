// The hard identifiers a fact mentions: tickets, code reviews, AWS accounts and ARNs, commit
// SHAs, URLs and file paths. They are found by pattern at index time, so the markdown never
// changes and the index stays derived from it. ADR 0020 has the patterns' reasons and their
// measured precision. Only a rebuild re-reads facts that are already indexed, so a change to
// any pattern here needs a SCHEMA_VERSION bump.

// Prefixes that are ticket-shaped (letters, a dash, three or more digits) but name a standard,
// a status code or a document rather than a ticket. CR has its own kind.
const NOT_A_TICKET = new Set(["SHA", "ISO", "RFC", "AES", "RSA", "HTTP", "ADR", "CR"]);

const ARN = /\barn:aws[a-z-]*:[a-z0-9-]+:[a-z0-9-]*:(?:\d{12})?:[^\s<>"'`,;]+/g;
const URL_WITH_A_SCHEME = /\bhttps?:\/\/[\w-][^\s<>"'`]*/g;
const URL_WITHOUT_ONE = /(?<![\w.@/-])(?:[a-z0-9-]+\.)+(?:com|dev|net|org|io|aws)\/[^\s<>"'`]*/g;
const SCHEME = /^https?:\/\//;
const CR = /\bCR-\d{6,}\b/gi;
// The prefix ends in a letter, so EC2-2023 or S3-123 is not a ticket.
const TICKET = /\b[A-Z][A-Z0-9]*[A-Z]-\d{3,}\b/g;
const ACCOUNT = /\b\d{12}\b/g;
// Seven characters is git's short SHA. Exactly eight is left out: in this corpus eight hex
// characters are a session id's prefix, a job id or a task id far more often than a commit.
// Hex touching a dash is part of a UUID, a host name or a resource id.
const SHA = /(?<![\w-])(?:[0-9a-f]{7}|[0-9a-f]{9,40})(?![\w-])/g;
const A_LETTER_AND_A_DIGIT = /^(?=.*[a-f])(?=.*\d)/;

const SEGMENT = String.raw`[\w.@+-]+`;
const SOURCE_DIRECTORY = "(?:src|test|tests|lib|bin|docs|scripts|hooks)";
const PATH = new RegExp(
  // A path starts a word: `)/close` and `}/types` are code, not paths.
  String.raw`(?<![^\s(\[{'"\x60=:,])` +
    "(?:" +
    [
      String.raw`(?:~|\.{1,2})?/${SEGMENT}(?:/${SEGMENT})+/?`,
      String.raw`${SEGMENT}(?:/${SEGMENT})+\.[a-z][a-z0-9]{1,5}\b`,
      String.raw`${SOURCE_DIRECTORY}(?:/${SEGMENT}){2,}/?`,
      String.raw`${SOURCE_DIRECTORY}/${SEGMENT}/`,
    ].join("|") +
    ")",
  "g"
);
// i3.xlarge/r5.large has a slash and an extension, and is two instance types. AGENTS.md/CLAUDE.md
// is two files, since a directory is not named like a file.
const INSTANCE_TYPE = /^[a-z]+\d+[a-z]*\.(?:nano|micro|small|medium|\d*x?large|metal)$/;
const FILE_NAME = /^[\w-]+\.[a-z][a-z0-9]{1,5}$/;
// .../coverage/index.html has its start left out, and /api/user/{id}/followers stops at its
// placeholder. Neither is a path any lookup would spell.
const ELIDED = "...";
const PLACEHOLDER = /^[{$<]/;

function isAPath(candidate, nextCharacter = "") {
  if (candidate.includes(ELIDED) || PLACEHOLDER.test(nextCharacter)) return false;
  const segments = candidate.split("/");
  if (segments.some((segment) => INSTANCE_TYPE.test(segment))) return false;
  return !segments.slice(0, -1).some((directory) => FILE_NAME.test(directory));
}

const TRAILING_PUNCTUATION = /[.,;:!?)\]}]+$/;

export function entitiesIn(text) {
  const found = new Map();
  const add = (kind, value) => {
    if (value) found.set(`${kind} ${value}`, { kind, value });
  };
  const line = String(text ?? "");

  // ARNs and URLs contain slashes, so paths are looked for in what is left once they are out.
  // Everything else is looked for in the whole line: a URL names the ticket it points at.
  const taken = (kind) => (span) => {
    add(kind, lookupForm(trimmed(span)));
    return " ";
  };
  const rest = line
    .replace(ARN, taken("arn"))
    .replace(URL_WITH_A_SCHEME, taken("url"))
    .replace(URL_WITHOUT_ONE, taken("url"));

  for (const cr of line.match(CR) ?? []) add("cr", cr.toUpperCase());
  for (const ticket of line.match(TICKET) ?? []) {
    if (!NOT_A_TICKET.has(ticket.slice(0, ticket.indexOf("-")))) add("ticket", ticket);
  }
  for (const account of line.match(ACCOUNT) ?? []) add("account", account);
  for (const sha of line.match(SHA) ?? []) {
    if (A_LETTER_AND_A_DIGIT.test(sha)) add("sha", sha);
  }
  for (const { 0: path, index } of rest.matchAll(PATH)) {
    if (isAPath(path, rest[index + path.length])) add("path", lookupForm(trimmed(path)));
  }

  return [...found.values()];
}

// The form a value is stored and looked up in. Case is left alone because the lookup ignores
// it. A URL loses its scheme, and a URL or path its trailing slash, so https://w/x/ and w/x
// are the same entity whichever way a fact or a search spells it.
export function lookupForm(value) {
  const trimmedValue = String(value ?? "").trim();
  return trimmedValue.replace(SCHEME, "").replace(/\/+$/, "") || trimmedValue;
}

function trimmed(span) {
  return span.replace(TRAILING_PUNCTUATION, "");
}
