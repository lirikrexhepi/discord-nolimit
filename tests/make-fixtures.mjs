import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import path from "node:path";

const ffmpeg = "C:\\Users\\PC\\tools\\ffmpeg\\bin\\ffmpeg.exe";
const dir = path.join(process.cwd(), "tests", "fixtures");
mkdirSync(dir, { recursive: true });

function run(args) {
  const result = spawnSync(ffmpeg, args, { stdio: "inherit" });
  if (result.status !== 0) throw new Error(`ffmpeg failed: ${args.join(" ")}`);
}

function makeVideo(name, { width, height, seconds, bitrate, audio }) {
  const target = path.join(dir, name);
  if (existsSync(target)) {
    console.log(`${name} exists (${(statSync(target).size / 1048576).toFixed(2)} MB)`);
    return;
  }
  run([
    "-y",
    "-f", "lavfi",
    "-i", `nullsrc=s=${width}x${height}:r=30:d=${seconds},geq=lum='random(1)*255':cb=128:cr=128`,
    "-f", "lavfi",
    "-i", `sine=frequency=440:duration=${seconds}`,
    "-c:v", "libx264",
    "-preset", "ultrafast",
    "-b:v", bitrate,
    "-maxrate", bitrate,
    "-bufsize", bitrate,
    "-pix_fmt", "yuv420p",
    "-c:a", "aac",
    "-b:a", `${audio}k`,
    "-shortest",
    "-movflags", "+faststart",
    target,
  ]);
  console.log(`${name}: ${(statSync(target).size / 1048576).toFixed(2)} MB`);
}

function makeImage() {
  const target = path.join(dir, "large.png");
  if (existsSync(target)) {
    console.log(`large.png exists (${(statSync(target).size / 1048576).toFixed(2)} MB)`);
    return;
  }
  const raw = path.join(dir, "large.rgb");
  writeFileSync(raw, randomBytes(3000 * 3000 * 3));
  run([
    "-y",
    "-f", "rawvideo",
    "-pix_fmt", "rgb24",
    "-s", "3000x3000",
    "-i", raw,
    "-frames:v", "1",
    "-compression_level", "0",
    target,
  ]);
  rmSync(raw, { force: true });
  console.log(`large.png: ${(statSync(target).size / 1048576).toFixed(2)} MB`);
}

makeVideo("large.mp4", { width: 854, height: 480, seconds: 8, bitrate: "24M", audio: 128 });
makeVideo("long.mp4", { width: 640, height: 360, seconds: 90, bitrate: "4M", audio: 64 });
makeImage();
