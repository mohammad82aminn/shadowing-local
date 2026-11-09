const DATABASE_NAME = "shadowing-local";
export const DATABASE_VERSION = 5;
const DEFAULT_WORKSPACE_SETTINGS = {
  language: "fa",
  appearance: "hybrid",
};

function workspaceSettingsKey(workspaceId) {
  return `workspace:${workspaceId}`;
}

function ensureWorkspaceSettings(transaction, workspace) {
  const settings = transaction.objectStore("settings");
  const key = workspaceSettingsKey(workspace.id);
  const request = settings.get(key);
  request.onsuccess = () => {
    if (!request.result) {
      settings.put({
        key,
        workspaceId: workspace.id,
        value: { ...DEFAULT_WORKSPACE_SETTINGS },
        updatedAt: new Date().toISOString(),
      });
    }
  };
}

export function ensureDatabaseSchema(database) {
  if (!database.objectStoreNames.contains("workspaces")) {
    const workspaces = database.createObjectStore("workspaces", { keyPath: "id" });
    workspaces.createIndex("status", "status", { unique: false });
  }
  if (!database.objectStoreNames.contains("settings")) {
    database.createObjectStore("settings", { keyPath: "key" });
  }
  if (!database.objectStoreNames.contains("pendingOperations")) {
    const pendingOperations = database.createObjectStore(
      "pendingOperations",
      { keyPath: "operationId" },
    );
    pendingOperations.createIndex("workspaceId", "workspaceId", { unique: false });
    pendingOperations.createIndex("type", "type", { unique: false });
  }
  if (!database.objectStoreNames.contains("videos")) {
    const videos = database.createObjectStore("videos", { keyPath: "id" });
    videos.createIndex("workspaceId", "workspaceId", { unique: false });
    videos.createIndex("selectedAt", "selectedAt", { unique: false });
  }
  if (!database.objectStoreNames.contains("practiceProjects")) {
    const projects = database.createObjectStore("practiceProjects", { keyPath: "id" });
    projects.createIndex("workspaceId", "workspaceId", { unique: false });
    projects.createIndex("videoId", "videoId", { unique: false });
    projects.createIndex("subtitleKey", ["workspaceId", "videoKey", "subtitleDigest"], { unique: true });
  }
  if (!database.objectStoreNames.contains("subtitles")) {
    const subtitles = database.createObjectStore("subtitles", { keyPath: "id" });
    subtitles.createIndex("projectId", "projectId", { unique: false });
  }
  if (!database.objectStoreNames.contains("cues")) {
    const cues = database.createObjectStore("cues", { keyPath: "id" });
    cues.createIndex("projectId", "projectId", { unique: false });
    cues.createIndex("parentId", "parentId", { unique: false });
  }
  if (!database.objectStoreNames.contains("vocabularyCache")) {
    const vocabulary = database.createObjectStore("vocabularyCache", { keyPath: "id" });
    vocabulary.createIndex("workspaceId", "workspaceId", { unique: false });
    vocabulary.createIndex("workspaceForm", ["workspaceId", "normalizedForm"], { unique: true });
  }
  if (!database.objectStoreNames.contains("syncOutbox")) {
    const outbox = database.createObjectStore("syncOutbox", { keyPath: "operationId" });
    outbox.createIndex("workspaceId", "workspaceId", { unique: false });
    outbox.createIndex("state", "state", { unique: false });
  }
  if (!database.objectStoreNames.contains("syncConflicts")) {
    const conflicts = database.createObjectStore("syncConflicts", { keyPath: "operationId" });
    conflicts.createIndex("workspaceId", "workspaceId", { unique: false });
  }
}

function newId() {
  return globalThis.crypto?.randomUUID?.() || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (char) => {
    const random = Math.floor(Math.random() * 16);
    return (char === "x" ? random : (random & 3) | 8).toString(16);
  });
}

