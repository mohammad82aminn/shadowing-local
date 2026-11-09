import {
  getActiveWorkspaceId,
  listWorkspaceVideos,
  saveVideoMetadata,
} from "./indexeddb-storage.js";
import { createSampledFingerprint } from "./video-fingerprint.js";

const root = document.querySelector("[data-video-player]");
const selectButton = root.querySelector("[data-select-video]");
const restoreButton = root.querySelector("[data-restore-video]");
const fileInput = root.querySelector("[data-video-file]");
const videoElement = root.querySelector("[data-video-element]");
const message = root.querySelector("[data-video-message]");
const details = root.querySelector("[data-video-details]");

let activeWorkspaceId = null;
let previousVideo = null;
let currentMetadata = null;
let currentObjectUrl = null;
let selectionVersion = 0;
let workspaceLoadVersion = 0;

function setMessage(text, tone = "info") {
  message.textContent = text;
  message.className = `alert alert-${tone}`;
}

function createUuid() {
  if (crypto.randomUUID) {
    return crypto.randomUUID();
  }
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
}

function videoMimeType(file) {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "mp4") {
    return { mimeType: "video/mp4", format: "MP4" };
  }
  if (extension === "webm") {
    return { mimeType: "video/webm", format: "WebM" };
  }
  return null;
}

function clearCurrentVideo() {
  selectionVersion += 1;
  videoElement.pause();
  videoElement.removeAttribute("src");
  videoElement.load();
  videoElement.hidden = true;
  details.hidden = true;
  details.textContent = "";
  currentMetadata = null;
  window.dispatchEvent(new CustomEvent("shadowing:videoavailable", { detail: { metadata: null } }));
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
    currentObjectUrl = null;
  }
}

