# Search ranks facts, not topics

The original design routed queries to topics first and retrieved within them
(coarse filter, then fine retrieval). We rank facts instead, and treat topic as a
label and provenance carried on each fact.

Topic size is unbounded and observably lumpy: 41% of all facts sit in 3 of 41
topics, and the largest holds 347. Returning a topic would therefore mean returning
347 facts or ranking within the topic — so fact-level ranking is required either
way. Making topic the retrieval unit buys nothing and inherits the junk-drawer
problem.

## Consequences

- **Topic merging and clustering are not needed.** They were the original design's
  future work and would have become prerequisites under topic-level ranking.
  Measured duplication is rare anyway: one genuine duplicate pair among 820.
- **A fact's section (context vs decisions) must be returned, not just stored.** It
  is the per-fact structure that makes fact-level results interpretable, and the
  earlier retrieval code discarded it by flattening every list item into one stream.
- **Topic-level aggregation survives as a presentation choice** — an overview mode
  reporting hit counts per topic — which is where grouping actually helps a reader.