export async function queueVocabularySave(workspaceId, entry, baseVersion = 0) {
  const database = await openDatabase();
  let operation = {
    operationId: newId(), workspaceId, type: "entry.save", entryId: entry.id,
    baseVersion, payload: {
      form: String(entry.form).trim().replace(/\s+/gu, " "),
      meanings: (entry.meanings || []).map((meaning) => ({ id: meaning.id || newId(), text: meaning.text })),
      lemmaEntryId: entry.lemmaEntryId || null,
    },
    state: "pending", createdAt: new Date().toISOString(),
  };
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "vocabularyCache", "syncOutbox"], "readwrite");
      const workspaceRequest = transaction.objectStore("workspaces").get(workspaceId);
      workspaceRequest.onsuccess = () => {
        if (!workspaceRequest.result || workspaceRequest.result.status !== "active") {
          transaction.abort(); reject(new Error("Vocabulary changes require an active Workspace.")); return;
        }
        const local = {
          ...entry, id: entry.id, workspaceId, form: operation.payload.form,
          meanings: operation.payload.meanings, normalizedForm: operation.payload.form.toLocaleLowerCase("en"),
          version: baseVersion, syncState: "pending", updatedAt: operation.createdAt,
        };
        const outbox = transaction.objectStore("syncOutbox");
        const pending = outbox.index("workspaceId").getAll(workspaceId);
        pending.onsuccess = () => {
          const previous = pending.result.find((item) => item.entryId === entry.id && item.state === "pending");
          if (previous) {
            operation = { ...operation, operationId: previous.operationId, baseVersion: previous.baseVersion, createdAt: previous.createdAt };
            outbox.delete(previous.operationId);
          } else {
            const lastCreated = pending.result.reduce((latest, item) => Math.max(latest, Date.parse(item.createdAt) || 0), 0);
            operation.createdAt = new Date(Math.max(Date.now(), lastCreated + 1)).toISOString();
          }
          transaction.objectStore("vocabularyCache").put({ ...local, version: operation.baseVersion, updatedAt: operation.createdAt });
          outbox.put(operation);
        };
      };
      transaction.oncomplete = () => resolve({ operation, entry: { ...entry, ...operation.payload, meanings: operation.payload.meanings } });
      transaction.onerror = () => reject(transaction.error || new Error("Vocabulary operation could not be queued."));
      transaction.onabort = () => reject(transaction.error || new Error("Vocabulary operation was aborted."));
    });
    return operation;
  } finally { database.close(); }
}

export async function queueVocabularyDelete(workspaceId, entry) {
  const database = await openDatabase();
  const operation = {
    operationId: newId(), workspaceId, type: "entry.delete", entryId: entry.id,
    baseVersion: entry.version || 0, payload: null, state: "pending", createdAt: new Date().toISOString(),
  };
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "vocabularyCache", "syncOutbox"], "readwrite");
      const workspaceRequest = transaction.objectStore("workspaces").get(workspaceId);
      workspaceRequest.onsuccess = () => {
        if (!workspaceRequest.result || workspaceRequest.result.status !== "active") {
          transaction.abort(); reject(new Error("Vocabulary changes require an active Workspace.")); return;
        }
        const outbox = transaction.objectStore("syncOutbox");
        const pending = outbox.index("workspaceId").getAll(workspaceId);
        pending.onsuccess = () => {
          const previous = pending.result.find((item) => item.entryId === entry.id && item.state === "pending");
          const effectiveVersion = previous ? previous.baseVersion : operation.baseVersion;
          if (previous) outbox.delete(previous.operationId);
          else {
            const lastCreated = pending.result.reduce((latest, item) => Math.max(latest, Date.parse(item.createdAt) || 0), 0);
            operation.createdAt = new Date(Math.max(Date.now(), lastCreated + 1)).toISOString();
          }
          transaction.objectStore("vocabularyCache").delete(entry.id);
          if (effectiveVersion > 0) {
            operation = { ...operation, operationId: previous?.operationId || operation.operationId, baseVersion: effectiveVersion };
            outbox.put(operation);
          } else operation = null;
        };
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Vocabulary deletion could not be queued."));
      transaction.onabort = () => reject(transaction.error || new Error("Vocabulary deletion was aborted."));
    });
    return operation;
  } finally { database.close(); }
}

