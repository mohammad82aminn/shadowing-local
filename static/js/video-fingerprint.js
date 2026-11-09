const SAMPLE_BYTES = 64 * 1024;
const FINGERPRINT_ALGORITHM = "SHA-256";
const FINGERPRINT_VERSION = 1;

function toHex(buffer) {
  return Array.from(new Uint8Array(buffer), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sampleOffsets(fileSize, sampleLength) {
  return [
    0,
    Math.floor((fileSize - sampleLength) / 2),
    fileSize - sampleLength,
  ];
}

export async function createSampledFingerprint(file) {
  if (!file || !Number.isSafeInteger(file.size) || file.size < 0) {
    throw new TypeError("A valid local File is required to calculate its fingerprint.");
  }
  if (!globalThis.crypto?.subtle) {
    throw new Error("Web Crypto is unavailable in this browser context.");
  }

  const sampleLength = Math.min(SAMPLE_BYTES, file.size);
  const samples = [];
  for (const offset of sampleOffsets(file.size, sampleLength)) {
    const bytes = await file.slice(offset, offset + sampleLength).arrayBuffer();
    const digest = await globalThis.crypto.subtle.digest(FINGERPRINT_ALGORITHM, bytes);
    samples.push({
      offset,
      length: sampleLength,
      sha256: toHex(digest),
    });
  }

  const fingerprintInput = [
    `shadowing-video-fingerprint-v${FINGERPRINT_VERSION}`,
    `size:${file.size}`,
    ...samples.map((sample) => `${sample.offset}:${sample.length}:${sample.sha256}`),
  ].join("\n");
  const digest = await globalThis.crypto.subtle.digest(
    FINGERPRINT_ALGORITHM,
    new TextEncoder().encode(fingerprintInput),
  );

  return {
    algorithm: FINGERPRINT_ALGORITHM,
    version: FINGERPRINT_VERSION,
    sampleBytes: SAMPLE_BYTES,
    fileSize: file.size,
    samples,
    digest: toHex(digest),
  };
}
