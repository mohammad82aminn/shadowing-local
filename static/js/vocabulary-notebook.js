import {
  getActiveWorkspaceId,
  listCachedVocabulary,
  replaceCachedVocabulary,
  queueVocabularySave,
  queueVocabularyDelete,
  listVocabularyOutbox,
  listVocabularyConflicts,
  recordVocabularySyncResult,
  resolveVocabularyConflict,
} from "./indexeddb-storage.js";
import { createWorkspaceLeaseManager } from "./workspace-lease.js";

export function normalizeVocabularyForm(value) {
  return String(value ?? "").trim().replace(/\s+/gu, " ").toLocaleLowerCase("en");
}

export function selectCueWord(text, index) {
  const words = String(text ?? "").trim().split(/\s+/u).filter(Boolean);
  return Number.isInteger(index) && index >= 0 && index < words.length ? words[index] : "";
}

export function selectCuePhrase(text, firstIndex, lastIndex) {
  const words = String(text ?? "").trim().split(/\s+/u).filter(Boolean);
  if (![firstIndex, lastIndex].every(Number.isInteger)
    || firstIndex < 0 || lastIndex < 0
    || firstIndex >= words.length || lastIndex >= words.length) return "";
  const start = Math.min(firstIndex, lastIndex);
  const end = Math.max(firstIndex, lastIndex);
  return words.slice(start, end + 1).join(" ");
}

const root = typeof document === "undefined"
  ? null
  : document.querySelector("[data-vocabulary-notebook]");