export async function listVocabularyOutbox(workspaceId) {
  const database = await openDatabase();
  try {
    return (await readRequest(database, "syncOutbox", (store) => store.index("workspaceId").getAll(workspaceId)))
      .filter((operation) => operation.state === "pending")
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  } finally { database.close(); }
}

export async function listVocabularyConflicts(workspaceId) {
  const database = await openDatabase();
  try { return await readRequest(database, "syncConflicts", (store) => store.index("workspaceId").getAll(workspaceId)); }
  finally { database.close(); }
}

export async function recordVocabularySyncResult(workspaceId, operationId, result) {
  const database = await openDatabase();
  try {
    await runTransaction(database, ["syncOutbox", "syncConflicts", "vocabularyCache"], "readwrite", (transaction) => {
      const outbox = transaction.objectStore("syncOutbox");
      const request = outbox.get(operationId);
      request.onsuccess = () => {
        const operation = request.result;
        if (!operation || operation.workspaceId !== workspaceId) return;
        if (result.status === "applied") {
          outbox.delete(operationId);
          transaction.objectStore("syncConflicts").delete(operationId);
          if (result.result?.entry) transaction.objectStore("vocabularyCache").put({ ...result.result.entry, syncState: "synced" });
          if (result.result?.deleted) transaction.objectStore("vocabularyCache").delete(result.result.entryId);
        } else if (result.status === "conflict" || result.status === "rejected") {
          operation.state = "conflict";
          outbox.put(operation);
          transaction.objectStore("syncConflicts").put({
            operationId, workspaceId, operation, serverEntry: result.serverEntry || null,
            error: result.error || "sync_conflict", detectedAt: new Date().toISOString(),
          });
        }
      };
    });
  } finally { database.close(); }
}

export async function resolveVocabularyConflict(operationId, keepLocal) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["syncOutbox", "syncConflicts", "vocabularyCache"], "readwrite");
      const conflicts = transaction.objectStore("syncConflicts");
      const request = conflicts.get(operationId);
      let replacement = null;
      request.onsuccess = () => {
        const conflict = request.result;
        if (!conflict) { transaction.abort(); reject(new Error("Vocabulary conflict was not found.")); return; }
        const { operation, serverEntry } = conflict;
        const cache = transaction.objectStore("vocabularyCache");
        if (!keepLocal || (operation.type === "entry.delete" && !serverEntry)) {
          cache.delete(operation.entryId);
          if (serverEntry) cache.put({ ...serverEntry, syncState: "synced" });
          transaction.objectStore("syncOutbox").delete(operationId);
          conflicts.delete(operationId);
          return;
        }
        replacement = {
          ...operation, operationId: newId(), baseVersion: serverEntry?.version || 0,
          state: "pending", createdAt: operation.createdAt,
        };
        if (serverEntry && operation.type === "entry.save" && serverEntry.id !== operation.entryId) {
          replacement.entryId = serverEntry.id;
          cache.delete(operation.entryId);
        }
        transaction.objectStore("syncOutbox").delete(operationId);
        transaction.objectStore("syncOutbox").add(replacement);
        conflicts.delete(operationId);
        if (replacement.type === "entry.save") {
          const localEntry = { ...replacement.payload, id: replacement.entryId, workspaceId: replacement.workspaceId,
            version: replacement.baseVersion, syncState: "pending", normalizedForm: replacement.payload.form.toLocaleLowerCase("en") };
          cache.put(localEntry);
        }
      };
      transaction.oncomplete = () => resolve(replacement);
      transaction.onerror = () => reject(transaction.error || new Error("Vocabulary conflict could not be resolved."));
      transaction.onabort = () => reject(transaction.error || new Error("Vocabulary conflict resolution was aborted."));
    });
  } finally { database.close(); }
}

export async function listCachedVocabulary(workspaceId) {
  const database = await openDatabase();
  try {
    return await readRequest(database, "vocabularyCache", (store) =>
      store.index("workspaceId").getAll(workspaceId),
    );
  } finally {
    database.close();
  }
}

