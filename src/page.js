import {
  TARGET,
  needsCompression,
  kindOf,
  videoPlan,
  replaceExt,
} from "./shared/plan.js";
import { createFFmpegClient } from "./ffmpeg-client.js";

const CSS = `
:host { all: initial; display: block; width: 100%; }
.bar {
  box-sizing: border-box;
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  height: 36px;
  margin: 0 0 6px 0;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: #2b2d31;
  color: #dbdee1;
  font: 400 12px/1.2 "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
  letter-spacing: 0.01em;
  opacity: 0;
  transform: translateY(4px);
  transition: opacity 160ms cubic-bezier(0.23, 1, 0.32, 1), transform 180ms cubic-bezier(0.23, 1, 0.32, 1), height 180ms cubic-bezier(0.23, 1, 0.32, 1), margin 180ms cubic-bezier(0.23, 1, 0.32, 1);
  pointer-events: auto;
  user-select: none;
  overflow: hidden;
}
.bar[data-visible="false"] {
  height: 0;
  margin: 0;
  padding: 0 12px;
  border-width: 0;
  opacity: 0;
  transform: translateY(4px);
  pointer-events: none;
}
.bar[data-visible="true"] {
  opacity: 1;
  transform: translateY(0);
}
:host([data-theme="light"]) .bar {
  background: #ebedef;
  border-color: rgba(0, 0, 0, 0.08);
  color: #2e3338;
}
.spinner {
  flex: none;
  display: grid;
  place-items: center;
  width: 14px;
  height: 14px;
  color: #5865f2;
  animation: dc-spin 0.8s linear infinite;
}
@keyframes dc-spin {
  to { transform: rotate(360deg); }
}
.icon-done, .icon-error {
  flex: none;
  display: none;
  place-items: center;
  width: 14px;
  height: 14px;
}
.bar[data-state="done"] .spinner { display: none; }
.bar[data-state="done"] .icon-done {
  display: grid;
  color: #23a559;
}
:host([data-theme="light"]) .bar[data-state="done"] .icon-done {
  color: #1a6334;
}
.bar[data-state="error"] .spinner { display: none; }
.bar[data-state="error"] .icon-error {
  display: grid;
  color: #f23f43;
}
:host([data-theme="light"]) .bar[data-state="error"] .icon-error {
  color: #d83c3e;
}
.label {
  min-width: 0;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  font-weight: 500;
}
.bar[data-state="done"] .label {
  color: #23a559;
}
:host([data-theme="light"]) .bar[data-state="done"] .label {
  color: #1a6334;
}
.bar[data-state="error"] .label {
  color: #f23f43;
}
:host([data-theme="light"]) .bar[data-state="error"] .label {
  color: #d83c3e;
}
.hint {
  flex: none;
  color: #949ba4;
  font-size: 11px;
}
:host([data-theme="light"]) .hint {
  color: #6d6f78;
}
.bar[data-state="done"] .hint,
.bar[data-state="error"] .hint {
  display: none;
}
.action {
  flex: none;
  margin: 0;
  padding: 4px 8px;
  border: 0;
  border-radius: 4px;
  background: rgba(88, 101, 242, 0.15);
  color: #5865f2;
  font: 500 11.5px/1 "gg sans", "Noto Sans", "Helvetica Neue", Arial, sans-serif;
  letter-spacing: 0.01em;
  cursor: pointer;
  transition: background 120ms ease, color 120ms ease, transform 140ms cubic-bezier(0.23, 1, 0.32, 1);
}
:host([data-theme="light"]) .action {
  color: #5865f2;
  background: rgba(88, 101, 242, 0.12);
}
.action:hover {
  background: #5865f2;
  color: #ffffff;
}
:host([data-theme="light"]) .action:hover {
  background: #5865f2;
  color: #ffffff;
}
.action:active {
  transform: scale(0.97);
}
.action:focus-visible {
  outline: 2px solid #5865f2;
  outline-offset: 2px;
}
.action[hidden] {
  display: none;
}
.track {
  flex: 1 1 auto;
  min-width: 40px;
  height: 4px;
  overflow: hidden;
  border-radius: 2px;
  background: #1e1f22;
}
:host([data-theme="light"]) .track {
  background: rgba(0, 0, 0, 0.12);
}
.fill {
  width: 100%;
  height: 100%;
  background: #5865f2;
  transform: scaleX(0);
  transform-origin: left center;
  transition: transform 160ms linear;
  will-change: transform;
}
.bar[data-state="done"] .fill {
  background: #23a559;
}
:host([data-theme="light"]) .bar[data-state="done"] .fill {
  background: #1a6334;
}
.pct {
  flex: none;
  min-width: 30px;
  text-align: right;
  color: #b5bac1;
  font-variant-numeric: tabular-nums;
  font-size: 11.5px;
}
:host([data-theme="light"]) .pct {
  color: #5c5e66;
}
.dismiss {
  flex: none;
  display: grid;
  place-items: center;
  width: 22px;
  height: 22px;
  margin-left: -2px;
  padding: 0;
  border: 0;
  border-radius: 4px;
  background: none;
  color: #b5bac1;
  cursor: pointer;
  transition: color 120ms ease, background-color 120ms ease, transform 120ms ease;
}
:host([data-theme="light"]) .dismiss {
  color: #5c5e66;
}
.dismiss:hover {
  color: #dbdee1;
  background: rgba(78, 80, 88, 0.4);
}
:host([data-theme="light"]) .dismiss:hover {
  color: #2e3338;
  background: rgba(0, 0, 0, 0.08);
}
.dismiss:active {
  transform: scale(0.92);
}
.dismiss:focus-visible {
  outline: 2px solid #5865f2;
  outline-offset: 2px;
}
.dismiss[hidden] {
  display: none;
}
@media (prefers-reduced-motion: reduce) {
  .bar,
  .action,
  .dismiss,
  .spinner {
    transform: none;
    animation: none;
    transition: opacity 140ms linear;
  }
}
`;

