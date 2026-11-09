import assert from "node:assert/strict";
import test from "node:test";
import { computeProgressStatistics } from "../static/js/progress-statistics.js";

const cue = (id, overrides = {}) => ({
  id,
  activeVersion: true,
  active: true,
  status: "not-attempted",
  attempts: [],
  ...overrides,
});

test("zero active Cues have explicit zero denominators for all metrics", () => {
  const result = computeProgressStatistics([
    cue("inactive", { active: false, status: "completed", attempts: [{ correct: true }] }),
    cue("old-version", { activeVersion: false, status: "skipped" }),
  ]);

  assert.deepEqual(result, {
    correctCompletion: { numerator: 0, denominator: 0 },
    coverage: { numerator: 0, denominator: 0 },
    firstAttemptAccuracy: { numerator: 0, denominator: 0 },
  });
});

test("all active Cues completed produce full completion, coverage, and accuracy", () => {
  const result = computeProgressStatistics([
    cue("one", { status: "completed", attempts: [{ correct: true }] }),
    cue("two", { status: "completed", attempts: [{ correct: true }, { correct: false }] }),
  ]);

  assert.deepEqual(result, {
    correctCompletion: { numerator: 2, denominator: 2 },
    coverage: { numerator: 2, denominator: 2 },
    firstAttemptAccuracy: { numerator: 2, denominator: 2 },
  });
});

test("mixed Cue states use independent completion, coverage, and first-attempt formulas", () => {
  const result = computeProgressStatistics([
    cue("not-attempted"),
    cue("completed", { status: "completed", attempts: [{ correct: true }] }),
    cue("incorrect", { status: "attempted-incorrect", attempts: [{ correct: false }, { correct: true }] }),
    cue("skipped-with-answer", { status: "attempted-incorrect", attempts: [{ correct: false }] }),
    cue("skipped-without-answer", { status: "skipped" }),
  ]);

  assert.deepEqual(result, {
    correctCompletion: { numerator: 1, denominator: 5 },
    coverage: { numerator: 4, denominator: 5 },
    firstAttemptAccuracy: { numerator: 1, denominator: 3 },
  });
});

test("inactive speech and Non-Speech Cues are excluded while active Non-Speech is included", () => {
  const result = computeProgressStatistics([
    cue("inactive-speech", { active: false, status: "completed", attempts: [{ correct: true }] }),
    cue("inactive-non-speech", {
      type: "non-speech", active: false, status: "skipped",
    }),
    cue("active-non-speech", {
      type: "non-speech", status: "not-attempted",
    }),
  ]);

  assert.deepEqual(result, {
    correctCompletion: { numerator: 0, denominator: 1 },
    coverage: { numerator: 0, denominator: 1 },
    firstAttemptAccuracy: { numerator: 0, denominator: 0 },
  });
});

test("Skipped Cues without submitted answers count toward coverage only", () => {
  const result = computeProgressStatistics([
    cue("skipped", { status: "skipped" }),
  ]);

  assert.deepEqual(result, {
    correctCompletion: { numerator: 0, denominator: 1 },
    coverage: { numerator: 1, denominator: 1 },
    firstAttemptAccuracy: { numerator: 0, denominator: 0 },
  });
});

test("statistics reflect Cue status and attempts after a persisted progress update", () => {
  const cues = [cue("one"), cue("two", { status: "skipped" })];
  const before = computeProgressStatistics(cues);
  cues[0] = {
    ...cues[0],
    status: "completed",
    attempts: [{ correct: true, at: "2026-01-01T00:00:00.000Z" }],
  };
  const after = computeProgressStatistics(cues);

  assert.deepEqual(before.coverage, { numerator: 1, denominator: 2 });
  assert.deepEqual(after.correctCompletion, { numerator: 1, denominator: 2 });
  assert.deepEqual(after.coverage, { numerator: 2, denominator: 2 });
  assert.deepEqual(after.firstAttemptAccuracy, { numerator: 1, denominator: 1 });
});

test("statistics can be rebuilt from reloaded Cue records without persisting aggregates", () => {
  const records = new Map([
    ["one", cue("one", { status: "completed", attempts: [{ correct: true }] })],
    ["two", cue("two", { status: "skipped" })],
  ]);
  const beforeReload = computeProgressStatistics([...records.values()]);
  const reloadedCues = [...records.values()].map((record) => JSON.parse(JSON.stringify(record)));
  const afterReload = computeProgressStatistics(reloadedCues);

  assert.deepEqual(afterReload, beforeReload);
  assert.ok(reloadedCues.every((record) => !("progressStatistics" in record)));
});

test("first-attempt accuracy follows the first recorded attempt when cached summary conflicts", () => {
  const result = computeProgressStatistics([
    cue("answer", {
      status: "completed",
      firstAttemptCorrect: false,
      attempts: [{ correct: true }, { correct: false }],
    }),
  ]);

  assert.deepEqual(result.firstAttemptAccuracy, { numerator: 1, denominator: 1 });
});
