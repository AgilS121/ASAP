// Tab Git di kolom ke-3: history commit (untuk graph), status, stage/unstage, diff, commit.
// Hanya stage + commit — push / pull / checkout tetap manual lewat terminal (keputusan dev 2026-10-07).
// Root = repo dari kolom Folder atau worktree task (divalidasi server.mjs, sama seperti pohon file).
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

const DATA_DIR = join(process.env.APPDATA || homedir(), "ade");
const DECISIONS_FILE = join(DATA_DIR, "decisions.jsonl");
const LOG_PAGE = 200;
const PATCH_MAX = 300_000;
const EMPTY_TREE = "4b825dc642cb6eb9a060e54bf8d69288fbee4904"; // pembanding untuk commit pertama
const SEP = "\x1f", END = "\x1e";

function git(cwd, args, { allowFail = false } = {}) {
  return new Promise((ok, fail) => {
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, timeout: 60000, windowsHide: true, maxBuffer: 64 * 1024 * 1024 },
      (err, stdout, stderr) => {
        if (err && !allowFail) return fail(new Error((stderr || err.message).trim()));
        ok(stdout);
      });
  });
}

function inside(root, rel) {
  const abs = resolve(root, rel || "");
  const r = relative(resolve(root), abs);
  if (!rel || r.startsWith("..") || isAbsolute(r)) throw new Error(`Path di luar folder project: ${rel}`);
  return r.replaceAll("\\", "/");
}

const clipPatch = (p) => (p.length > PATCH_MAX ? { patch: p.slice(0, PATCH_MAX), truncated: true } : { patch: p, truncated: false });

/** Halaman history. `all` = semua branch (--all), selain itu hanya yang tercapai dari HEAD. */
export async function log(root, { all = false, skip = 0 } = {}) {
  const fmt = ["%H", "%P", "%an", "%ae", "%at", "%D", "%s"].join(SEP) + END;
  const args = ["log", "--date-order", `--format=${fmt}`, `-n${LOG_PAGE + 1}`, `--skip=${skip | 0}`];
  args.push(all ? "--all" : "HEAD");
  const out = await git(root, args, { allowFail: true }); // repo tanpa commit → kosong
  const commits = out.split(END).map((s) => s.replace(/^\n/, "")).filter(Boolean).map((rec) => {
    const [hash, parents, author, email, at, refs, subject] = rec.split(SEP);
    return {
      hash, parents: parents ? parents.split(" ") : [], author, email, at: Number(at) * 1000,
      refs: refs ? refs.split(", ").filter((r) => r !== "origin/HEAD") : [], subject,
    };
  });
  return { commits: commits.slice(0, LOG_PAGE), hasMore: commits.length > LOG_PAGE, skip: skip | 0, all: !!all };
}

/** Proses git yang belum selesai (commit di tengahnya berbahaya / membingungkan). */
async function inProgress(root) {
  const dir = resolve(root, (await git(root, ["rev-parse", "--git-dir"])).trim());
  if (existsSync(join(dir, "MERGE_HEAD"))) return "merge";
  if (existsSync(join(dir, "rebase-merge")) || existsSync(join(dir, "rebase-apply"))) return "rebase";
  if (existsSync(join(dir, "CHERRY_PICK_HEAD"))) return "cherry-pick";
  if (existsSync(join(dir, "REVERT_HEAD"))) return "revert";
  return null;
}

/** File yang belum di-commit. x = status di index (staged), y = di working tree. */
export async function status(root) {
  const out = await git(root, ["status", "--porcelain=v1", "-z", "-uall"]);
  const parts = out.split("\0");
  const files = [];
  for (let i = 0; i < parts.length; i++) {
    const rec = parts[i];
    if (rec.length < 4) continue;
    const x = rec[0], y = rec[1], path = rec.slice(3);
    const f = { path, x, y };
    if (x === "R" || x === "C") f.orig = parts[++i]; // -z: path asal rename di field berikutnya
    files.push(f);
  }
  const branch = (await git(root, ["rev-parse", "--abbrev-ref", "HEAD"], { allowFail: true })).trim() || "(belum ada commit)";
  // ahead/behind terhadap upstream — data fetch terakhir; ADE tidak fetch/pull/push sendiri
  const upstream = (await git(root, ["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{u}"], { allowFail: true })).trim() || null;
  let ahead = 0, behind = 0;
  if (upstream) {
    [behind, ahead] = (await git(root, ["rev-list", "--left-right", "--count", `${upstream}...HEAD`], { allowFail: true }))
      .trim().split(/\s+/).map((n) => Number(n) || 0);
  }
  return { branch, upstream, ahead, behind, files, inProgress: await inProgress(root) };
}

