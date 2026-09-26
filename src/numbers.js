// How a number reads on a report. Formatting is not a property of the thing being counted, so
// neither spend.js nor status.js owns this: both read a count and an amount the same way.

export const thousands = (count) => count.toLocaleString("en-US");

// Two decimal places would print every amount below a cent as $0.00, which reads as nothing
// spent rather than as a little.
const CENTS_ARE_TOO_COARSE_BELOW = 0.01;

export const dollars = (amount) =>
  `$${amount.toFixed(amount > 0 && amount < CENTS_ARE_TOO_COARSE_BELOW ? 4 : 2)}`;
