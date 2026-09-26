// The local date and time of an instant, in the zone the user was in. SQLite has no notion of
// a local zone, so every local date this project stores or compares is computed here, in
// JavaScript, and an explicit zone is what makes it testable (ADR 0005).

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
