# Extraction prompt is bounded by an index query, not by the corpus

Extraction has to pick which topic a session belongs to. The obvious way — and what
the original code did — is to put every topic's summary and keywords into the prompt
and let the model choose. That is O(corpus) on every extraction: about 4K tokens at
41 topics, but roughly 75K tokens per extraction at the ~800 topics the first year
projects to, across thousands of extractions. It also degrades quality, because
finding one subject among hundreds of summaries is a needle-in-haystack task.

So candidate topics come from a full-text query against the session's salient terms
— roughly ten candidates, with same-project topics scored higher — and the
already-known-facts block is capped at about twenty facts. Extraction cost becomes
O(1) in corpus size.

## Consequences

**Extraction now reads the search index.** The index is still *derived* and still
rebuildable from markdown at any time, so it remains safe to delete. But it is no
longer *optional*: the write path depends on it, which is why one refresh function
is called by both the sweeper and the read path rather than only by search.

**A topic's candidate score is its best-matching fact, not the sum of its facts.** Topic size
is lumpy (see ADR 0003), so a summed score would make the largest topics candidates for every
conversation regardless of subject. Same-project topics are boosted by a constant factor on
top of that score, which decides between comparable topics without letting an unrelated
same-project topic outrank a real match.

**The query is the conversation's most repeated terms**, non-stopword and at least three
characters, capped at 24. ORing every term of a whole conversation is both an unusable
full-text query and an unbounded one; term frequency is what the conversation is about.

**Both caps are filled from one ranked scan of 200 matching facts.** `bm25` is usable
only in a flat query over the full-text table — not inside an aggregate, a subquery, or
a CTE — so the facts come back one ranked row at a time and are grouped into topics in
JavaScript. 200 is deep enough that the same-project boost has candidates to promote
and shallow enough to stay constant work as the corpus grows.

A stale index during a sweep causes duplicate topics — the sweeper cannot see a
topic created an hour ago — which is why refresh happens before candidate selection
and not on a schedule.
