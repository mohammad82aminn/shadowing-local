import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const fingerprintSource = await readFile(
  fileURLToPath(new URL("../static/js/video-fingerprint.js", import.meta.url)),
  "utf8",
);
const fingerprintModule = await import(
  `data:text/javascript;base64,${Buffer.from(fingerprintSource).toString("base64")}`
);
const { createSampledFingerprint } = fingerprintModule;

test("fingerprint records three 64 KiB samples and includes file size", async () => {
  const file = new Blob([new Uint8Array(1024 * 1024)]);

  const fingerprint = await createSampledFingerprint(file);

  assert.equal(fingerprint.algorithm, "SHA-256");
  assert.equal(fingerprint.version, 1);
  assert.equal(fingerprint.sampleBytes, 64 * 1024);
  assert.equal(fingerprint.fileSize, file.size);
  assert.deepEqual(fingerprint.samples.map(({ offset, length }) => ({ offset, length })), [
    { offset: 0, length: 64 * 1024 },
    { offset: (file.size - 64 * 1024) / 2, length: 64 * 1024 },
    { offset: file.size - 64 * 1024, length: 64 * 1024 },
  ]);
  assert.match(fingerprint.digest, /^[0-9a-f]{64}$/);
});

test("sampled fingerprint changes for sampled bytes but not for unsampled bytes", async () => {
  const originalBytes = new Uint8Array(1024 * 1024);
  const original = await createSampledFingerprint(new Blob([originalBytes]));

  const changedSample = originalBytes.slice();
  changedSample[100] = 1;
  const sampleChanged = await createSampledFingerprint(new Blob([changedSample]));

  const changedUnsampled = originalBytes.slice();
  changedUnsampled[300_000] = 1;
  const unsampledChanged = await createSampledFingerprint(new Blob([changedUnsampled]));

  assert.notEqual(sampleChanged.digest, original.digest);
  assert.equal(unsampledChanged.digest, original.digest);
});
