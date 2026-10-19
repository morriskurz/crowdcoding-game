// Offensive-text gate: tesseract OCR on the screenshots, fail on any word from the hashed slur list
// (wordlist.mjs). OCR'd text is checked as words and also with spaces removed per line, so text
// drawn with letter spacing ("s l u r") is caught too.
//
// Run: node scripts/gates/ocr.mjs <image>...   (prints JSON, exit 1 on fail)
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findSlurs, loadHashes } from "./wordlist.mjs";

// Game text is often small and light-on-dark: upscale 2x to grayscale, and also OCR the inverted
// image. psm 11 = sparse text anywhere (HUDs, signs), psm 3 = page layout.
const PASSES = [
  { vf: "scale=iw*2:ih*2:flags=lanczos,format=gray", psm: "11" },
  { vf: "scale=iw*2:ih*2:flags=lanczos,format=gray", psm: "3" },
  { vf: "scale=iw*2:ih*2:flags=lanczos,format=gray,negate", psm: "11" },
];

export function ocrText(image) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "ocr-"));
  try {
    return PASSES.map(({ vf, psm }, i) => {
      const pre = path.join(dir, `p${i}.png`);
      const f = spawnSync("ffmpeg", ["-y", "-loglevel", "error", "-i", image, "-vf", vf, pre], { encoding: "utf8" });
      if (f.status !== 0) throw new Error(`ffmpeg preprocess failed on ${image}: ${f.stderr}`);
      const r = spawnSync("tesseract", [pre, "stdout", "--psm", psm, "-l", "eng"], { encoding: "utf8" });
      if (r.status !== 0) throw new Error(`tesseract failed on ${image}: ${r.stderr}`);
      return r.stdout;
    }).join("\n");
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Pure check of OCR'd text. Matches are counted, never echoed. */
export function checkText(text, hashes = loadHashes()) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hits = findSlurs(text, hashes).length + lines.reduce((n, l) => n + (/\s/.test(l) ? findSlurs(l.replace(/\s+/g, ""), hashes).length : 0), 0);
  return { hits, words: text.split(/\s+/).filter(Boolean).length }; // summed over OCR passes
}

export function ocrGate(images) {
  const hashes = loadHashes();
  const per = images.map((img) => ({ image: img, ...checkText(ocrText(img), hashes) }));
  return { result: per.some((p) => p.hits > 0) ? "fail" : "pass", images: per };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const r = ocrGate(process.argv.slice(2));
  console.log(JSON.stringify(r));
  process.exit(r.result === "pass" ? 0 : 1);
}