function formatBytes(bytes) {
  if (bytes < 1024 * 1024) {
    return `${(bytes / 1024).toFixed(1)} KiB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function persistMetadata(metadata) {
  try {
    await saveVideoMetadata(metadata);
    return { saved: true, handleSaved: Boolean(metadata.fileHandle) };
  } catch (error) {
    if (metadata.fileHandle) {
      const withoutHandle = { ...metadata };
      delete withoutHandle.fileHandle;
      try {
        await saveVideoMetadata(withoutHandle);
        return { saved: true, handleSaved: false };
      } catch (fallbackError) {
        return { saved: false, error: fallbackError };
      }
    }
    return { saved: false, error };
  }
}

async function selectFile(file, fileHandle = null, existingRecord = null) {
  if (!file) {
    return;
  }
  clearCurrentVideo();
  const version = selectionVersion;
  if (!activeWorkspaceId) {
    setMessage("ابتدا یک Workspace فعال انتخاب کنید.", "warning");
    return;
  }

  const media = videoMimeType(file);
  if (!media) {
    setMessage("این فایل پشتیبانی نمی‌شود. یک فایل با پسوند MP4 یا WebM انتخاب کنید.", "danger");
    return;
  }
  const support = videoElement.canPlayType(media.mimeType);
  if (support === "") {
    setMessage(
      `این مرورگر پخش ${media.format} را اعلام نمی‌کند. ممکن است ظرف فایل یا کدک آن پشتیبانی نشود؛ فایل دیگری امتحان کنید.`,
      "danger",
    );
    return;
  }

  const selectedAt = existingRecord?.selectedAt || new Date().toISOString();
  const metadata = {
    ...(existingRecord || {}),
    id: existingRecord?.id || createUuid(),
    workspaceId: activeWorkspaceId,
    fileName: file.name,
    size: file.size,
    declaredType: file.type || media.mimeType,
    lastModified: file.lastModified || null,
    duration: null,
    selectedAt,
    fingerprint: null,
    fileHandle: fileHandle || existingRecord?.fileHandle || null,
  };
  if (!metadata.fileHandle) {
    delete metadata.fileHandle;
  }

  currentMetadata = metadata;
  currentObjectUrl = URL.createObjectURL(file);
  videoElement.src = currentObjectUrl;
  videoElement.hidden = false;
  videoElement.load();
  details.textContent = `${file.name} · ${media.format} · ${formatBytes(file.size)}`;
  details.hidden = false;
  setMessage(
    support === "probably"
      ? `فایل ${media.format} انتخاب شد و مرورگر از پخش آن پشتیبانی می‌کند.`
      : `فایل ${media.format} انتخاب شد؛ سازگاری کدک پس از بارگذاری رسانه مشخص می‌شود.`,
    "success",
  );

  const result = await persistMetadata(metadata);
  if (version !== selectionVersion) {
    return;
  }
  if (!result.saved) {
    setMessage("ویدئو برای این نشست پخش می‌شود، اما فراداده در IndexedDB ذخیره نشد. فضای ذخیره‌سازی مرورگر را بررسی کنید.", "warning");
  } else if (metadata.fileHandle && !result.handleSaved) {
    setMessage("فراداده ذخیره شد؛ این مرورگر File Handle را نگه نداشت و دفعهٔ بعد باید فایل را دوباره انتخاب کنید.", "warning");
  }
  fileInput.value = "";

  try {
    const fingerprint = await createSampledFingerprint(file);
    if (version !== selectionVersion || currentMetadata !== metadata) {
      return;
    }
    metadata.fingerprint = fingerprint;
    const fingerprintSave = await persistMetadata(metadata);
    window.dispatchEvent(new CustomEvent("shadowing:videoavailable", { detail: { metadata: { ...metadata } } }));
    if (!fingerprintSave.saved) {
      setMessage("ویدئو پخش می‌شود، اما fingerprint نمونه‌برداری‌شده در IndexedDB ذخیره نشد.", "warning");
    }
  } catch {
    if (version === selectionVersion && currentMetadata === metadata) {
      setMessage("ویدئو پخش می‌شود، اما مرورگر نتوانست fingerprint محلی را محاسبه کند.", "warning");
    }
  }
}

async function loadPreviousVideo(workspaceId) {
  const loadVersion = ++workspaceLoadVersion;
  previousVideo = null;
  restoreButton.hidden = true;
  if (!workspaceId) {
    return;
  }
  try {
    const records = await listWorkspaceVideos(workspaceId);
    if (loadVersion !== workspaceLoadVersion || workspaceId !== activeWorkspaceId) {
      return;
    }
    previousVideo = records.sort((first, second) =>
      String(second.selectedAt).localeCompare(String(first.selectedAt)),
    )[0] || null;
    if (!previousVideo) {
      return;
    }
    if (!previousVideo.fileHandle || typeof previousVideo.fileHandle.getFile !== "function") {
      setMessage(`וیدئوی قبلی «${previousVideo.fileName}» ثبت شده است؛ برای پخش، فایل را دوباره انتخاب کنید. خود فایل در مرورگر ذخیره نشده است.`, "info");
      return;
    }
    restoreButton.hidden = false;
    setMessage(`فرادادهٔ «${previousVideo.fileName}» پیدا شد. برای بازیابی دسترسی فایل از دکمهٔ بازیابی استفاده کنید.`, "info");

    if (typeof previousVideo.fileHandle.queryPermission === "function") {
      const permission = await previousVideo.fileHandle.queryPermission({ mode: "read" });
      if (permission === "granted" && loadVersion === workspaceLoadVersion) {
        await restorePreviousVideo(false);
      }
    }
  } catch {
    setMessage("فرادادهٔ ویدئوی قبلی خوانده نشد؛ انتخاب فایل همچنان در دسترس است.", "warning");
  }
}

async function restorePreviousVideo(requestPermission = true) {
  const record = previousVideo;
  if (!record?.fileHandle) {
    setMessage("مرورگر دسترسی بازیابی‌پذیر ذخیره نکرده است؛ فایل را دوباره انتخاب کنید.", "warning");
    return;
  }
  try {
    const handle = record.fileHandle;
    let permission = typeof handle.queryPermission === "function"
      ? await handle.queryPermission({ mode: "read" })
      : "granted";
    if (permission !== "granted" && requestPermission && typeof handle.requestPermission === "function") {
      permission = await handle.requestPermission({ mode: "read" });
    }
    if (permission !== "granted") {
      setMessage("اجازهٔ خواندن فایل داده نشد. فایل را دوباره انتخاب کنید.", "warning");
      return;
    }
    if (activeWorkspaceId !== record.workspaceId || previousVideo !== record) {
      return;
    }
    const file = await handle.getFile();
    if (activeWorkspaceId !== record.workspaceId || previousVideo !== record) {
      return;
    }
    await selectFile(file, handle, record);
  } catch {
    setMessage("دسترسی به فایل قبلی از بین رفته یا فایل جابه‌جا شده است؛ لطفاً آن را دوباره انتخاب کنید.", "warning");
    restoreButton.hidden = true;
  }
}

selectButton.addEventListener("click", async () => {
  if (typeof window.showOpenFilePicker !== "function") {
    fileInput.click();
    return;
  }
  try {
    const [handle] = await window.showOpenFilePicker({
      multiple: false,
      types: [{
        description: "ویدئوی MP4 یا WebM",
        accept: { "video/mp4": [".mp4"], "video/webm": [".webm"] },
      }],
    });
    await selectFile(await handle.getFile(), handle);
  } catch (error) {
    if (error?.name !== "AbortError") {
      setMessage("انتخاب‌گر دسترسی فایل در دسترس نبود؛ از ورودی انتخاب فایل استفاده کنید.", "warning");
      fileInput.click();
    }
  }
});

fileInput.addEventListener("change", async () => {
  await selectFile(fileInput.files?.[0] || null);
});

restoreButton.addEventListener("click", () => restorePreviousVideo(true));

videoElement.addEventListener("loadedmetadata", async () => {
  if (!currentMetadata || !Number.isFinite(videoElement.duration)) {
    return;
  }
  currentMetadata.duration = videoElement.duration;
  const result = await persistMetadata(currentMetadata);
  if (!result.saved) {
    setMessage("ویدئو پخش‌پذیر است، اما مدت آن در IndexedDB ذخیره نشد.", "warning");
    return;
  }
  details.textContent = `${currentMetadata.fileName} · ${formatBytes(currentMetadata.size)} · مدت ${Math.floor(videoElement.duration / 60)}:${String(Math.floor(videoElement.duration % 60)).padStart(2, "0")}`;
});

videoElement.addEventListener("error", () => {
  const code = videoElement.error?.code;
  if (code === MediaError.MEDIA_ERR_DECODE || code === MediaError.MEDIA_ERR_SRC_NOT_SUPPORTED) {
    setMessage("مرورگر نتوانست رسانه را رمزگشایی کند. ظرف MP4/WebM شناخته شد، اما کدک ویدئو یا صدا پشتیبانی نمی‌شود.", "danger");
  } else if (code === MediaError.MEDIA_ERR_ABORTED) {
    setMessage("خواندن ویدئو متوقف شد. فایل را دوباره انتخاب کنید.", "warning");
  } else if (code === MediaError.MEDIA_ERR_NETWORK) {
    setMessage("خواندن فایل محلی ناموفق بود یا دسترسی آن از بین رفت؛ فایل را دوباره انتخاب کنید.", "danger");
  } else {
    setMessage("پخش ویدئو ناموفق بود. دسترسی فایل را بررسی و دوباره انتخاب کنید.", "danger");
  }
});

window.addEventListener("beforeunload", () => {
  if (currentObjectUrl) {
    URL.revokeObjectURL(currentObjectUrl);
  }
});

window.addEventListener("shadowing:workspacechange", async (event) => {
  activeWorkspaceId = event.detail?.workspaceId || null;
  clearCurrentVideo();
  selectButton.disabled = !activeWorkspaceId;
  setMessage(activeWorkspaceId ? "برای شروع یک فایل MP4 یا WebM انتخاب کنید." : "ابتدا یک Workspace فعال انتخاب کنید.", "info");
  await loadPreviousVideo(activeWorkspaceId);
});

(async function initialize() {
  try {
    activeWorkspaceId = await getActiveWorkspaceId();
    selectButton.disabled = !activeWorkspaceId;
    setMessage(activeWorkspaceId ? "برای شروع یک فایل MP4 یا WebM انتخاب کنید." : "ابتدا یک Workspace فعال انتخاب کنید.", "info");
    await loadPreviousVideo(activeWorkspaceId);
  } catch {
    selectButton.disabled = true;
    setMessage("IndexedDB در دسترس نیست؛ فرادادهٔ ویدئو ذخیره نخواهد شد.", "danger");
  }
})();
