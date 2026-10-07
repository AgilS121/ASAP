// ADE sidecar: jembatan UI (WebSocket) <-> Claude Agent SDK.
// Dijalankan oleh Tauri saat app start, berhenti saat app ditutup / mati.
import { WebSocketServer } from "ws";
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { addFolder, listGroups, removeFolder } from "./folders.mjs";
import { TaskManager } from "./tasks.mjs";
import { authStatus, openLogin } from "./auth.mjs";
import { findFiles, listDir, readIn } from "./files.mjs";
import { Terminals } from "./terminal.mjs";
import * as gitOps from "./git.mjs";
import { lookup as vaultLookup } from "./vault.mjs";

// Port 0 = OS pilih port bebas → tidak bisa bentrok dengan sidecar sisa sesi lain.
const PORT = Number(process.env.ADE_PORT || 0);
// Token per sesi: halaman web mana pun bisa membuka ws://127.0.0.1, jadi tanpa token
// situs luar bisa menyuruh agent. Token hanya diketahui shell Tauri (lewat stdout) dan UI.
// ADE_DEV_TOKEN hanya untuk tes otomatis (env proses induk) — pemakaian normal selalu acak.
const TOKEN = process.env.ADE_DEV_TOKEN || randomUUID();
// package.json SDK tidak ada di "exports", jadi baca langsung dari node_modules
const sdkVersion = JSON.parse(
  readFileSync(new URL("./node_modules/@anthropic-ai/claude-agent-sdk/package.json", import.meta.url), "utf8")
).version;

// hanya terima koneksi lokal yang membawa token sesi
const wss = new WebSocketServer({
  host: "127.0.0.1",
  port: PORT,
  verifyClient: ({ req }) => new URL(req.url, "http://x").searchParams.get("token") === TOKEN,
});

function send(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}
function broadcast(obj) {
  for (const client of wss.clients) send(client, obj);
}

