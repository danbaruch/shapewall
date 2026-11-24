// A busy flag that several operations share (the board's comment, capture
// and journey actions): a count of the ones running, so the first to finish
// does not turn it off under one still running. Pure, tested in
// test/board-params.test.js.
export const busyStep = (count, on) => Math.max(0, count + (on ? 1 : -1))
