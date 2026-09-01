import { test } from "node:test";
import assert from "node:assert/strict";

import { tablesFor } from "../../src/cli/table.js";

// The two block shapes the renderer draws: a key-value block, whose rows carry one `value` or
// several `values`, and a windowed block, whose `columns` head the readings under them.
const keyValue = (rows) => ({ title: "ONE", rows });
const windowed = (rows) => ({ title: "TWO", columns: ["7d", "all-time"], rows });

const A_READING = [{ label: "a label", value: "a reading" }];

function linesOf(blocks) {
  return tablesFor(blocks).flat();
}

const lengthsOf = (lines) => new Set(lines.map((line) => line.length));

test("a block is drawn as a full grid with its title in the top border", () => {
  const [table] = tablesFor([keyValue(A_READING)]);

  assert.deepEqual(table, [
    "┌─ ONE ───┬───────────┐",
    "│ a label │ a reading │",
    "└─────────┴───────────┘",
  ]);
});

test("every line of every block is exactly as long as every other", () => {
  const lines = linesOf([
    keyValue([...A_READING, { label: "a much longer label here", value: "x" }]),
    windowed([{ label: "counted", values: ["1", "2"] }]),
  ]);

  assert.equal(lengthsOf(lines).size, 1);
});

// The width is what the widest reading needs, because a value worth printing is worth reading
// in full and truncating one would hide the reading most worth having.
test("the widest reading widens every block and is printed whole", () => {
  const aVeryLongReading = "a_reading_that_is_much_longer_than_any_other_on_the_report";
  const narrow = linesOf([keyValue(A_READING), windowed([{ label: "c", values: ["1", "2"] }])]);
  const widened = linesOf([
    keyValue([{ label: "a label", value: aVeryLongReading }]),
    windowed([{ label: "c", values: ["1", "2"] }]),
  ]);

  assert.ok(widened[0].length > narrow[0].length);
  assert.equal(lengthsOf(widened).size, 1);
  assert.ok(widened.some((line) => line.includes(aVeryLongReading)));
});

test("a windowed block heads its columns and right-aligns the readings under them", () => {
  const [table] = tablesFor([windowed([{ label: "counted", values: ["1", "2"] }])]);

  assert.match(table[1], /^│ +│ +7d │ +all-time │$/);
  assert.match(table[3], /^│ counted +│ +1 │ +2 │$/);
});

// A divided row leads each cell with the word naming it, so its cells stay left-aligned where
// a windowed block's are right-aligned for comparison down the column's edge.
test("a row of several readings gets a cell each, evenly split and left-aligned", () => {
  const [table] = tablesFor([keyValue([{ label: "spread", values: ["min 1", "max 9"] }])]);

  const cells = table[1].split("│").slice(2, -1);
  assert.deepEqual(
    cells.map((cell) => cell.trim()),
    ["min 1", "max 9"]
  );
  assert.equal(cells[0].length, cells[1].length);
});

test("the rule between rows that divide differently opens and closes each wall", () => {
  const [table] = tablesFor([
    keyValue([...A_READING, { label: "spread", values: ["min 1", "max 9"] }, { label: "z", value: "y" }]),
  ]);

  const dividedRow = table.findIndex((line) => line.startsWith("│ spread"));

  assert.match(table[dividedRow - 1], /┬/);
  assert.match(table[dividedRow + 1], /┴/);
});

test("a reading gets a space of breathing room on each side of it", () => {
  const [table] = tablesFor([keyValue(A_READING)]);

  assert.ok(table[1].startsWith("│ a label │ a reading "));
});

test("blocks are returned one table at a time, so a caller can put prose between them", () => {
  const tables = tablesFor([keyValue(A_READING), windowed([{ label: "c", values: ["1", "2"] }])]);

  assert.equal(tables.length, 2);
  assert.ok(tables[0][0].includes("ONE"));
  assert.ok(tables[1][0].includes("TWO"));
});
