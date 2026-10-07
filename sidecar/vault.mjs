// Info Brain Vault (D:\HSD\brain-vault) untuk file simlab-v2 yang dibuka di ADE: hotspot + riwayat bug.
// Vault = petunjuk awal (snapshot saat terakhir di-generate), bukan bukti — UI wajib menyebut ini.
// Laptop tanpa vault → fitur diam (lookup selalu null).
import { existsSync, readFileSync } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join, resolve } from "node:path";

const VAULT = process.env.ADE_VAULT || "D:\\HSD\\brain-vault";
const REGISTRY = join(homedir(), ".claude", "project-registry.json");
const SOURCES = [
  ["simlab-v2-fe", ["controllers", "views"]],
  ["simlab-v2-be", ["controllers", "models"]],
];
const TTL = 60_000; // vault di-generate ulang sesekali — cukup dibaca ulang tiap menit

const norm = (p) => resolve(p).replace(/[\\/]+$/, "").toLowerCase();
let cache = null; // { at, map, ready }

function frontmatter(text) {
  const m = text.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  const out = {};
  if (!m) return out;
  for (const line of m[1].split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i > 0) out[line.slice(0, i).trim()] = line.slice(i + 1).trim();
  }
  return out;
}

/** "- [[slug]] — high/fixed (2026-08-14)" di bawah heading "Bug history". */
function bugHistory(text) {
  const start = text.search(/^## .*Bug history/m);
  if (start < 0) return [];
  const section = text.slice(start).split(/\r?\n/).slice(1);
  const bugs = [];
  for (const line of section) {
    if (line.startsWith("## ")) break;
    const m = line.match(/^- \[\[([^\]]+)\]\]\s*—\s*([\w/.-]+)\s*(?:\((\d{4}-\d{2}-\d{2})\))?/);
    if (!m) continue;
    // "high/fixed" atau "n/a/fixed": status = segmen terakhir
    const parts = m[2].split("/");
    const status = parts.length > 1 ? parts.pop() : "?";
    bugs.push({ slug: m[1], severity: parts.join("/"), status, date: m[3] || null });
  }
  return bugs;
}

async function noteInfo(file, dir) {
  const text = await readFile(file, "utf8");
  const fm = frontmatter(text);
  const path = (fm.path || fm.blade || "").replaceAll("\\", "/");
  if (!path) return null;
  const bugs = bugHistory(text);
  return [path.toLowerCase(), {
    note: basename(file).replace(/\.md$/, ""), noteFile: file, type: fm.type || dir,
    hotspot: fm.hotspot === "true",
    bugCount: Number(fm.bug_count) || bugs.length,
    open: bugs.filter((b) => b.status !== "fixed").length,
    bugs: bugs.slice(0, 8),
    generated: (await stat(file)).mtime.toISOString().slice(0, 10),
  }];
}

async function buildIndex() {
  const index = new Map(); // `${project}|${path relatif repo}` -> info
  for (const [project, dirs] of SOURCES) {
    for (const dir of dirs) {
      const full = join(VAULT, project, dir);
      if (!existsSync(full)) continue;
      const names = (await readdir(full)).filter((n) => n.endsWith(".md"));
      const infos = await Promise.all(names.map((n) => noteInfo(join(full, n), dir).catch(() => null)));
      for (const it of infos) if (it) index.set(`${project}|${it[0]}`, it[1]);
    }
  }
  return index;
}

/** Index di-cache; dibangun ulang di belakang layar kalau sudah lewat TTL (async — sidecar tidak membeku). */
function index() {
  if (!existsSync(VAULT)) return null;
  if (!cache || Date.now() - cache.at > TTL) {
    const building = buildIndex();
    cache = { at: Date.now(), ready: building.then((map) => { cache.map = map; return map; }), map: cache?.map };
  }
  return cache.map ? Promise.resolve(cache.map) : cache.ready;
}

/** simlab-v2-fe / simlab-v2-be dari path repo (registry dulu, lalu nama folder seperti old-simlab-v2-fe). */
function projectOf(repoPath) {
  try {
    const reg = JSON.parse(readFileSync(REGISTRY, "utf8")).projects || {};
    for (const [id, p] of Object.entries(reg)) {
      if (p.path && norm(p.path) === norm(repoPath) && SOURCES.some(([s]) => s === id)) return id;
    }
  } catch {}
  const m = basename(repoPath).toLowerCase().match(/simlab-v2-(fe|be)$/);
  return m ? `simlab-v2-${m[1]}` : null;
}

/** @returns info vault untuk file itu, atau null (bukan simlab-v2 / tidak ada note / vault tidak ada). */
export async function lookup(repoPath, relPath) {
  const project = repoPath && projectOf(repoPath);
  if (!project || !relPath) return null;
  const map = await index();
  return map?.get(`${project}|${relPath.replaceAll("\\", "/").toLowerCase()}`) || null;
}

// panaskan index sejak sidecar start supaya file pertama yang dibuka tidak menunggu
setTimeout(() => index()?.catch(() => {}), 2000).unref();
