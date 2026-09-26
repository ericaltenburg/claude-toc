// The contract with the extraction model: the prompt that declares the JSON shape, and the
// parser that reads that shape back. They are two halves of one agreement, so they change
// together and live together.

// The prompt's opening words are also how a transcript is recognised as the extractor's own,
// per ADR 0011. The prompt owns them; the sweeper imports them to know what to skip.
export const EXTRACTION_PROMPT_MARKER = "You are a memory extraction system";

const SCHEMA_INSTRUCTIONS = `${EXTRACTION_PROMPT_MARKER}. Analyze this conversation and extract structured information.

Return ONLY valid JSON with this exact schema:
{
  "topic": {
    "id": "snake_case_topic_name",
    "keywords": ["keyword1", "keyword2"],
    "summary": "one sentence summary"
  },
  "context": ["durable fact 1", "durable fact 2"],
  "decisions": ["decision 1", "decision 2"]
}

Rules:
- topic.id: short reusable identifier (e.g. "broadcast_variants", "resume_project")
- keywords: words that would appear in future messages about this topic
- topic.summary: one sentence describing the subject the topic covers: what it is about, stated so it stays true across sessions (e.g. "How ALCS stores and serves broadcast variants"). It never mentions a session, the user, or what was done.
- context: durable truths learned (e.g. "ALCS uses DynamoDB for broadcast variants")
- decisions: settled outcomes only: a choice that was made and stands, with its reason when one was stated (e.g. "Chose topic-scoped memory over flat summarization, because flat summaries lost per-subject detail"). A plan, an intention or a pending item is not a decision.
- context and decisions record what the conversation established, not what happened in it. Session narrative (what was run, committed, created, opened or asked, or who did what) is left out unless it established a durable fact; when it did, record the durable fact itself (e.g. "The deploy role lacks s3:PutObject", not "Ran the deploy and it failed with AccessDenied").
- leave out the user's working-style preferences and conventions for the assistant (e.g. "no em dashes"); those live in the user's CLAUDE.md.
- if the conversation has no meaningful content, return {"skip": true}
- deduplicate — don't extract things that are essentially the same fact reworded
`;

export function buildExtractPrompt({ candidates = [], knownFacts = [] } = {}) {
  let prompt = SCHEMA_INSTRUCTIONS;

  if (candidates.length) {
    prompt += `\nCandidate topics (the closest matches in memory, not the whole corpus):\n`;
    for (const candidate of candidates) {
      prompt += `- ${candidate.topic}: ${candidate.summary || "no summary"}`;
      prompt += candidate.keywords ? ` (keywords: ${candidate.keywords})` : "";
      prompt += `\n`;
    }
    // A topic's summary is overwritten by every extraction that lands on it, so a reused topic
    // hands its summary back as it is. Rewriting only a missing or recap-shaped one is what lets
    // summaries that drifted into describing a session heal as later sessions land.
    prompt +=
      `\nIf this conversation belongs to one of those topics, use that topic's id exactly, and ` +
      `return that candidate's summary unchanged. Rewrite it as a description of the subject only ` +
      `when it is missing, no longer describes the subject, or reads as a recap of a session.\n` +
      `Only invent a new topic.id if none of them fits.\n`;
  }

  if (knownFacts.length) {
    prompt += `\nAlready known about those topics — do not repeat these:\n`;
    for (const fact of knownFacts) {
      prompt += `- (${fact.topic}/${fact.section}) ${fact.text}\n`;
    }
  }

  return `${prompt}\nCONVERSATION:\n`;
}

// --- Reading the reply ---

const FENCE = /^```[\w-]*\n?|\n?```$/g;
const OUTERMOST_OBJECT = /\{[\s\S]*\}/;

export class MalformedOutput extends Error {}

export function parseModelOutput(output) {
  const raw = String(output ?? "").trim();

  const asWritten = extractionFrom(raw);
  if (asWritten) return asWritten;

  const unfenced = raw.replace(FENCE, "");
  const afterStrippingFences =
    extractionFrom(unfenced) ?? extractionFrom(OUTERMOST_OBJECT.exec(unfenced)?.[0] ?? "");
  if (afterStrippingFences) return afterStrippingFences;

  throw new MalformedOutput(`model returned malformed output: ${asEvidence(raw)}`);
}

const ENOUGH_OUTPUT_TO_DIAGNOSE_A_FAILURE = 400;

function asEvidence(output) {
  const collapsed = output.replace(/\s+/g, " ").trim();
  if (!collapsed) return "(it returned nothing)";
  return collapsed.length > ENOUGH_OUTPUT_TO_DIAGNOSE_A_FAILURE
    ? `${collapsed.slice(0, ENOUGH_OUTPUT_TO_DIAGNOSE_A_FAILURE)}…`
    : collapsed;
}

function extractionFrom(text) {
  if (!text) return null;
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object") return null;
  if (parsed.skip) return { skip: true };
  if (typeof parsed.topic?.id !== "string" || !parsed.topic.id.trim()) return null;

  return {
    topic: {
      id: parsed.topic.id,
      keywords: Array.isArray(parsed.topic.keywords) ? parsed.topic.keywords : [],
      summary: typeof parsed.topic.summary === "string" ? parsed.topic.summary : "",
    },
    context: stringsOnly(parsed.context),
    decisions: stringsOnly(parsed.decisions),
  };
}

function stringsOnly(value) {
  return (Array.isArray(value) ? value : []).filter(
    (item) => typeof item === "string" && item.trim()
  );
}
