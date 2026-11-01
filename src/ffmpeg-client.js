import { TARGET, videoPlan, partName, replaceExt } from "./shared/plan.js";

const WORKER_PATH = "vendor/ffmpeg/814.ffmpeg.js";
const CORE_PATH = "vendor/ffmpeg/ffmpeg-core.js";
const WASM_PATH = "vendor/ffmpeg/ffmpeg-core.wasm";
const PATCH_FROM = "({coreURL:o,wasmURL:s,workerURL:E})";
const PATCH_TO = "({coreURL:o,wasmURL:s,workerURL:E,wasmBinary:W})";
const CORE_FROM = "self.createFFmpegCore({mainScriptUrlOrBlob:";
const CORE_TO = "self.createFFmpegCore({wasmBinary:W,mainScriptUrlOrBlob:";
const TEXT_ENCODER = new TextEncoder();

function patchWorker(text) {
  if (!text.includes(PATCH_FROM) || !text.includes(CORE_FROM)) {
    throw new Error("Unsupported ffmpeg build");
  }
  return text.replace(PATCH_FROM, PATCH_TO).replace(CORE_FROM, CORE_TO);
}

function requestFromBridge(timeout = 20000) {
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
          wasm: message.wasm,
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
    fetchAsset(base, WASM_PATH, "buffer"),
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
    const timer = setTimeout(() => finish(() => reject(new Error("Could not read video"))), 8000);
    const ready = () => {
      if (Number.isFinite(video.duration) && video.duration > 0 && video.videoWidth) {
        const meta = {
          duration: video.duration,
          width: video.videoWidth,
          height: video.videoHeight,
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
      } catch {}
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
    duration:
      Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3]),
    width: stream ? Number(stream[1]) : 1280,
    height: stream ? Number(stream[2]) : 720,
  };
}

function logSeconds(line) {
  const match = /time=\s*(-?\d+):(\d+):([\d.]+)/.exec(line);
  if (!match) return null;
  const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
  return seconds >= 0 ? seconds : null;
}

function buildArgs(input, output, plan, kbps, preset = "ultrafast") {
  const filters =
    plan.width && plan.height
      ? ["-vf", `scale=${plan.width}:${plan.height}:flags=fast_bilinear`]
      : [];
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
    output,
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
    output,
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
    pattern,
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
    output,
  ];
}

