const HEARTBEAT_MS = 15_000;

function newId() {
  return globalThis.crypto?.randomUUID?.()
    || "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/gu, (char) => {
      const random = Math.floor(Math.random() * 16);
      return (char === "x" ? random : (random & 3) | 8).toString(16);
    });
}

function holderIdFor(storage) {
  const key = "shadowing.workspace-lease-holder";
  try {
    let id = storage?.getItem(key);
    if (!id) {
      id = newId();
      storage?.setItem(key, id);
    }
    return id;
  } catch {
    return newId();
  }
}

export function createWorkspaceLeaseManager(
  workspaceId,
  {
    fetchImpl = globalThis.fetch?.bind(globalThis),
    locks = globalThis.navigator?.locks,
    storage = globalThis.localStorage,
    readCsrf = () => document.cookie.split(";").map((part) => part.trim())
      .find((part) => part.startsWith("csrftoken="))?.slice("csrftoken=".length) || "",
    baseUrl = `/api/workspaces/${workspaceId}/lease/`,
    heartbeatMs = HEARTBEAT_MS,
    setIntervalImpl = globalThis.setInterval.bind(globalThis),
    clearIntervalImpl = globalThis.clearInterval.bind(globalThis),
  } = {},
) {
  const holderId = holderIdFor(storage);
  let fencingToken = null;
  let timer = null;
  let stopped = false;

  async function request(path, { body, token = fencingToken } = {}) {
    const headers = { "Content-Type": "application/json", "X-CSRFToken": readCsrf() };
    if (token !== null) {
      headers["X-Workspace-Lease"] = holderId;
      headers["X-Fencing-Token"] = String(token);
    }
    const response = await fetchImpl(`${baseUrl}${path}`, {
      method: "POST",
      credentials: "same-origin",
      headers,
      body: JSON.stringify(body || {}),
    });
    const payload = await response.json();
    if (!response.ok) {
      const error = new Error(payload.error || "lease_request_failed");
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  function exclusive(callback) {
    if (!locks?.request) throw new Error("web_locks_unavailable");
    return locks.request(`shadowing-workspace-${workspaceId}`, { mode: "exclusive" }, callback);
  }

  async function acquireLocked() {
    fencingToken = null;
    const lease = await request("", { body: { holderId } });
    fencingToken = lease.fencingToken;
    return lease;
  }

  async function heartbeatLocked() {
    if (fencingToken === null) return acquireLocked();
    try {
      const lease = await request("heartbeat/", { token: fencingToken });
      fencingToken = lease.fencingToken;
      return lease;
    } catch (error) {
      fencingToken = null;
      return acquireLocked();
    }
  }

  function ensureHeartbeat() {
    if (timer !== null) return;
    timer = setIntervalImpl(() => {
      if (stopped) return;
      exclusive(heartbeatLocked).catch(() => { fencingToken = null; });
    }, heartbeatMs);
  }

  async function start() {
    stopped = false;
    const lease = await exclusive(acquireLocked);
    ensureHeartbeat();
    return lease;
  }

  async function withLease(callback) {
    if (stopped) throw new Error("lease_manager_stopped");
    return exclusive(async () => {
      const lease = await acquireLocked();
      ensureHeartbeat();
      return callback({
        "X-Workspace-Lease": holderId,
        "X-Fencing-Token": String(lease.fencingToken),
      });
    });
  }

  async function getHeaders() {
    if (stopped) throw new Error("lease_manager_stopped");
    const lease = await exclusive(async () => {
      const current = await acquireLocked();
      ensureHeartbeat();
      return current;
    });
    return {
      "X-Workspace-Lease": holderId,
      "X-Fencing-Token": String(lease.fencingToken),
    };
  }

  async function stop() {
    stopped = true;
    if (timer !== null) clearIntervalImpl(timer);
    timer = null;
    if (fencingToken === null) return;
    const token = fencingToken;
    fencingToken = null;
    try {
      await exclusive(() => request("release/", { token }));
    } catch {
      // A failed release is safe: the server expires the lease after 60 seconds.
    }
  }

  return {
    start,
    stop,
    withLease,
    getHeaders,
    get holderId() { return holderId; },
    get fencingToken() { return fencingToken; },
  };
}
