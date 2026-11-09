import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

async function importSource(path) {
  const source = await readFile(fileURLToPath(new URL(path, import.meta.url)), "utf8");
  return import(`data:text/javascript;base64,${Buffer.from(source).toString("base64")}`);
}

const { parseSubtitle, timestampToMilliseconds } = await importSource("../static/js/subtitle-parser.js");
const { effectiveCueTiming, suggestCueSplit, splitCueRecord } = await importSource("../static/js/cue-manager.js");

test("SRT parsing strips common formatting tags, decodes entities, and detects speaker labels", () => {
  const result = parseSubtitle("1\n00:00:01,250 --> 00:00:03,000\n<i>JOEY:</i> <b>How &amp; why?</b>\n", "srt");
  assert.equal(result.errors.length, 0);
  assert.equal(result.cues[0].text, "How & why?");
  assert.equal(result.cues[0].speaker, "JOEY");
  assert.equal(result.cues[0].originalStartMs, 1250);
  assert.equal(result.cues[0].originalEndMs, 3000);
});

test("standalone speaker labels are separated from following dialogue", () => {
  const result = parseSubtitle("1\n00:00:01,000 --> 00:00:02,000\nJOEY\nHow are you?", "srt");
  assert.equal(result.cues[0].speaker, "JOEY");
  assert.equal(result.cues[0].text, "How are you?");
});

test("VTT parses cue identifiers, voice labels, cue settings, and non-speech descriptions", () => {
  const source = "WEBVTT\n\nintro\n00:00.000 --> 00:02.500 align:start\n<v Alex>Hello</v>\n\n00:03.000 --> 00:04.000\n[Door Opens]\n";
  const result = parseSubtitle(source, "vtt");
  assert.equal(result.errors.length, 0);
  assert.equal(result.cues[0].speaker, "Alex");
  assert.equal(result.cues[0].text, "Hello");
  assert.equal(result.cues[1].type, "non-speech");
  assert.equal(result.cues[1].active, false);
});

test("malformed blocks are reported without discarding valid neighboring cues", () => {
  const source = "1\n00:00:01,000 --> 00:00:02,000\nFirst\n\n2\n00:99:00,000 --> 00:00:03,000\nBroken\n\n3\n00:00:04,000 --> 00:00:05,000\nThird";
  const result = parseSubtitle(source, "srt");
  assert.equal(result.cues.length, 2);
  assert.equal(result.errors.length, 1);
  assert.equal(result.cues[1].text, "Third");
});

test("timestamp syntax and cue ordering are validated", () => {
  assert.equal(timestampToMilliseconds("00:61:00,000", "srt"), null);
  assert.equal(parseSubtitle("1\n00:00:02,000 --> 00:00:01,000\nBackwards", "srt").errors.length, 1);
  assert.equal(parseSubtitle("text", "vtt").errors[0].reason, "Missing WEBVTT header.");
});

test("malformed formatting tags are reported as invalid cues", () => {
  const result = parseSubtitle("1\n00:00:01,000 --> 00:00:02,000\n<i>Unclosed tag", "srt");
  assert.equal(result.cues.length, 0);
  assert.match(result.errors[0].reason, /Formatting tags/);
});

test("offset and individual timing adjustments preserve original timestamps", () => {
  const cue = { originalStartMs: 1000, originalEndMs: 3000, startAdjustmentMs: 200, endAdjustmentMs: -100 };
  assert.deepEqual(effectiveCueTiming(cue, 500), { startMs: 1700, endMs: 3400 });
});

test("split proposal uses a sentence boundary when available and creates clean child history", () => {
  const parent = { id: "parent", text: "First sentence. Second part now", originalStartMs: 0, originalEndMs: 5000,
    status: "completed", attempts: [{ correct: true }], history: [], activeVersion: true };
  const suggestion = suggestCueSplit(parent);
  assert.equal(suggestion.leftText, "First sentence.");
  const result = splitCueRecord(parent, suggestion, (() => { let id = 0; return () => `child-${++id}`; })());
  assert.equal(result.parent.activeVersion, false);
  assert.equal(result.parent.history[0].attempts.length, 1);
  assert.deepEqual(result.parent.childIds, ["child-1", "child-2"]);
  assert.deepEqual(result.children.map((cue) => cue.status), ["not-attempted", "not-attempted"]);
  assert.deepEqual(result.children.map((cue) => cue.attempts), [[], []]);
});
