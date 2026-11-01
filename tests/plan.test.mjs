import test from "node:test";
import assert from "node:assert/strict";
import {
  LIMIT,
  TARGET,
  needsCompression,
  kindOf,
  fitPixels,
  videoPlan,
  replaceExt,
  partName,
} from "../src/shared/plan.js";

test("limit is 20 MB and target stays under it", () => {
  assert.equal(LIMIT, 20 * 1024 * 1024);
  assert.ok(TARGET < LIMIT);
});

test("needsCompression only trips above the limit", () => {
  assert.equal(needsCompression(LIMIT), false);
  assert.equal(needsCompression(LIMIT + 1), true);
  assert.equal(needsCompression(1024), false);
});

test("kindOf reads mime types and extensions", () => {
  assert.equal(kindOf({ type: "video/mp4", name: "clip" }), "video");
  assert.equal(kindOf({ type: "", name: "clip.MOV" }), "video");
  assert.equal(kindOf({ type: "image/png", name: "shot" }), "image");
  assert.equal(kindOf({ type: "", name: "shot.webp" }), "image");
  assert.equal(kindOf({ type: "application/zip", name: "archive.zip" }), "other");
});

test("fitPixels keeps aspect ratio and even dimensions", () => {
  const wide = fitPixels(3840, 2160, 921600);
  assert.equal(wide.width % 2, 0);
  assert.equal(wide.height % 2, 0);
  assert.ok(wide.width * wide.height <= 921600);
  assert.ok(Math.abs(wide.width / wide.height - 16 / 9) < 0.01);

  const small = fitPixels(640, 360, 2073600);
  assert.deepEqual(small, { width: 640, height: 360 });
});

test("videoPlan keeps a short high bitrate clip at full size", () => {
  const plan = videoPlan({
    size: 24 * 1024 * 1024,
    duration: 8,
    width: 1920,
    height: 1080,
  });
  assert.equal(plan.audioKbps, 128);
  assert.equal(plan.width, 1920);
  assert.equal(plan.height, 1080);
  assert.ok(plan.videoKbps > 10000);
  assert.equal(plan.offerSplit, false);
});

test("videoPlan lowers resolution when the bitrate is tight", () => {
  const plan = videoPlan({
    size: 50 * 1024 * 1024,
    duration: 300,
    width: 1920,
    height: 1080,
  });
  assert.equal(plan.audioKbps, 96);
  assert.ok(plan.videoKbps < 1800);
  assert.ok(plan.width * plan.height <= 2073600);
  assert.equal(plan.offerSplit, true);
});

test("videoPlan offers a split only for long, heavy videos", () => {
  const short = videoPlan({
    size: 60 * 1024 * 1024,
    duration: 20,
    width: 1920,
    height: 1080,
  });
  assert.equal(short.offerSplit, false);
  const small = videoPlan({
    size: 30 * 1024 * 1024,
    duration: 300,
    width: 1920,
    height: 1080,
  });
  assert.equal(small.offerSplit, false);
});

test("names keep their base and gain the right extension", () => {
  assert.equal(replaceExt("clip.mov", "mp4"), "clip.mp4");
  assert.equal(replaceExt("no-extension", "webp"), "no-extension.webp");
  assert.equal(partName("clip.mov", 2), "clip part 2.mp4");
});
