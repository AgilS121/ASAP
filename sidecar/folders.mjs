// Daftar project untuk kolom "Folder", dikelompokkan.
// Sumber: (1) ~/.claude/project-registry.json — dibaca live, tidak disalin;
//         (2) folder yang ditambah manual — disimpan di %APPDATA%\ade\folders.json.
//             Kalau folder itu repo git → 1 project. Kalau bukan → folder induk:
//             isinya dipindai (live, tiap list) untuk mencari repo git di dalamnya.
import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";

const REGISTRY = join(homedir(), ".claude", "project-registry.json");
const DATA_DIR = join(process.env.APPDATA || homedir(), "ade");
const STORE = join(DATA_DIR, "folders.json");

const SCAN_DEPTH = 3;      // D:\HSD → D:\HSD\SIMLAB\old-simlab-v2-fe masih kena
const SCAN_LIMIT = 300;    // pengaman kalau ada yang menambah root sebesar C:\
const SKIP_DIRS = new Set(["node_modules", "vendor", "dist", "build", "storage", "target", "bower_components"]);

// path Windows tidak case-sensitive; registry menulis "d:\\HSD" dan "c:\\laragon" campur
const norm = (p) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();

function readJson(file, fallback) {
  try { return JSON.parse(readFileSync(file, "utf8")); } catch { return fallback; }
}

function loadManual() {
  return readJson(STORE, { folders: [] }).folders;
}

function saveManual(folders) {
  mkdirSync(DATA_DIR, { recursive: true });
  writeFileSync(STORE, JSON.stringify({ folders }, null, 2));
}

const isDir = (p) => existsSync(p) && statSync(p).isDirectory();
const isRepo = (p) => existsSync(join(p, ".git")); // .git bisa folder atau file (worktree/submodule)

function registryProjects() {
  const reg = readJson(REGISTRY, { projects: {} });
  return Object.entries(reg.projects || {}).map(([id, p]) => ({
    id: `reg:${id}`, name: p.name || id, path: p.path, stack: p.stack_profile || null,
  }));
}

/** Cari repo git di bawah root. Berhenti turun begitu ketemu repo. */
async function scanRepos(root) {
  const found = [];
  async function walk(dir, depth) {
    if (found.length >= SCAN_LIMIT || depth > SCAN_DEPTH) return;
    let entries;
    try { entries = await readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory() || e.name.startsWith(".") || SKIP_DIRS.has(e.name.toLowerCase())) continue;
      const child = join(dir, e.name);
      if (isRepo(child)) found.push(child);
      else await walk(child, depth + 1);
      if (found.length >= SCAN_LIMIT) return;
    }
  }
  await walk(root, 1);
  return found.sort((a, b) => a.localeCompare(b));
}

function git(cwd, args) {
  return new Promise((ok) => {
    execFile("git", args, { cwd, timeout: 5000, windowsHide: true }, (err, stdout) =>
      ok(err ? null : stdout.trim()));
  });
}

async function gitInfo(path) {
  if (!isDir(path)) return { exists: false, isGit: false };
  const branch = await git(path, ["rev-parse", "--abbrev-ref", "HEAD"]);
  if (branch === null) return { exists: true, isGit: false };
  const status = await git(path, ["status", "--porcelain"]);
  return { exists: true, isGit: true, branch, changed: status ? status.split("\n").length : 0 };
}

/**
 * @returns {Promise<Array<{id,name,path,kind,removable,items:Array}>>}
 * kind: "registry" | "root" (folder induk) | "repos" (repo tambahan satuan)
 */
export async function listGroups() {
  const seen = new Set();
  const take = (p) => { const k = norm(p); if (seen.has(k)) return false; seen.add(k); return true; };

  const groups = [];
  const reg = registryProjects().filter((p) => take(p.path));
  groups.push({ id: "registry", name: "Registry", path: REGISTRY, kind: "registry", removable: false, items: reg });

  const singles = [];
  for (const entry of loadManual()) {
    if (!isDir(entry.path)) {
      // folder hilang: tetap tampil supaya user tahu & bisa hapus
      groups.push({ id: entry.id, name: entry.name, path: entry.path, kind: "root", removable: true, missing: true, items: [] });
    } else if (isRepo(entry.path)) {
      if (take(entry.path)) singles.push({ id: entry.id, name: entry.name, path: entry.path, removable: true });
    } else {
      const repos = (await scanRepos(entry.path)).filter(take);
      groups.push({
        id: entry.id, name: entry.name, path: entry.path, kind: "root", removable: true,
        // nama = path relatif dari induk: SIMLAB punya banyak salinan "old-simlab-v2-fe"
        items: repos.map((p) => ({ id: `${entry.id}:${norm(p)}`, name: relative(entry.path, p).replaceAll("\\", "/"), path: p })),
      });
    }
  }
  if (singles.length) groups.push({ id: "singles", name: "Repo tambahan", path: null, kind: "repos", removable: false, items: singles });

  // status git semua project sekaligus (paralel)
  const all = groups.flatMap((g) => g.items);
  const infos = await Promise.all(all.map((p) => gitInfo(p.path)));
  all.forEach((p, i) => Object.assign(p, infos[i], { agents: 0 })); // agents diisi di Fase 2
  return groups;
}

export async function addFolder(rawPath, name) {
  const path = (rawPath || "").trim().replace(/^"(.*)"$/, "$1");
  if (!path) throw new Error("Path folder kosong.");
  if (!isDir(path)) throw new Error(`Folder tidak ditemukan: ${path}`);
  const abs = resolve(path);

  const manual = loadManual();
  const same = manual.find((f) => norm(f.path) === norm(abs));
  if (same) throw new Error(`Folder sudah ditambahkan sebagai "${same.name}".`);
  if (isRepo(abs)) {
    const groups = await listGroups();
    const dup = groups.flatMap((g) => g.items).find((p) => norm(p.path) === norm(abs));
    if (dup) throw new Error(`Project ini sudah ada di daftar sebagai "${dup.name}".`);
  } else if ((await scanRepos(abs)).length === 0) {
    throw new Error(`Tidak ada repo git di dalam ${abs} (dicari sampai ${SCAN_DEPTH} level).`);
  }

  manual.push({ id: `man:${Date.now()}`, name: (name || "").trim() || basename(abs), path: abs });
  saveManual(manual);
}

export function removeFolder(id) {
  if (!id?.startsWith("man:")) throw new Error("Project dari registry tidak bisa dihapus dari ASAP (ubah registry-nya).");
  saveManual(loadManual().filter((f) => f.id !== id));
}
