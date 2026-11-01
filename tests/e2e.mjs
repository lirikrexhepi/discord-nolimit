import http from "node:http";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import path from "node:path";
import { chromium } from "playwright-core";

const root = process.cwd();
const dist = path.join(root, "dist");
const chrome = "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe";
const csp = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-eval' 'unsafe-inline' blob:",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' blob: data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "child-src 'self' blob:",
].join("; ");

const mime = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".wasm": "application/wasm",
  ".png": "image/png",
  ".mp4": "video/mp4",
};

function serve() {
  return new Promise((resolve) => {
    const server = http.createServer(async (request, response) => {
      const url = new URL(request.url, "http://localhost");
      let pathname = decodeURIComponent(url.pathname);
      if (pathname === "/") pathname = "/demo/";
      if (pathname.endsWith("/")) pathname += "index.html";
      const file = path.join(dist, pathname);
      if (!file.startsWith(dist)) {
        response.writeHead(403);
        response.end();
        return;
      }
      try {
        const data = await readFile(file);
        response.writeHead(200, {
          "content-type": mime[path.extname(file)] || "application/octet-stream",
        });
        response.end(data);
      } catch {
        response.writeHead(404);
        response.end();
      }
    });
    server.listen(0, "127.0.0.1", () => resolve(server));
  });
}

async function waitForBar(page, visible) {
  await page.waitForFunction(
    (want) => {
      const host = document.querySelector("#dc-compressor");
      const bar = host?.shadowRoot?.querySelector(".bar");
      return bar?.dataset.visible === (want ? "true" : "false");
    },
    visible,
    { timeout: 20000 },
  );
}

async function barLabel(page) {
  return page.evaluate(() => {
    const host = document.querySelector("#dc-compressor");
    return host?.shadowRoot?.querySelector(".label")?.textContent || "";
  });
}

async function reset(page) {
  await page.evaluate(() => {
    window.__files = [];
    window.__events = [];
  });
}

async function files(page) {
  return page.evaluate(() =>
    (window.__files || []).map((file) => ({
      name: file.name,
      size: file.size,
      type: file.type,
    })),
  );
}

async function waitForFiles(page, count, timeout = 600000) {
  await page.waitForFunction(
    (want) => window.__files && window.__files.length >= want,
    count,
    { timeout },
  );
  return files(page);
}

function assertVideo(output, name) {
  assert.equal(output.length, 1, "one compressed video");
  const file = output[0];
  assert.equal(file.name, name);
  assert.equal(file.type, "video/mp4");
  assert.ok(file.size > 0, "video has bytes");
  assert.ok(file.size <= 20 * 1024 * 1024, `video fits 20 MB, got ${file.size}`);
}

function assertImage(output, name) {
  assert.equal(output.length, 1, "one compressed image");
  const file = output[0];
  assert.equal(file.name, name);
  assert.equal(file.type, "image/webp");
  assert.ok(file.size > 0, "image has bytes");
  assert.ok(file.size <= 20 * 1024 * 1024, `image fits 20 MB, got ${file.size}`);
}

async function standalone() {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.goto(`http://127.0.0.1:${port}/demo/`);
    await page.waitForSelector("#dc-compressor", { state: "attached", timeout: 20000 });

    await reset(page);
    await page.setInputFiles("#file", path.join(root, "tests", "fixtures", "large.mp4"));
    await waitForBar(page, true);
    const videoLabel = await barLabel(page);
    assert.match(videoLabel, /Compressing video/);
    const video = await waitForFiles(page, 1);
    assertVideo(video, "large.mp4");
    await waitForBar(page, false);
    console.log("standalone video:", video[0].size);

    await reset(page);
    await page.setInputFiles("#file", path.join(root, "tests", "fixtures", "large.png"));
    await waitForBar(page, true);
    const imageLabel = await barLabel(page);
    assert.match(imageLabel, /Compressing image/);
    const image = await waitForFiles(page, 1);
    assertImage(image, "large.webp");
    await waitForBar(page, false);
    console.log("standalone image:", image[0].size);
  } finally {
    await browser.close();
    server.close();
  }
}

async function custom(file) {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    page.on("console", (message) => console.log("console:", message.type(), message.text()));
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.goto(`http://127.0.0.1:${port}/demo/`);
    await page.waitForSelector("#dc-compressor", { state: "attached", timeout: 20000 });
    await reset(page);
    await page.setInputFiles("#file", file);
    await waitForBar(page, true);
    console.log("custom label:", await barLabel(page));
    const output = await waitForFiles(page, 1, 1200000);
    console.log("custom output:", output);
    assert.ok(output.length >= 1);
    for (const item of output) {
      assert.ok(item.size <= 20 * 1024 * 1024, `fits 20 MB, got ${item.size}`);
    }
  } finally {
    await browser.close();
    server.close();
  }
}

