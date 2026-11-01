import { build } from "esbuild";
import { cp, mkdir, readFile, rm } from "node:fs/promises";
import path from "node:path";

const root = process.cwd();
const dist = path.join(root, "dist");
const vendor = path.join(dist, "vendor", "ffmpeg");

await rm(dist, { recursive: true, force: true });
await mkdir(vendor, { recursive: true });
await mkdir(path.join(dist, "demo"), { recursive: true });

await build({
  bundle: true,
  format: "iife",
  target: ["chrome111"],
  legalComments: "none",
  logLevel: "info",
  entryPoints: [path.join(root, "src/page.js")],
  outfile: path.join(dist, "page.js"),
});

for (const file of ["bridge.js", "manifest.json"]) {
  await cp(path.join(root, "src", file), path.join(dist, file));
}
await cp(path.join(root, "demo/index.html"), path.join(dist, "demo/index.html"));

for (const file of ["814.ffmpeg.js"]) {
  await cp(
    path.join(root, "node_modules/@ffmpeg/ffmpeg/dist/umd", file),
    path.join(vendor, file),
  );
}
for (const file of ["ffmpeg-core.js", "ffmpeg-core.wasm"]) {
  await cp(
    path.join(root, "node_modules/@ffmpeg/core/dist/umd", file),
    path.join(vendor, file),
  );
}

JSON.parse(await readFile(path.join(dist, "manifest.json"), "utf8"));
console.log("built dist/");
