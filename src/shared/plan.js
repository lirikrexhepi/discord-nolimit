export const LIMIT = 20 * 1024 * 1024;
export const TARGET = Math.floor(19.2 * 1024 * 1024);

const VIDEO_EXT = /\.(mp4|m4v|mov|webm|mkv|avi|wmv|flv|mpg|mpeg|3gp|ts|gif)$/i;
const IMAGE_EXT = /\.(png|jpe?g|webp|avif|bmp|tiff?)$/i;

export function needsCompression(size) {
  return size > LIMIT;
}

export function kindOf(file) {
  const type = (file.type || "").toLowerCase();
  const name = file.name || "";
  if (type.startsWith("video/") || VIDEO_EXT.test(name)) return "video";
  if (type.startsWith("image/") || IMAGE_EXT.test(name)) return "image";
  return "other";
}

export function fitPixels(width, height, maxPixels) {
  const w = Math.max(2, Math.round(width || 1280));
  const h = Math.max(2, Math.round(height || 720));
  const scale = Math.min(1, Math.sqrt(maxPixels / (w * h)));
  return {
    width: Math.max(2, Math.round((w * scale) / 2) * 2),
    height: Math.max(2, Math.round((h * scale) / 2) * 2),
  };
}

export function videoPlan({ size, duration, width, height, limit = TARGET }) {
  const seconds = Number.isFinite(duration) && duration > 0 ? duration : 1;
  const audioKbps = seconds < 45 ? 128 : 96;
  const totalKbps = Math.floor((limit * 8 * 0.94) / seconds / 1000);
  const videoKbps = Math.max(140, totalKbps - audioKbps);
  const maxPixels =
    videoKbps >= 4200
      ? 2073600
      : videoKbps >= 2100
        ? 921600
        : videoKbps >= 950
          ? 518400
          : 409920;
  const dims = fitPixels(width, height, maxPixels);
  return {
    videoKbps,
    audioKbps,
    width: dims.width,
    height: dims.height,
    offerSplit: size > LIMIT * 2 && seconds >= 45 && videoKbps < 1800,
  };
}

export function replaceExt(name, ext) {
  return `${(name || "file").replace(/\.[^.]+$/, "")}.${ext}`;
}

export function partName(name, index) {
  return `${(name || "video").replace(/\.[^.]+$/, "")} part ${index}.mp4`;
}
