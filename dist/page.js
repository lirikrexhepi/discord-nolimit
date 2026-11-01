(() => {
  // src/shared/plan.js
  var LIMIT = 20 * 1024 * 1024;
  var TARGET = Math.floor(19.2 * 1024 * 1024);
  var VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ts|gif)$/i;
  var IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i;
  function needsCompression(size) {
    return size > LIMIT;
  }
  function kindOf(file) {
    const type = (file.type || "").toLowerCase();
    const name = file.name || "";
    if (type.startsWith("video/") || VIDEO_EXT.test(name)) return "video";
    if (type.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
    return "other";
  }
  function fitPixels(width, height, maxPixels) {
    const w = Math.max(2, Math.round(width || 1280));
    const h = Math.max(2, Math.round(height || 720));
    const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
    return {
      width: Math.max(2, Math.round(w * scale / 2) * 2),
      height: Math.max(2, Math.round(h * scale / 2) * 2)
    };
  }
  function videoPlan({ size, duration, width, height, limit = TARGET }) {
    const seconds = Number.isFinite(duration) && duration > 0 ? duration : 1;
    const audioKbps = seconds < 45 ? 128 : 96;
    const totalKbps = Math.floor(limit * 8 * 0.94 / seconds / 1e3);
    const videoKbps = Math.max(140, totalKbps - audioKbps);
    const maxPixels = videoKbps >= 4200 ? 2073600 : videoKbps >= 2100 ? 921600 : videoKbps >= 950 ? 518400 : 409920;
    const dims = fitPixels(width, height, maxPixels);
    return {
      videoKbps,
      audioKbps,
      width: dims.width,
      height: dims.height,
      offerSplit: size > LIMIT * 2 && seconds >= 45 && videoKbps < 1800
    };
  }
  function replaceExt(name, ext) {
    return `${(name || "file").replace(/\.[^.]+$/, "")}.${ext}`;
  }
  function partName(name, index) {
    return `${(name || "video").replace(/\.[^.]+$/, "")} part ${index}.mp4`;
  }

  // src/ffmpeg-client.js
  var WORKER_PATH = "vendor/ffmpeg/814.ffmpeg.js";
  var CORE_PATH = "vendor/ffmpeg/ffmpeg-core.js";
  var WASM_PATH = "vendor/ffmpeg/ffmpeg-core.wasm";
  var PATCH_FROM = "({coreURL:o,wasmURL:s,workerURL:E})";
  var PATCH_TO = "({coreURL:o,wasmURL:s,workerURL:E,wasmBinary:W})";
  var CORE_FROM = "self.createFFmpegCore({mainScriptUrlOrBlob:";
  var CORE_TO = "self.createFFmpegCore({wasmBinary:W,mainScriptUrlOrBlob:";
  var TEXT_ENCODER = new TextEncoder();
  function patchWorker(text) {
    if (!text.includes(PATCH_FROM) || !text.includes(CORE_FROM)) {
      throw new Error("Unsupported ffmpeg build");
    }
    return text.replace(PATCH_FROM, PATCH_TO).replace(CORE_FROM, CORE_TO);
  }
  function requestFromBridge(timeout = 2e4) {
    return new Promise((resolve, reject) => {
      let timer = 0;
      const cleanup = () => {
        clearTimeout(timer);
        window.removeEventListener("message", onMessage);
      };
      const onMessage = (event) => {
        const message = event.data;
        if (!message || message.source !== "dc-bridge") return;
        if (message.type === "assets") {
          cleanup();
          resolve({
            workerText: message.workerText,
            coreText: message.coreText,
            wasm: message.wasm
          });
        } else if (message.type === "assets-error") {
          cleanup();
          reject(new Error(message.message || "Could not load compressor"));
        }
      };
      timer = setTimeout(() => {
        cleanup();
        reject(new Error("Could not load compressor"));
      }, timeout);
      window.addEventListener("message", onMessage);
      window.postMessage({ source: "dc-page", type: "assets-request" }, "*");
    });
  }
  async function fetchAsset(base, file, kind) {
    const response = await fetch(new URL(file, base));
    if (!response.ok) throw new Error(`Could not load ${file}`);
    return kind === "text" ? response.text() : response.arrayBuffer();
  }
  async function fetchDirect(base) {
    const [workerText, coreText, wasm] = await Promise.all([
      fetchAsset(base, WORKER_PATH, "text"),
      fetchAsset(base, CORE_PATH, "text"),
      fetchAsset(base, WASM_PATH, "buffer")
    ]);
    return { workerText, coreText, wasm };
  }
  function probeWithVideo(file) {
    return new Promise((resolve, reject) => {
      const url = URL.createObjectURL(file);
      const video = document.createElement("video");
      let settled = false;
      const finish = (callback) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        video.removeAttribute("src");
        video.load();
        URL.revokeObjectURL(url);
        callback();
      };
      const timer = setTimeout(() => finish(() => reject(new Error("Could not read video"))), 8e3);
      const ready = () => {
        if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth) {
          const meta = {
            duration: video.duration,
            width: video.videoWidth,
            height: video.videoHeight
          };
          finish(() => resolve(meta));
          return true;
        }
        return false;
      };
      video.preload = "metadata";
      video.muted = true;
      video.onloadedmetadata = () => {
        if (ready()) return;
        try {
          video.currentTime = 1e7;
        } catch {
        }
      };
      video.ondurationchange = ready;
      video.onseeked = ready;
      video.onerror = () => finish(() => reject(new Error("Could not read video")));
      video.src = url;
    });
  }
  function extensionOf(name) {
    const match = /(\.[a-z0-9]+)$/i.exec(name || "");
    return match ? match[1].toLowerCase() : ".mp4";
  }
  function parseProbeLogs(logText) {
    const duration = logText.match(/Duration:\s*(\d+):(\d+):(\d+(?:\.\d+)?)/);
    if (!duration) throw new Error("Could not read video");
    const stream = logText.match(/Stream #0:\d+.*?,\s*(\d{2,5})x(\d{2,5})/);
    return {
      duration: Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
      width: stream ? Number(stream[1]) : 1280,
      height: stream ? Number(stream[2]) : 720
    };
  }
  function logSeconds(line) {
    const match = /time=\s*(-?\d+):(\d+):([\d.]+)/.exec(line);
    if (!match) return null;
    const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
    return seconds >= 0 ? seconds : null;
  }
  function buildArgs(input, output, plan, kbps, preset = "ultrafast") {
    const filters = plan.width && plan.height ? ["-vf", `scale=${plan.width}:${plan.height}:flags=fast_bilinear`] : [];
    return [
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      ...filters,
      "-r",
      "30",
      "-c:v",
      "libx264",
      "-preset",
      preset,
      "-b:v",
      `${kbps}k`,
      "-maxrate",
      `${Math.round(kbps * 1.05)}k`,
      "-bufsize",
      `${Math.round(kbps * 1.15)}k`,
      "-pix_fmt",
      "yuv420p",
      "-c:a",
      "aac",
      "-b:a",
      `${plan.audioKbps}k`,
      "-ac",
      "2",
      "-movflags",
      "+faststart",
      "-sn",
      "-dn",
      "-y",
      output
    ];
  }
  function copyCutArgs(input, output, startAt, runFor) {
    return [
      "-ss",
      String(startAt),
      "-t",
      String(runFor),
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      output
    ];
  }
  function segmentCutArgs(input, pattern, seconds, count) {
    return [
      "-i",
      input,
      "-map",
      "0:v:0",
      "-map",
      "0:a:0?",
      "-f",
      "segment",
      "-segment_time",
      String(Math.ceil(seconds / count)),
      "-reset_timestamps",
      "1",
      "-c",
      "copy",
      "-avoid_negative_ts",
      "make_zero",
      "-y",
      pattern
    ];
  }
  function stitchArgs(listFile, output) {
    return [
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-y",
      output
    ];
  }
  function createFFmpegClient() {
    const MAX_WORKERS = Math.max(2, Math.min(4, (navigator.hardwareConcurrency || 4) - 1));
    let assets = null;
    let assetsPromise = null;
    let chain = Promise.resolve();
    let idleTimer = 0;
    let spawning = 0;
    const entries = [];
    const waiters = [];
    function clearIdle() {
      clearTimeout(idleTimer);
      idleTimer = 0;
    }
    function scheduleIdle() {
      clearIdle();
      idleTimer = setTimeout(() => {
        if (entries.some((entry) => entry.busy)) return;
        terminateAll();
      }, 9e4);
    }
    function cancel() {
      clearIdle();
      const pending = [...waiters];
      waiters.length = 0;
      for (const waiter of pending) waiter(null);
      terminateAll();
    }
    function terminateAll() {
      for (const entry of [...entries]) destroyEntry(entry);
    }
    function destroyEntry(entry, reason) {
      if (!entry.alive) return;
      entry.alive = false;
      const index = entries.indexOf(entry);
      if (index >= 0) entries.splice(index, 1);
      if (entry.instance) {
        entry.instance.onmessage = null;
        entry.instance.onerror = null;
        try {
          entry.instance.terminate();
        } catch {
        }
        entry.instance = null;
      }
      for (const request of [...entry.pending.values()]) {
        clearTimeout(request.timer);
        request.reject(
          Object.assign(new Error(reason || "Cancelled"), {
            code: reason ? "error" : "cancelled"
          })
        );
      }
      entry.pending.clear();
    }
    function handleMessage(entry, message) {
      if (!message || typeof message !== "object") return;
      if (message.type === "LOG") {
        const line = message.data?.message;
        if (!line) return;
        entry.logs.push(line);
        if (entry.logs.length > 400) entry.logs.shift();
        if (entry.reportTime && entry.durationSec > 0) {
          const seconds = logSeconds(line);
          if (seconds !== null) {
            entry.reportTime(Math.max(0, Math.min(1, seconds / entry.durationSec)));
          }
        }
        return;
      }
      if (message.type === "PROGRESS") {
        if (entry.reportTime) {
          entry.reportTime(Math.max(0, Math.min(1, message.data?.progress || 0)));
        }
        return;
      }
      const request = entry.pending.get(message.id);
      if (!request) return;
      entry.pending.delete(message.id);
      clearTimeout(request.timer);
      if (message.type === "ERROR") {
        request.reject(Object.assign(new Error(String(message.data)), { code: "error" }));
      } else {
        request.resolve(message.data);
      }
    }
    async function getAssets() {
      if (assetsPromise) return assetsPromise;
      assetsPromise = (async () => {
        const base = document.documentElement.dataset.dcBase;
        if (base && base.startsWith("chrome-extension:")) {
          return requestFromBridge();
        }
        if (!location.hostname.endsWith("discord.com")) {
          return fetchDirect(new URL(base || "../", location.href).href);
        }
        try {
          return await requestFromBridge(2500);
        } catch {
          return fetchDirect(new URL("../", location.href).href);
        }
      })().catch((error) => {
        assetsPromise = null;
        throw error;
      });
      return assetsPromise;
    }
    async function spawn() {
      assets = assets || await getAssets();
      const coreUrl = URL.createObjectURL(
        new Blob([assets.coreText], { type: "text/javascript" })
      );
      const workerUrl = URL.createObjectURL(
        new Blob([patchWorker(assets.workerText)], { type: "text/javascript" })
      );
      const entry = {
        instance: null,
        busy: false,
        alive: true,
        pending: /* @__PURE__ */ new Map(),
        logs: [],
        seq: 0,
        durationSec: 0,
        reportTime: null
      };
      try {
        entry.instance = new Worker(workerUrl);
        entry.instance.onmessage = (event) => handleMessage(entry, event.data);
        entry.instance.onerror = (event) => destroyEntry(entry, event.message || "Compressor crashed");
        await entryPost(entry, "LOAD", { coreURL: coreUrl, wasmBinary: assets.wasm }, 6e4);
      } catch (error) {
        destroyEntry(entry, "Could not load compressor");
        throw error;
      } finally {
        URL.revokeObjectURL(workerUrl);
        URL.revokeObjectURL(coreUrl);
      }
      return entry;
    }
    function entryPost(entry, type, data, timeoutMs) {
      const id = ++entry.seq;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          entry.pending.delete(id);
          destroyEntry(entry, "Compression timed out");
          reject(Object.assign(new Error("Compression timed out"), { code: "timeout" }));
        }, timeoutMs);
        entry.pending.set(id, { resolve, reject, timer });
        entry.instance.postMessage({ id, type, data });
      });
    }
    async function entryWriteFile(entry, path, data) {
      await entryPost(entry, "WRITE_FILE", { path, data }, 18e4);
    }
    async function entryReadFile(entry, path) {
      return entryPost(entry, "READ_FILE", { path }, 18e4);
    }
    async function entryDeleteFile(entry, path) {
      await entryPost(entry, "DELETE_FILE", { path }, 3e4).catch(() => {
      });
    }
    async function entryExec(entry, args, options = {}) {
      entry.logs = [];
      entry.durationSec = options.duration || 0;
      const response = await entryPost(entry, "EXEC", { args }, options.timeout || 6e5);
      if (response !== 0) {
        throw new Error(entry.logs.slice(-2).join(" ") || "ffmpeg failed");
      }
      return response;
    }
    async function acquire() {
      clearIdle();
      const idleEntry = entries.find((entry2) => !entry2.busy);
      if (idleEntry) {
        idleEntry.busy = true;
        return idleEntry;
      }
      if (entries.length + spawning < MAX_WORKERS) {
        spawning += 1;
        try {
          const entry2 = await spawn();
          entry2.busy = true;
          entries.push(entry2);
          return entry2;
        } finally {
          spawning -= 1;
        }
      }
      const entry = await new Promise((resolve) => waiters.push(resolve));
      if (!entry) throw Object.assign(new Error("Cancelled"), { code: "cancelled" });
      entry.busy = true;
      return entry;
    }
    function release(entry) {
      if (!entry.alive) return;
      const waiter = waiters.shift();
      if (waiter) {
        waiter(entry);
        return;
      }
      entry.busy = false;
    }
    async function probeWithWorker(file) {
      const entry = await acquire();
      try {
        const input = `probe-${++entry.seq}${extensionOf(file.name)}`;
        await entryWriteFile(entry, input, new Uint8Array(await file.arrayBuffer()));
        await entryExec(entry, ["-i", input], { timeout: 12e4 });
        return parseProbeLogs(entry.logs.join("\n"));
      } finally {
        release(entry);
      }
    }
    function probe(file) {
      return enqueue(async () => {
        clearIdle();
        try {
          return await probeWithVideo(file);
        } catch (error) {
          console.log("[dc] video probe failed", error?.message || error);
          return probeWithWorker(file);
        }
      });
    }
    function segmentCount(seconds) {
      if (seconds < 16) return 1;
      return Math.max(2, Math.min(MAX_WORKERS, Math.floor(seconds / 15)));
    }
    async function encodeSegment(job) {
      const entry = await acquire();
      let input = null;
      try {
        input = `in-${++entry.seq}${extensionOf(job.name)}`;
        await entryWriteFile(entry, input, job.data);
        let kbps = job.plan.videoKbps;
        for (let attempt = 0; attempt < 3; attempt++) {
          const output = `out-${++entry.seq}.mp4`;
          const attemptStart = job.start + job.span * (attempt / 3);
          const attemptSpan = job.span / 3;
          entry.reportTime = (value) => job.report(attemptStart + Math.max(0, Math.min(1, value)) * attemptSpan);
          await entryExec(
            entry,
            buildArgs(
              input,
              output,
              job.plan,
              kbps,
              "ultrafast"
            ),
            { duration: job.seconds }
          );
          const response = await entryReadFile(entry, output);
          await entryDeleteFile(entry, output);
          const blob = new Blob([response], { type: "video/mp4" });
          if (blob.size <= job.limit) {
            return new File([blob], job.name, {
              type: "video/mp4",
              lastModified: Date.now()
            });
          }
          kbps = Math.max(120, Math.floor(kbps * (job.limit * 0.94 / blob.size)));
        }
        throw new Error("Video is still too large");
      } finally {
        entry.reportTime = null;
        if (input) await entryDeleteFile(entry, input);
        release(entry);
      }
    }
    async function encodeWithWorkers(file, meta, plan, outputName, report, forceParts) {
      const seconds = Math.max(1, meta.duration);
      const count = forceParts || segmentCount(seconds);
      if (count === 1) {
        const data = new Uint8Array(await file.arrayBuffer());
        const encoded = await encodeSegment({
          name: outputName,
          data,
          seconds,
          plan,
          limit: TARGET,
          report,
          start: 0.05,
          span: 0.9
        });
        return [encoded];
      }
      const splitter = await acquire();
      const cutPaths = [];
      let half = seconds / 2;
      let segments = [];
      try {
        const input = `in-${++splitter.seq}${extensionOf(file.name)}`;
        await entryWriteFile(splitter, input, new Uint8Array(await file.arrayBuffer()));
        if (forceParts === 2) {
          const firstPath = `cut-${++splitter.seq}.mp4`;
          const secondPath = `cut-${++splitter.seq}.mp4`;
          cutPaths.push(firstPath, secondPath);
          await entryExec(splitter, copyCutArgs(input, firstPath, 0, half), {
            timeout: 18e4
          });
          report?.(0.04);
          await entryExec(splitter, copyCutArgs(input, secondPath, half, seconds - half + 0.5), {
            timeout: 18e4
          });
          report?.(0.08);
          const firstData = await entryReadFile(splitter, firstPath);
          const secondData = await entryReadFile(splitter, secondPath);
          await entryDeleteFile(splitter, firstPath);
          await entryDeleteFile(splitter, secondPath);
          if (firstData.byteLength > 0 && secondData.byteLength > 0 && firstData.byteLength <= TARGET && secondData.byteLength <= TARGET) {
            return [
              new File([firstData], partName(file.name, 1), {
                type: "video/mp4",
                lastModified: Date.now()
              }),
              new File([secondData], partName(file.name, 2), {
                type: "video/mp4",
                lastModified: Date.now()
              })
            ];
          }
          segments = [
            { data: firstData, seconds: half },
            { data: secondData, seconds: seconds - half }
          ];
        } else {
          const patternBase = `seg-${++splitter.seq}`;
          await entryExec(
            splitter,
            segmentCutArgs(input, `${patternBase}-%03d.mp4`, seconds, count),
            { timeout: 18e4 }
          );
          report?.(0.08);
          const found = [];
          for (let index = 0; index <= count + 2; index++) {
            const path = `${patternBase}-${String(index).padStart(3, "0")}.mp4`;
            try {
              const data = await entryReadFile(splitter, path);
              if (data.byteLength > 0) found.push(data);
              await entryDeleteFile(splitter, path);
            } catch {
              break;
            }
          }
          if (!found.length) throw new Error("Could not split video");
          const totalBytes2 = found.reduce((sum, data) => sum + data.byteLength, 0);
          segments = found.map((data) => ({
            data,
            seconds: Math.max(1, seconds * (data.byteLength / totalBytes2))
          }));
        }
        await entryDeleteFile(splitter, input);
        for (const path of cutPaths) {
          if (splitter.alive) await entryDeleteFile(splitter, path);
        }
      } finally {
        release(splitter);
      }
      const totalBytes = segments.reduce((sum, part) => sum + part.data.byteLength, 0);
      const halfPlan = forceParts === 2 ? videoPlan({
        size: file.size / segments.length,
        duration: half,
        width: meta.width,
        height: meta.height
      }) : null;
      const outputs = await Promise.all(
        segments.map((part, index) => {
          const forcedPair = forceParts === 2;
          return encodeSegment({
            name: forcedPair ? partName(file.name, index + 1) : `seg-${index}.mp4`,
            data: part.data,
            seconds: part.seconds,
            plan: forcedPair ? halfPlan : plan,
            limit: forcedPair ? TARGET : Math.max(
              131072,
              Math.floor(TARGET * 0.97 * (part.data.byteLength / totalBytes))
            ),
            report,
            start: 0.1 + 0.85 * index / segments.length,
            span: 0.85 / segments.length
          });
        })
      );
      if (forceParts === 2) {
        report?.(1);
        return outputs;
      }
      const stitcher = await acquire();
      let partPaths = [];
      let listName = null;
      let stitchedPath = null;
      try {
        for (const [index, encoded] of outputs.entries()) {
          const path = `stitch-${++stitcher.seq}-${index}.mp4`;
          partPaths.push(path);
          await entryWriteFile(stitcher, path, new Uint8Array(await encoded.arrayBuffer()));
        }
        listName = `stitch-${++stitcher.seq}.txt`;
        await entryWriteFile(
          stitcher,
          listName,
          TEXT_ENCODER.encode(partPaths.map((path) => `file ${path}`).join("\n"))
        );
        report?.(0.95);
        stitchedPath = `final-${++stitcher.seq}.mp4`;
        await entryExec(stitcher, stitchArgs(listName, stitchedPath), {
          timeout: 3e5
        });
        const response = await entryReadFile(stitcher, stitchedPath);
        report?.(0.99);
        return [
          new File([response], outputName, { type: "video/mp4", lastModified: Date.now() })
        ];
      } finally {
        for (const path of partPaths) await entryDeleteFile(stitcher, path);
        if (listName) await entryDeleteFile(stitcher, listName);
        if (stitchedPath) await entryDeleteFile(stitcher, stitchedPath);
        release(stitcher);
      }
    }
    function compress(file, meta, plan, splitRequested, progress) {
      return enqueue(async () => {
        clearIdle();
        try {
          if (splitRequested) {
            return await encodeWithWorkers(file, meta, plan, "", progress, 2);
          }
          return await encodeWithWorkers(
            file,
            meta,
            plan,
            replaceExt(file.name, "mp4"),
            progress,
            0
          );
        } finally {
          scheduleIdle();
        }
      });
    }
    function enqueue(task) {
      const run = chain.then(task, task);
      chain = run.catch(() => {
      });
      return run;
    }
    return {
      probe,
      compress,
      cancel,
      scheduleIdle
    };
  }

  // src/page.js
  var CSS = `
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
  var ffmpeg = createFFmpegClient();
  var composer = null;
  var host = null;
  var shadow = null;
  var bar = null;
  var labelEl = null;
  var hintEl = null;
  var actionEl = null;
  var pctEl = null;
  var dismissEl = null;
  var fillEl = null;
  var actionJob = null;
  var actionHandler = null;
  var jobs = [];
  var jobSeq = 0;
  var bypass = false;
  var hideTimer = 0;
  var noticeTimer = 0;
  var mountScheduled = false;
  var themeObserver = null;
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
    spinner.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2" stroke-opacity="0.25"/><path d="M14 8a6 6 0 0 0-6-6" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    const doneIcon = document.createElement("div");
    doneIcon.className = "icon-done";
    doneIcon.setAttribute("aria-hidden", "true");
    doneIcon.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><path d="M3.5 8.5l3 3 6-6" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    const errorIcon = document.createElement("div");
    errorIcon.className = "icon-error";
    errorIcon.setAttribute("aria-hidden", "true");
    errorIcon.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none"><circle cx="8" cy="8" r="6" stroke="currentColor" stroke-width="2"/><path d="M8 5v3.5M8 11.5h.01" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>';
    labelEl = document.createElement("div");
    labelEl.className = "label";
    hintEl = document.createElement("span");
    hintEl.className = "hint";
    hintEl.textContent = "\u2022 You can keep typing";
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
    dismissEl.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" fill="none" aria-hidden="true"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
    dismissEl.addEventListener("click", () => hideBar());
    bar.append(spinner, doneIcon, errorIcon, labelEl, hintEl, actionEl, track, pctEl, dismissEl);
    shadow.append(bar);
    document.documentElement.append(host);
    applyTheme();
    themeObserver?.disconnect();
    themeObserver = new MutationObserver(applyTheme);
    themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ["class"]
    });
  }
  function anchorBar() {
    if (!host || !composer || !composer.isConnected) return;
    const textArea = composer.closest('[class*="channelTextArea"]') || composer.querySelector?.('[class*="channelTextArea"]') || composer;
    const scrollable = textArea.querySelector?.('[class*="scrollableContainer"]') || (textArea.classList?.contains("scrollableContainer") ? textArea : null) || textArea.firstElementChild || textArea;
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
      return box.closest('[class*="scrollableContainer"]') || box.closest('[class*="channelTextArea"]') || box.closest("form") || box;
    }
    const input = findFileInput();
    if (input) {
      return input.closest('[class*="channelTextArea"]') || input.closest('[class*="scrollableContainer"]') || input.parentElement;
    }
    return null;
  }
  function findFileInput() {
    const sources = [
      composer && composer.isConnected ? composer.querySelector('input[type="file"]') : null,
      document.querySelector('[class*="uploadInput"] input[type="file"]'),
      document.querySelector('input[class~="file-input"]')
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
    const progress = weight ? jobs.reduce((sum, job) => sum + job.progress * job.weight, 0) / weight : 0;
    fillEl.style.transform = `scaleX(${Math.max(0, Math.min(0.99, progress))})`;
    pctEl.textContent = `${Math.round(progress * 100)}%`;
    dismissEl.hidden = false;
    const splitJob = videos.length === 1 && videos[0].allowSplit && !videos[0].split ? videos[0] : null;
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
    }, 14e3);
  }
  function showError(failed) {
    if (jobs.length || !failed.length) return;
    showBar();
    bar.dataset.state = "error";
    const videosOnly = failed.every((job) => job.kind === "video");
    const text = failed.length === 1 ? `Couldn't compress ${videosOnly ? "video" : "file"}` : `Couldn't compress ${failed.length} files`;
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
    }, 8e3);
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
      height: meta.height
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
          }
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
      const scale = Math.min(1, Math.sqrt(4e7 / (width * height)));
      width = Math.max(2, Math.round(width * scale / 2) * 2);
      height = Math.max(2, Math.round(height * scale / 2) * 2);
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
        job.progress = 0.2 + 0.75 * (attempt + 1) / 8;
        renderBar();
        if (blob.size <= TARGET) {
          return [
            new File([blob], replaceExt(job.file.name, "webp"), {
              type: "image/webp",
              lastModified: Date.now()
            })
          ];
        }
        if (quality > 0.62) {
          quality -= 0.08;
        } else {
          width = Math.max(2, Math.round(width * 0.85 / 2) * 2);
          height = Math.max(2, Math.round(height * 0.85 / 2) * 2);
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
    const target = input ? { kind: "input", input, channel: location.pathname } : { kind: "drop", element: composer, channel: location.pathname };
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
        const transfer2 = new DataTransfer();
        for (const file of files) transfer2.items.add(file);
        bypass = true;
        try {
          input.files = transfer2.files;
          input.dispatchEvent(new Event("change", { bubbles: true }));
        } finally {
          bypass = false;
        }
        return;
      }
    }
    const element = target.element && target.element.isConnected ? target.element : composer;
    if (!element || !element.isConnected) return;
    const transfer = new DataTransfer();
    for (const file of files) transfer.items.add(file);
    const drop = new DragEvent("drop", {
      bubbles: true,
      cancelable: true,
      dataTransfer: transfer
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
      (file) => needsCompression(file.size) && kindOf(file) !== "other"
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
      failed: false
    }));
    jobs.push(...batchJobs);
    renderBar();
    const results = /* @__PURE__ */ new Map();
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
      })
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
      subtree: true
    });
    scheduleMount();
  }
  boot();
})();
