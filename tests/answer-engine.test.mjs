import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
  fileURLToPath(new URL("../static/js/answer-engine.js", import.meta.url)),
  "utf8",
);
const isolatedCore = source.replace(/^import .*;\r?\n/gm, "");
const { normalizeAnswer, compareAnswer, recordCueAnswer, recordCueRetry, recordCueContinue, recordCueSkip } = await import(
  `data:text/javascript;base64,${Buffer.from(isolatedCore).toString("base64")}`
);

const cue = (overrides = {}) => ({
  id: "cue-1",
  text: "A clean expected sentence.",
  status: "not-attempted",
  attempts: [],
  history: [],
  ...overrides,
});

test("comparison ignores casing and normalizes repeated and surrounding whitespace", () => {
  assert.equal(compareAnswer("  Hello   WORLD ", "hello world"), true);
  assert.equal(normalizeAnswer("\tA\n  B  "), "a b");
});

test("ordinary punctuation is ignored", () => {
  assert.equal(compareAnswer("Hello, world!", "hello world"), true);
  assert.equal(compareAnswer("Wait... what?", "wait what"), true);
});

test("straight and curly internal apostrophes are equivalent and preserved", () => {
  assert.equal(compareAnswer("I'm ready.", "i’m ready"), true);
  assert.equal(normalizeAnswer("don't"), "don't");
  assert.equal(compareAnswer("Don't go.", "dont go"), false);
  assert.equal(compareAnswer("I'm happy.", "I am happy"), false);
  assert.equal(compareAnswer("We're ready.", "were ready"), false);
});

test("hyphens compare as spaces without spelling correction", () => {
  assert.equal(compareAnswer("Well-known", "well known"), true);
  assert.equal(compareAnswer("beautiful", "beautifull"), false);
});

test("first incorrect response records statistics without retaining submitted text", () => {
  const raw = "unique-raw-answer-7391";
  const updated = recordCueAnswer(cue(), raw);
  assert.equal(updated.status, "attempted-incorrect");
  assert.equal(updated.totalAttempts, 1);
  assert.equal(updated.firstAttemptCorrect, false);
  assert.deepEqual(updated.attempts.map(({ correct }) => correct), [false]);
  assert.ok(updated.history.some((event) => event.type === "status" && event.to === "attempted-incorrect"));
  assert.equal(JSON.stringify(updated).includes(raw), false);
  assert.equal("answer" in updated, false);
  assert.equal("rawAnswer" in updated, false);
});

test("Retry preserves incorrect status and attempts while Continue records a separate event", () => {
  const wrong = recordCueAnswer(cue(), "not it");
  const retried = recordCueRetry(wrong);
  assert.equal(retried.status, "attempted-incorrect");
  assert.equal(retried.attempts.length, 1);
  assert.equal(retried.history.at(-1).type, "retry");
  const continued = recordCueContinue(retried);
  assert.equal(continued.status, "attempted-incorrect");
  assert.equal(continued.history.at(-1).type, "continue");
});

test("Skip without an answer marks Cue skipped and records its status transition", () => {
  const skipped = recordCueSkip(cue());
  assert.equal(skipped.status, "skipped");
  assert.deepEqual(skipped.attempts, []);
  assert.ok(skipped.history.some((event) => event.type === "skip"));
  assert.ok(skipped.history.some((event) => event.type === "status" && event.to === "skipped"));
});

test("Skip after a wrong answer keeps attempted/incorrect and adds a skip event", () => {
  const wrong = recordCueAnswer(cue(), "wrong");
  const skipped = recordCueSkip(wrong);
  assert.equal(skipped.status, "attempted-incorrect");
  assert.equal(skipped.attempts.length, 1);
  assert.equal(skipped.history.filter((event) => event.type === "skip").length, 1);
});

test("a skipped Cue can later complete without losing Skip history", () => {
  const skipped = recordCueSkip(cue());
  const completed = recordCueAnswer(skipped, "A clean expected sentence.");
  assert.equal(completed.status, "completed");
  assert.equal(completed.firstAttemptCorrect, true);
  assert.ok(completed.history.some((event) => event.type === "skip"));
  assert.ok(completed.history.some((event) => event.type === "status" && event.to === "completed"));
});

test("another attempt on a Completed Cue preserves Completed status and appends history", () => {
  const completed = recordCueAnswer(cue(), "A clean expected sentence.");
  const retry = recordCueRetry(completed);
  const attemptedAgain = recordCueAnswer(retry, "still incorrect");
  assert.equal(attemptedAgain.status, "completed");
  assert.equal(attemptedAgain.totalAttempts, 2);
  assert.equal(attemptedAgain.firstAttemptCorrect, true);
  assert.deepEqual(attemptedAgain.attempts.map(({ correct }) => correct), [true, false]);
  assert.ok(attemptedAgain.history.some((event) => event.type === "retry"));
});

test("a later correct response after an incorrect attempt completes the Cue", () => {
  const wrong = recordCueAnswer(cue(), "wrong");
  const completed = recordCueAnswer(wrong, "A clean expected sentence.");
  assert.equal(completed.status, "completed");
  assert.equal(completed.totalAttempts, 2);
  assert.equal(completed.firstAttemptCorrect, false);
});

test("answer module persists only Cue records and never calls a network API", () => {
  assert.match(source, /await saveCue\(updated\)/);
  assert.doesNotMatch(source, /fetch\s*\(/);
  assert.doesNotMatch(source, /XMLHttpRequest/);
});
