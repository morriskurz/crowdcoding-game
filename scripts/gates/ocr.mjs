// Offensive-text gate: tesseract OCR on the screenshots, fail on any word from the hashed slur list
// (wordlist.mjs). OCR'd text is checked as words and also with spaces removed per line, so text
// drawn with letter spacing ("s l u r") is caught too.
//
// Run: node scripts/gates/ocr.mjs <image>...   (prints JSON, exit 1 on fail)
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { findSlurs, loadHashes } from "./wordlist.mjs";

export function ocrText(image) {
  const texts = [];
  // psm 11 = sparse text anywhere (game HUDs); psm 3 = page layout. Both, to miss less.
  for (const psm of ["11", "3"]) {
    const r = spawnSync("tesseract", [image, "stdout", "--psm", psm, "-l", "eng"], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`tesseract failed on ${image}: ${r.stderr}`);
    texts.push(r.stdout);
  }
  return texts.join("\n");
}

/** Pure check of OCR'd text. Matches are counted, never echoed. */
export function checkText(text, hashes = loadHashes()) {
  const lines = text.split("\n").map((l) => l.trim()).filter(Boolean);
  const hits = findSlurs(text, hashes).length + lines.reduce((n, l) => n + (/\s/.test(l) ? findSlurs(l.replace(/\s+/g, ""), hashes).length : 0), 0);
  return { hits, words: text.split(/\s+/).filter(Boolean).length };
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
