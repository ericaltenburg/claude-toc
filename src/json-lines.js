// One line of a JSON-lines file, or null. Every log this project reads is appended to by
// something that can be killed mid-line, so a line that does not parse to an object is
// skipped, never thrown.
export function parseJsonLine(line) {
  try {
    const record = JSON.parse(line);
    return record && typeof record === "object" ? record : null;
  } catch {
    return null;
  }
}
