import {
  getActiveWorkspaceId,
  listPendingOperations,
  listWorkspaces,
  saveProvisionalWorkspace,
  saveRegisteredWorkspace,
  saveRemoteWorkspaces,
  setActiveWorkspace,
  setWorkspaceStatus,
} from "./indexeddb-storage.js";

const root = document.querySelector("[data-workspace-app]");
const form = document.querySelector("[data-workspace-form]");
const nameInput = document.querySelector("[data-workspace-name]");
const list = document.querySelector("[data-workspace-list]");
const activeWorkspaceLabel = document.querySelector("[data-active-workspace]");
const message = document.querySelector("[data-workspace-message]");
const retryButton = document.querySelector("[data-retry-registration]");
const submitButton = form.querySelector("button[type='submit']");

let workspaces = [];
let activeWorkspaceId = null;
let databaseReady = false;
let serverAvailable = false;

function setMessage(text, tone = "info") {
  message.textContent = text;
  message.className = `alert alert-${tone}`;
  message.hidden = !text;
}

function readCookie(name) {
  const prefix = `${name}=`;
  const cookie = document.cookie
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(prefix));
  return cookie ? decodeURIComponent(cookie.slice(prefix.length)) : "";
}

async function requestJson(url, options = {}) {
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 5000);
  try {
    const headers = new Headers(options.headers || {});
    if (options.body) {
      headers.set("Content-Type", "application/json");
      headers.set("X-CSRFToken", readCookie("csrftoken"));
    }
    const response = await fetch(url, {
      ...options,
      headers,
      credentials: "same-origin",
      signal: controller.signal,
    });
    let payload = {};
    try {
      payload = await response.json();
    } catch {
      payload = {};
    }
    if (!response.ok) {
      const error = new Error(payload.error || "workspace_request_failed");
      error.status = response.status;
      throw error;
    }
    return payload;
  } finally {
    window.clearTimeout(timeout);
  }
}

function apiUrlForWorkspace(workspaceId) {
  return root.dataset.workspaceDetailUrl.replace("00000000-0000-0000-0000-000000000000", workspaceId);
}

function createUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return [
    hex.slice(0, 4).join(""),
    hex.slice(4, 6).join(""),
    hex.slice(6, 8).join(""),
    hex.slice(8, 10).join(""),
    hex.slice(10, 16).join(""),
  ].join("-");
}

function updateActiveWorkspaceLabel() {
  const current = workspaces.find((workspace) => workspace.id === activeWorkspaceId);
  activeWorkspaceLabel.textContent = current ? current.name : "هیچ Workspace فعالی انتخاب نشده است.";
}

function makeActionButton(label, action, workspaceId, disabled = false) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "btn btn-sm btn-outline-primary";
  button.textContent = label;
  button.dataset.action = action;
  button.dataset.workspaceId = workspaceId;
  button.disabled = disabled;
  return button;
}

function renderWorkspaces() {
  list.replaceChildren();
  workspaces.forEach((workspace) => {
    const item = document.createElement("li");
    item.className = "list-group-item d-flex flex-wrap align-items-center justify-content-between gap-2";

    const details = document.createElement("div");
    details.className = "workspace-details";
    const name = document.createElement("strong");
    name.textContent = workspace.name;
    details.append(name);

    const status = document.createElement("span");
    status.className = "workspace-status text-secondary";
    const registration = workspace.registrationState === "registered"
      ? "ثبت‌شده در پایگاه محلی"
      : "موقت؛ فقط در این مرورگر";
    status.textContent = `${workspace.status === "archived" ? "بایگانی‌شده" : "فعال"} · ${registration}`;
    details.append(status);
    item.append(details);

    const actions = document.createElement("div");
    actions.className = "d-flex flex-wrap gap-2";
    if (workspace.status === "active") {
      actions.append(
        makeActionButton(
          workspace.id === activeWorkspaceId ? "Workspace جاری" : "انتخاب",
          "select",
          workspace.id,
          workspace.id === activeWorkspaceId,
        ),
        makeActionButton(
          "بایگانی",
          "archive",
          workspace.id,
          !serverAvailable || workspace.registrationState !== "registered",
        ),
      );
    } else {
      actions.append(
        makeActionButton(
          "بازگردانی",
          "restore",
          workspace.id,
          !serverAvailable || workspace.registrationState !== "registered",
        ),
      );
    }
    item.append(actions);
    list.append(item);
  });
  updateActiveWorkspaceLabel();
}

async function reloadLocalState() {
  workspaces = await listWorkspaces();
  activeWorkspaceId = await getActiveWorkspaceId();
  const active = workspaces.find(
    (workspace) => workspace.id === activeWorkspaceId && workspace.status === "active",
  );
  if (!active && activeWorkspaceId) {
    activeWorkspaceId = null;
  }
  renderWorkspaces();
  window.dispatchEvent(new CustomEvent("shadowing:workspacechange", {
    detail: { workspaceId: activeWorkspaceId },
  }));
}

async function registerPendingOperations() {
  const operations = await listPendingOperations();
  let registrationFailed = false;
  for (const operation of operations) {
    if (operation.type !== "workspace.register") {
      continue;
    }
    const workspace = workspaces.find((item) => item.id === operation.workspaceId);
    if (!workspace) {
      continue;
    }
    try {
      const payload = await requestJson(root.dataset.workspaceCollectionUrl, {
        method: "POST",
        body: JSON.stringify({ id: workspace.id, name: workspace.name }),
      });
      await saveRegisteredWorkspace(payload.workspace, operation.operationId);
      serverAvailable = true;
    } catch {
      serverAvailable = false;
      registrationFailed = true;
      break;
    }
  }
  await reloadLocalState();
  return registrationFailed;
}

