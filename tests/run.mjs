// Tes ADE end-to-end tanpa menyentuh repo asli: `npm test` (tambahkan `-- --no-ui` untuk lewati tes UI).
// 1. Buat repo dummy (merge, branch, tag, upstream) + APPDATA sementara berisi folders.json.
// 2. Nyalakan sidecar dengan APPDATA itu → tes protokol: folder, pohon file, baca/cari file,
//    terminal (PTY), git (log/status/stage/commit), Brain Vault (kalau ada di laptop ini).
// 3. Kalau Edge ada: sajikan src/ dengan shim pengganti Tauri, kendalikan Edge headless lewat CDP.
import { spawn, execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(join(ROOT, "sidecar", "package.json"));
const WebSocket = require("ws");
const NO_UI = process.argv.includes("--no-ui");
const TOKEN = "ade-test";
const EDGE = ["C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe", "C:/Program Files/Microsoft/Edge/Application/msedge.exe"].find(existsSync);

let passed = 0, failed = 0, skipped = 0;
const ok = (cond, name, detail = "") => {
  if (cond) { passed++; console.log(`  ✓ ${name}`); }
  else { failed++; console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ""}`); }
};
const skip = (name, why) => { skipped++; console.log(`  - ${name} (dilewati: ${why})`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------- 1. repo dummy ----------
const BASE = mkdtempSync(join(tmpdir(), "ade-test-"));
const REPO = join(BASE, "demo-repo");
const APPDATA = join(BASE, "appdata");
const gitEnv = { ...process.env, GIT_AUTHOR_NAME: "Dev", GIT_AUTHOR_EMAIL: "dev@test", GIT_COMMITTER_NAME: "Dev", GIT_COMMITTER_EMAIL: "dev@test" };
const g = (cwd, ...args) => execFileSync("git", args, { cwd, env: gitEnv, stdio: ["ignore", "pipe", "ignore"] }).toString().trim();
const write = (p, s) => { mkdirSync(dirname(p), { recursive: true }); writeFileSync(p, s); };

function makeRepo() {
  g(BASE, "init", "-q", "--bare", "remote.git");
  g(BASE, "clone", "-q", "remote.git", "demo-repo");
  g(REPO, "checkout", "-q", "-b", "main");
  write(join(REPO, "app/Http/OrderController.php"), "<?php\n// controller order\nclass OrderController {\n  public function index($id) { return 'ok'; }\n}\n");
  write(join(REPO, "README.md"), "demo\n");
  g(REPO, "add", "."); g(REPO, "commit", "-qm", "init project");
  g(REPO, "push", "-q", "-u", "origin", "main");
  g(REPO, "checkout", "-q", "-b", "fitur/coa");
  write(join(REPO, "coa.txt"), "c\n"); g(REPO, "add", "."); g(REPO, "commit", "-qm", "feat: COA draft");
  g(REPO, "checkout", "-q", "main");
  write(join(REPO, "README.md"), "demo\nmain\n"); g(REPO, "commit", "-qam", "fix: readme");
  g(REPO, "merge", "-q", "--no-edit", "fitur/coa");
  g(REPO, "tag", "v1.0");
  // perubahan belum di-commit: 1 file diubah + 1 file baru
  write(join(REPO, "README.md"), "demo\nmain\nwip\n");
  write(join(REPO, "baru.txt"), "baru\n");
  write(join(APPDATA, "ade", "folders.json"), JSON.stringify({ folders: [{ id: "man:test", name: "demo-repo", path: REPO }] }));
}

// ---------- 2. sidecar ----------
function startSidecar() {
  return new Promise((ok, fail) => {
    const child = spawn(process.execPath, [join(ROOT, "sidecar", "server.mjs")], {
      env: { ...process.env, APPDATA, ADE_DEV_TOKEN: TOKEN, ADE_PORT: "0" },
      stdio: ["pipe", "pipe", "inherit"], windowsHide: true,
    });
    const t = setTimeout(() => fail(new Error("sidecar tidak siap dalam 15 detik")), 15000);
    child.stdout.on("data", (d) => {
      const m = String(d).match(/ADE_READY (\{.*\})/);
      if (m) { clearTimeout(t); ok({ child, port: JSON.parse(m[1]).port }); }
    });
    child.on("exit", (code) => fail(new Error(`sidecar keluar (${code})`)));
  });
}

function client(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/?token=${TOKEN}`);
  const inbox = [];
  const waiters = [];
  ws.on("message", (raw) => {
    const m = JSON.parse(raw);
    const w = waiters.findIndex((x) => x.pred(m));
    if (w >= 0) { waiters[w].ok(m); waiters.splice(w, 1); } else inbox.push(m);
  });
  const wait = (pred, ms = 10000) => {
    const i = inbox.findIndex(pred);
    if (i >= 0) return Promise.resolve(inbox.splice(i, 1)[0]);
    return new Promise((ok, fail) => {
      const entry = { pred, ok };
      waiters.push(entry);
      setTimeout(() => { const k = waiters.indexOf(entry); if (k >= 0) { waiters.splice(k, 1); fail(new Error("timeout")); } }, ms);
    });
  };
  const call = async (msg, pred) => { ws.send(JSON.stringify(msg)); return wait((m) => pred(m) || (m.type === "error" && m.scope === msg.type)); };
  return { ws, wait, call, inbox, open: new Promise((r) => ws.on("open", r)) };
}

