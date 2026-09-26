// How words become an FTS5 MATCH expression. That expression is the index's query language,
// so both paths that search the full-text tables build it here: the read path from what a
// person or Claude typed, and the extractor from what a conversation said (ADR 0002). Neither
// imports it from the other.

const STOPWORDS = new Set(
  `a an and the of to in on for with about from by at or is are was were be been
   what when why how who which did do does done have has had i we my our it its
   that this these those there here so if then than as into over under again
   please can could should would will just not no yes any some all`
    .split(/\s+/)
    .filter(Boolean)
);

const FTS5_OPERATOR_OR_PREFIX_SEARCH = /\b(?:AND|OR|NOT|NEAR)\b|[\p{L}\p{N}]\*/u;
const TERM = /[\p{L}\p{N}_]+/gu;
const SHORTEST_USABLE_TERM = 2;
const SHORTEST_SALIENT_TERM = 3;
const MOST_REPEATED_TERMS_QUERIED = 24;

function quoted(term) {
  return `"${term.replace(/"/g, '""')}"`;
}

export function termsQuery(text) {
  const terms = String(text ?? "").match(TERM) ?? [];
  const usable = terms.filter((term) => term.length >= SHORTEST_USABLE_TERM);
  const meaningful = usable.filter((term) => !STOPWORDS.has(term.toLowerCase()));
  const chosen = meaningful.length ? meaningful : usable;
  if (!chosen.length) return null;
  return chosen.map(quoted).join(" OR ");
}

export function salientTermsQuery(text) {
  const counts = new Map();
  for (const raw of String(text ?? "").match(TERM) ?? []) {
    const term = raw.toLowerCase();
    if (term.length < SHORTEST_SALIENT_TERM || STOPWORDS.has(term)) continue;
    counts.set(term, (counts.get(term) ?? 0) + 1);
  }
  if (!counts.size) return null;

  const ranked = [...counts.entries()]
    .sort(([termA, countA], [termB, countB]) => countB - countA || termA.localeCompare(termB))
    .slice(0, MOST_REPEATED_TERMS_QUERIED);
  return ranked.map(([term]) => quoted(term)).join(" OR ");
}

export function ftsQuery(text) {
  const trimmed = String(text ?? "").trim();
  if (!trimmed) return null;
  if (FTS5_OPERATOR_OR_PREFIX_SEARCH.test(trimmed)) return trimmed;
  return termsQuery(trimmed);
}