const ffmpeg = createFFmpegClient();
let composer = null;
let host = null;
let shadow = null;
let bar = null;
let labelEl = null;
let hintEl = null;
let actionEl = null;
let pctEl = null;
let dismissEl = null;
let fillEl = null;
let actionJob = null;
let actionHandler = null;
let jobs = [];
let jobSeq = 0;
let bypass = false;
let hideTimer = 0;
let noticeTimer = 0;
let mountScheduled = false;
let themeObserver = null;

function applyTheme() {
  if (!host) return;
  const root = document.documentElement;
  const light = root.classList.contains("theme-light") || root.dataset.theme === "light";
  host.dataset.theme = light ? "light" : "dark";
}

function ensureUI() {
  if (host && host.isConnected) return;
  host = document.createElement("div");
  host.id = "dc-compressor";
  shadow = host.attachShadow({ mode: "open" });
  const sheet = new CSSStyleSheet();
  sheet.replaceSync(CSS);
  shadow.adoptedStyleSheets = [sheet];

  bar = document.createElement("div");
  bar.className = "bar";
  bar.setAttribute("role", "status");
  bar.setAttribute("aria-live", "polite");
  bar.dataset.visible = "false";

  const spinner = document.createElement("div");
  spinner.className = "spinner";
  spinner.setAttribute("aria-hidden", "true");
  spinner.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-opacity="0.25"/><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  const doneIcon = document.createElement("div");
  doneIcon.className = "icon-done";
  doneIcon.setAttribute("aria-hidden", "true");
  doneIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M3.5 8.5l3 3 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  const errorIcon = document.createElement("div");
  errorIcon.className = "icon-error";
  errorIcon.setAttribute("aria-hidden", "true");
  errorIcon.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2"/><path d="M8 5v3.5M8 11.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';

  labelEl = document.createElement("div");
  labelEl.className = "label";

  hintEl = document.createElement("span");
  hintEl.className = "hint";
  hintEl.textContent = "• You can keep typing";

  actionEl = document.createElement("button");
  actionEl.type = "button";
  actionEl.className = "action";
  actionEl.hidden = true;
  actionEl.addEventListener("click", () => actionHandler?.());

  const track = document.createElement("div");
  track.className = "track";
  fillEl = document.createElement("div");
  fillEl.className = "fill";
  track.append(fillEl);

  pctEl = document.createElement("span");
  pctEl.className = "pct";

  dismissEl = document.createElement("button");
  dismissEl.type = "button";
  dismissEl.className = "dismiss";
  dismissEl.setAttribute("aria-label", "Dismiss");
  dismissEl.setAttribute("title", "Dismiss");
  dismissEl.innerHTML =
    '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  dismissEl.addEventListener("click", () => hideBar());

  bar.append(spinner, doneIcon, errorIcon, labelEl, hintEl, actionEl, track, pctEl, dismissEl);
  shadow.append(bar);
  document.documentElement.append(host);
  applyTheme();
  themeObserver?.disconnect();
  themeObserver = new MutationObserver(applyTheme);
  themeObserver.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["class"],
  });
}

