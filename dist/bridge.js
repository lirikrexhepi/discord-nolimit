document.documentElement.dataset.dcBase = chrome.runtime.getURL("");

const WORKER_PATH = "vendor/ffmpeg/814.ffmpeg.js";
const CORE_PATH = "vendor/ffmpeg/ffmpeg-core.js";
const WASM_PATH = "vendor/ffmpeg/ffmpeg-core.wasm";

let textsPromise = null;

function fetchText(path) {
  return fetch(chrome.runtime.getURL(path)).then((response) => {
    if (!response.ok) throw new Error(`Could not load ${path}`);
    return response.text();
  });
}

function fetchWasm() {
  return fetch(chrome.runtime.getURL(WASM_PATH)).then((response) => {
    if (!response.ok) throw new Error(`Could not load ${WASM_PATH}`);
    return response.arrayBuffer();
  });
}

function getTexts() {
  if (!textsPromise) {
    textsPromise = Promise.all([fetchText(WORKER_PATH), fetchText(CORE_PATH)])
      .then(([workerText, coreText]) => ({ workerText, coreText }))
      .catch((error) => {
        textsPromise = null;
        throw error;
      });
  }
  return textsPromise;
}

async function sendAssets() {
  try {
    const [texts, wasm] = await Promise.all([getTexts(), fetchWasm()]);
    window.postMessage(
      {
        source: "dc-bridge",
        type: "assets",
        workerText: texts.workerText,
        coreText: texts.coreText,
        wasm,
      },
      "*",
      [wasm],
    );
  } catch (error) {
    window.postMessage(
      {
        source: "dc-bridge",
        type: "assets-error",
        message: String(error?.message || error),
      },
      "*",
    );
  }
}

addEventListener("message", (event) => {
  const message = event.data;
  if (!message || message.source !== "dc-page" || message.type !== "assets-request") {
    return;
  }
  sendAssets();
});