// path project yang tampil di kolom Folder — hanya ini (dan worktree task) yang boleh dijelajahi
let knownRepos = new Set();
const normPath = (p) => (p || "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
async function folderGroups() {
  const groups = await listGroups();
  knownRepos = new Set(groups.flatMap((g) => g.items).filter((p) => p.exists).map((p) => normPath(p.path)));
  return groups;
}
async function broadcastFolders() {
  broadcast({ type: "folders", groups: await folderGroups() });
}

/** Root penjelajah file: worktree task (`id`) atau repo dari kolom Folder (`repo`). */
function fsRoot(m) {
  if (m.id) {
    const t = tasks.get(m.id);
    if (t.worktreeRemoved) throw new Error("Worktree task ini sudah dibersihkan.");
    return t.worktree;
  }
  if (m.repo && knownRepos.has(normPath(m.repo))) return m.repo;
  throw new Error("Folder ini tidak ada di daftar project ASAP.");
}
const fsKey = (m) => (m.id ? m.id : `repo:${m.repo}`);
const terminals = new Terminals();

// state task + izin dikirim utuh; di-throttle karena agent bisa update berkali-kali per detik
const tasks = new TaskManager(scheduleTasksBroadcast);
let tasksTimer = null;
function tasksSnapshot() {
  return { type: "tasks", tasks: tasks.listTasks(), permissions: tasks.listPermissions() };
}
function scheduleTasksBroadcast() {
  if (tasksTimer) return;
  tasksTimer = setTimeout(() => { tasksTimer = null; broadcast(tasksSnapshot()); }, 100);
}

const handlers = {
  "folders:list": async (ws) => send(ws, { type: "folders", groups: await folderGroups() }),
  "folders:add": async (ws, m) => { await addFolder(m.path, m.name); await broadcastFolders(); },
  "folders:remove": async (ws, m) => { removeFolder(m.id); await broadcastFolders(); },
  "task:create": async (ws, m) => {
    const t = await tasks.create(m);
    send(ws, { type: "task:created", id: t.id });
  },
  "task:stop": async (ws, m) => tasks.stop(m.id),
  "task:forget": async (ws, m) => tasks.forget(m.id),
  "perm:decide": async (ws, m) => tasks.decide(m.id, !!m.allow, m.reason),
  "task:diff": async (ws, m) => send(ws, { type: "diff", id: m.id, ...(await tasks.diff(m.id)) }),
  "task:approve": async (ws, m) => { await tasks.approve(m.id); send(ws, { type: "diff", id: m.id, ...(await tasks.diff(m.id)) }); },
  "task:revise": async (ws, m) => tasks.revise(m.id, m.feedback),
  "task:cleanup": async (ws, m) => tasks.cleanup(m.id),
  "task:send": async (ws, m) => tasks.send(m.id, m.text),
  "fs:list": async (ws, m) => send(ws, { type: "dir", key: fsKey(m), ...(await listDir(fsRoot(m), m.dir)) }),
  "fs:read": async (ws, m) => send(ws, { type: "file", key: fsKey(m), ...readIn(fsRoot(m), m.path) }),
  "fs:find": async (ws, m) => send(ws, { type: "found", key: fsKey(m), q: m.q, items: await findFiles(fsRoot(m), m.q) }),
  "vault:lookup": async (ws, m) => {
    fsRoot(m); // validasi akses sama seperti pohon file
    // worktree task: note vault dicocokkan lewat repo asalnya (nama folder worktree = slug task)
    const repo = m.id ? tasks.get(m.id).repoPath : m.repo;
    send(ws, { type: "vault", key: fsKey(m), path: m.path, info: await vaultLookup(repo, m.path) });
  },
  "git:log": async (ws, m) => send(ws, { type: "git:log", key: fsKey(m), ...(await gitOps.log(fsRoot(m), m)) }),
  "git:status": async (ws, m) => send(ws, { type: "git:status", key: fsKey(m), ...(await gitOps.status(fsRoot(m))) }),
  "git:stage": async (ws, m) => {
    await gitOps.stage(fsRoot(m), m.paths, !!m.on);
    send(ws, { type: "git:status", key: fsKey(m), ...(await gitOps.status(fsRoot(m))) });
  },
  "git:fileDiff": async (ws, m) => send(ws, { type: "git:fileDiff", key: fsKey(m), ...(await gitOps.fileDiff(fsRoot(m), m.path)) }),
  "git:show": async (ws, m) => send(ws, { type: "git:show", key: fsKey(m), ...(await gitOps.show(fsRoot(m), m.hash)) }),
  "git:commitFile": async (ws, m) => send(ws, { type: "git:commitFile", key: fsKey(m), ...(await gitOps.commitFile(fsRoot(m), m.hash, m.path)) }),
  "git:commit": async (ws, m) => {
    const res = await gitOps.commit(fsRoot(m), m.message, m.id ? { taskId: m.id } : {});
    send(ws, { type: "git:committed", key: fsKey(m), ...res });
    // jumlah "file berubah" di kolom Folder & diff task ikut berubah
    if (m.id) send(ws, { type: "diff", id: m.id, ...(await tasks.diff(m.id)) });
    else await broadcastFolders();
  },
  "term:open": async (ws, m) => {
    const cwd = m.id || m.repo ? fsRoot(m) : null;
    const tid = terminals.open(ws, (obj) => send(ws, obj), { cwd, cols: m.cols, rows: m.rows, shell: m.shell });
    send(ws, { type: "term:opened", tid, ref: m.ref, cwd });
  },
  "term:input": async (ws, m) => terminals.write(m.tid, m.data),
  "term:resize": async (ws, m) => terminals.resize(m.tid, m.cols, m.rows),
  "term:close": async (ws, m) => terminals.close(m.tid),
  "auth:status": async (ws) => send(ws, { type: "auth", ...authStatus() }),
  "auth:login": async (ws) => openLogin(),
};

wss.on("connection", (ws) => {
  send(ws, { type: "ready", node: process.version, sdk: sdkVersion });
  send(ws, tasksSnapshot());
  send(ws, { type: "auth", ...authStatus() });
  ws.on("close", () => terminals.closeFor(ws));
  ws.on("message", async (raw) => {
    let msg;
    try { msg = JSON.parse(raw); } catch { return send(ws, { type: "error", error: "JSON tidak valid" }); }
    const handler = handlers[msg.type];
    if (!handler) return send(ws, { type: "error", scope: msg.type, error: `Pesan tidak dikenal: ${msg.type}` });
    try { await handler(ws, msg); }
    catch (e) { send(ws, { type: "error", scope: msg.type, error: String(e?.message || e) }); }
  });
});

wss.on("error", (e) => {
  console.error(`ADE sidecar gagal listen di ${PORT}: ${e.message}`);
  process.exit(1);
});

// Hentikan semua agent sebelum keluar: di Windows proses claude.exe anak tidak ikut mati sendiri.
function shutdown() {
  terminals.closeAll();
  for (const t of tasks.listTasks()) { try { tasks.stop(t.id); } catch {} }
  setTimeout(() => process.exit(0), 1500).unref();
}

// Dijalankan oleh ADE: stdin = pipe ke proses induk. Pipe tertutup → induk mati → ikut keluar.
// (Saat dijalankan manual dari terminal untuk tes, set ADE_STANDALONE=1.)
if (!process.env.ADE_STANDALONE) {
  process.stdin.on("end", shutdown);
  process.stdin.resume();
}

wss.on("listening", () => {
  // baris ini dibaca shell Tauri (stdout) — jangan ubah formatnya
  console.log(`ADE_READY ${JSON.stringify({ port: wss.address().port, token: TOKEN })}`);
});