function anchorBar() {
  if (!host || !composer || !composer.isConnected) return;
  const textArea =
    composer.closest('[class*="channelTextArea"]') ||
    composer.querySelector?.('[class*="channelTextArea"]') ||
    composer;
  const scrollable =
    textArea.querySelector?.('[class*="scrollableContainer"]') ||
    (textArea.classList?.contains("scrollableContainer") ? textArea : null) ||
    textArea.firstElementChild ||
    textArea;

  if (scrollable && scrollable.parentElement === textArea) {
    if (host.parentElement === textArea && host.nextElementSibling === scrollable) return;
    scrollable.insertAdjacentElement("beforebegin", host);
    return;
  }
  if (host.parentElement === textArea.parentElement && host.nextElementSibling === textArea) return;
  textArea.insertAdjacentElement("beforebegin", host);
}

function findComposer() {
  const box = document.querySelector('[role="textbox"][data-slate-editor="true"]');
  if (box) {
    return (
      box.closest('[class*="scrollableContainer"]') ||
      box.closest('[class*="channelTextArea"]') ||
      box.closest("form") ||
      box
    );
  }
  const input = findFileInput();
  if (input) {
    return (
      input.closest('[class*="channelTextArea"]') ||
      input.closest('[class*="scrollableContainer"]') ||
      input.parentElement
    );
  }
  return null;
}

function findFileInput() {
  const sources = [
    composer && composer.isConnected ? composer.querySelector('input[type="file"]') : null,
    document.querySelector('[class*="uploadInput"] input[type="file"]'),
    document.querySelector('input[class~="file-input"]'),
  ];
  for (const input of sources) {
    if (input && input.isConnected) return input;
  }
  return null;
}

function scheduleMount() {
  if (mountScheduled) return;
  mountScheduled = true;
  requestAnimationFrame(() => {
    mountScheduled = false;
    const next = findComposer();
    if (next && next !== composer) {
      composer = next;
      console.log("[dc] composer found");
      if (host?.isConnected && jobs.length) anchorBar();
    }
  });
}

function showBar() {
  ensureUI();
  anchorBar();
  if (!host.isConnected) document.documentElement.append(host);
  clearTimeout(noticeTimer);
  clearTimeout(hideTimer);
  bar.dataset.state = "";
  bar.dataset.visible = "true";
}

