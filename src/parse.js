const FACT_WITH_SESSION = /^(.*?)\s*\[session:([^\s,\]]+),\s*(\d{4}-\d{2}-\d{2})\]$/;
const FACT_WITH_DATE = /^(.*?)\s*\[(\d{4}-\d{2}-\d{2})\]$/;

export function parseFactLine(line) {
  const match = /^-[ \t]+(.*)$/.exec(line);
  if (!match) return null;

  const body = match[1].trim();

  const withSession = FACT_WITH_SESSION.exec(body);
  if (withSession) {
    return { text: withSession[1], session: withSession[2], date: withSession[3] };
  }

  const withDate = FACT_WITH_DATE.exec(body);
  if (withDate) {
    return { text: withDate[1], session: null, date: withDate[2] };
  }

  return { text: body, session: null, date: null };
}

export function parseTopic(markdown) {
  const facts = [];
  let section = null;

  const lines = markdown.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const heading = /^##[ \t]+(.+?)[ \t]*$/.exec(line);
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

const formatters = new Map();

function formatter(timeZone) {
  const key = timeZone ?? "";
  let existing = formatters.get(key);
  if (!existing) {
    existing = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hourCycle: "h23",
    });
    formatters.set(key, existing);
  }
  return existing;
}

export function localDateParts(ms, timeZone) {
  const parts = {};
  for (const { type, value } of formatter(timeZone).formatToParts(ms)) {
    parts[type] = value;
  }
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

export function parseJsonLine(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}

export function parsePromptRecord(line, timeZone) {
  const record = parseJsonLine(line);
  if (!record) return null;

  const text = typeof record.display === "string" ? record.display.trim() : "";
  if (!text) return null;

  const ts = typeof record.timestamp === "number" ? record.timestamp : NaN;
  if (!Number.isFinite(ts)) return null;

  const { date, time } = localDateParts(ts, timeZone);

  return {
    ts,
    localDate: date,
    localTime: time,
    session: typeof record.sessionId === "string" ? record.sessionId : null,
    project: typeof record.project === "string" ? record.project : null,
    text,
    isCommand: text.startsWith("/") ? 1 : 0,
  };
}

export function parseSessionRecord(line) {
  const record = parseJsonLine(line);
  if (!record?.session_id) return null;

  return {
    sessionId: record.session_id,
    transcriptPath: record.transcript ?? null,
    project: record.cwd ?? null,
    startedAt: record.started ?? null,
  };
}