export async function replaceCachedVocabulary(workspaceId, entries) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "vocabularyCache", "syncOutbox"], "readwrite");
      const workspaces = transaction.objectStore("workspaces");
      const cache = transaction.objectStore("vocabularyCache");
      const outbox = transaction.objectStore("syncOutbox");
      const workspaceRequest = workspaces.get(workspaceId);
      workspaceRequest.onsuccess = () => {
        if (!workspaceRequest.result || workspaceRequest.result.status !== "active") {
          transaction.abort();
          reject(new Error("Vocabulary cache requires an active Workspace."));
          return;
        }
        const pendingRequest = outbox.index("workspaceId").getAll(workspaceId);
        pendingRequest.onsuccess = () => {
          const pendingIds = new Set(pendingRequest.result.map((item) => item.entryId));
          const oldRequest = cache.index("workspaceId").getAllKeys(workspaceId);
          oldRequest.onsuccess = () => {
            oldRequest.result.forEach((key) => { if (!pendingIds.has(key)) cache.delete(key); });
            entries.forEach((entry) => {
              if (entry.workspaceId !== workspaceId) {
                transaction.abort();
                reject(new Error("Vocabulary cache cannot cross Workspace boundaries."));
                return;
              }
              if (!pendingIds.has(entry.id)) {
                cache.put({
                  ...entry,
                  normalizedForm: String(entry.form).trim().replace(/\\s+/gu, " ").toLocaleLowerCase("en"),
                });
              }
            });
          };
        };
      };
      workspaceRequest.onerror = () => reject(workspaceRequest.error || new Error("Workspace could not be read."));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Vocabulary cache could not be saved."));
      transaction.onabort = () => reject(transaction.error || new Error("Vocabulary cache update was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function listPracticeProjects(workspaceId) {
  const database = await openDatabase();
  try {
    return await readRequest(database, "practiceProjects", (store) =>
      store.index("workspaceId").getAll(workspaceId),
    );
  } finally {
    database.close();
  }
}

export async function getProjectData(projectId) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["practiceProjects", "subtitles", "cues"], "readonly");
      const projectRequest = transaction.objectStore("practiceProjects").get(projectId);
      projectRequest.onsuccess = () => {
        const project = projectRequest.result;
        if (!project) {
          transaction.oncomplete = () => resolve(null);
          return;
        }
        const subtitleRequest = transaction.objectStore("subtitles").get(project.subtitleId);
        const cuesRequest = transaction.objectStore("cues").index("projectId").getAll(projectId);
        let subtitle;
        let cues;
        subtitleRequest.onsuccess = () => { subtitle = subtitleRequest.result; };
        cuesRequest.onsuccess = () => { cues = cuesRequest.result; };
        transaction.oncomplete = () => resolve({ project, subtitle, cues });
      };
      projectRequest.onerror = () => reject(projectRequest.error || new Error("Project could not be read."));
      transaction.onerror = () => reject(transaction.error || new Error("Project data could not be read."));
      transaction.onabort = () => reject(transaction.error || new Error("Project data read was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function saveImportedPracticeProject({ project, subtitle, cues }) {
  const database = await openDatabase();
  try {
    return await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "videos", "practiceProjects", "subtitles", "cues"], "readwrite");
      const workspaces = transaction.objectStore("workspaces");
      const videos = transaction.objectStore("videos");
      const projectStore = transaction.objectStore("practiceProjects");
      const existingRequest = projectStore.index("subtitleKey").get([project.workspaceId, project.videoKey, project.subtitleDigest]);
      existingRequest.onsuccess = () => {
        if (existingRequest.result) {
          transaction.oncomplete = () => resolve({ project: existingRequest.result, existing: true });
          return;
        }
        const workspaceRequest = workspaces.get(project.workspaceId);
        const videoRequest = videos.get(project.videoId);
        let workspace;
        let video;
        let readyCount = 0;
        const validateAndWrite = () => {
          readyCount += 1;
          if (readyCount !== 2) return;
          if (!workspace || workspace.status !== "active" || !video || video.workspaceId !== project.workspaceId) {
            transaction.abort();
            reject(new Error("An active Workspace and its local video are required."));
            return;
          }
          projectStore.add(project);
          transaction.objectStore("subtitles").add(subtitle);
          const cueStore = transaction.objectStore("cues");
          cues.forEach((cue) => cueStore.add(cue));
          transaction.oncomplete = () => resolve({ project, existing: false });
        };
        workspaceRequest.onsuccess = () => { workspace = workspaceRequest.result; validateAndWrite(); };
        videoRequest.onsuccess = () => { video = videoRequest.result; validateAndWrite(); };
        workspaceRequest.onerror = () => { transaction.abort(); reject(workspaceRequest.error); };
        videoRequest.onerror = () => { transaction.abort(); reject(videoRequest.error); };
      };
      existingRequest.onerror = () => reject(existingRequest.error || new Error("Project lookup failed."));
      transaction.onerror = () => reject(transaction.error || new Error("Practice project could not be saved."));
      transaction.onabort = () => reject(transaction.error || new Error("Practice project import was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function saveCue(cue) {
  const database = await openDatabase();
  try {
    await runTransaction(database, ["cues"], "readwrite", (transaction) => {
      transaction.objectStore("cues").put(cue);
    });
  } finally {
    database.close();
  }
}

export async function saveCueAndProject(cue, project) {
  const database = await openDatabase();
  try {
    await runTransaction(database, ["cues", "practiceProjects"], "readwrite", (transaction) => {
      transaction.objectStore("cues").put(cue);
      transaction.objectStore("practiceProjects").put(project);
    });
  } finally { database.close(); }
}

export async function saveProjectOffset(projectId, offsetSeconds) {
  if (!Number.isFinite(offsetSeconds) || offsetSeconds < -10 || offsetSeconds > 10 || Math.round(offsetSeconds * 10) !== offsetSeconds * 10) {
    throw new RangeError("Subtitle offset must be between -10 and 10 seconds in 0.1 second steps.");
  }
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("practiceProjects", "readwrite");
      const store = transaction.objectStore("practiceProjects");
      const request = store.get(projectId);
      request.onsuccess = () => {
        if (!request.result) { transaction.abort(); reject(new Error("Practice project was not found.")); return; }
        store.put({ ...request.result, offsetMs: Math.round(offsetSeconds * 1000), updatedAt: new Date().toISOString() });
      };
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Subtitle offset could not be saved."));
      transaction.onabort = () => reject(transaction.error || new Error("Subtitle offset update was aborted."));
    });
  } finally { database.close(); }
}