export async function stage(root, paths, on) {
  const rel = (paths || []).map((p) => inside(root, p));
  if (!rel.length) return;
  if (on) await git(root, ["add", "-A", "--", ...rel]);
  else {
    const hasHead = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim();
    // repo tanpa commit: restore --staged belum bisa → keluarkan dari index saja
    await git(root, hasHead ? ["restore", "--staged", "--", ...rel] : ["rm", "--cached", "-q", "--", ...rel]);
  }
}

/** Diff 1 file yang belum di-commit, terhadap HEAD (staged + belum staged sekaligus). */
export async function fileDiff(root, path) {
  const rel = inside(root, path);
  const st = (await git(root, ["status", "--porcelain=v1", "--", rel])).slice(0, 2);
  if (st === "??") { // untracked: git diff tidak menampilkannya → buat patch "semua baris baru"
    const abs = join(root, rel);
    if (!existsSync(abs) || statSync(abs).isDirectory()) return { path, patch: "" };
    const buf = readFileSync(abs);
    if (buf.subarray(0, 8000).includes(0)) return { path, binary: true, patch: "" };
    const lines = buf.toString("utf8").replace(/\r\n/g, "\n").split("\n");
    if (lines.at(-1) === "") lines.pop();
    return { path, ...clipPatch(`@@ -0,0 +1,${lines.length} @@ file baru (untracked)\n` + lines.map((l) => "+" + l).join("\n")) };
  }
  const hasHead = (await git(root, ["rev-parse", "--verify", "-q", "HEAD"], { allowFail: true })).trim();
  const out = await git(root, ["diff", hasHead ? "HEAD" : "--cached", "--", rel]);
  return { path, ...clipPatch(out) };
}

/** Detail 1 commit: metadata + daftar file (patch per file diambil terpisah). */
export async function show(root, hash) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash || "")) throw new Error("Hash commit tidak valid.");
  const meta = (await git(root, ["show", "-s", `--format=%H${SEP}%P${SEP}%an${SEP}%ae${SEP}%at${SEP}%D${SEP}%B`, hash])).split(SEP);
  const parents = meta[1] ? meta[1].split(" ") : [];
  const base = parents[0] || EMPTY_TREE; // merge: dibanding parent pertama (yang masuk dari branch lain)
  const numstat = await git(root, ["diff", "--no-renames", "--numstat", base, hash, "--"]);
  const names = await git(root, ["diff", "--no-renames", "--name-status", base, hash, "--"]);
  // --no-renames: rename tampil sebagai D + A, jadi path di numstat selalu 1 path utuh
  const status = new Map(names.split("\n").filter(Boolean).map((l) => { const [s, path] = l.split("\t"); return [path, s[0]]; }));
  const files = numstat.split("\n").filter(Boolean).map((l) => {
    const [a, d, path] = l.split("\t");
    return { path, status: status.get(path) || "M", additions: a === "-" ? 0 : +a, deletions: d === "-" ? 0 : +d, binary: a === "-" };
  });
  return {
    hash: meta[0], parents, author: meta[2], email: meta[3], at: Number(meta[4]) * 1000,
    refs: meta[5] ? meta[5].split(", ") : [], body: (meta[6] || "").trim(), files,
  };
}

export async function commitFile(root, hash, path) {
  if (!/^[0-9a-f]{7,40}$/i.test(hash || "")) throw new Error("Hash commit tidak valid.");
  const rel = inside(root, path);
  const parents = (await git(root, ["show", "-s", "--format=%P", hash])).trim();
  const out = await git(root, ["diff", parents.split(" ")[0] || EMPTY_TREE, hash, "--", rel]);
  return { hash, path, ...clipPatch(out) };
}

/** Commit file yang sudah di-stage. Hook repo (pre-commit dll) tetap berjalan. */
export async function commit(root, message, meta = {}) {
  const msg = (message || "").trim();
  if (!msg) throw new Error("Pesan commit masih kosong.");
  const busy = await inProgress(root);
  if (busy) throw new Error(`Repo sedang dalam proses ${busy} — selesaikan dulu lewat terminal.`);
  const staged = (await git(root, ["diff", "--cached", "--name-only"])).split("\n").filter(Boolean);
  if (!staged.length) throw new Error("Belum ada file yang di-stage. Centang file yang mau di-commit.");
  await git(root, ["commit", "-m", msg]);
  const hash = (await git(root, ["rev-parse", "HEAD"])).trim();
  try {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DECISIONS_FILE, JSON.stringify({ ts: new Date().toISOString(), action: "git-commit", root, hash, files: staged, message: msg, ...meta }) + "\n");
  } catch {}
  return { hash, files: staged.length };
}
