// Hashed slur list shared by the OCR gate and the caption filter. The plain words are never
// committed: slur-hashes.json holds sha256(lowercase word) for each listed word and its plural
// (`sha256`), and of their repeated-letter-collapsed forms (`collapsed`). A token matches if its
// plain or leet-decoded form is in `sha256`, or, when it contains repeated letters ("niiice"), if its
// collapsed form is in `collapsed` (so "con" never matches a collapsed "coon").
//
// Add a word (owner, locally):  node scripts/gates/wordlist.mjs add <word> [...]
// Check text:                   node scripts/gates/wordlist.mjs check "some text"
// SLUR_TEST_WORDS="a,b" adds plain test words at runtime (tests and local demos only).
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const FILE = path.join(path.dirname(fileURLToPath(import.meta.url)), "slur-hashes.json");
const LEET = { 0: "o", 1: "i", 3: "e", 4: "a", 5: "s", 7: "t", 8: "b", "@": "a", $: "s", "!": "i", "|": "l" };

export const sha256 = (s) => crypto.createHash("sha256").update(s).digest("hex");
export const collapse = (w) => w.replace(/(.)\1+/g, "$1");

/** Exact forms of one token: letters as written, and leet-decoded. */
export function forms(token) {
  // trailing "!" is punctuation, not a leet "i"
  const lower = token.toLowerCase().replace(/^[^a-z0-9@$|!]+|[^a-z0-9$]+$/g, "");
  const leet = [...lower].map((c) => LEET[c] ?? c).join("").replace(/[^a-z]/g, "");
  const plain = lower.replace(/[^a-z]/g, "");
  return [...new Set([plain, leet].filter(Boolean))];
}

/** Collapsed forms, only for exact forms that actually contain a repeated letter. */
export const collapsedForms = (token) => forms(token).filter((f) => collapse(f) !== f).map(collapse);

export function tokens(text) {
  return String(text).split(/[\s.,;:?"'()[\]{}<>\/\\_+=*~^`-]+/).filter(Boolean);
}

const addWord = (h, w) => {
  for (const v of [w, `${w}s`]) for (const f of forms(v)) { h.exact.add(sha256(f)); h.collapsed.add(sha256(collapse(f))); }
};

let cached = null;
export function loadHashes(env = process.env) {
  if (cached && !env.SLUR_TEST_WORDS) return cached;
  const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
  const h = { exact: new Set(doc.sha256), collapsed: new Set(doc.collapsed) };
  for (const w of (env.SLUR_TEST_WORDS ?? "").split(",").map((s) => s.trim().toLowerCase()).filter(Boolean)) addWord(h, w);
  if (!env.SLUR_TEST_WORDS) cached = h;
  return h;
}

export const isSlur = (token, h = loadHashes()) =>
  forms(token).some((f) => h.exact.has(sha256(f))) || collapsedForms(token).some((f) => h.collapsed.has(sha256(f)));

/** Tokens of `text` that are on the list, as written. */
export function findSlurs(text, hashes = loadHashes()) {
  return tokens(text).filter((t) => isSlur(t, hashes));
}

/** Captions for the presentation: strings only, control chars stripped, slur-free, max 140 chars. */
export function filterCaptions(raw, hashes = loadHashes()) {
  if (!Array.isArray(raw)) return [];
  return raw
    .filter((c) => typeof c === "string")
    .map((c) => c.replace(/[\u0000-\u001f\u007f-\u009f​-‏‪-‮⁦-⁩]/g, " ").replace(/\s+/g, " ").trim())
    .filter((c) => c && findSlurs(c, hashes).length === 0)
    .map((c) => [...c].slice(0, 140).join(""))
    .slice(0, 20);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  const [cmd, ...args] = process.argv.slice(2);
  if (cmd === "add") {
    const doc = JSON.parse(fs.readFileSync(FILE, "utf8"));
    const h = { exact: new Set(doc.sha256), collapsed: new Set(doc.collapsed) };
    for (const w of args) addWord(h, w.toLowerCase());
    doc.sha256 = [...h.exact].sort();
    doc.collapsed = [...h.collapsed].sort();
    fs.writeFileSync(FILE, JSON.stringify(doc, null, 1) + "\n");
    console.log(`${doc.sha256.length} exact + ${doc.collapsed.length} collapsed hashes`);
  } else if (cmd === "check") {
    const hits = findSlurs(args.join(" "));
    console.log(hits.length ? `match: ${hits.length} token(s)` : "clean");
    process.exit(hits.length ? 1 : 0);
  } else {
    console.error("usage: wordlist.mjs add <word>... | check <text>");
    process.exit(2);
  }
}
