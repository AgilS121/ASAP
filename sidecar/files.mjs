// Penjelajah file untuk kolom Perubahan: isi folder per level (lazy), baca file, filter nama.
// Root = worktree task atau repo yang terdaftar di kolom Folder. Semua path relatif terhadap
// root dan tidak boleh keluar darinya (`..`, path absolut, drive lain).
import { existsSync, readFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { isAbsolute, relative, resolve } from "node:path";

const FILE_VIEW_MAX = 1_000_000; // batas tampilan "File lengkap"
const DIR_LIMIT = 2000;          // pengaman folder raksasa (mis. storage/logs)

function git(cwd, args) {
  return new Promise((ok) => {
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, timeout: 15000, windowsHide: true, maxBuffer: 32 * 1024 * 1024 },
      (err, stdout) => ok(err ? "" : stdout));
  });
}

function inside(root, rel) {
  const abs = resolve(root, rel || "");
  const r = relative(resolve(root), abs);
  if (r.startsWith("..") || isAbsolute(r)) throw new Error("Path di luar folder project.");
  return abs;
}

/** Status git per path (relatif root, pakai "/"): A = baru, M = berubah, D = dihapus. */
async function gitStatus(root) {
  const out = await git(root, ["status", "--porcelain"]);
  const map = new Map();
  for (const line of out.split("\n")) {
    if (line.length < 4) continue;
    const xy = line.slice(0, 2);
    let path = line.slice(3);
    if (path.includes(" -> ")) path = path.split(" -> ").pop(); // rename
    path = path.replace(/^"(.*)"$/, "$1").replace(/\/$/, "");
    const s = xy === "??" || xy.includes("A") ? "A" : xy.includes("D") ? "D" : "M";
    map.set(path, s);
  }
  return map;
}

/** Isi 1 folder: folder dulu lalu file, masing-masing urut nama. `.git` disembunyikan. */
export async function listDir(root, dir) {
  const abs = inside(root, dir);
  const entries = await readdir(abs, { withFileTypes: true });
  const status = await gitStatus(root);
  const prefix = dir ? `${dir.replaceAll("\\", "/")}/` : "";
  const keys = [...status.keys()];
  const statusOf = (path, isDir) => {
    if (status.has(path)) return status.get(path);
    // folder untracked dilaporkan git sebagai 1 baris "folder/" → semua isinya baru
    const parent = keys.find((k) => status.get(k) === "A" && path.startsWith(`${k}/`));
    if (parent) return "A";
    return isDir && keys.some((k) => k.startsWith(`${path}/`)) ? "M" : null;
  };
  const items = entries
    .filter((e) => e.name !== ".git")
    .map((e) => {
      const path = prefix + e.name;
      return { name: e.name, path, dir: e.isDirectory(), status: statusOf(path, e.isDirectory()) };
    })
    .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  // file yang dihapus tidak ada di disk tapi tetap perlu terlihat di pohon
  for (const [k, v] of status) {
    if (v !== "D" || !k.startsWith(prefix) || k.slice(prefix.length).includes("/")) continue;
    if (!items.some((i) => i.path === k)) items.push({ name: k.slice(prefix.length), path: k, dir: false, status: "D" });
  }
  return { dir: dir || "", entries: items.slice(0, DIR_LIMIT), truncated: items.length > DIR_LIMIT };
}

export function readIn(root, relPath) {
  const abs = inside(root, relPath);
  if (abs === resolve(root)) throw new Error("Path bukan file.");
  if (!existsSync(abs)) return { path: relPath, missing: true };
  const buf = readFileSync(abs);
  const binary = buf.subarray(0, 8000).includes(0);
  const truncated = buf.length > FILE_VIEW_MAX;
  return {
    path: relPath, size: buf.length, binary, truncated,
    content: binary ? "" : buf.subarray(0, FILE_VIEW_MAX).toString("utf8"),
  };
}

/** Cari file (tracked + untracked yang tidak di-ignore) berdasarkan potongan path. */
export async function findFiles(root, q) {
  const needle = (q || "").trim().toLowerCase().replaceAll("\\", "/");
  if (needle.length < 2) return [];
  const out = await git(root, ["ls-files", "-co", "--exclude-standard"]);
  const parts = needle.split(/\s+/);
  return out.split("\n").filter((p) => p && parts.every((x) => p.toLowerCase().includes(x)))
    // nama file yang cocok di depan, baru path yang lebih pendek
    .sort((a, b) => (b.toLowerCase().split("/").pop().includes(parts[0]) - a.toLowerCase().split("/").pop().includes(parts[0])) || a.length - b.length)
    .slice(0, 60);
}