export function createFFmpegClient() {
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
    }, 90000);
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
      } catch {}
      entry.instance = null;
    }
    for (const request of [...entry.pending.values()]) {
      clearTimeout(request.timer);
      request.reject(
        Object.assign(new Error(reason || "Cancelled"), {
          code: reason ? "error" : "cancelled",
        }),
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
    assets = assets || (await getAssets());
    const coreUrl = URL.createObjectURL(
      new Blob([assets.coreText], { type: "text/javascript" }),
    );
    const workerUrl = URL.createObjectURL(
      new Blob([patchWorker(assets.workerText)], { type: "text/javascript" }),
    );
    const entry = {
      instance: null,
      busy: false,
      alive: true,
      pending: new Map(),
      logs: [],
      seq: 0,
      durationSec: 0,
      reportTime: null,
    };
    try {
      entry.instance = new Worker(workerUrl);
      entry.instance.onmessage = (event) => handleMessage(entry, event.data);
      entry.instance.onerror = (event) =>
        destroyEntry(entry, event.message || "Compressor crashed");
      await entryPost(entry, "LOAD", { coreURL: coreUrl, wasmBinary: assets.wasm }, 60000);
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
    await entryPost(entry, "WRITE_FILE", { path, data }, 180000);
  }

  async function entryReadFile(entry, path) {
    return entryPost(entry, "READ_FILE", { path }, 180000);
  }

  async function entryDeleteFile(entry, path) {
    await entryPost(entry, "DELETE_FILE", { path }, 30000).catch(() => {});
  }

  async function entryExec(entry, args, options = {}) {
    entry.logs = [];
    entry.durationSec = options.duration || 0;
    const response = await entryPost(entry, "EXEC", { args }, options.timeout || 600000);
    if (response !== 0) {
      throw new Error(entry.logs.slice(-2).join(" ") || "ffmpeg failed");
    }
    return response;
  }

  async function acquire() {
    clearIdle();
    const idleEntry = entries.find((entry) => !entry.busy);
    if (idleEntry) {
      idleEntry.busy = true;
      return idleEntry;
    }
    if (entries.length + spawning < MAX_WORKERS) {
      spawning += 1;
      try {
        const entry = await spawn();
        entry.busy = true;
        entries.push(entry);
        return entry;
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
      await entryExec(entry, ["-i", input], { timeout: 120000 });
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
        entry.reportTime = (value) =>
          job.report(attemptStart + Math.max(0, Math.min(1, value)) * attemptSpan);
        await entryExec(
          entry,
          buildArgs(
            input,
            output,
            job.plan,
            kbps,
            "ultrafast",
          ),
          { duration: job.seconds },
        );
        const response = await entryReadFile(entry, output);
        await entryDeleteFile(entry, output);
        const blob = new Blob([response], { type: "video/mp4" });
        if (blob.size <= job.limit) {
          return new File([blob], job.name, {
            type: "video/mp4",
            lastModified: Date.now(),
          });
        }
        kbps = Math.max(120, Math.floor(kbps * ((job.limit * 0.94) / blob.size)));
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
        span: 0.9,
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
          timeout: 180000,
        });
        report?.(0.04);
        await entryExec(splitter, copyCutArgs(input, secondPath, half, seconds - half + 0.5), {
          timeout: 180000,
        });
        report?.(0.08);
        const firstData = await entryReadFile(splitter, firstPath);
        const secondData = await entryReadFile(splitter, secondPath);
        await entryDeleteFile(splitter, firstPath);
        await entryDeleteFile(splitter, secondPath);
        if (
          firstData.byteLength > 0 &&
          secondData.byteLength > 0 &&
          firstData.byteLength <= TARGET &&
          secondData.byteLength <= TARGET
        ) {
          return [
            new File([firstData], partName(file.name, 1), {
              type: "video/mp4",
              lastModified: Date.now(),
            }),
            new File([secondData], partName(file.name, 2), {
              type: "video/mp4",
              lastModified: Date.now(),
            }),
          ];
        }
        segments = [
          { data: firstData, seconds: half },
          { data: secondData, seconds: seconds - half },
        ];
      } else {
        const patternBase = `seg-${++splitter.seq}`;
        await entryExec(
          splitter,
          segmentCutArgs(input, `${patternBase}-%03d.mp4`, seconds, count),
          { timeout: 180000 },
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
        const totalBytes = found.reduce((sum, data) => sum + data.byteLength, 0);
        segments = found.map((data) => ({
          data,
          seconds: Math.max(1, seconds * (data.byteLength / totalBytes)),
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
    const halfPlan =
      forceParts === 2
        ? videoPlan({
            size: file.size / segments.length,
            duration: half,
            width: meta.width,
            height: meta.height,
          })
        : null;
    const outputs = await Promise.all(
      segments.map((part, index) => {
        const forcedPair = forceParts === 2;
        return encodeSegment({
          name: forcedPair ? partName(file.name, index + 1) : `seg-${index}.mp4`,
          data: part.data,
          seconds: part.seconds,
          plan: forcedPair ? halfPlan : plan,
          limit: forcedPair
            ? TARGET
            : Math.max(
                131072,
                Math.floor(TARGET * 0.97 * (part.data.byteLength / totalBytes)),
              ),
          report,
          start: 0.1 + (0.85 * index) / segments.length,
          span: 0.85 / segments.length,
        });
      }),
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
        TEXT_ENCODER.encode(partPaths.map((path) => `file ${path}`).join("\n")),
      );
      report?.(0.95);
      stitchedPath = `final-${++stitcher.seq}.mp4`;
      await entryExec(stitcher, stitchArgs(listName, stitchedPath), {
        timeout: 300000,
      });
      const response = await entryReadFile(stitcher, stitchedPath);
      report?.(0.99);
      return [
        new File([response], outputName, { type: "video/mp4", lastModified: Date.now() }),
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
          0,
        );
      } finally {
        scheduleIdle();
      }
    });
  }

  function enqueue(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  return {
    probe,
    compress,
    cancel,
    scheduleIdle,
  };
}