export async function saveProjectReplayPadding(projectId, beforeMs, afterMs) {
  for (const value of [beforeMs, afterMs]) {
    if (!Number.isInteger(value) || value < 0 || value > 2000) {
      throw new RangeError("Replay padding must be between 0 and 2000 milliseconds.");
    }
  }
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction("practiceProjects", "readwrite");
      const store = transaction.objectStore("practiceProjects");
      const request = store.get(projectId);
      request.onsuccess = () => {
        if (!request.result) {
          transaction.abort();
          reject(new Error("Practice project was not found."));
          return;
        }
        store.put({
          ...request.result,
          replayPaddingBeforeMs: beforeMs,
          replayPaddingAfterMs: afterMs,
          updatedAt: new Date().toISOString(),
        });
      };
      request.onerror = () => reject(request.error || new Error("Practice project could not be read."));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Replay settings could not be saved."));
      transaction.onabort = () => reject(transaction.error || new Error("Replay settings update was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function updateCueAndProject(cue, project) {
  const database = await openDatabase();
  try {
    await runTransaction(database, ["cues", "practiceProjects"], "readwrite", (transaction) => {
      transaction.objectStore("cues").put(cue);
      transaction.objectStore("practiceProjects").put(project);
    });
  } finally { database.close(); }
}

export async function splitStoredCue(parent, children, project) {
  const database = await openDatabase();
  try {
    await runTransaction(database, ["cues", "practiceProjects"], "readwrite", (transaction) => {
      const cueStore = transaction.objectStore("cues");
      cueStore.put({ ...parent, active: false, splitAt: new Date().toISOString() });
      children.forEach((child) => cueStore.add(child));
      transaction.objectStore("practiceProjects").put(project);
    });
  } finally { database.close(); }
}

function openDatabase() {
  return new Promise((resolve, reject) => {
    if (!window.indexedDB) {
      reject(new Error("IndexedDB is not supported by this browser."));
      return;
    }

    const request = window.indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      ensureDatabaseSchema(request.result);
    };
    request.onerror = () => reject(request.error || new Error("Could not open IndexedDB."));
    request.onblocked = () => reject(new Error("Close other Shadowing tabs to upgrade local storage."));
    request.onsuccess = () => resolve(request.result);
  });
}

function runTransaction(database, storeNames, mode, action) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeNames, mode);
    let result;
    try {
      result = action(transaction);
    } catch (error) {
      transaction.abort();
      reject(error);
      return;
    }
    transaction.oncomplete = () => resolve(result);
    transaction.onerror = () => reject(transaction.error || new Error("IndexedDB transaction failed."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB transaction was aborted."));
  });
}

