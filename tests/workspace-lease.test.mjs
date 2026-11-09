import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const source = await readFile(
  fileURLToPath(new URL("../static/js/workspace-lease.js", import.meta.url)),
  "utf8",
);
const leaseModule = await import(
  `data:text/javascript;base64,${Buffer.from(source).toString("base64")}`
);

test("lease manager serializes ownership calls with a Workspace-scoped Web Lock", async () => {
  const lockNames = [];
  const requests = [];
  const locks = {
    request: async (name, options, callback) => {
      lockNames.push([name, options.mode]);
      return callback({ name });
    },
  };
  const storage = {
    value: null,
    getItem() { return this.value; },
    setItem(_key, value) { this.value = value; },
  };
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    return {
      ok: true,
      json: async () => ({ holderId: storage.value, fencingToken: 7, expiresAt: "later" }),
    };
  };
  const manager = leaseModule.createWorkspaceLeaseManager("workspace-a", {
    fetchImpl,
    locks,
    storage,
    readCsrf: () => "csrf",
    heartbeatMs: 60_000,
  });

  await manager.start();
  const headers = await manager.getHeaders();
  assert.equal(manager.fencingToken, 7);
  assert.equal(headers["X-Workspace-Lease"], storage.value);
  assert.equal(headers["X-Fencing-Token"], "7");
  assert.ok(lockNames.every(([name, mode]) => name === "shadowing-workspace-workspace-a" && mode === "exclusive"));
  assert.equal(requests[0].url, "/api/workspaces/workspace-a/lease/");
  assert.equal(requests[0].options.credentials, "same-origin");
  assert.deepEqual(JSON.parse(requests[0].options.body), { holderId: storage.value });
  await manager.stop();
  assert.equal(requests.at(-1).url, "/api/workspaces/workspace-a/lease/release/");
});

test("lease manager sends heartbeats on the configured cadence", async () => {
  let tick;
  const paths = [];
  const manager = leaseModule.createWorkspaceLeaseManager("workspace-heartbeat", {
    locks: { request: async (_name, _options, callback) => callback({}) },
    storage: { getItem: () => "browser-1", setItem() {} },
    fetchImpl: async (url) => {
      paths.push(url);
      return { ok: true, json: async () => ({ fencingToken: 3, expiresAt: "later" }) };
    },
    readCsrf: () => "",
    heartbeatMs: 15_000,
    setIntervalImpl: (callback, delay) => { tick = callback; assert.equal(delay, 15_000); return 1; },
    clearIntervalImpl: () => {},
  });

  await manager.start();
  tick();
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(paths.map((path) => path.split("/lease/")[1]), ["", "heartbeat/"]);
  await manager.stop();
});

test("lease and sync browser code never reads exercise answers or subtitle content", async () => {
  const notebookSource = await readFile(
    fileURLToPath(new URL("../static/js/vocabulary-notebook.js", import.meta.url)),
    "utf8",
  );
  assert.match(source, /setIntervalImpl\([\s\S]*?heartbeatMs/u);
  assert.match(source, /heartbeat\/\x22/u);
  assert.doesNotMatch(source, /answer-input|subtitle|cueText|rawAnswer/iu);
  assert.doesNotMatch(notebookSource, /data-answer-input|rawAnswer|subtitleText.*JSON\.stringify/iu);
  assert.match(notebookSource, /headers: leaseHeaders/u);
  assert.match(notebookSource, /operations: wireOperations/u);
});
