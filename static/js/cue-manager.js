export function effectiveCueTiming(cue, projectOffsetMs = 0) {
  return {
    startMs: cue.originalStartMs + Number(projectOffsetMs || 0) + Number(cue.startAdjustmentMs ?? cue.adjustmentMs ?? 0),
    endMs: cue.originalEndMs + Number(projectOffsetMs || 0) + Number(cue.endAdjustmentMs ?? cue.adjustmentMs ?? 0),
  };
}

export function suggestCueSplit(cue) {
  const words = [...cue.text.matchAll(/\S+/g)];
  if (words.length < 2) return null;
  let splitIndex = -1;
  for (let index = 0; index < words.length - 1; index += 1) {
    if (/[.!?;:]$/.test(words[index][0])) splitIndex = index + 1;
  }
  if (splitIndex < 1 || splitIndex >= words.length) splitIndex = Math.floor(words.length / 2);
  const textOffset = words[splitIndex].index;
  const ratio = textOffset / cue.text.length;
  const startMs = cue.originalStartMs;
  const endMs = cue.originalEndMs;
  const suggestedTimeMs = Math.round((startMs + (endMs - startMs) * ratio) / 10) * 10;
  return {
    leftText: cue.text.slice(0, textOffset).trim(),
    rightText: cue.text.slice(textOffset).trim(),
    splitTimeMs: Math.min(endMs - 1, Math.max(startMs + 1, suggestedTimeMs)),
  };
}

export function splitCueRecord(cue, split, createId) {
  if (!cue?.activeVersion || !split?.leftText?.trim() || !split?.rightText?.trim()) {
    throw new TypeError("An active Cue and non-empty child texts are required.");
  }
  if (!Number.isFinite(split.splitTimeMs) || split.splitTimeMs <= cue.originalStartMs || split.splitTimeMs >= cue.originalEndMs) {
    throw new RangeError("The split time must fall inside the original Cue timing.");
  }
  const parent = {
    ...cue,
    activeVersion: false,
    childIds: [],
    history: [...(cue.history || []), {
      type: "split",
      status: cue.status,
      attempts: cue.attempts || [],
      at: new Date().toISOString(),
    }],
  };
  const children = [
    { text: split.leftText.trim(), originalStartMs: cue.originalStartMs, originalEndMs: split.splitTimeMs },
    { text: split.rightText.trim(), originalStartMs: split.splitTimeMs, originalEndMs: cue.originalEndMs },
  ].map((part, index) => ({
    ...cue,
    ...part,
    id: createId(),
    parentId: cue.id,
    childIds: [],
    isRoot: false,
    activeVersion: true,
    status: "not-attempted",
    attempts: [],
    history: [],
    adjustmentMs: 0,
    startAdjustmentMs: index === 0 ? (cue.startAdjustmentMs || cue.adjustmentMs || 0) : 0,
    endAdjustmentMs: index === 1 ? (cue.endAdjustmentMs || cue.adjustmentMs || 0) : 0,
  }));
  parent.childIds = children.map((child) => child.id);
  return { parent, children };
}