function readRequest(database, storeName, requestFactory) {
  return new Promise((resolve, reject) => {
    const transaction = database.transaction(storeName, "readonly");
    const request = requestFactory(transaction.objectStore(storeName));
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error || new Error("Could not read IndexedDB."));
    transaction.onabort = () => reject(transaction.error || new Error("IndexedDB read was aborted."));
  });
}

export async function listWorkspaces() {
  const database = await openDatabase();
  try {
    return await readRequest(database, "workspaces", (store) => store.getAll());
  } finally {
    database.close();
  }
}

export async function getWorkspace(workspaceId) {
  const database = await openDatabase();
  try {
    return await readRequest(database, "workspaces", (store) => store.get(workspaceId));
  } finally {
    database.close();
  }
}

export async function getActiveWorkspaceId() {
  const database = await openDatabase();
  try {
    const record = await readRequest(database, "settings", (store) =>
      store.get("activeWorkspaceId"),
    );
    return record?.value || null;
  } finally {
    database.close();
  }
}

export async function getWorkspaceSettings(workspaceId) {
  const database = await openDatabase();
  try {
    const record = await readRequest(database, "settings", (store) =>
      store.get(workspaceSettingsKey(workspaceId)),
    );
    return record?.value || { ...DEFAULT_WORKSPACE_SETTINGS };
  } finally {
    database.close();
  }
}

export async function saveWorkspaceSettings(workspaceId, value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("Workspace settings must be an object.");
  }
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "settings"], "readwrite");
      const workspaceRequest = transaction.objectStore("workspaces").get(workspaceId);
      workspaceRequest.onsuccess = () => {
        if (!workspaceRequest.result) {
          transaction.abort();
          reject(new Error("Workspace does not exist in local storage."));
          return;
        }
        transaction.objectStore("settings").put({
          key: workspaceSettingsKey(workspaceId),
          workspaceId,
          value,
          updatedAt: new Date().toISOString(),
        });
      };
      workspaceRequest.onerror = () => reject(
        workspaceRequest.error || new Error("Workspace could not be read."),
      );
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(
        transaction.error || new Error("Workspace settings could not be saved."),
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Workspace settings transaction was aborted."),
      );
    });
  } finally {
    database.close();
  }
}

export async function listPendingOperations() {
  const database = await openDatabase();
  try {
    return await readRequest(database, "pendingOperations", (store) => store.getAll());
  } finally {
    database.close();
  }
}

export async function saveProvisionalWorkspace(workspace, operation) {
  const database = await openDatabase();
  try {
    await runTransaction(
      database,
      ["workspaces", "settings", "pendingOperations"],
      "readwrite",
      (transaction) => {
        transaction.objectStore("workspaces").put(workspace);
        ensureWorkspaceSettings(transaction, workspace);
        transaction.objectStore("settings").put({
          key: "activeWorkspaceId",
          value: workspace.id,
        });
        transaction.objectStore("pendingOperations").put(operation);
      },
    );
  } finally {
    database.close();
  }
}