function hideBar() {
  clearTimeout(noticeTimer);
  clearTimeout(hideTimer);
  if (!host?.isConnected) return;
  bar.dataset.visible = "false";
  bar.dataset.state = "";
  bar.setAttribute("aria-label", "");
  actionEl.hidden = true;
  dismissEl.hidden = true;
  actionJob = null;
  actionHandler = null;
  hideTimer = setTimeout(() => {
    if (jobs.length || !host?.isConnected) return;
    host.remove();
    ffmpeg.scheduleIdle();
  }, 200);
}

function setAction(job) {
  if (job === actionJob) return;
  actionJob = job;
  if (!job) {
    actionEl.hidden = true;
    actionHandler = null;
    return;
  }
  actionEl.hidden = false;
  actionEl.textContent = "Split into 2";
  actionHandler = () => {
    if (job.done || job.split) return;
    job.splitRequested = true;
    job.split = true;
    job.progress = 0;
    actionEl.hidden = true;
    actionJob = null;
    actionHandler = null;
    renderBar();
    ffmpeg.cancel();
  };
}

function renderBar() {
  if (!jobs.length) return;
  showBar();
  const videos = jobs.filter((job) => job.kind === "video");
  const images = jobs.filter((job) => job.kind === "image");
  const videoCount = videos.reduce((count, job) => count + (job.split ? 2 : 1), 0);
  let text;
  if (videoCount && !images.length) {
    text = `Compressing ${videoCount === 1 ? "video" : `${videoCount} videos`}`;
  } else if (images.length && !videoCount) {
    text = `Compressing ${images.length === 1 ? "image" : `${images.length} images`}`;
  } else {
    text = `Compressing ${jobs.length} files`;
  }
  if (labelEl.textContent !== text) labelEl.textContent = text;
  bar.setAttribute("aria-label", text);
  hintEl.hidden = false;
  const weight = jobs.reduce((sum, job) => sum + job.weight, 0);
  const progress = weight
    ? jobs.reduce((sum, job) => sum + job.progress * job.weight, 0) / weight
    : 0;
  fillEl.style.transform = `scaleX(${Math.max(0, Math.min(0.99, progress))})`;
  pctEl.textContent = `${Math.round(progress * 100)}%`;
  dismissEl.hidden = false;
  const splitJob =
    videos.length === 1 && videos[0].allowSplit && !videos[0].split ? videos[0] : null;
  setAction(splitJob);
}

function finishBar(batchJobs) {
  if (jobs.length) return;
  showBar();
  bar.dataset.state = "done";
  let text;
  if (batchJobs.length === 1 && batchJobs[0].split) {
    text = "Split into 2 parts and attached";
  } else if (batchJobs.length === 1) {
    const kind = batchJobs[0].kind;
    text = `${kind === "video" ? "Video" : kind === "image" ? "Image" : "File"} compressed and attached`;
  } else {
    text = `${batchJobs.length} files compressed and attached`;
  }
  labelEl.textContent = text;
  bar.setAttribute("aria-label", text);
  hintEl.hidden = true;
  fillEl.style.transform = "scaleX(1)";
  pctEl.textContent = "";
  dismissEl.hidden = false;
  actionEl.hidden = true;
  actionJob = null;
  actionHandler = null;
  ffmpeg.scheduleIdle();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (!jobs.length) hideBar();
  }, 14000);
}

function showError(failed) {
  if (jobs.length || !failed.length) return;
  showBar();
  bar.dataset.state = "error";
  const videosOnly = failed.every((job) => job.kind === "video");
  const text =
    failed.length === 1
      ? `Couldn't compress ${videosOnly ? "video" : "file"}`
      : `Couldn't compress ${failed.length} files`;
  labelEl.textContent = text;
  bar.setAttribute("aria-label", text);
  hintEl.hidden = true;
  fillEl.style.transform = "scaleX(0)";
  pctEl.textContent = "";
  dismissEl.hidden = false;
  actionEl.hidden = true;
  actionJob = null;
  actionHandler = null;
  ffmpeg.scheduleIdle();
  clearTimeout(noticeTimer);
  noticeTimer = setTimeout(() => {
    if (!jobs.length) hideBar();
  }, 8000);
}