async function protocolTests(port) {
  console.log("\nProtokol sidecar");
  const c = client(port);
  await c.open;
  const repo = { repo: REPO };

  const f = await c.call({ type: "folders:list" }, (m) => m.type === "folders");
  ok(f.groups.flatMap((x) => x.items).some((p) => p.path === REPO), "folders:list memuat repo dummy");

  const d = await c.call({ type: "fs:list", ...repo, dir: "" }, (m) => m.type === "dir");
  const names = d.entries?.map((e) => e.name) || [];
  ok(names[0] === "app" && !names.includes(".git"), "fs:list: folder dulu, .git disembunyikan", names.join(","));
  ok(d.entries?.find((e) => e.name === "README.md")?.status === "M" && d.entries?.find((e) => e.name === "baru.txt")?.status === "A", "fs:list: tanda status M / A");

  const r = await c.call({ type: "fs:read", ...repo, path: "app/Http/OrderController.php" }, (m) => m.type === "file");
  ok(r.content?.includes("class OrderController"), "fs:read isi file");
  const bad = await c.call({ type: "fs:read", ...repo, path: "../../etc/x" }, () => false);
  ok(bad.type === "error" && /luar/.test(bad.error), "fs:read menolak path traversal");
  const foreign = await c.call({ type: "fs:list", repo: "C:\\Windows", dir: "" }, () => false);
  ok(foreign.type === "error", "fs:list menolak folder di luar daftar project");
  const found = await c.call({ type: "fs:find", ...repo, q: "order" }, (m) => m.type === "found");
  ok(found.items?.[0] === "app/Http/OrderController.php", "fs:find mencari nama file");

  // terminal
  const o = await c.call({ type: "term:open", ...repo, ref: 1, cols: 100, rows: 30 }, (m) => m.type === "term:opened");
  ok(o.type === "term:opened" && o.cwd === REPO, "term:open di folder repo", o.error);
  if (o.tid) {
    let out = "";
    const collect = (raw) => { const m = JSON.parse(raw); if (m.type === "term:data" && m.tid === o.tid) out += m.data; };
    c.ws.on("message", collect);
    c.ws.send(JSON.stringify({ type: "term:resize", tid: o.tid, cols: 120, rows: 40 }));
    c.ws.send(JSON.stringify({ type: "term:input", tid: o.tid, data: "git rev-parse --abbrev-ref HEAD; $Host.UI.RawUI.WindowSize.Width\r" }));
    for (let i = 0; i < 40 && !/120\s*\r?\n/.test(out); i++) await sleep(250);
    const plain = out.replace(/\x1b\[[0-9;?]*[a-zA-Z]/g, "");
    ok(/\bmain\b/.test(plain), "terminal menjalankan perintah (git branch = main)");
    ok(/\b120\b/.test(plain), "terminal mengikuti resize (120 kolom)");
    c.ws.off("message", collect);
    c.ws.send(JSON.stringify({ type: "term:close", tid: o.tid }));
    const after = await c.call({ type: "term:input", tid: o.tid, data: "x" }, () => false);
    ok(after.type === "error", "terminal yang ditutup tidak menerima input");
  }

  // git
  const log = await c.call({ type: "git:log", ...repo, all: false, skip: 0 }, (m) => m.type === "git:log");
  ok(log.commits?.length === 4 && log.commits[0].parents.length === 2, "git:log: 4 commit, teratas merge", JSON.stringify(log.commits?.map((x) => x.subject)));
  ok(log.commits?.[0].refs.some((x) => x.includes("v1.0")), "git:log: label tag ikut");
  const st = await c.call({ type: "git:status", ...repo }, (m) => m.type === "git:status");
  ok(st.branch === "main" && st.upstream === "origin/main" && st.ahead === 3 && st.behind === 0, "git:status: branch + ↑3 ↓0", `${st.branch} ${st.upstream} ${st.ahead}/${st.behind}`);
  ok(st.files?.length === 2, "git:status: 2 file belum di-commit");
  const noStage = await c.call({ type: "git:commit", ...repo, message: "x" }, (m) => m.type === "git:committed");
  ok(noStage.type === "error" && /stage/i.test(noStage.error), "git:commit ditolak tanpa file staged");
  const st2 = await c.call({ type: "git:stage", ...repo, paths: ["README.md"], on: true }, (m) => m.type === "git:status");
  ok(st2.files?.find((x) => x.path === "README.md")?.x === "M", "git:stage menandai README.md staged");
  const empty = await c.call({ type: "git:commit", ...repo, message: "   " }, (m) => m.type === "git:committed");
  ok(empty.type === "error" && /kosong/.test(empty.error), "git:commit ditolak kalau pesan kosong");
  const diff = await c.call({ type: "git:fileDiff", ...repo, path: "baru.txt" }, (m) => m.type === "git:fileDiff");
  ok(diff.patch?.includes("+baru"), "git:fileDiff untuk file untracked");
  const done = await c.call({ type: "git:commit", ...repo, message: "fix: readme wip" }, (m) => m.type === "git:committed");
  ok(done.type === "git:committed" && g(REPO, "log", "-1", "--format=%s") === "fix: readme wip", "git:commit membuat commit di repo");
  const decisions = existsSync(join(APPDATA, "ade", "decisions.jsonl")) ? readFileSync(join(APPDATA, "ade", "decisions.jsonl"), "utf8") : "";
  ok(decisions.includes('"git-commit"') && decisions.includes(done.hash || "?"), "commit tercatat di decisions.jsonl");
  const show = await c.call({ type: "git:show", ...repo, hash: log.commits[0].hash }, (m) => m.type === "git:show");
  ok(show.files?.some((x) => x.path === "coa.txt" && x.status === "A"), "git:show merge: file dari branch fitur");

  // Brain Vault — hanya kalau vault + repo simlab-v2-fe terdaftar ada di laptop ini
  const reg = (() => { try { return JSON.parse(readFileSync(join(process.env.USERPROFILE || "", ".claude", "project-registry.json"), "utf8")).projects || {}; } catch { return {}; } })();
  const fe = reg["simlab-v2-fe"]?.path;
  if (existsSync("D:\\HSD\\brain-vault") && fe && existsSync(fe)) {
    const v = await c.call({ type: "vault:lookup", repo: fe, path: "app/Http/Controllers/transaction/CoaController.php" }, (m) => m.type === "vault");
    ok(v.info?.hotspot === true && v.info.bugCount > 0, "vault:lookup: CoaController = hotspot", JSON.stringify(v.info)?.slice(0, 120));
    const none = await c.call({ type: "vault:lookup", ...repo, path: "README.md" }, (m) => m.type === "vault");
    ok(none.info === null, "vault:lookup: repo non-simlab → null");
  } else skip("vault:lookup", "brain-vault / simlab-v2-fe tidak ada di laptop ini");

  c.ws.close();
}

// ---------- 3. UI lewat Edge headless ----------
function serveUi(port) {
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png" };
  const shim = `<script>window.__TAURI__={core:{invoke:async()=>({port:${port},token:"${TOKEN}"})}};try{localStorage.clear()}catch{}</script>`;
  const server = createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "") || "index.html";
    const file = resolve(ROOT, "src", rel);
    if (!file.startsWith(resolve(ROOT, "src")) || !existsSync(file)) { res.writeHead(404); return res.end(); }
    let body = readFileSync(file);
    if (rel === "index.html") body = body.toString().replace('<script type="module"', `${shim}<script type="module"`);
    res.writeHead(200, { "content-type": types[extname(file)] || "application/octet-stream" });
    res.end(body);
  });
  return new Promise((r) => server.listen(0, "127.0.0.1", () => r(server)));
}