async function split() {
  const server = await serve();
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: chrome, headless: true });
  try {
    const page = await browser.newPage();
    page.on("console", (message) => console.log("console:", message.type(), message.text()));
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.goto(`http://127.0.0.1:${port}/demo/`);
    await page.waitForSelector("#dc-compressor", { state: "attached", timeout: 20000 });

    await reset(page);
    await page.setInputFiles("#file", path.join(root, "tests", "fixtures", "long.mp4"));
    await waitForBar(page, true);
    let ready = false;
    for (let tick = 0; tick < 180; tick++) {
      const state = await page.evaluate(() => {
        const host = document.querySelector("#dc-compressor");
        const action = host?.shadowRoot?.querySelector(".action");
        return {
          label: host?.shadowRoot?.querySelector(".label")?.textContent || "",
          action: action ? { hidden: action.hidden, text: action.textContent } : null,
          visible: host?.shadowRoot?.querySelector(".bar")?.dataset.visible || "",
          files: (window.__files || []).length,
        };
      });
      if (tick % 5 === 0 || state.action?.hidden === false || state.files) {
        console.log("split state:", tick, state);
      }
      if (state.action && !state.action.hidden) {
        ready = true;
        break;
      }
      if (state.files) break;
      await page.waitForTimeout(1000);
    }
    assert.ok(ready, "split action appeared");
    await page.evaluate(() => {
      const host = document.querySelector("#dc-compressor");
      host.shadowRoot.querySelector(".action").click();
    });
    await page.waitForFunction(
      () => {
        const host = document.querySelector("#dc-compressor");
        const label = host?.shadowRoot?.querySelector(".label")?.textContent || "";
        return label.includes("2 videos");
      },
      null,
      { timeout: 20000 },
    );
    const output = await waitForFiles(page, 2, 900000);
    assert.equal(output.length, 2, "two parts");
    assert.equal(output[0].name, "long part 1.mp4");
    assert.equal(output[1].name, "long part 2.mp4");
    for (const file of output) {
      assert.equal(file.type, "video/mp4");
      assert.ok(file.size > 0);
      assert.ok(file.size <= 20 * 1024 * 1024, `part fits 20 MB, got ${file.size}`);
    }
    console.log("split parts:", output.map((file) => file.size));
  } finally {
    await browser.close();
    server.close();
  }
}

async function extension() {
  const html = await readFile(path.join(dist, "demo", "index.html"), "utf8");
  const executablePath = [
    process.env.CHROME_PATH,
    "C:\\Users\\PC\\AppData\\Local\\ms-playwright\\chromium-1234\\chrome-win64\\chrome.exe",
    chromium.executablePath(),
    chrome,
  ].find((candidate) => candidate && existsSync(candidate));
  console.log("extension browser:", executablePath);
  const context = await chromium.launchPersistentContext("", {
    executablePath,
    headless: process.env.HEADLESS ? true : false,
    args: [
      `--disable-extensions-except=${dist}`,
      `--load-extension=${dist}`,
      "--no-first-run",
      "--no-default-browser-check",
    ],
  });
  try {
    await context.route("https://discord.com/**", (route) =>
      route.fulfill({
        status: 200,
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": csp,
        },
        body: html,
      }),
    );
    const page = await context.newPage();
    page.on("console", (message) => console.log("console:", message.type(), message.text()));
    page.on("pageerror", (error) => console.log("pageerror:", error.message));
    await page.goto("https://discord.com/channels/1/2");
    await page.waitForTimeout(1500);
    const before = await page.evaluate(() => ({
      title: document.title,
      composer: !!document.querySelector('[data-slate-editor="true"]'),
      host: !!document.querySelector("#dc-compressor"),
      base: document.documentElement.dataset.dcBase || "",
      hostStyle: document.querySelector("#dc-compressor")?.getAttribute("style") || "",
      agent: navigator.userAgent,
    }));
    console.log("extension page:", before);
    await page.waitForSelector("#dc-compressor", { state: "attached", timeout: 20000 });
    const base = await page.evaluate(() => document.documentElement.dataset.dcBase || "");
    assert.match(base, /^chrome-extension:\/\//, "bridge is installed");

    await reset(page);
    await page.setInputFiles("#file", path.join(root, "tests", "fixtures", "large.mp4"));
    await waitForBar(page, true);
    const label = await barLabel(page);
    assert.match(label, /Compressing video/);
    const video = await waitForFiles(page, 1);
    assertVideo(video, "large.mp4");
    console.log("extension video:", video[0].size);

    await reset(page);
    await page.setInputFiles("#file", path.join(root, "tests", "fixtures", "large.png"));
    await waitForBar(page, true);
    const image = await waitForFiles(page, 1);
    assertImage(image, "large.webp");
    console.log("extension image:", image[0].size);
  } finally {
    await context.close();
  }
}

const mode = process.argv[2] || "standalone";
if (mode === "standalone") await standalone();
else if (mode === "split") await split();
else if (mode === "extension") await extension();
else if (mode === "custom") await custom(process.argv[3]);
else if (mode === "all") {
  await standalone();
  await split();
  await extension();
} else {
  throw new Error(`Unknown mode: ${mode}`);
}