function probeVideo(file) {
  return ffmpeg.probe(file);
}

async function compressVideoJob(job, batchJobs) {
  const meta = await probeVideo(job.file);
  const plan = videoPlan({
    size: job.file.size,
    duration: meta.duration,
    width: meta.width,
    height: meta.height,
  });
  job.plan = plan;
  const videoJobs = batchJobs.filter((item) => item.kind === "video");
  job.allowSplit = plan.offerSplit && videoJobs.length === 1;
  if (job.allowSplit) renderBar();
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await ffmpeg.compress(
        job.file,
        meta,
        plan,
        job.splitRequested,
        (progress) => {
          job.progress = Math.max(job.progress || 0, Math.max(0, Math.min(1, progress)));
          renderBar();
        },
      );
    } catch (error) {
      if (error.code === "cancelled" && job.splitRequested) {
        job.progress = 0;
        renderBar();
        continue;
      }
      if (job.splitRequested && !job.splitRetried) {
        job.splitRequested = false;
        job.split = false;
        job.splitRetried = true;
        job.progress = 0;
        renderBar();
        continue;
      }
      throw error;
    }
  }
  throw new Error("Compression failed");
}

async function compressImageJob(job) {
  job.progress = 0.05;
  renderBar();
  const bitmap = await createImageBitmap(job.file);
  try {
    let width = bitmap.width;
    let height = bitmap.height;
    const scale = Math.min(1, Math.sqrt(40000000 / (width * height)));
    width = Math.max(2, Math.round((width * scale) / 2) * 2);
    height = Math.max(2, Math.round((height * scale) / 2) * 2);
    let quality = 0.92;
    const canvas = new OffscreenCanvas(width, height);
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    for (let attempt = 0; attempt < 8; attempt++) {
      canvas.width = width;
      canvas.height = height;
      context.clearRect(0, 0, width, height);
      context.drawImage(bitmap, 0, 0, width, height);
      const blob = await canvas.convertToBlob({ type: "image/webp", quality });
      job.progress = 0.2 + (0.75 * (attempt + 1)) / 8;
      renderBar();
      if (blob.size <= TARGET) {
        return [
          new File([blob], replaceExt(job.file.name, "webp"), {
            type: "image/webp",
            lastModified: Date.now(),
          }),
        ];
      }
      if (quality > 0.62) {
        quality -= 0.08;
      } else {
        width = Math.max(2, Math.round((width * 0.85) / 2) * 2);
        height = Math.max(2, Math.round((height * 0.85) / 2) * 2);
        quality = 0.8;
      }
    }
  } finally {
    bitmap.close?.();
  }
  throw new Error("Image is still too large");
}

function fileTag(file) {
  return `${file.name} ${(file.size / 1048576).toFixed(1)} MB`;
}

function hasOversized(files) {
  for (const file of files) {
    if (needsCompression(file.size) && kindOf(file) !== "other") return true;
  }
  return false;
}