async function uiTests(sidecarPort) {
  console.log("\nUI (Edge headless)");
  if (NO_UI) return skip("tes UI", "--no-ui");
  if (!EDGE) return skip("tes UI", "Microsoft Edge tidak ditemukan");
  const server = await serveUi(sidecarPort);
  const url = `http://127.0.0.1:${server.address().port}/`;
  const profile = join(BASE, "edge");
  const edge = spawn(EDGE, ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", url], { stdio: "ignore" });
  try {
    let portFile = join(profile, "DevToolsActivePort");
    for (let i = 0; i < 60 && !existsSync(portFile); i++) await sleep(250);
    const devPort = readFileSync(portFile, "utf8").split("\n")[0].trim();
    let page;
    for (let i = 0; i < 40 && !page; i++) {
      page = (await (await fetch(`http://127.0.0.1:${devPort}/json`)).json()).find((t) => t.type === "page" && t.url.startsWith(url));
      if (!page) await sleep(250);
    }
    const cdp = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((r) => cdp.on("open", r));
    let id = 0;
    const pending = new Map();
    const errors = [];
    cdp.on("message", (raw) => {
      const m = JSON.parse(raw);
      if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
      if (m.method === "Runtime.exceptionThrown") errors.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    });
    const cmd = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); cdp.send(JSON.stringify({ id: i, method, params })); });
    const ev = async (expr) => (await cmd("Runtime.evaluate", { expression: expr, returnByValue: true })).result?.result?.value;
    const until = async (expr, ms = 8000) => { for (let t = 0; t < ms; t += 200) { if (await ev(expr)) return true; await sleep(200); } return false; };

    await cmd("Runtime.enable");
    await cmd("Emulation.setDeviceMetricsOverride", { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false });
    await cmd("Page.reload");
    ok(await until(`[...document.querySelectorAll('.folder')].some(b=>b.title.endsWith('demo-repo'))`), "kolom Folder memuat repo dummy");
    await ev(`[...document.querySelectorAll('.folder')].find(b=>b.title.endsWith('demo-repo')).click()`);
    ok(await until(`document.querySelectorAll('#ex-tree .ex-item').length>0`), "pohon file tampil untuk repo terpilih");
    await ev(`[...document.querySelectorAll('#ex-tree .ex-item.dir')].find(b=>b.title==='app').click()`);
    await until(`[...document.querySelectorAll('#ex-tree .ex-item.dir')].some(b=>b.title==='app/Http')`);
    await ev(`[...document.querySelectorAll('#ex-tree .ex-item.dir')].find(b=>b.title==='app/Http').click()`);
    await until(`[...document.querySelectorAll('#ex-tree .ex-item')].some(b=>b.title.endsWith('OrderController.php'))`);
    await ev(`[...document.querySelectorAll('#ex-tree .ex-item')].find(b=>b.title.endsWith('OrderController.php')).click()`);
    ok(await until(`document.querySelectorAll('#chg-body pre.code > span').length===6`), "file dibuka dengan nomor baris");
    ok(await ev(`!!document.querySelector('#chg-body .hl-k') && !!document.querySelector('#chg-body .hl-v') && !!document.querySelector('#chg-body .hl-c')`), "syntax highlighting PHP (keyword, variabel, komentar)");
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "f", code: "KeyF", windowsVirtualKeyCode: 70, modifiers: 2 });
    ok(await until(`!!document.querySelector('#chg-body .find-input')`), "Ctrl+F membuka kotak cari");
    await cmd("Input.insertText", { text: "function" });
    ok(await until(`document.querySelector('.find-count')?.textContent==='1/1' && !!document.querySelector('pre.code > span.hit-cur')`), "cari di file menandai baris yang cocok");

    await ev(`document.querySelector('.col-tab[data-tab=git]').click()`);
    ok(await until(`document.querySelectorAll('.git-row').length===5`), "tab Git: graph 5 commit (termasuk commit dari tes protokol)");
    ok(await until(`document.getElementById('git-branch').textContent.includes('↑4')`), "tab Git: indikator ahead ↑4", await ev(`document.getElementById('git-branch').textContent`));
    ok(await ev(`document.querySelectorAll('.git-row svg circle').length===5`), "graph menggambar node tiap commit");
    await ev(`document.querySelectorAll('.focus-btn')[2].click()`);
    ok(await ev(`[...document.querySelectorAll('.ade>.col')].filter(c=>c.offsetWidth>0).length===1`), "mode fokus: hanya 1 kartu tampil");
    await cmd("Input.dispatchKeyEvent", { type: "keyDown", key: "Escape", code: "Escape", windowsVirtualKeyCode: 27 });
    ok(await until(`[...document.querySelectorAll('.ade>.col')].filter(c=>c.offsetWidth>0).length===4`), "Esc keluar dari mode fokus");

    await ev(`document.getElementById('term-toggle').click()`);
    ok(await until(`/PS .*demo-repo>/.test(document.querySelector('.xterm-rows')?.innerText||'')`, 10000), "terminal terbuka di folder repo");
    ok(errors.length === 0, "tidak ada error JavaScript di halaman", errors.join(" | "));
    cdp.close();
  } finally {
    server.close();
    try { execFileSync("taskkill", ["/PID", String(edge.pid), "/T", "/F"], { stdio: "ignore" }); } catch {}
  }
}

// ---------- main ----------
let sidecar;
try {
  makeRepo();
  console.log(`Repo dummy: ${REPO}`);
  sidecar = await startSidecar();
  await protocolTests(sidecar.port);
  await uiTests(sidecar.port);
} catch (e) {
  failed++;
  console.log(`  ✗ tes berhenti: ${e.stack || e}`);
} finally {
  sidecar?.child.stdin.end(); // sidecar keluar sendiri saat stdin tertutup (mematikan shell & agent)
  await sleep(1500);
  try { rmSync(BASE, { recursive: true, force: true }); } catch {}
  console.log(`\n${passed} lulus, ${failed} gagal, ${skipped} dilewati`);
  process.exit(failed ? 1 : 0);
}