async function refreshFromServer() {
  const payload = await requestJson(root.dataset.workspaceCollectionUrl);
  const pendingIds = new Set(
    (await listPendingOperations()).map((operation) => operation.workspaceId),
  );
  await saveRemoteWorkspaces(
    payload.workspaces.filter((workspace) => !pendingIds.has(workspace.id)),
  );
  serverAvailable = true;
  await reloadLocalState();
}

async function initialize() {
  try {
    await reloadLocalState();
    databaseReady = true;
  } catch {
    databaseReady = false;
    form.querySelectorAll("input, button").forEach((element) => {
      element.disabled = true;
    });
    retryButton.disabled = true;
    setMessage(
      "ذخیره‌سازی محلی مرورگر در دسترس نیست. داده‌ای ذخیره نشده است؛ از مرورگر پشتیبانی‌شده استفاده کنید و دوباره تلاش کنید.",
      "danger",
    );
    return;
  }

  const registrationFailed = await registerPendingOperations();
  try {
    await refreshFromServer();
    if (registrationFailed) {
      setMessage(
        "فهرست سرور در دسترس است، اما ثبت یک Workspace موقت انجام نشد. عملیات آن حفظ شده؛ برای تلاش دوباره از دکمهٔ پایین استفاده کنید.",
        "warning",
      );
    } else {
      setMessage(
        "اطلاعات Workspace در IndexedDB این مرورگر نگهداری می‌شود؛ فهرست سرور محلی نیز به‌روز است.",
        "success",
      );
    }
  } catch {
    serverAvailable = false;
    renderWorkspaces();
    setMessage(
      "حالت محلی فعال است. ثبت سروری یا بایگانی تا آماده‌شدن SQLite انجام نمی‌شود؛ Workspaceهای موقت در همین مرورگر باقی می‌مانند.",
      "warning",
    );
  }
}

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!databaseReady) {
    return;
  }
  const name = nameInput.value.trim();
  if (!name || name.length > 120) {
    nameInput.setCustomValidity("نام Workspace باید بین ۱ تا ۱۲۰ نویسه باشد.");
    nameInput.reportValidity();
    return;
  }
  nameInput.setCustomValidity("");
  submitButton.disabled = true;

  const now = new Date().toISOString();
  const workspace = {
    id: createUuid(),
    name,
    status: "active",
    registrationState: "pending",
    createdAt: now,
    updatedAt: now,
  };
  const operation = {
    operationId: createUuid(),
    type: "workspace.register",
    workspaceId: workspace.id,
    createdAt: now,
    attempts: 0,
  };

  try {
    await saveProvisionalWorkspace(workspace, operation);
    await reloadLocalState();
    nameInput.value = "";
    try {
      const payload = await requestJson(root.dataset.workspaceCollectionUrl, {
        method: "POST",
        body: JSON.stringify({ id: workspace.id, name: workspace.name }),
      });
      await saveRegisteredWorkspace(payload.workspace, operation.operationId);
      serverAvailable = true;
      await reloadLocalState();
      setMessage("Workspace ذخیره و در SQLite محلی ثبت شد.", "success");
    } catch {
      serverAvailable = false;
      renderWorkspaces();
      setMessage(
        "Workspace در IndexedDB ذخیره شد، اما ثبت SQLite انجام نشد. عملیات ثبت برای تلاش دوباره نگهداری شده است.",
        "warning",
      );
    }
  } catch {
    setMessage("ذخیره‌سازی Workspace در مرورگر ناموفق بود؛ داده‌ای ثبت نشده است.", "danger");
  } finally {
    submitButton.disabled = false;
  }
});

list.addEventListener("click", async (event) => {
  const button = event.target.closest("button[data-action]");
  if (!button) {
    return;
  }
  const workspace = workspaces.find((item) => item.id === button.dataset.workspaceId);
  if (!workspace) {
    return;
  }
  button.disabled = true;
  try {
    if (button.dataset.action === "select") {
      await setActiveWorkspace(workspace.id);
      await reloadLocalState();
      setMessage(`Workspace «${workspace.name}» انتخاب شد.`, "success");
      return;
    }

    const status = button.dataset.action === "archive" ? "archived" : "active";
    const payload = await requestJson(apiUrlForWorkspace(workspace.id), {
      method: "PATCH",
      body: JSON.stringify({ status }),
    });
    await setWorkspaceStatus(payload.workspace, status);
    serverAvailable = true;
    await reloadLocalState();
    setMessage(status === "archived" ? "Workspace بایگانی شد." : "Workspace بازگردانی شد.", "success");
  } catch {
    serverAvailable = false;
    renderWorkspaces();
    setMessage(
      "تغییر وضعیت انجام نشد. برای بایگانی یا بازگردانی، اتصال SQLite لازم است.",
      "warning",
    );
  }
});

retryButton.addEventListener("click", async () => {
  retryButton.disabled = true;
  try {
    const registrationFailed = await registerPendingOperations();
    await refreshFromServer();
    if (registrationFailed) {
      setMessage(
        "یک Workspace همچنان موقت است؛ عملیات ثبت در IndexedDB حفظ شد.",
        "warning",
      );
    } else {
      setMessage("ثبت‌های معوق بررسی و فهرست Workspaceها به‌روز شد.", "success");
    }
  } catch {
    serverAvailable = false;
    renderWorkspaces();
    setMessage("SQLite هنوز در دسترس نیست؛ اطلاعات محلی حفظ شده‌اند.", "warning");
  } finally {
    retryButton.disabled = false;
  }
});

initialize();