function onChange(event) {
  if (bypass) return;
  const input = event.target;
  if (!input || input.tagName !== "INPUT" || input.type !== "file") return;
  const files = input.files;
  if (!files || !files.length) return;
  console.log("[dc] change", files.length, "file(s)");
  if (!hasOversized(files)) {
    console.log("[dc] ignored", [...files].map(fileTag).join(", "));
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const list = [...files];
  console.log("[dc] intercepting", list.map(fileTag).join(", "));
  const target = { kind: "input", input, channel: location.pathname };
  input.value = "";
  runBatch(list, target);
}

function onDrop(event) {
  if (bypass) return;
  const transfer = event.dataTransfer;
  if (!transfer || !transfer.files || !transfer.files.length) return;
  console.log("[dc] drop", transfer.files.length, "file(s)");
  if (!hasOversized(transfer.files)) {
    console.log("[dc] ignored", [...transfer.files].map(fileTag).join(", "));
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const element = event.target instanceof Element ? event.target : composer;
  console.log("[dc] intercepting", [...transfer.files].map(fileTag).join(", "));
  const target = { kind: "drop", element, channel: location.pathname };
  runBatch([...transfer.files], target);
}

function onPaste(event) {
  if (bypass) return;
  const files = event.clipboardData?.files;
  if (!files || !files.length) return;
  console.log("[dc] paste", files.length, "file(s)");
  if (!hasOversized(files)) {
    console.log("[dc] ignored", [...files].map(fileTag).join(", "));
    return;
  }
  event.preventDefault();
  event.stopImmediatePropagation();
  const input = findFileInput();
  console.log("[dc] intercepting", [...files].map(fileTag).join(", "));
  const target = input
    ? { kind: "input", input, channel: location.pathname }
    : { kind: "drop", element: composer, channel: location.pathname };
  runBatch([...files], target);
}

function attachFiles(target, files) {
  if (!files.length) return;
  if (target.kind === "input") {
    let input = target.input;
    if (!input || !input.isConnected) {
      input = findFileInput();
    }
    if (input) {
      const transfer = new DataTransfer();
      for (const file of files) transfer.items.add(file);
      bypass = true;
      try {
        input.files = transfer.files;
        input.dispatchEvent(new Event("change", { bubbles: true }));
      } finally {
        bypass = false;
      }
      return;
    }
  }
  const element =
    target.element && target.element.isConnected ? target.element : composer;
  if (!element || !element.isConnected) return;
  const transfer = new DataTransfer();
  for (const file of files) transfer.items.add(file);
  const drop = new DragEvent("drop", {
    bubbles: true,
    cancelable: true,
    dataTransfer: transfer,
  });
  bypass = true;
  try {
    element.dispatchEvent(drop);
  } finally {
    bypass = false;
  }
}

async function runBatch(files, target) {
  const oversized = files.filter(
    (file) => needsCompression(file.size) && kindOf(file) !== "other",
  );
  if (!oversized.length) return;
  const batchJobs = oversized.map((file) => ({
    id: ++jobSeq,
    file,
    kind: kindOf(file),
    progress: 0,
    weight: file.size,
    split: false,
    splitRequested: false,
    splitRetried: false,
    allowSplit: false,
    done: false,
    failed: false,
  }));
  jobs.push(...batchJobs);
  renderBar();
  const results = new Map();
  await Promise.all(
    batchJobs.map(async (job) => {
      try {
        if (job.kind === "image") {
          results.set(job, await compressImageJob(job));
        } else {
          results.set(job, await compressVideoJob(job, batchJobs));
        }
      } catch (error) {
        console.warn("[dc] failed", job.file.name, error);
        job.failed = true;
        results.set(job, [job.file]);
      } finally {
        job.done = true;
        job.progress = 1;
        jobs = jobs.filter((item) => item !== job);
        renderBar();
      }
    }),
  );
  const output = [];
  for (const file of files) {
    const job = batchJobs.find((item) => item.file === file);
    if (job && results.has(job)) output.push(...results.get(job));
    else output.push(file);
  }
  const failed = batchJobs.filter((job) => job.failed);
  if (target.channel !== location.pathname) {
    if (!jobs.length) hideBar();
    return;
  }
  attachFiles(target, output);
  if (failed.length) showError(failed);
  else finishBar(batchJobs);
}

function boot() {
  console.log("[dc] active");
  const root = document.documentElement;
  ensureUI();
  window.addEventListener("change", onChange, true);
  window.addEventListener("drop", onDrop, true);
  window.addEventListener("paste", onPaste, true);
  new MutationObserver(scheduleMount).observe(root, {
    childList: true,
    subtree: true,
  });
  scheduleMount();
}

boot();
