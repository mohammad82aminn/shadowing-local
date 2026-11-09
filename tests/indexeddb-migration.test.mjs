import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const storageSource = await readFile(
  fileURLToPath(new URL("../static/js/indexeddb-storage.js", import.meta.url)),
  "utf8",
);
const storageModule = await import(
  `data:text/javascript;base64,${Buffer.from(storageSource).toString("base64")}`
);
const { ensureDatabaseSchema } = storageModule;

class FakeObjectStore {
  constructor(options = {}) {
    this.options = options;
    this.indexes = new Map();
  }

  createIndex(name, keyPath, options) {
    this.indexes.set(name, { keyPath, options });
  }
}

class FakeDatabase {
  constructor() {
    this.stores = new Map();
    this.objectStoreNames = {
      contains: (name) => this.stores.has(name),
    };
  }

  createObjectStore(name, options) {
    if (this.stores.has(name)) {
      throw new Error(`Object store already exists: ${name}`);
    }
    const store = new FakeObjectStore(options);
    this.stores.set(name, store);
    return store;
  }
}

test("version 1 stores and records survive the version 5 schema upgrade", () => {
  const database = new FakeDatabase();
  const workspaceStore = database.createObjectStore("workspaces", { keyPath: "id" });
  const settingsStore = database.createObjectStore("settings", { keyPath: "key" });
  const operationsStore = database.createObjectStore("pendingOperations", {
    keyPath: "operationId",
  });
  const workspace = { id: "workspace-1", name: "Existing" };
  const setting = { key: "activeWorkspaceId", value: workspace.id };
  const operation = { operationId: "operation-1", workspaceId: workspace.id };
  workspaceStore.records = new Map([[workspace.id, workspace]]);
  settingsStore.records = new Map([[setting.key, setting]]);
  operationsStore.records = new Map([[operation.operationId, operation]]);

  ensureDatabaseSchema(database);

  assert.deepEqual([...database.stores.keys()], [
    "workspaces",
    "settings",
    "pendingOperations",
    "videos",
    "practiceProjects",
    "subtitles",
    "cues",
    "vocabularyCache",
    "syncOutbox",
    "syncConflicts",
  ]);
  assert.equal(database.stores.get("workspaces"), workspaceStore);
  assert.equal(database.stores.get("settings"), settingsStore);
  assert.equal(database.stores.get("pendingOperations"), operationsStore);
  assert.equal(workspaceStore.records.get(workspace.id), workspace);
  assert.equal(settingsStore.records.get(setting.key), setting);
  assert.equal(operationsStore.records.get(operation.operationId), operation);
  assert.equal(database.stores.get("videos").options.keyPath, "id");
  assert.equal(database.stores.get("videos").indexes.get("workspaceId").keyPath, "workspaceId");
  assert.deepEqual(database.stores.get("practiceProjects").indexes.get("subtitleKey").keyPath,
    ["workspaceId", "videoKey", "subtitleDigest"]);
  assert.equal(database.stores.get("subtitles").indexes.get("projectId").keyPath, "projectId");
  assert.equal(database.stores.get("cues").indexes.get("projectId").keyPath, "projectId");
  assert.equal(database.stores.get("vocabularyCache").options.keyPath, "id");
  assert.deepEqual(database.stores.get("vocabularyCache").indexes.get("workspaceForm").keyPath,
    ["workspaceId", "normalizedForm"]);
  assert.equal(database.stores.get("syncOutbox").indexes.get("workspaceId").keyPath, "workspaceId");
  assert.equal(database.stores.get("syncConflicts").indexes.get("workspaceId").keyPath, "workspaceId");
});

test("fresh databases receive all required stores and a repeated upgrade is safe", () => {
  const database = new FakeDatabase();

  ensureDatabaseSchema(database);
  ensureDatabaseSchema(database);

  assert.deepEqual([...database.stores.keys()], [
    "workspaces",
    "settings",
    "pendingOperations",
    "videos",
    "practiceProjects",
    "subtitles",
    "cues",
    "vocabularyCache",
    "syncOutbox",
    "syncConflicts",
  ]);
});

test("version 2 video metadata and its indexes survive the version 5 upgrade", () => {
  const database = new FakeDatabase();
  for (const [name, keyPath] of [["workspaces", "id"], ["settings", "key"], ["pendingOperations", "operationId"]]) {
    database.createObjectStore(name, { keyPath });
  }
  const videos = database.createObjectStore("videos", { keyPath: "id" });
  videos.createIndex("workspaceId", "workspaceId", { unique: false });
  videos.createIndex("selectedAt", "selectedAt", { unique: false });
  const video = { id: "video-1", workspaceId: "workspace-1", fileName: "local.mp4" };
  videos.records = new Map([[video.id, video]]);

  ensureDatabaseSchema(database);

  assert.equal(database.stores.get("videos"), videos);
  assert.equal(videos.records.get(video.id), video);
  assert.equal(videos.indexes.get("workspaceId").keyPath, "workspaceId");
  assert.equal(videos.indexes.get("selectedAt").keyPath, "selectedAt");
  assert.ok(database.stores.has("practiceProjects"));
  assert.ok(database.stores.has("subtitles"));
  assert.ok(database.stores.has("cues"));
  assert.ok(database.stores.has("vocabularyCache"));
});

test("version 3 practice records survive additive vocabulary upgrades", () => {
  const database = new FakeDatabase();
  for (const name of ["workspaces", "settings", "pendingOperations", "videos", "practiceProjects", "subtitles", "cues"]) {
    const store = database.createObjectStore(name, { keyPath: "id" });
    store.records = new Map([[`${name}-old`, { id: `${name}-old`, preserved: true }]]);
  }
  const previousStores = new Map(database.stores);

  ensureDatabaseSchema(database);

  for (const [name, store] of previousStores) {
    assert.equal(database.stores.get(name), store);
    assert.deepEqual([...store.records.values()], [{ id: `${name}-old`, preserved: true }]);
  }
  assert.ok(database.stores.has("vocabularyCache"));
  assert.ok(database.stores.has("syncOutbox"));
  assert.ok(database.stores.has("syncConflicts"));
});