export async function saveRegisteredWorkspace(workspace, operationId = null) {
  const database = await openDatabase();
  try {
    await runTransaction(
      database,
      ["workspaces", "settings", "pendingOperations"],
      "readwrite",
      (transaction) => {
        transaction.objectStore("workspaces").put({
          ...workspace,
          registrationState: "registered",
        });
        ensureWorkspaceSettings(transaction, workspace);
        if (operationId) {
          transaction.objectStore("pendingOperations").delete(operationId);
        }
      },
    );
  } finally {
    database.close();
  }
}

export async function saveRemoteWorkspaces(workspaces) {
  const database = await openDatabase();
  try {
    await runTransaction(
      database,
      ["workspaces", "settings"],
      "readwrite",
      (transaction) => {
        const store = transaction.objectStore("workspaces");
        workspaces.forEach((workspace) => {
          store.put({ ...workspace, registrationState: "registered" });
          ensureWorkspaceSettings(transaction, workspace);
        });
      },
    );
  } finally {
    database.close();
  }
}

export async function setActiveWorkspace(workspaceId) {
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "settings"], "readwrite");
      const request = transaction.objectStore("workspaces").get(workspaceId);
      request.onsuccess = () => {
        const workspace = request.result;
        if (!workspace || workspace.status !== "active") {
          transaction.abort();
          reject(new Error("Only an active local Workspace can be selected."));
          return;
        }
        transaction.objectStore("settings").put({
          key: "activeWorkspaceId",
          value: workspaceId,
        });
      };
      request.onerror = () => reject(request.error || new Error("Workspace could not be read."));
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(transaction.error || new Error("Workspace selection failed."));
      transaction.onabort = () => reject(transaction.error || new Error("Workspace selection was aborted."));
    });
  } finally {
    database.close();
  }
}

export async function setWorkspaceStatus(workspace, status) {
  const database = await openDatabase();
  try {
    await runTransaction(
      database,
      ["workspaces", "settings"],
      "readwrite",
      (transaction) => {
        transaction.objectStore("workspaces").put({ ...workspace, status });
        if (status === "archived") {
          const settings = transaction.objectStore("settings");
          const request = settings.get("activeWorkspaceId");
          request.onsuccess = () => {
            if (request.result?.value === workspace.id) {
              settings.put({ key: "activeWorkspaceId", value: null });
            }
          };
        }
      },
    );
  } finally {
    database.close();
  }
}

export async function listWorkspaceVideos(workspaceId) {
  const database = await openDatabase();
  try {
    return await readRequest(database, "videos", (store) =>
      store.index("workspaceId").getAll(workspaceId),
    );
  } finally {
    database.close();
  }
}

export async function saveVideoMetadata(metadata) {
  if (!metadata || typeof metadata !== "object" || !metadata.id || !metadata.workspaceId) {
    throw new TypeError("Video metadata requires a video and Workspace identifier.");
  }
  const database = await openDatabase();
  try {
    await new Promise((resolve, reject) => {
      const transaction = database.transaction(["workspaces", "videos"], "readwrite");
      const workspaceRequest = transaction.objectStore("workspaces").get(metadata.workspaceId);
      workspaceRequest.onsuccess = () => {
        if (!workspaceRequest.result || workspaceRequest.result.status !== "active") {
          transaction.abort();
          reject(new Error("Video metadata requires an active Workspace."));
          return;
        }
        transaction.objectStore("videos").put(metadata);
      };
      workspaceRequest.onerror = () => reject(
        workspaceRequest.error || new Error("Workspace could not be read."),
      );
      transaction.oncomplete = resolve;
      transaction.onerror = () => reject(
        transaction.error || new Error("Video metadata could not be saved."),
      );
      transaction.onabort = () => reject(
        transaction.error || new Error("Video metadata transaction was aborted."),
      );
    });
  } finally {
    database.close();
  }
}
