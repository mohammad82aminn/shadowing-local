import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const moduleSource = await readFile(
  fileURLToPath(new URL("../static/js/vocabulary-notebook.js", import.meta.url)),
  "utf8",
);
const moduleWithoutBrowserDependencies = moduleSource.replace(
  /^import \{[\s\S]*?\} from ["'][^"']+["'];\r?\n/gm,
  "",
);
const vocabularyModule = await import(
  `data:text/javascript;base64,${Buffer.from(moduleWithoutBrowserDependencies).toString("base64")}`
);

test("a single subtitle click selects exactly one word", () => {
  assert.equal(vocabularyModule.selectCueWord("We should look it up.", 2), "look");
  assert.equal(vocabularyModule.selectCueWord("We should look it up.", 8), "");
});

test("two phrase clicks select an inclusive multi-word expression in either direction", () => {
  assert.equal(vocabularyModule.selectCuePhrase("We should look it up.", 2, 4), "look it up.");
  assert.equal(vocabularyModule.selectCuePhrase("We should look it up.", 4, 2), "look it up.");
  assert.equal(vocabularyModule.selectCuePhrase("short phrase", 0, 8), "");
});

test("duplicate keys fold case and whitespace while retaining apostrophes and inflections", () => {
  const key = vocabularyModule.normalizeVocabularyForm;
  assert.equal(key("  DON'T   stop "), key("don't stop"));
  assert.notEqual(key("don't stop"), key("dont stop"));
  assert.notEqual(key("running"), key("run"));
});

test("notebook requests contain selected fields and never read the practice answer input", () => {
  assert.match(moduleSource, /form: formValue/u);
  assert.match(moduleSource, /meanings: meaningValues\.map/u);
  assert.doesNotMatch(moduleSource, /data-answer-input|rawAnswer|input\.value.*answer/iu);
  assert.match(moduleSource, /credentials: "same-origin"/u);
  assert.match(moduleSource, /X-CSRFToken/u);
});

test("lemma suggestion requests send only the selected word or phrase", () => {
  assert.match(moduleSource, /body: JSON\.stringify\(\{ form: selectedForm \}\)/u);
  assert.doesNotMatch(moduleSource, /data-answer-input|rawAnswer|subtitleText|cue\.text.*fetch/iu);
  assert.match(moduleSource, /observed\.lemmaEntryId = observedKey === lemmaKey \? null : lemma\.id/u);
  assert.match(moduleSource, /queueVocabularySave\(workspaceId, observed/u);
});

test("lemma suggestions require an explicit choice and support rejection", () => {
  assert.match(moduleSource, /lemmaConfirmButton\.disabled = true/u);
  assert.match(moduleSource, /data-lemma-reject/u);
  assert.match(moduleSource, /resetLemmaPanel\(\)/u);
  assert.match(moduleSource, /entryInput\.addEventListener\("input"/u);
});

test("vocabulary changes use an IndexedDB outbox and send only vocabulary operation batches", async () => {
  const storageSource = await readFile(
    fileURLToPath(new URL("../static/js/indexeddb-storage.js", import.meta.url)),
    "utf8",
  );
  assert.match(storageSource, /createObjectStore\("syncOutbox"/u);
  assert.match(storageSource, /operationId: newId\(\)/u);
  assert.match(storageSource, /type: "entry\.save"/u);
  assert.match(storageSource, /type: "entry\.delete"/u);
  assert.match(moduleSource, /operations: wireOperations/u);
  assert.match(moduleSource, /operationId, workspaceId: operationWorkspaceId, type, entryId, baseVersion, payload/u);
  assert.match(moduleSource, /resolveVocabularyConflict\(conflict\.operationId, false\)/u);
  assert.match(moduleSource, /resolveVocabularyConflict\(conflict\.operationId, true\)/u);
  assert.doesNotMatch(moduleSource, /data-answer-input|rawAnswer|subtitleText.*JSON\.stringify/iu);
});
