// Box-drawn tables for a terminal. A block is `{ title, rows }`, where a row carries either
// one `value` or several `values`, and a windowed block adds `columns` to head them.
//
// This module knows nothing about what it is drawing. Every label, every reading and the
// wording of both belong to the report that hands the blocks over; ADR 0015 records why the
// report's register is its own concern.

const RULE = "─";
const WALL = "│";
const CORNERS = { top: "┌┬┐", between: "├┼┤", bottom: "└┴┘" };

// A cell is its text with a space of breathing room on each side of it.
const PADDING = 2;

// Every block is measured before any is drawn, so the tables share one outer width and the
// report reads as one report. The width is what the widest reading needs, because a value
// worth printing is worth reading in full and truncating one would hide the reading most
// worth having.
export function tablesFor(blocks) {
  const layout = layoutFor(blocks);
  return blocks.map((block) => tableFor(block, layout));
}

const inColumnLayout = (block) => Boolean(block.columns);

function layoutFor(blocks) {
  const columns = countedColumns(blocks);
  const readingWidth = Math.max(0, ...blocks.filter(isKeyValueBlock).map(readingRoomFor));
  const cellWidth = widest(blocks.filter(inColumnLayout).flatMap(cellsIn)) + PADDING;
  const columnWidth = columns
    ? Math.max(cellWidth, Math.ceil((readingWidth - (columns - 1)) / columns))
    : 0;

  return {
    labelWidth: Math.max(...blocks.map(labelColumnFor)),
    valueWidth: columns ? spannedBy(columns, columnWidth) : readingWidth,
    columnWidth,
  };
}

// The windowed blocks report the same windows by construction, so one column width serves
// them both and a dollar amount sits under a call count. Their columns are equal to each
// other rather than dividing the width exactly, which is what widens the whole report to a
// multiple of a column when a key-value reading asks for more room than they need.
function countedColumns(blocks) {
  const windowed = blocks.filter(inColumnLayout);
  return windowed.length ? Math.max(...windowed.map((block) => block.columns.length)) : 0;
}

const isKeyValueBlock = (block) => !inColumnLayout(block);
const cellsIn = (block) => [...block.columns, ...block.rows.flatMap((row) => row.values)];

// A row that divides its reading into cells needs room for the widest of them in every cell,
// plus the walls that come to stand between them.
const readingRoomFor = (block) => Math.max(...block.rows.map(readingRoomForRow));

function readingRoomForRow(row) {
  if (!row.values) return row.value.length + PADDING;
  return spannedBy(row.values.length, widest(row.values) + PADDING);
}

// The cells of a divided row are equal to each other, so a row reads as evenly weighed. Any
// character left over by the division goes to the leftmost cells.
function evenlySplit(width, count) {
  const room = width - (count - 1);
  const each = Math.floor(room / count);
  const leftOver = room % count;
  return Array.from({ length: count }, (_, i) => each + (i < leftOver ? 1 : 0));
}

// The title sits in the top border of the label column, so a long title widens that column
// the way a long label does.
function labelColumnFor(block) {
  return Math.max(widest(block.rows.map((row) => row.label)) + PADDING, titled(block.title).length);
}

function spannedBy(count, width) {
  return count * width + (count - 1);
}

// Labels and key-value readings are left-aligned; a windowed block's cells are right-
// aligned, because a column exists to be compared down its right edge. A divided key-value
// row keeps its cells left-aligned, because each one leads with the word that names it.
function drawnRowsFor(block, { labelWidth, valueWidth, columnWidth }) {
  if (isKeyValueBlock(block)) {
    return block.rows.map((row) =>
      row.values
        ? {
            cells: [leftAligned(row.label), ...row.values.map(leftAligned)],
            widths: [labelWidth, ...evenlySplit(valueWidth, row.values.length)],
          }
        : {
            cells: [leftAligned(row.label), leftAligned(row.value)],
            widths: [labelWidth, valueWidth],
          }
    );
  }

  const widths = [labelWidth, ...block.columns.map(() => columnWidth)];
  return [
    { cells: [leftAligned(""), ...block.columns.map(rightAligned)], widths },
    ...block.rows.map((row) => ({
      cells: [leftAligned(row.label), ...row.values.map(rightAligned)],
      widths,
    })),
  ];
}

const leftAligned = (text) => ({ text, alignRight: false });
const rightAligned = (text) => ({ text, alignRight: true });

function tableFor(block, layout) {
  const rows = drawnRowsFor(block, layout);
  const lines = [topBorder(block.title, rows[0].widths)];

  rows.forEach((row, index) => {
    if (index) lines.push(borderBetween(rows[index - 1].widths, row.widths));
    lines.push(cellLine(row.cells, row.widths));
  });
  lines.push(border(rows.at(-1).widths, CORNERS.bottom));

  return lines;
}

// The block's title lives in the top border, where nothing can read it as a reading.
function topBorder(title, [labelWidth, ...rest]) {
  const [left, join, right] = CORNERS.top;
  return left + [titled(title).padEnd(labelWidth, RULE), ...rest.map(ruled)].join(join) + right;
}

const titled = (title) => `${RULE} ${title} `;

function border(widths, [left, join, right]) {
  return left + widths.map(ruled).join(join) + right;
}

// Rows are free to divide their readings differently, so the rule between two of them shows
// where each one's walls stand: a wall meeting one from above and below crosses, one that
// only ends above closes, and one that only begins below opens.
function borderBetween(above, below) {
  const [left, , right] = CORNERS.between;
  const ends = wallsIn(above);
  const begins = wallsIn(below);

  let drawn = "";
  for (let at = 0; at < insideTheWalls(above); at++) {
    drawn += junction(ends.has(at), begins.has(at));
  }
  return left + drawn + right;
}

const insideTheWalls = (widths) => sum(widths) + widths.length - 1;

function junction(ends, begins) {
  if (ends && begins) return CORNERS.between[1];
  if (ends) return CORNERS.bottom[1];
  if (begins) return CORNERS.top[1];
  return RULE;
}

// Where each wall stands, counted from the first character inside the left wall.
function wallsIn(widths) {
  const walls = new Set();
  let at = 0;
  for (const width of widths.slice(0, -1)) {
    at += width;
    walls.add(at);
    at += 1;
  }
  return walls;
}

const sum = (numbers) => numbers.reduce((total, value) => total + value, 0);
const ruled = (width) => RULE.repeat(width);

function cellLine(cells, widths) {
  const drawn = cells.map(({ text, alignRight }, i) => {
    const room = widths[i] - PADDING;
    return ` ${alignRight ? text.padStart(room) : text.padEnd(room)} `;
  });
  return WALL + drawn.join(WALL) + WALL;
}

const widest = (texts) => texts.reduce((width, text) => Math.max(width, text.length), 0);