if (root) {
  const form = root.querySelector("[data-vocabulary-form]");
  const entryInput = root.querySelector("[data-vocabulary-entry-form]");
  const meanings = root.querySelector("[data-vocabulary-meanings]");
  const list = root.querySelector("[data-vocabulary-list]");
  const search = root.querySelector("[data-vocabulary-search]");
  const message = root.querySelector("[data-vocabulary-message]");
  const saveButton = root.querySelector("[data-save-vocabulary]");
  const cancelButton = root.querySelector("[data-cancel-vocabulary]");
  const collectionTemplate = root.dataset.vocabularyCollectionTemplate;
  const lemmaSuggestionsTemplate = root.dataset.lemmaSuggestionsTemplate;
  const syncTemplate = root.dataset.vocabularySyncTemplate;
  const syncButton = root.querySelector("[data-vocabulary-sync]");
  const syncStatus = root.querySelector("[data-sync-status]");
  const conflictPanel = root.querySelector("[data-vocabulary-conflicts]");
  const lemmaPanel = root.querySelector("[data-lemma-panel]");
  const lemmaMessage = root.querySelector("[data-lemma-message]");
  const lemmaOptions = root.querySelector("[data-lemma-options]");
  const lemmaInput = root.querySelector("[data-lemma-form]");
  const lemmaSuggestButton = root.querySelector("[data-lemma-suggest]");
  const lemmaConfirmButton = root.querySelector("[data-lemma-confirm]");
  const lemmaRejectButton = root.querySelector("[data-lemma-reject]");
  const selection = document.querySelector("[data-vocabulary-selection]");
  const wordsElement = document.querySelector("[data-subtitle-words]");
  const phraseModeButton = document.querySelector("[data-phrase-mode]");
  const selectionHelp = document.querySelector("[data-selection-help]");
  let workspaceId = null;
  let entries = [];
  let editingId = null;
  let phraseMode = false;
  let phraseStart = null;
  let revealed = new Set();
  let searchTimer = 0;
  let syncing = false;
  let leaseManager = null;

  function setMessage(text, tone = "secondary") {
    message.textContent = text;
    message.className = `small text-${tone}`;
  }

  function readCookie(name) {
    const prefix = `${name}=`;
    const part = document.cookie.split(";").map((item) => item.trim())
      .find((item) => item.startsWith(prefix));
    return part ? decodeURIComponent(part.slice(prefix.length)) : "";
  }

  function collectionUrl() {
    return collectionTemplate.replace("00000000-0000-0000-0000-000000000000", workspaceId);
  }

  function lemmaUrl(template) {
    return template.replace("00000000-0000-0000-0000-000000000000", workspaceId);
  }

  function syncUrl() {
    return syncTemplate.replace("00000000-0000-0000-0000-000000000000", workspaceId);
  }

  function newId() {
    return globalThis.crypto?.randomUUID?.()
      || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (char) => {
        const random = Math.floor(Math.random() * 16);
        return (char === "x" ? random : (random & 3) | 8).toString(16);
      });
  }

  async function request(url, options = {}) {
    const headers = new Headers(options.headers || {});
    if (options.body) {
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRFToken", readCookie("csrftoken"));
    }
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(payload.error || "vocabulary_request_failed");
      error.status = response.status;
      error.payload = payload;
      throw error;
    }
    return payload;
  }

  function addMeaningRow(value = "") {
    const row = document.createElement("div");
    row.className = "input-group mb-2 vocabulary-meaning-row";
    const label = document.createElement("label");
    label.className = "visually-hidden";
    label.textContent = "معنی فارسی";
    const input = document.createElement("input");
    input.className = "form-control";
    input.type = "text";
    input.maxLength = 500;
    input.value = value;
    input.placeholder = "معنی فارسی (اختیاری)";
    input.dataset.meaningInput = "";
    label.append(input);
    const remove = document.createElement("button");
    remove.className = "btn btn-outline-secondary";
    remove.type = "button";
    remove.textContent = "حذف معنی";
    remove.addEventListener("click", () => row.remove());
    row.append(label, remove);
    meanings.append(row);
  }

  function resetForm() {
    editingId = null;
    form.reset();
    meanings.replaceChildren();
    saveButton.textContent = "ثبت مدخل";
    cancelButton.hidden = true;
  }

  function openEditor(entry) {
    editingId = entry.id;
    entryInput.value = entry.form;
    meanings.replaceChildren();
    entry.meanings.forEach((meaning) => addMeaningRow(meaning.text));
    saveButton.textContent = "ذخیرهٔ ویرایش";
    cancelButton.hidden = false;
    entryInput.focus();
    form.scrollIntoView({ behavior: "smooth", block: "center" });
    setMessage("مدخل قبلی برای ویرایش باز شد.", "info");
  }

  function renderEntries() {
    list.replaceChildren();
    if (!entries.length) {
      const empty = document.createElement("p");
      empty.className = "text-secondary mb-0";
      empty.textContent = "مدخلی پیدا نشد.";
      list.append(empty);
      return;
    }
    entries.forEach((entry) => {
      const item = document.createElement("article");
      item.className = "list-group-item vocabulary-entry";
      const heading = document.createElement("div");
      heading.className = "d-flex flex-wrap justify-content-between align-items-center gap-2";
      const term = document.createElement("strong");
      term.dir = "auto";
      term.textContent = entry.form;
      const actions = document.createElement("div");
      actions.className = "d-flex flex-wrap gap-2";
      const toggle = document.createElement("button");
      toggle.className = "btn btn-sm btn-outline-secondary";
      toggle.type = "button";
      toggle.textContent = revealed.has(entry.id) ? "پنهان‌کردن معنی‌ها" : `نمایش معنی‌ها (${entry.meanings.length})`;
      toggle.setAttribute("aria-expanded", String(revealed.has(entry.id)));
      toggle.addEventListener("click", () => {
        if (revealed.has(entry.id)) revealed.delete(entry.id);
        else revealed.add(entry.id);
        renderEntries();
      });
      const edit = document.createElement("button");
      edit.className = "btn btn-sm btn-outline-primary";
      edit.type = "button";
      edit.textContent = "ویرایش";
      edit.addEventListener("click", () => openEditor(entry));
      const remove = document.createElement("button");
      remove.className = "btn btn-sm btn-outline-danger";
      remove.type = "button";
      remove.textContent = "حذف";
      remove.addEventListener("click", () => deleteEntry(entry));
      actions.append(toggle, edit, remove);
      heading.append(term, actions);
      item.append(heading);
      const lemmaForm = entry.lemmaForm || entries.find((candidate) => candidate.id === entry.lemmaEntryId)?.form;
      if (lemmaForm) {
        const relation = document.createElement("p");
        relation.className = "small text-secondary mt-2 mb-0";
        relation.dir = "auto";
        relation.textContent = `صورت پایه: ${lemmaForm}`;
        item.append(relation);
      }
      if (revealed.has(entry.id)) {
        const meaningList = document.createElement("ul");
        meaningList.className = "mt-2 mb-0";
        meaningList.dir = "rtl";
        entry.meanings.forEach((meaning) => {
          const row = document.createElement("li");
          row.textContent = meaning.text;
          meaningList.append(row);
        });
        if (!entry.meanings.length) {
          const none = document.createElement("p");
          none.className = "small text-secondary mt-2 mb-0";
          none.textContent = "هنوز معنی‌ای ثبت نشده است.";
          item.append(none);
        } else item.append(meaningList);
      }
      list.append(item);
    });
  }

  async function renderSyncState() {
    if (!workspaceId) return;
    const [pending, conflicts] = await Promise.all([
      listVocabularyOutbox(workspaceId), listVocabularyConflicts(workspaceId),
    ]);
    syncStatus.textContent = pending.length ? `عملیات منتظر: ${pending.length}` : "صف خالی است";
    conflictPanel.replaceChildren();
    conflictPanel.hidden = conflicts.length === 0;
    conflicts.forEach((conflict) => {
      const row = document.createElement("div");
      row.className = "d-flex flex-wrap align-items-center gap-2 mb-2";
      const label = document.createElement("span");
      const serverVersion = conflict.serverEntry?.version ?? "حذف شده";
      const localVersion = conflict.operation.baseVersion + 1;
      label.textContent = `تعارض «${conflict.operation.payload?.form || conflict.operation.entryId}» (${conflict.error}) — پایه ${conflict.operation.baseVersion}، سرور ${serverVersion}، محلی ${localVersion}`;
      const server = document.createElement("button");
      server.type = "button";
      server.className = "btn btn-sm btn-outline-secondary";
      server.textContent = "نگه‌داشتن نسخهٔ سرور";
      server.addEventListener("click", async () => {
        await resolveVocabularyConflict(conflict.operationId, false);
        await refresh(search.value.trim());
        await renderSyncState();
      });
      const local = document.createElement("button");
      local.type = "button";
      local.className = "btn btn-sm btn-outline-primary";
      local.textContent = "نگه‌داشتن نسخهٔ محلی و ارسال دوباره";
      local.addEventListener("click", async () => {
        await resolveVocabularyConflict(conflict.operationId, true);
        await syncQueuedOperations();
        await refresh(search.value.trim());
        await renderSyncState();
      });
      const merge = document.createElement("button");
      merge.type = "button";
      merge.className = "btn btn-sm btn-outline-primary";
      merge.textContent = "ادغام دستی";
      merge.addEventListener("click", async () => {
        await resolveVocabularyConflict(conflict.operationId, true);
        entries = await listCachedVocabulary(workspaceId);
        const localEntry = entries.find((entry) => entry.id === conflict.operation.entryId)
          || entries.find((entry) => normalizeVocabularyForm(entry.form) === normalizeVocabularyForm(conflict.operation.payload?.form || ""));
        renderEntries();
        if (localEntry) openEditor(localEntry);
        await renderSyncState();
      });
      row.append(label, server, local, merge);
      conflictPanel.append(row);
    });
  }

  async function syncQueuedOperations() {
    if (!workspaceId || !navigator.onLine || syncing) return;
    syncing = true;
    syncButton.disabled = true;
    try {
      if (!leaseManager) throw new Error("lease_unavailable");
      await leaseManager.withLease(async (leaseHeaders) => {
        const operations = await listVocabularyOutbox(workspaceId);
        for (let offset = 0; offset < operations.length; offset += 50) {
          const batch = operations.slice(offset, offset + 50);
          const wireOperations = batch.map(({ operationId, workspaceId: operationWorkspaceId, type, entryId, baseVersion, payload }) => ({
            operationId, workspaceId: operationWorkspaceId, type, entryId, baseVersion, payload,
          }));
          const response = await request(syncUrl(), { method: "POST", headers: leaseHeaders, body: JSON.stringify({ operations: wireOperations }) });
          for (const result of response.results) await recordVocabularySyncResult(workspaceId, result.operationId, result);
        }
        const snapshot = await request(syncUrl());
        await replaceCachedVocabulary(workspaceId, snapshot.entries);
        entries = await listCachedVocabulary(workspaceId);
        renderEntries();
      });
      setMessage("همگام‌سازی انجام شد؛ تعارض‌ها برای تصمیم شما نگه داشته شده‌اند.", "success");
    } catch {
      setMessage("همگام‌سازی انجام نشد؛ عملیات با همان شناسه برای تلاش امن بعدی در صف ماند.", "warning");
    } finally {
      syncButton.disabled = false;
      syncing = false;
      await renderSyncState();
    }
  }

  async function refresh(query = "") {
    if (!workspaceId) return;
    try {
      const url = new URL(collectionUrl(), window.location.href);
      const payload = await request(url);
      await replaceCachedVocabulary(workspaceId, payload.entries);
      entries = await listCachedVocabulary(workspaceId);
      if (query) {
        const key = normalizeVocabularyForm(query);
        entries = entries.filter((entry) => normalizeVocabularyForm(entry.form).includes(key));
      }
      renderEntries();
      setMessage("دفتر محلی آماده است؛ تغییرها در صف همگام‌سازی نگهداری می‌شوند.", "success");
    } catch {
      try {
        entries = await listCachedVocabulary(workspaceId);
        if (query) {
          const key = normalizeVocabularyForm(query);
          entries = entries.filter((entry) => normalizeVocabularyForm(entry.form).includes(key));
        }
        renderEntries();
        setMessage("SQLite در دسترس نیست؛ cache محلی نمایش داده شد و ویرایش‌ها در صف می‌مانند.", "warning");
      } catch {
        entries = [];
        renderEntries();
        setMessage("دفتر واژگان در دسترس نیست؛ اتصال به SQLite محلی را بررسی کنید.", "danger");
      }
    }
    await renderSyncState();
  }

  function openDuplicate(error) {
    const duplicate = error.payload?.entry;
    if (!duplicate) return;
    const current = entries.find((entry) => entry.id === duplicate.id);
    if (current) openEditor(current);
    else {
      entries = [duplicate, ...entries];
      renderEntries();
      openEditor(duplicate);
    }
    setMessage("این واژه یا عبارت از قبل وجود دارد؛ مدخل قبلی برای ویرایش باز شد.", "warning");
  }

  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    if (!workspaceId) {
      setMessage("ابتدا یک Workspace فعال انتخاب کنید.", "warning");
      return;
    }
    const formValue = entryInput.value.trim().replace(/\s+/gu, " ");
    const normalized = normalizeVocabularyForm(formValue);
    const duplicate = entries.find((entry) => entry.id !== editingId
      && normalizeVocabularyForm(entry.form) === normalized);
    if (duplicate) {
      openEditor(duplicate);
      setMessage("این واژه یا عبارت در همین Workspace وجود دارد؛ مدخل قبلی برای ویرایش باز شد.", "warning");
      return;
    }
    const meaningValues = [...meanings.querySelectorAll("[data-meaning-input]")]
      .map((input) => input.value.trim()).filter(Boolean);
    saveButton.disabled = true;
    try {
      const current = entries.find((entry) => entry.id === editingId);
      const payload = {
        id: editingId || newId(), workspaceId, form: formValue,
        meanings: meaningValues.map((text, index) => ({ id: current?.meanings?.[index]?.id, text })),
        lemmaEntryId: current?.lemmaEntryId || null, version: current?.version || 0,
      };
      const operation = await queueVocabularySave(workspaceId, payload, payload.version);
      const localEntry = { ...payload, meanings: operation.payload.meanings, version: operation.baseVersion, syncState: "pending" };
      const oldIndex = entries.findIndex((entry) => entry.id === localEntry.id);
      if (oldIndex >= 0) entries[oldIndex] = localEntry;
      else entries.unshift(localEntry);
      resetForm();
      search.value = "";
      renderEntries();
      await renderSyncState();
      setMessage("مدخل محلی ذخیره و در صف همگام‌سازی قرار گرفت.", "success");
      if (navigator.onLine) syncQueuedOperations();
    } catch (error) {
      if (error.status === 409 && error.payload?.entry) openDuplicate(error);
      else setMessage(error.message === "workspace_not_active"
        ? "Workspace بایگانی شده و ویرایش آن ممکن نیست."
        : "ذخیره انجام نشد؛ ورودی یا اتصال SQLite را بررسی کنید.", "danger");
    } finally {
      saveButton.disabled = false;
    }
  });

  function resetLemmaPanel() {
    lemmaPanel.hidden = true;
    lemmaOptions.replaceChildren();
    lemmaInput.value = "";
    lemmaInput.disabled = true;
    lemmaConfirmButton.disabled = true;
    lemmaMessage.textContent = "پیشنهاد را انتخاب یا اصلاح کنید؛ هیچ گزینه‌ای خودکار پذیرفته نمی‌شود.";
  }

  lemmaSuggestButton.addEventListener("click", async () => {
    if (!workspaceId) {
      setMessage("ابتدا یک Workspace فعال انتخاب کنید.", "warning");
      return;
    }
    const selectedForm = entryInput.value.trim().replace(/\s+/gu, " ");
    lemmaPanel.hidden = false;
    lemmaOptions.replaceChildren();
    lemmaInput.value = "";
    lemmaInput.disabled = true;
    lemmaConfirmButton.disabled = true;
    lemmaMessage.textContent = "در حال بررسی آفلاینِ واژه یا عبارت انتخاب‌شده…";
    lemmaSuggestButton.disabled = true;
    try {
      const result = await request(lemmaUrl(lemmaSuggestionsTemplate), {
        method: "POST",
        body: JSON.stringify({ form: selectedForm }),
      });
      lemmaMessage.textContent = result.suggestions.length
        ? "یکی از پیشنهادها را انتخاب کنید یا صورت پایه را اصلاح کنید؛ تأیید با شماست."
        : "پیشنهادی پیدا نشد؛ می‌توانید صورت پایه را دستی وارد کنید یا پیشنهاد را رد کنید.";
      lemmaInput.disabled = false;
      result.suggestions.forEach((suggestion) => {
        const button = document.createElement("button");
        button.className = "btn btn-sm btn-outline-primary";
        button.type = "button";
        button.textContent = `${suggestion.form} — ${suggestion.partOfSpeech}`;
        button.addEventListener("click", () => {
          lemmaInput.value = suggestion.form;
          lemmaConfirmButton.disabled = false;
          lemmaOptions.querySelectorAll("button").forEach((option) => option.classList.remove("active"));
          button.classList.add("active");
        });
        lemmaOptions.append(button);
      });
    } catch (error) {
      lemmaInput.disabled = false;
      lemmaMessage.textContent = error.status === 400
        ? "فقط یک واژه یا عبارت کوتاه را انتخاب کنید؛ جمله پذیرفته نمی‌شود."
        : "پیشنهاد آفلاین در دسترس نیست؛ اتصال محلی و Workspace را بررسی کنید.";
    } finally {
      lemmaSuggestButton.disabled = false;
    }
  });

  lemmaInput.addEventListener("input", () => {
    lemmaConfirmButton.disabled = !lemmaInput.value.trim();
    lemmaOptions.querySelectorAll("button").forEach((option) => option.classList.remove("active"));
  });

  lemmaConfirmButton.addEventListener("click", async () => {
    if (!workspaceId) return;
    const selectedForm = entryInput.value.trim().replace(/\s+/gu, " ");
    const selectedLemma = lemmaInput.value.trim().replace(/\s+/gu, " ");
    if (!selectedForm || !selectedLemma) return;
    lemmaConfirmButton.disabled = true;
    try {
      const observedKey = normalizeVocabularyForm(selectedForm);
      const lemmaKey = normalizeVocabularyForm(selectedLemma);
      let observed = entries.find((entry) => normalizeVocabularyForm(entry.form) === observedKey);
      if (!observed) observed = { id: newId(), workspaceId, form: selectedForm, meanings: [], lemmaEntryId: null, version: 0 };
      let lemma = entries.find((entry) => normalizeVocabularyForm(entry.form) === lemmaKey);
      if (!lemma && observedKey !== lemmaKey) {
        lemma = { id: newId(), workspaceId, form: selectedLemma, meanings: [], lemmaEntryId: null, version: 0 };
        await queueVocabularySave(workspaceId, lemma, 0);
        entries.unshift(lemma);
      }
      observed.lemmaEntryId = observedKey === lemmaKey ? null : lemma.id;
      const relationOperation = await queueVocabularySave(workspaceId, observed, observed.version || 0);
      if (!entries.some((entry) => entry.id === observed.id)) entries.unshift(observed);
      search.value = "";
      renderEntries();
      await renderSyncState();
      setMessage(observed.lemmaEntryId
        ? `رابطهٔ «${observed.form}» ← «${selectedLemma}» در صف ثبت شد.`
        : "مدخل مستقل ذخیره شد؛ صورت انتخاب‌شده با صورت پایه یکسان بود.", "success");
      resetLemmaPanel();
      if (navigator.onLine) syncQueuedOperations();
    } catch (error) {
      lemmaMessage.textContent = error.status === 400
        ? "ورودی باید فقط واژه یا عبارت انتخاب‌شده باشد، نه جمله."
        : "ثبت رابطه انجام نشد؛ اتصال SQLite محلی را بررسی کنید.";
      lemmaConfirmButton.disabled = false;
    }
  });

  lemmaRejectButton.addEventListener("click", () => {
    resetLemmaPanel();
    setMessage("پیشنهادها رد شدند و رابطه‌ای ذخیره نشد.", "secondary");
  });

  entryInput.addEventListener("input", () => {
    if (!lemmaPanel.hidden) resetLemmaPanel();
  });

  async function deleteEntry(entry) {
    if (!window.confirm(`مدخل «${entry.form}» و معنی‌های آن حذف شود؟`)) return;
    try {
      await queueVocabularyDelete(workspaceId, entry);
      revealed.delete(entry.id);
      search.value = "";
      entries = entries.filter((item) => item.id !== entry.id);
      renderEntries();
      await renderSyncState();
      setMessage("حذف محلی ذخیره و در صف همگام‌سازی قرار گرفت.", "success");
      if (navigator.onLine) syncQueuedOperations();
    } catch {
      setMessage("حذف انجام نشد؛ اتصال SQLite را بررسی کنید.", "danger");
    }
  }

  root.querySelector("[data-add-meaning]").addEventListener("click", () => addMeaningRow());
  cancelButton.addEventListener("click", resetForm);
  search.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => refresh(search.value.trim()), 180);
  });

  function renderSelectableCue(cue) {
    phraseMode = false;
    phraseStart = null;
    phraseModeButton.setAttribute("aria-pressed", "false");
    selectionHelp.textContent = "برای افزودن یک واژه، روی آن کلیک کنید.";
    wordsElement.replaceChildren();
    selection.hidden = !cue;
    if (!cue) return;
    const tokens = cue.text.trim().split(/\s+/u).filter(Boolean);
    tokens.forEach((token, index) => {
      const button = document.createElement("button");
      button.className = "btn btn-sm btn-light border subtitle-word";
      button.type = "button";
      button.textContent = token;
      button.dataset.wordIndex = String(index);
      button.addEventListener("click", () => {
        if (!phraseMode) {
          entryInput.value = selectCueWord(cue.text, index);
          entryInput.focus();
          form.scrollIntoView({ behavior: "smooth", block: "center" });
          setMessage("واژه انتخاب شد؛ معنی فارسی را در صورت نیاز اضافه و مدخل را ثبت کنید.", "info");
          return;
        }
        if (phraseStart === null) {
          phraseStart = index;
          selectionHelp.textContent = `ابتدا انتخاب شد؛ برای پایان عبارت روی واژه‌ای دیگر کلیک کنید.`;
          button.classList.add("active");
          return;
        }
        entryInput.value = selectCuePhrase(cue.text, phraseStart, index);
        phraseStart = null;
        phraseMode = false;
        phraseModeButton.setAttribute("aria-pressed", "false");
        selectionHelp.textContent = "عبارت انتخاب شد؛ معنی فارسی را در صورت نیاز اضافه و مدخل را ثبت کنید.";
        entryInput.focus();
        form.scrollIntoView({ behavior: "smooth", block: "center" });
      });
      wordsElement.append(button);
    });
  }

  phraseModeButton.addEventListener("click", () => {
    phraseMode = !phraseMode;
    phraseStart = null;
    phraseModeButton.setAttribute("aria-pressed", String(phraseMode));
    selectionHelp.textContent = phraseMode
      ? "روی واژهٔ ابتدا و سپس واژهٔ انتهای عبارت کلیک کنید."
      : "برای افزودن یک واژه، روی آن کلیک کنید.";
  });

  syncButton.addEventListener("click", () => syncQueuedOperations());
  window.addEventListener("online", () => syncQueuedOperations());

  window.addEventListener("shadowing:vocabularyselection", (event) => renderSelectableCue(event.detail?.cue || null));
  window.addEventListener("shadowing:workspacechange", (event) => {
    leaseManager?.stop();
    workspaceId = event.detail?.workspaceId || null;
    leaseManager = workspaceId ? createWorkspaceLeaseManager(workspaceId) : null;
    if (leaseManager) leaseManager.start().catch(() => {});
    entries = [];
    revealed.clear();
    resetLemmaPanel();
    selection.hidden = true;
    list.replaceChildren();
    if (workspaceId) refresh(search.value.trim()).then(() => syncQueuedOperations());
    else setMessage("برای استفاده، یک Workspace فعال انتخاب کنید.", "secondary");
  });

  getActiveWorkspaceId().then((activeId) => {
    if (!workspaceId && activeId) {
      workspaceId = activeId;
      leaseManager = createWorkspaceLeaseManager(workspaceId);
      leaseManager.start().catch(() => {});
      refresh(search.value.trim()).then(() => syncQueuedOperations());
    }
  }).catch(() => setMessage("خواندن Workspace از IndexedDB انجام نشد.", "danger"));
  window.addEventListener("pagehide", () => leaseManager?.stop());
  renderEntries();
  resetLemmaPanel();
}
