import { effectiveCueTiming } from "./cue-manager.js";
import { saveCue, saveProjectReplayPadding } from "./indexeddb-storage.js";

const APOSTROPHES = /[\u2018\u2019\u02BC\uFF07]/gu;
const DASHES = /\p{Dash_Punctuation}/gu;

export function normalizeAnswer(value) {
  return String(value ?? "")
    .normalize("NFC")
    .toLowerCase()
    .replace(APOSTROPHES, "'")
    .replace(DASHES, " ")
    .replace(/[^\p{L}\p{N}'\s]/gu, " ")
    .replace(/(?<![\p{L}\p{N}])'|'(?![\p{L}\p{N}])/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

export function compareAnswer(expected, submitted) {
  return normalizeAnswer(expected) === normalizeAnswer(submitted);
}

function withHistory(cue, event, status = cue.status) {
  const at = event.at || new Date().toISOString();
  const history = [...(cue.history || []), { ...event, at }];
  if (status !== cue.status) {
    history.push({ type: "status", from: cue.status, to: status, at });
  }
  return { ...cue, status, history, updatedAt: at };
}

export function recordCueAnswer(cue, submitted) {
  const correct = compareAnswer(cue.text, submitted);
  const at = new Date().toISOString();
  const attempts = [...(cue.attempts || []), { correct, at }];
  const status = correct
    ? "completed"
    : cue.status === "completed" ? "completed" : "attempted-incorrect";
  const updated = withHistory(cue, {
    type: "attempt",
    correct,
    attemptNumber: attempts.length,
    at,
  }, status);
  return {
    ...updated,
    attempts,
    totalAttempts: (Number.isInteger(cue.totalAttempts) ? cue.totalAttempts : (cue.attempts || []).length) + 1,
    firstAttemptCorrect: cue.firstAttemptCorrect ?? correct,
  };
}

export function recordCueRetry(cue) {
  return withHistory(cue, { type: "retry" });
}

export function recordCueContinue(cue) {
  return withHistory(cue, { type: "continue" });
}

export function recordCueSkip(cue) {
  const hasSubmittedAttempt = (cue.attempts || []).length > 0;
  const nextStatus = hasSubmittedAttempt || cue.status === "completed"
    ? cue.status
    : "skipped";
  return withHistory(cue, { type: "skip" }, nextStatus);
}

function statusLabel(status) {
  return ({
    "not-attempted": "انجام‌نشده",
    completed: "تکمیل‌شده",
    "attempted-incorrect": "تلاش‌شده / نادرست",
    skipped: "ردشده",
  })[status] || status;
}

function practicePanel(root) {
  const panel = document.createElement("section");
  panel.className = "card shadow-sm mt-4 answer-practice";
  panel.setAttribute("aria-labelledby", "answer-practice-heading");
  panel.innerHTML = `
    <div class="card-body p-4">
      <h3 class="h5" id="answer-practice-heading">تمرین جمله</h3>
      <p class="text-secondary" data-practice-prompt>برای شروع، یک Cue گفتاری را انتخاب کنید.</p>
      <div class="alert alert-info" role="status" aria-live="polite" data-answer-feedback hidden></div>
      <p class="answer-expected" data-expected-answer hidden></p>
      <section class="vocabulary-selection mt-3" data-vocabulary-selection hidden aria-label="انتخاب واژه از زیرنویس">
        <div class="d-flex flex-wrap align-items-center gap-2 mb-2">
          <button class="btn btn-sm btn-outline-primary" type="button" data-phrase-mode aria-pressed="false">انتخاب عبارت</button>
          <span class="small text-secondary" data-selection-help>برای افزودن یک واژه، روی آن کلیک کنید.</span>
        </div>
        <div class="d-flex flex-wrap gap-1" data-subtitle-words></div>
      </section>
      <div class="d-flex flex-wrap gap-2 align-items-end mb-3" data-replay-settings hidden>
        <label class="form-label mb-0">حاشیهٔ پخش قبل (ثانیه)
          <input class="form-control form-control-sm replay-padding" type="number" min="0" max="2" step="0.05" data-padding-before>
        </label>
        <label class="form-label mb-0">حاشیهٔ پخش بعد (ثانیه)
          <input class="form-control form-control-sm replay-padding" type="number" min="0" max="2" step="0.05" data-padding-after>
        </label>
        <button class="btn btn-sm btn-outline-secondary" type="button" data-save-padding>ذخیرهٔ حاشیه‌ها</button>
      </div>
      <form class="d-flex flex-wrap gap-2" data-answer-form hidden>
        <label class="visually-hidden" for="answer-input">پاسخ شما</label>
        <input class="form-control answer-input" id="answer-input" type="text" autocomplete="off" spellcheck="false" data-answer-input>
        <button class="btn btn-primary" type="submit" data-submit-answer>بررسی پاسخ</button>
      </form>
      <div class="d-flex flex-wrap gap-2 mt-3" data-answer-actions hidden>
        <button class="btn btn-outline-primary" type="button" data-replay-cue>پخش دوبارهٔ جمله</button>
        <button class="btn btn-outline-secondary" type="button" data-skip-cue>رد کردن</button>
        <button class="btn btn-primary" type="button" data-retry-cue hidden>تلاش دوباره</button>
        <button class="btn btn-success" type="button" data-continue-cue hidden>ادامه</button>
      </div>
      <p class="small text-secondary mt-3 mb-0" data-cue-attempt-count></p>
    </div>`;
  root.append(panel);
  return panel;
}

const root = typeof document === "undefined" ? null : document.querySelector("[data-subtitle-manager]");
if (root) {
  const panel = practicePanel(root);
  const cueList = root.querySelector("[data-cue-list]");
  const video = document.querySelector("[data-video-element]");
  const prompt = panel.querySelector("[data-practice-prompt]");
  const feedback = panel.querySelector("[data-answer-feedback]");
  const expected = panel.querySelector("[data-expected-answer]");
  const form = panel.querySelector("[data-answer-form]");
  const input = panel.querySelector("[data-answer-input]");
  const actions = panel.querySelector("[data-answer-actions]");
  const replayButton = panel.querySelector("[data-replay-cue]");
  const skipButton = panel.querySelector("[data-skip-cue]");
  const retryButton = panel.querySelector("[data-retry-cue]");
  const continueButton = panel.querySelector("[data-continue-cue]");
  const count = panel.querySelector("[data-cue-attempt-count]");
  const paddingControls = panel.querySelector("[data-replay-settings]");
  const beforeInput = panel.querySelector("[data-padding-before]");
  const afterInput = panel.querySelector("[data-padding-after]");
  let project = null;
  let cues = [];
  let selectedCueId = null;
  let view = "ready";
  let replayFrame = 0;
  let replayEndSeconds = null;

  function activeCue() {
    return cues.find((cue) => cue.id === selectedCueId) || null;
  }

  function nextCueAfter(cue) {
    return [...cues]
      .filter((item) => item.activeVersion && item.active !== false && item.type !== "non-speech")
      .sort((first, second) => first.originalStartMs - second.originalStartMs)
      .find((item) => item.originalStartMs > cue.originalStartMs) || null;
  }

  function showExpected(visible) {
    const cue = activeCue();
    expected.hidden = !visible || !cue;
    expected.textContent = visible && cue ? cue.text : "";
    window.dispatchEvent(new CustomEvent("shadowing:vocabularyselection", {
      detail: { cue: visible ? cue : null },
    }));
  }

  function showFeedback(text, tone) {
    feedback.hidden = !text;
    feedback.className = `alert alert-${tone}`;
    feedback.textContent = text;
  }

  function render() {
    const cue = activeCue();
    const selected = Boolean(cue);
    prompt.textContent = selected
      ? `وضعیت فعلی: ${statusLabel(cue.status)}${cue.speaker ? ` · گوینده: ${cue.speaker}` : ""}`
      : "برای شروع، یک Cue گفتاری را انتخاب کنید.";
    form.hidden = !selected || view === "wrong" || view === "correct" || view === "continued" || view === "skipped";
    actions.hidden = !selected;
    paddingControls.hidden = !selected;
    retryButton.hidden = view !== "wrong";
    continueButton.hidden = view !== "wrong";
    skipButton.hidden = !selected || view === "correct" || view === "continued" || view === "skipped";
    replayButton.disabled = !selected || !video || !video.currentSrc;
    count.textContent = selected
      ? `تعداد تلاش‌ها: ${cue.totalAttempts ?? cue.attempts?.length ?? 0} · پاسخ درست در تلاش اول: ${cue.firstAttemptCorrect === true ? "بله" : cue.firstAttemptCorrect === false ? "خیر" : "ثبت نشده"}`
      : "";
    showExpected(["wrong", "correct", "continued", "skipped"].includes(view));
    if (project) {
      beforeInput.value = ((project.replayPaddingBeforeMs ?? 250) / 1000).toFixed(2);
      afterInput.value = ((project.replayPaddingAfterMs ?? 250) / 1000).toFixed(2);
    }
  }

  async function persistCue(updated, localView) {
    await saveCue(updated);
    cues = cues.map((cue) => cue.id === updated.id ? updated : cue);
    view = localView;
    window.dispatchEvent(new CustomEvent("shadowing:cueprogress", { detail: { cue: updated } }));
    render();
  }

  async function replay() {
    const cue = activeCue();
    if (!cue || !video || !video.currentSrc) {
      showFeedback("ابتدا ویدئوی محلی را انتخاب کنید.", "warning");
      return;
    }
    const offset = Number(project?.offsetMs || 0);
    const timing = effectiveCueTiming(cue, offset);
    const beforeMs = project?.replayPaddingBeforeMs ?? 250;
    const afterMs = project?.replayPaddingAfterMs ?? 250;
    const duration = Number.isFinite(video.duration) ? video.duration : Infinity;
    const start = Math.max(0, (timing.startMs - beforeMs) / 1000);
    const end = Math.min(duration, (timing.endMs + afterMs) / 1000);
    if (!(Number.isFinite(start) && end > start)) {
      showFeedback("زمان مؤثر Cue برای پخش معتبر نیست.", "danger");
      return;
    }
    if (replayFrame) cancelAnimationFrame(replayFrame);
    replayEndSeconds = end;
    video.pause();
    video.currentTime = start;
    try {
      await video.play();
    } catch {
      replayEndSeconds = null;
      showFeedback("پخش ویدئوی محلی آغاز نشد. دوباره تلاش کنید.", "warning");
      return;
    }
    const stopAtBoundary = () => {
      if (replayEndSeconds === null) return;
      if (video.currentTime >= replayEndSeconds || video.ended) {
        video.pause();
        replayEndSeconds = null;
        replayFrame = 0;
        return;
      }
      replayFrame = requestAnimationFrame(stopAtBoundary);
    };
    replayFrame = requestAnimationFrame(stopAtBoundary);
  }

  cueList.addEventListener("click", (event) => {
    const button = event.target.closest("[data-practice-cue]");
    if (!button) return;
    const cue = cues.find((item) => item.id === button.dataset.practiceCue && item.activeVersion && item.active !== false);
    if (!cue) return;
    selectedCueId = cue.id;
    view = "ready";
    input.value = "";
    showFeedback("پاسخ را تایپ کنید؛ متن زیرنویس تا ارسال پاسخ پنهان می‌ماند.", "info");
    render();
    input.focus();
  });

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const cue = activeCue();
    if (!cue) return;
    const rawAnswer = input.value;
    if (!rawAnswer.trim()) {
      showFeedback("پاسخ خالی ارسال نمی‌شود. برای رد کردن Cue از دکمهٔ رد کردن استفاده کنید.", "warning");
      input.focus();
      return;
    }
    const updated = recordCueAnswer(cue, rawAnswer);
    input.value = "";
    const correct = updated.attempts.at(-1).correct;
    await persistCue(updated, correct ? "correct" : "wrong");
    showFeedback(correct ? "پاسخ درست است." : "پاسخ نادرست است. می‌توانید دوباره تلاش کنید یا ادامه دهید.", correct ? "success" : "danger");
  });

  retryButton.addEventListener("click", async () => {
    const cue = activeCue();
    if (!cue) return;
    await persistCue(recordCueRetry(cue), "ready");
    input.value = "";
    showFeedback("پاسخ قبلی پاک شد. متن زیرنویس پنهان است؛ می‌توانید جمله را دوباره پخش کنید.", "info");
    input.focus();
  });

  continueButton.addEventListener("click", async () => {
    const cue = activeCue();
    if (!cue) return;
    await persistCue(recordCueContinue(cue), "continued");
    const next = nextCueAfter(cue);
    if (next) {
      selectedCueId = next.id;
      view = "ready";
      input.value = "";
      render();
      showFeedback("پاسخ نادرست ثبت شد؛ Cue بعدی آمادهٔ تمرین است.", "warning");
    } else {
      showFeedback("این Cue با وضعیت تلاش‌شده / نادرست ثبت شد. Cue گفتاری دیگری باقی نمانده است.", "warning");
    }
  });

  skipButton.addEventListener("click", async () => {
    const cue = activeCue();
    if (!cue) return;
    const updated = recordCueSkip(cue);
    await persistCue(updated, "skipped");
    showFeedback(updated.status === "skipped"
      ? "Cue بدون پاسخ رد شد. متن زیرنویس برای مرور نمایش داده می‌شود."
      : "رویداد رد کردن ثبت شد و وضعیت تلاش قبلی حفظ شد.", "secondary");
  });

  replayButton.addEventListener("click", () => replay().catch(() => showFeedback("پخش Cue ناموفق بود.", "warning")));
  panel.querySelector("[data-save-padding]").addEventListener("click", async () => {
    if (!project) return;
    const beforeMs = Math.round(Number(beforeInput.value) * 1000);
    const afterMs = Math.round(Number(afterInput.value) * 1000);
    try {
      await saveProjectReplayPadding(project.id, beforeMs, afterMs);
      project = { ...project, replayPaddingBeforeMs: beforeMs, replayPaddingAfterMs: afterMs };
      showFeedback("حاشیه‌های پخش برای این پروژه ذخیره شد.", "success");
    } catch (error) {
      showFeedback(error.message, "danger");
      render();
    }
  });

  window.addEventListener("shadowing:practiceprojectloaded", (event) => {
    project = event.detail?.project || null;
    cues = event.detail?.cues || [];
    selectedCueId = null;
    view = "ready";
    input.value = "";
    showFeedback("", "info");
    render();
  });
  window.addEventListener("shadowing:videoavailable", () => render());
  window.addEventListener("shadowing:workspacechange", () => {
    project = null;
    cues = [];
    selectedCueId = null;
    view = "ready";
    render();
  });
  render();
}