function createUuid() {
  return globalThis.crypto?.randomUUID?.() || `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

const root = typeof document === "undefined" ? null : document.querySelector("[data-subtitle-manager]");
if (root) {
  const fileInput = root.querySelector("[data-subtitle-file]");
  const importMessage = root.querySelector("[data-subtitle-message]");
  const preview = root.querySelector("[data-subtitle-preview]");
  const confirmButton = root.querySelector("[data-confirm-subtitle]");
  const projectsList = root.querySelector("[data-practice-projects]");
  const cueList = root.querySelector("[data-cue-list]");
  const offsetInput = root.querySelector("[data-subtitle-offset]");
  const videoName = root.querySelector("[data-subtitle-video-name]");
  let workspaceId = null;
  let video = null;
  let pendingImport = null;
  let activeProject = null;
  let activeSubtitle = null;
  let cues = [];

  function message(text, tone = "info") {
    importMessage.textContent = text;
    importMessage.className = `alert alert-${tone}`;
  }

  function node(tag, text, className = "") {
    const element = document.createElement(tag);
    element.textContent = text;
    if (className) element.className = className;
    return element;
  }

  function renderPreview(parsed) {
    preview.replaceChildren();
    if (parsed.errors.length) {
      const errorList = node("ul", "", "text-danger small");
      parsed.errors.forEach((error) => errorList.append(node("li", `بلوک ${error.block}: ${error.reason}`)));
      preview.append(errorList);
    }
    if (!parsed.cues.length) {
      preview.append(node("p", "Cue معتبر برای استفاده پیدا نشد.", "text-secondary"));
    }
    parsed.cues.forEach((cue, index) => {
      const row = node("article", "", "subtitle-preview-cue border rounded p-3 mb-2");
      const time = `${(cue.originalStartMs / 1000).toFixed(3)} – ${(cue.originalEndMs / 1000).toFixed(3)}`;
      row.append(node("div", `#${cue.sourceBlock} · ${time}s · ${cue.type === "non-speech" ? "غیرگفتاری" : "گفتار"}`, "small text-secondary"));
      row.append(node("p", cue.text, "mb-2"));
      const label = node("label", "برچسب گوینده");
      const speaker = document.createElement("input");
      speaker.type = "text";
      speaker.className = "form-control form-control-sm subtitle-speaker";
      speaker.value = cue.speaker || "";
      speaker.placeholder = "بدون برچسب";
      speaker.dataset.cueIndex = String(index);
      speaker.setAttribute("aria-label", `برچسب گویندهٔ Cue ${index + 1}`);
      label.append(speaker);
      row.append(label);
      const nonSpeechLabel = node("label", "Cue غیرگفتاری");
      const nonSpeech = document.createElement("input");
      nonSpeech.type = "checkbox";
      nonSpeech.checked = cue.type === "non-speech";
      nonSpeech.dataset.cueIndex = String(index);
      nonSpeech.className = "form-check-input ms-2";
      nonSpeechLabel.append(nonSpeech);
      row.append(nonSpeechLabel);
      const activeLabel = node("label", "فعال برای تمرین");
      const active = document.createElement("input");
      active.type = "checkbox";
      active.checked = cue.active;
      active.dataset.cueIndex = String(index);
      active.className = "form-check-input ms-2";
      activeLabel.append(active);
      row.append(activeLabel);
      preview.append(row);
    });
    confirmButton.disabled = parsed.cues.length === 0;
    confirmButton.textContent = parsed.errors.length ? `تأیید و استفاده از ${parsed.cues.length} Cue معتبر` : `تأیید و ساخت پروژه با ${parsed.cues.length} Cue`;
  }

  async function subtitleDigest(text) {
    if (!globalThis.crypto?.subtle) throw new Error("محاسبهٔ شناسهٔ زیرنویس در این مرورگر پشتیبانی نمی‌شود.");
    const bytes = new TextEncoder().encode(text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n"));
    const hash = await crypto.subtle.digest("SHA-256", bytes);
    return Array.from(new Uint8Array(hash), (byte) => byte.toString(16).padStart(2, "0")).join("");
  }

  async function loadProject(projectId) {
    const data = await import("./indexeddb-storage.js").then((storage) => storage.getProjectData(projectId));
    if (!data) return;
    activeProject = data.project;
    activeSubtitle = data.subtitle;
    cues = data.cues || [];
    offsetInput.value = (activeProject.offsetMs || 0) / 1000;
    renderCueList();
    window.dispatchEvent(new CustomEvent("shadowing:practiceprojectloaded", {
      detail: { project: activeProject, cues },
    }));
    message(`پروژهٔ «${activeProject.subtitleName}» باز شد؛ ${cues.filter((cue) => cue.activeVersion).length} Cue جاری.`, "success");
  }

  async function loadProjects() {
    projectsList.replaceChildren();
    cueList.replaceChildren();
    activeProject = null;
    activeSubtitle = null;
    cues = [];
    window.dispatchEvent(new CustomEvent("shadowing:practiceprojectloaded", { detail: null }));
    offsetInput.disabled = true;
    if (!workspaceId || !video?.id) return;
    const storage = await import("./indexeddb-storage.js");
    const projects = (await storage.listPracticeProjects(workspaceId))
      .filter((project) => project.videoKey === video.fingerprint.digest)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
    if (!projects.length) return;
    offsetInput.disabled = false;
    projects.forEach((project) => {
      const button = node("button", `${project.subtitleName} · ${new Date(project.createdAt).toLocaleDateString()}`, "btn btn-outline-primary btn-sm me-2 mb-2");
      button.type = "button";
      button.addEventListener("click", () => loadProject(project.id).catch((error) => message(error.message, "danger")));
      projectsList.append(button);
    });
    await loadProject(projects[0].id);
  }

  function formatTime(ms) {
    return `${(ms / 1000).toFixed(3)}s`;
  }

  function cueStatusLabel(status) {
    return ({
      "not-attempted": "انجام‌نشده",
      completed: "تکمیل‌شده",
      "attempted-incorrect": "تلاش‌شده / نادرست",
      skipped: "ردشده",
    })[status] || status;
  }

  function renderCueList() {
    cueList.replaceChildren();
    cues.filter((cue) => cue.activeVersion).sort((a, b) => a.originalStartMs - b.originalStartMs).forEach((cue) => {
      const card = node("article", "", "cue-card border rounded p-3 mb-2");
      const effective = effectiveCueTiming(cue, activeProject?.offsetMs || 0);
      card.append(node("div", `${formatTime(effective.startMs)} – ${formatTime(effective.endMs)} · وضعیت: ${cueStatusLabel(cue.status)}${cue.speaker ? ` · ${cue.speaker}` : ""}${cue.type === "non-speech" ? " · غیرگفتاری" : ""}`, "small text-secondary"));
      if (cue.type !== "non-speech" && cue.active !== false) {
        const practice = node("button", "تمرین این جمله", "btn btn-sm btn-success mt-2");
        practice.type = "button";
        practice.dataset.practiceCue = cue.id;
        card.append(practice);
      }
      const editor = document.createElement("details");
      editor.className = "cue-editor mt-2";
      editor.append(node("summary", "مدیریت متن و زمان Cue"));
      const text = document.createElement("textarea");
      text.className = "form-control my-2";
      text.value = cue.text;
      text.rows = 2;
      text.setAttribute("aria-label", "متن Cue");
      editor.append(text);
      const controls = node("div", "", "d-flex flex-wrap gap-2");
      const start = document.createElement("input");
      start.type = "number"; start.step = "0.001"; start.value = effective.startMs / 1000;
      start.className = "form-control cue-time"; start.setAttribute("aria-label", "زمان شروع مؤثر (ثانیه)");
      const end = document.createElement("input");
      end.type = "number"; end.step = "0.001"; end.value = effective.endMs / 1000;
      end.className = "form-control cue-time"; end.setAttribute("aria-label", "زمان پایان مؤثر (ثانیه)");
      const save = node("button", "ذخیرهٔ ویرایش", "btn btn-sm btn-primary"); save.type = "button";
      save.addEventListener("click", async () => {
        const startMs = Math.round(Number(start.value) * 1000);
        const endMs = Math.round(Number(end.value) * 1000);
        if (!Number.isFinite(startMs) || !Number.isFinite(endMs) || startMs < 0 || endMs <= startMs) { message("زمان شروع و پایان Cue معتبر نیست.", "danger"); return; }
        const startAdjustmentMs = startMs - cue.originalStartMs - (activeProject.offsetMs || 0);
        const endAdjustmentMs = endMs - cue.originalEndMs - (activeProject.offsetMs || 0);
        const updated = { ...cue, text: text.value.trim(), startAdjustmentMs, endAdjustmentMs, updatedAt: new Date().toISOString() };
        if (!updated.text) { message("متن Cue نمی‌تواند خالی باشد.", "danger"); return; }
        const storage = await import("./indexeddb-storage.js");
        activeProject = { ...activeProject, updatedAt: new Date().toISOString() };
        await storage.saveCueAndProject(updated, activeProject);
        cues = cues.map((item) => item.id === cue.id ? updated : item); renderCueList(); message("ویرایش Cue ذخیره شد.", "success");
      });
      const split = node("button", "تقسیم Cue", "btn btn-sm btn-outline-secondary"); split.type = "button";
      split.addEventListener("click", () => openSplitEditor(cue, card));
      controls.append(start, end, save, split); editor.append(controls); card.append(editor); cueList.append(card);
    });
  }

  function openSplitEditor(cue, card) {
    const suggestion = globalThis.ShadowingCueTools.suggestCueSplit(cue);
    if (!suggestion) { message("برای تقسیم، متن باید دست‌کم دو واژه داشته باشد.", "warning"); return; }
    const editor = node("div", "", "border rounded p-3 mt-3");
    editor.append(node("p", "نقطهٔ تقسیم پیشنهادی بر اساس مرز جمله/واژه و نسبت زمانی است؛ هر دو بخش را می‌توان ویرایش کرد."));
    const left = document.createElement("textarea"); left.className = "form-control mb-2"; left.value = suggestion.leftText; left.setAttribute("aria-label", "متن Cue فرزند اول");
    const right = document.createElement("textarea"); right.className = "form-control mb-2"; right.value = suggestion.rightText; right.setAttribute("aria-label", "متن Cue فرزند دوم");
    const time = document.createElement("input"); time.type = "number"; time.step = "0.01"; time.min = (cue.originalStartMs / 1000).toFixed(2); time.max = (cue.originalEndMs / 1000).toFixed(2); time.value = (suggestion.splitTimeMs / 1000).toFixed(2); time.className = "form-control cue-time"; time.setAttribute("aria-label", "زمان مرز تقسیم به ثانیه");
    const apply = node("button", "اعمال تقسیم", "btn btn-sm btn-primary mt-2"); apply.type = "button";
    apply.addEventListener("click", async () => {
      const split = { leftText: left.value, rightText: right.value, splitTimeMs: Math.round(Number(time.value) * 1000) };
      const { parent, children } = globalThis.ShadowingCueTools.splitCueRecord(cue, split, createUuid);
      const storage = await import("./indexeddb-storage.js");
      await storage.splitStoredCue(parent, children, { ...activeProject, updatedAt: new Date().toISOString() });
      cues = cues.filter((item) => item.id !== cue.id).concat(parent, children); renderCueList(); message("Cue به دو فرزند Not Attempted تقسیم شد؛ تاریخچهٔ والد حفظ شد.", "success");
    });
    editor.append(left, right, time, apply); card.append(editor);
  }

  fileInput.addEventListener("change", async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    pendingImport = null;
    confirmButton.disabled = true;
    preview.replaceChildren();
    if (!workspaceId || !video?.fingerprint) { message("ابتدا Workspace و ویدئوی دارای fingerprint انتخاب کنید.", "warning"); fileInput.value = ""; return; }
    const { detectSubtitleFormat, parseSubtitle } = await import("./subtitle-parser.js");
    const format = detectSubtitleFormat(file.name);
    if (!format) { message("فقط فایل‌های SRT و VTT پشتیبانی می‌شوند.", "danger"); fileInput.value = ""; return; }
    try {
      const text = await file.text();
      const parsed = parseSubtitle(text, format);
      if (!parsed.cues.length) { message("Cue معتبری یافت نشد؛ فایل ذخیره نشد.", "danger"); }
      else {
        pendingImport = { file, text, parsed };
        renderPreview(parsed);
        message(`${parsed.cues.length} Cue معتبر و ${parsed.errors.length} خطا. برای ذخیرهٔ پروژه، پیش‌نمایش را بازبینی و صریحاً تأیید کنید.`, parsed.errors.length ? "warning" : "info");
      }
    } catch (error) { message(`خواندن زیرنویس ناموفق بود: ${error.message}`, "danger"); }
  });

  preview.addEventListener("change", (event) => {
    if (!pendingImport) return;
    const index = Number(event.target.dataset.cueIndex);
    const cue = pendingImport.parsed.cues[index];
    if (!cue) return;
    if (event.target.matches(".subtitle-speaker")) cue.speaker = event.target.value.trim() || null;
    else if (event.target.type === "checkbox" && event.target.parentElement.textContent.includes("غیرگفتاری")) {
      cue.type = event.target.checked ? "non-speech" : "speech";
      cue.active = event.target.checked ? false : true;
      renderPreview(pendingImport.parsed);
    } else if (event.target.type === "checkbox") cue.active = event.target.checked;
  });

  confirmButton.addEventListener("click", async () => {
    if (!pendingImport || !workspaceId || !video?.id) return;
    confirmButton.disabled = true;
    try {
      const digest = await subtitleDigest(pendingImport.text);
      const projectId = createUuid();
      const subtitleId = createUuid();
      const now = new Date().toISOString();
      const project = { id: projectId, workspaceId, videoId: video.id, videoKey: video.fingerprint.digest, videoFingerprint: video.fingerprint, subtitleId, subtitleDigest: digest, subtitleName: pendingImport.file.name, format: pendingImport.parsed.format, offsetMs: 0, createdAt: now, updatedAt: now };
      const subtitle = { id: subtitleId, projectId, fileName: pendingImport.file.name, format: pendingImport.parsed.format, content: pendingImport.text, importedAt: now };
      const importedCues = pendingImport.parsed.cues.map((cue) => ({ ...cue, projectId, createdAt: now, updatedAt: now }));
      const storage = await import("./indexeddb-storage.js");
      const result = await storage.saveImportedPracticeProject({ project, subtitle, cues: importedCues });
      pendingImport = null; preview.replaceChildren(); fileInput.value = "";
      await loadProjects();
      await loadProject(result.project.id);
      if (result.existing) message("این زیرنویس قبلاً وارد شده بود؛ همان پروژه باز شد و پیشرفت آن حفظ شد.", "success");
      else message("پروژهٔ تمرینی جدید در IndexedDB ساخته شد. فایل‌ها به سرور ارسال نشدند.", "success");
    } catch (error) { message(`ذخیرهٔ پروژه ناموفق بود: ${error.message}`, "danger"); }
    finally { confirmButton.disabled = false; }
  });

  offsetInput.addEventListener("change", async () => {
    if (!activeProject) return;
    try {
      const seconds = Number(offsetInput.value);
      const storage = await import("./indexeddb-storage.js"); await storage.saveProjectOffset(activeProject.id, seconds);
      activeProject = { ...activeProject, offsetMs: Math.round(seconds * 1000) };
      message("Offset کلی زیرنویس ذخیره شد؛ زمان‌های اصلی تغییر نکردند.", "success");
    } catch (error) { message(error.message, "danger"); offsetInput.value = (activeProject.offsetMs || 0) / 1000; }
  });

  window.addEventListener("shadowing:workspacechange", (event) => { workspaceId = event.detail.workspaceId; loadProjects().catch((error) => message(error.message, "danger")); });
  window.addEventListener("shadowing:cueprogress", (event) => {
    const updated = event.detail?.cue;
    if (!updated) return;
    cues = cues.map((cue) => cue.id === updated.id ? updated : cue);
    renderCueList();
  });
  window.addEventListener("shadowing:videoavailable", (event) => {
    video = event.detail.metadata;
    videoName.textContent = video ? `ویدئوی پیوندشده: ${video.fileName}` : "برای واردکردن زیرنویس، ابتدا ویدئو را انتخاب کنید.";
    loadProjects().catch((error) => message(error.message, "danger"));
  });
  import("./indexeddb-storage.js").then((storage) => storage.getActiveWorkspaceId()).then((id) => {
    workspaceId = id;
    return loadProjects();
  }).catch((error) => message(error.message, "danger"));
}

if (typeof window !== "undefined") window.ShadowingCueTools = { effectiveCueTiming, suggestCueSplit, splitCueRecord };
