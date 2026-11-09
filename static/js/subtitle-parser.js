const TIMESTAMP = /^(?:(\d{2,}):)?(\d{2}):(\d{2})[.,](\d{3})$/;
const VTT_TIMESTAMP = /^(?:(\d{2,}):)?(\d{2}):(\d{2})\.(\d{3})$/;
const VTT_SHORT_TIMESTAMP = /^(\d{2,}):(\d{2})\.(\d{3})$/;
const KNOWN_FORMAT_TAGS = /<\/?(?:i|b|u|s|ruby|rt|c(?:\.[\w-]+)?|lang(?:\s+[^>]*)?)\s*>/gi;

export function timestampToMilliseconds(value, format) {
  const trimmed = value.trim();
  const shortVtt = format === "vtt" ? VTT_SHORT_TIMESTAMP.exec(trimmed) : null;
  const match = shortVtt || (format === "vtt" ? VTT_TIMESTAMP : TIMESTAMP).exec(trimmed);
  if (!match) return null;
  const hours = shortVtt ? 0 : Number(match[1] || 0);
  const minutes = Number(shortVtt ? match[1] : match[2]);
  const seconds = Number(shortVtt ? match[2] : match[3]);
  const milliseconds = Number(shortVtt ? match[3] : match[4]);
  if (minutes > 59 || seconds > 59) return null;
  return ((hours * 60 + minutes) * 60 + seconds) * 1000 + milliseconds;
}

function decodeEntities(text) {
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, (entity, value) => {
    const lower = value.toLowerCase();
    if (lower === "amp") return "&";
    if (lower === "lt") return "<";
    if (lower === "gt") return ">";
    if (lower === "quot") return '"';
    if (lower === "apos") return "'";
    if (lower === "nbsp") return " ";
    const codePoint = lower.startsWith("#x") ? parseInt(lower.slice(2), 16) : Number(lower.slice(1));
    return Number.isInteger(codePoint) && codePoint >= 0 && codePoint <= 0x10ffff
      ? String.fromCodePoint(codePoint)
      : entity;
  });
}

function cleanCueText(rawText) {
  let speaker = null;
  const voice = /<v(?:\.[^\s>]*)?\s+([^>]+)>/i.exec(rawText);
  if (voice) speaker = voice[1].trim();
  const withoutTags = rawText
    .replace(/<br\s*\/?\s*>/gi, "\n")
    .replace(/<\d{2,}:\d{2}:\d{2}\.\d{3}>/g, "")
    .replace(/<v(?:\.[^\s>]*)?\s+[^>]+>/gi, "")
    .replace(/<\/v>/gi, "")
    .replace(KNOWN_FORMAT_TAGS, "")
    .replace(/<[^>]*>/g, "");
  const text = decodeEntities(withoutTags).replace(/\r/g, "").split("\n").map((line) => line.trim()).join("\n").trim();
  if (!speaker) {
    const standaloneLabel = /^([A-Z][A-Z0-9 _.'-]{0,39})\n+([\s\S]+)$/.exec(text);
    if (standaloneLabel) {
      speaker = standaloneLabel[1].trim();
      return { text: standaloneLabel[2].trim(), speaker };
    }
    const label = /^([A-Z][A-Z0-9 _.'-]{0,39}):\s+(.+)$/s.exec(text);
    if (label) {
      speaker = label[1].trim();
      return { text: label[2].trim(), speaker };
    }
  }
  return { text, speaker };
}

function hasBalancedFormattingTags(rawText) {
  const stack = [];
  const tags = /<\s*(\/?)\s*(i|b|u|s|ruby|rt|c|v|lang)(?:\.[\w-]+)?(?:\s+[^>]*)?\s*>/gi;
  let match;
  while ((match = tags.exec(rawText))) {
    const closing = Boolean(match[1]);
    const name = match[2].toLowerCase();
    if (closing) {
      if (stack.pop() !== name) return false;
    } else {
      stack.push(name);
    }
  }
  return stack.length === 0;
}

function blocksFor(source, format) {
  const normalized = source.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n");
  if (format === "vtt") {
    if (!/^WEBVTT(?:[ \t].*)?$/m.test(normalized)) {
      return { blocks: [], errors: [{ block: 1, reason: "Missing WEBVTT header." }] };
    }
    const body = normalized.replace(/^WEBVTT[^\n]*\n/, "");
    return { blocks: body.split(/\n{2,}/).filter(Boolean), errors: [] };
  }
  return { blocks: normalized.split(/\n{2,}/).filter(Boolean), errors: [] };
}

function parseBlock(block, blockNumber, format) {
  const lines = block.split("\n");
  if (format === "vtt" && /^(NOTE|STYLE|REGION)(?:\s|$)/.test(lines[0])) return { ignored: true };
  let timingIndex = lines.findIndex((line) => line.includes("-->"));
  if (timingIndex < 0) return { error: "Missing timestamp line." };
  if (format === "srt" && timingIndex > 1) return { error: "Unexpected lines before SRT timestamp." };
  const timing = /^\s*(\S+)\s+-->\s+(\S+)(?:\s+.*)?$/.exec(lines[timingIndex]);
  if (!timing) return { error: "Malformed timestamp line." };
  const startMs = timestampToMilliseconds(timing[1], format);
  const endMs = timestampToMilliseconds(timing[2], format);
  if (startMs === null || endMs === null) return { error: "Timestamp is not valid for this subtitle format." };
  if (endMs <= startMs) return { error: "Cue end must be later than cue start." };
  const rawText = lines.slice(timingIndex + 1).join("\n").trim();
  if (!rawText) return { error: "Cue text is empty." };
  if (!hasBalancedFormattingTags(rawText)) return { error: "Formatting tags are unbalanced or incorrectly nested." };
  const { text, speaker } = cleanCueText(rawText);
  if (!text) return { error: "Cue text is empty after formatting tags are removed." };
  const nonSpeech = /^\s*(?:\[[^\]]+\]|\([^\)]+\))(?:\s*(?:\[[^\]]+\]|\([^\)]+\)))*\s*$/.test(text);
  return {
    cue: {
      id: `cue-${blockNumber}-${globalThis.crypto?.randomUUID?.() || Math.random().toString(36).slice(2)}`,
      sourceBlock: blockNumber,
      originalStartMs: startMs,
      originalEndMs: endMs,
      adjustmentMs: 0,
      text,
      speaker,
      type: nonSpeech ? "non-speech" : "speech",
      active: !nonSpeech,
      status: "not-attempted",
      attempts: [],
      history: [],
      parentId: null,
      childIds: [],
      isRoot: true,
      activeVersion: true,
    },
  };
}

export function parseSubtitle(source, format) {
  if (typeof source !== "string") throw new TypeError("Subtitle source must be text.");
  if (!["srt", "vtt"].includes(format)) throw new TypeError("Subtitle format must be SRT or VTT.");
  const { blocks, errors } = blocksFor(source, format);
  const cues = [];
  blocks.forEach((block, index) => {
    const blockNumber = index + 1;
    const result = parseBlock(block, blockNumber, format);
    if (result.ignored) return;
    if (result.error) errors.push({ block: blockNumber, reason: result.error });
    else cues.push(result.cue);
  });
  return { format, cues, errors, totalBlocks: blocks.length };
}

export function detectSubtitleFormat(fileName) {
  const extension = fileName.split(".").pop()?.toLowerCase();
  return extension === "srt" || extension === "vtt" ? extension : null;
}
