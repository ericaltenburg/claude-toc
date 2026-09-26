// The corpus's own format: how a topic file and the fact lines in it are written, and how
// they are read back. Both directions live here because they drifted apart when they lived in
// two modules: the topic store wrote a fact line and stripped its attribution with patterns of
// its own, the index parsed it with others, and a fact moved by a merge went back through the
// writer and was attributed a second time (#23). ADR 0017.
//
// A fact is one markdown list item under a section heading, ending with the session and date
// it came from:
//
//   - Project uses Brazil build system [session:316972f2, 2026-05-12]
//
// Older lines carry the date alone, `[2026-04-24]`, and a line carrying neither is still a
// fact, with no session and no date.
//
// A fact a later session superseded keeps its line and gains a second group after the first,
// naming the session and date that superseded it (ADR 0019):
//
//   - Batch size is 264,000 [session:316972f2, 2026-05-12] [superseded:ef56ab78, 2026-09-20]

export const SECTIONS = ["Context", "Decisions", "Gotchas", "Open"];

// A fact carries the first eight characters of its session id, so a fact matches a full
// session id as a prefix of it.
const SESSION_ID_LENGTH_ON_A_FACT = 8;
const NO_SESSION = "unknown";

const LIST_ITEM = /^-[ \t]+(.*)$/;
const HEADING = /^##[ \t]+(.+?)[ \t]*$/;

// The one pattern for the attribution a fact line ends with, in both its forms. Reading a
// fact's session and date and comparing two facts by their words alone both go through it, so
// what the writer appends and what the readers take off cannot disagree.
const ATTRIBUTED = /^(.*?)\s*\[(?:session:([^\s,\]]+),\s*)?(\d{4}-\d{2}-\d{2})\]$/;

// The marker is taken off before the attribution is read, so a line that had no attribution
// of its own can still be superseded.
const SUPERSEDED = /^(.*?)\s*\[superseded:([^\s,\]]+),\s*(\d{4}-\d{2}-\d{2})\]$/;

// --- Writing ---

export function factLine(text, sessionId, whenTheConversationHappened) {
  const date = whenTheConversationHappened ?? new Date().toISOString().slice(0, 10);
  return `- ${text} [session:${sessionOnAFact(sessionId)}, ${date}]\n`;
}

// The topic file with one fact marked superseded, or null when no current fact in that section
// says exactly that text. The line is found by what it says, not by its number, because facts
// appended since it was read have moved it. Everything already on the line stays as it was.
export function markSupersededIn(markdown, { section, text }, sessionId, date) {
  const target = parseTopic(markdown).find(
    (fact) => fact.section === section && fact.text === text && !fact.superseded
  );
  if (!target) return null;

  const lines = markdown.split("\n");
  lines[target.line - 1] += ` [superseded:${sessionOnAFact(sessionId)}, ${date}]`;
  return lines.join("\n");
}

function sessionOnAFact(sessionId) {
  return sessionId?.slice(0, SESSION_ID_LENGTH_ON_A_FACT) || NO_SESSION;
}

export function newTopicFile(id) {
  const headings = SECTIONS.map((section) => `## ${section}\n`).join("\n");
  return `# ${id.replace(/_/g, " ")}\n\n${headings}`;
}

export function newSection(section, line) {
  return `\n## ${section}\n\n${line}`;
}

// Where a section's facts sit in a topic file: its text, and the offset a new fact is
// inserted at, which is the end of the section.
export function sectionBlock(content, section) {
  const idx = content.indexOf(`## ${section}`);
  if (idx === -1) return null;
  const start = content.indexOf("\n", idx) + 1;
  const nextSection = content.indexOf("\n## ", start);
  const end = nextSection === -1 ? content.length : nextSection;
  return { text: content.slice(start, end), end };
}

// --- Reading ---

export function parseFactLine(line) {
  const item = LIST_ITEM.exec(line);
  if (!item) return null;

  const body = item[1].trim();
  const marker = SUPERSEDED.exec(body);
  return {
    ...attributed(marker ? marker[1] : body),
    superseded: marker ? { session: marker[2], date: marker[3] } : null,
  };
}

export function parseTopic(markdown) {
  const facts = [];
  let section = null;

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = HEADING.exec(line);
    if (heading) {
      section = heading[1];
      continue;
    }
    if (!section) continue;

    const fact = parseFactLine(line);
    if (fact) facts.push({ ...fact, section, line: i + 1 });
  }

  return facts;
}

// Every fact line in a stretch of a topic file, as written and as said. `line` is what a merge
// carries to another topic untouched, attribution and marker and all, and `text` is what dedup
// compares: two facts are compared by what they say, never by where they came from.
export function factLinesIn(markdown) {
  return markdown.split("\n").flatMap((line) => {
    const fact = parseFactLine(line);
    return fact ? [{ line: `${line}\n`, text: fact.text, superseded: fact.superseded }] : [];
  });
}

function attributed(body) {
  const match = ATTRIBUTED.exec(body);
  if (!match) return { text: body, session: null, date: null };
  return { text: match[1], session: match[2] ?? null, date: match[3] };
}
