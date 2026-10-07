import { dueLabel, parseDue } from "./todo-parse.js";

const $ = (id) => document.getElementById(id);

const state = {
  groups: [], selectedId: null, collapsed: new Set(), tasks: [], permissions: [],
  reviewId: null,     // task yang tampil di kolom Perubahan
  diffs: new Map(),   // taskId -> hasil task:diff terakhir
};
const allProjects = () => state.groups.flatMap((g) => g.items);
const ACTIVE = new Set(["starting", "running", "waiting"]);
const normPath = (p) => (p || "").replaceAll("/", "\\").replace(/\\+$/, "").toLowerCase();
const agentsFor = (path) => state.tasks.filter((t) => ACTIVE.has(t.status) && normPath(t.repoPath) === normPath(path)).length;
const selectedProject = () => allProjects().find((f) => f.id === state.selectedId) || null;
let ws;

// ---------- sidecar connection ----------
// Port acak + token sesi dibagikan shell Tauri; sidecar menolak koneksi tanpa token.
async function connect() {
  const info = await window.__TAURI__.core.invoke("sidecar_info");
  if (!info) { // sidecar belum mengumumkan ADE_READY
    setSidecar("menunggu sidecar…", false);
    return setTimeout(connect, 300);
  }
  ws = new WebSocket(`ws://127.0.0.1:${info.port}/?token=${encodeURIComponent(info.token)}`);
  ws.onopen = () => { setSidecar("terhubung", true); request({ type: "folders:list" }); };
  ws.onclose = () => {
    setSidecar("terputus — mencoba lagi…", false);
    termsLost(); // shell hidup di sidecar — ikut mati saat koneksi putus
    setTimeout(connect, 1000);
  };
  ws.onmessage = (e) => handle(JSON.parse(e.data));
}

function request(msg) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
}

function handle(m) {
  if (m.type === "folders") {
    state.groups = m.groups;
    if (!allProjects().some((f) => f.id === state.selectedId)) state.selectedId = allProjects()[0]?.id ?? null;
    renderFolders();
    if (!state.reviewId) renderChanges(); // pohon file mengikuti project terpilih
    if (pendingAdd) { pendingAdd = false; closeAddForm(); }
  } else if (m.type === "tasks") {
    state.tasks = m.tasks;
    state.permissions = m.permissions;
    syncReview();
    renderFolders();
    renderTasks();
    renderPermissions();
    if (!chg.revising) renderChanges(); // jangan hapus catatan revisi yang sedang diketik
  } else if (m.type === "todos") {
    handleTodos(m);
  } else if (m.type === "auth") {
    renderAuth(m);
  } else if (m.type === "file") {
    chg.fileError = null;
    chg.fileCache.set(`${m.key}:${m.path}`, m);
    if (m.key === fsTarget()?.key && !chg.revising) renderChanges();
  } else if (m.type === "found") {
    if (m.key === fsTarget()?.key && m.q === $("ex-filter").value.trim()) { ex.found = m.items; renderTree(); }
  } else if (m.type === "vault") {
    chg.vault.set(`${m.key}|${m.path}`, m.info);
    if (m.info && m.key === fsTarget()?.key && !chg.revising) renderChanges();
  } else if (m.type === "dir") {
    ex.error = null;
    ex.dirs.set(`${m.key}|${m.dir}`, m);
    ex.pending.delete(`${m.key}|${m.dir}`);
    if (m.key === fsTarget()?.key) renderTree();
  } else if (m.type === "error" && (m.scope === "fs:list" || m.scope === "fs:find")) {
    ex.pending.clear();
    ex.error = m.error;
    renderTree();
  } else if (m.type === "error" && m.scope === "fs:read") {
    chg.fileError = m.error;
    renderChanges();
  } else if (m.type.startsWith("git:") || (m.type === "error" && m.scope?.startsWith("git:"))) {
    handleGit(m);
  } else if (m.type.startsWith("term:") || (m.type === "error" && m.scope === "term:open")) {
    handleTerm(m);
  } else if (m.type === "diff") {
    state.diffs.set(m.id, m);
    chg.busy = false; // balasan approve juga berupa diff
    // diff baru = agent mungkin mengubah file lagi → isi file yang di-cache sudah basi
    for (const k of chg.fileCache.keys()) if (k.startsWith(`${m.id}:`)) chg.fileCache.delete(k);
    if (m.id === state.reviewId) {
      refreshTree(); // status A/M/D di pohon ikut berubah
      if (gitv.tab === "git") request({ type: "git:status", id: m.id });
    }
    if (m.id === state.reviewId && !chg.revising) renderChanges();
  } else if (m.type === "error" && ["task:approve", "task:revise", "task:cleanup", "task:diff"].includes(m.scope)) {
    chg.busy = false;
    chg.error = m.error;
    renderChanges();
  } else if (m.type === "task:created") {
    closeTaskForm();
    selectReview(m.id);
  } else if (m.type === "error" && m.scope === "task:create") {
    showTaskError(m.error);
  } else if (m.type === "error" && m.scope === "folders:add") {
    pendingAdd = false;
    showAddError(m.error);
  } else if (m.type === "error") {
    console.error("[ADE sidecar]", m.error);
  }
}

function setSidecar(text, ok) {
  $("sidecar-text").textContent = `sidecar ${text}`;
  $("sidecar").classList.toggle("ok", ok);
}

// ---------- folder column ----------
function el(tag, cls, text) {
  const n = document.createElement(tag);
  if (cls) n.className = cls;
  if (text != null) n.textContent = text; // textContent: nama/path tidak pernah dirender sebagai HTML
  return n;
}

function folderMeta(f) {
  if (!f.exists) return { text: "folder tidak ditemukan", cls: "bad" };
  if (!f.isGit) return { text: "bukan repo git", cls: "warn" };
  const parts = [f.branch, f.changed ? `${f.changed} file berubah` : "bersih"];
  if (f.stack) parts.push(f.stack);
  return { text: parts.join(" · "), cls: "" };
}

function renderFolders() {
  const list = $("folder-list");
  list.replaceChildren();
  for (const g of state.groups) {
    if (!g.items.length && !g.missing && !g.removable) continue; // grup kosong bawaan tidak perlu tampil
    list.append(groupHeader(g));
    if (state.collapsed.has(g.id)) continue;
    if (g.missing) list.append(el("div", "group-note bad", "Folder induk tidak ditemukan di disk."));
    for (const f of g.items) list.append(folderItem(f));
  }
  if (!allProjects().length) list.append(el("div", "empty small", "Belum ada project. Tambah folder di bawah."));

  renderHeader();
}

function groupHeader(g) {
  const h = el("button", "group");
  h.title = g.path || "";
  const open = !state.collapsed.has(g.id);
  h.append(el("span", "chev", open ? "▾" : "▸"), el("span", "group-name", g.name), el("span", "group-count", String(g.items.length)));
  if (g.removable) {
    const rm = el("span", "rm", "×");
    rm.title = "Hapus kelompok ini dari ASAP (folder di disk tidak disentuh)";
    rm.addEventListener("click", (e) => { e.stopPropagation(); request({ type: "folders:remove", id: g.id }); });
    h.append(rm);
  }
  h.addEventListener("click", () => {
    open ? state.collapsed.add(g.id) : state.collapsed.delete(g.id);
    saveCollapsed();
    renderFolders();
  });
  return h;
}

function folderItem(f) {
  const item = el("button", "folder" + (f.id === state.selectedId ? " active" : ""));
  item.title = f.path;
  item.addEventListener("click", () => {
    state.selectedId = f.id; saveSelection();
    // klik folder = jelajahi folder itu: kolom Perubahan pindah dari task ke pohon repo ini
    if (state.reviewId) { state.reviewId = null; renderTasks(); }
    renderFolders(); renderTaskTarget(); renderChanges();
    renderTodo(); renderTodoPreview(); // label project & filter Todo ikut project terpilih
  });

  const main = el("div", "folder-main");
  const meta = folderMeta(f);
  main.append(el("span", "folder-name", f.name), el("span", "folder-meta " + meta.cls, meta.text));

  const side = el("div", "folder-side");
  const agents = agentsFor(f.path);
  if (agents) side.append(el("span", "count", `${agents} agent`)); // badge hanya kalau ada agent
  if (f.removable) { // repo tambahan satuan
    const rm = el("span", "rm", "×");
    rm.title = "Hapus dari ASAP (folder di disk tidak disentuh)";
    rm.addEventListener("click", (e) => { e.stopPropagation(); request({ type: "folders:remove", id: f.id }); });
    side.append(rm);
  }
  item.append(svgFolder(), main, side);
  return item;
}

function svgFolder() {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("class", "folder-icon");
  const path = document.createElementNS(ns, "path");
  path.setAttribute("d", "M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z");
  svg.append(path);
  return svg;
}

// pilihan folder terakhir = kenyamanan per-viewer; aman kalau storage tidak tersedia
function saveSelection() {
  try { localStorage.setItem("ade.selectedFolder", state.selectedId ?? ""); } catch {}
}
function saveCollapsed() {
  try { localStorage.setItem("ade.collapsedGroups", JSON.stringify([...state.collapsed])); } catch {}
}
try {
  state.selectedId = localStorage.getItem("ade.selectedFolder") || null;
  state.collapsed = new Set(JSON.parse(localStorage.getItem("ade.collapsedGroups") || "[]"));
} catch {}

// ---------- add folder ----------
let pendingAdd = false;

function openAddForm() {
  $("add-open").hidden = true;
  $("add-form").hidden = false;
  $("add-error").hidden = true;
  $("add-path").focus();
}

function closeAddForm() {
  $("add-form").reset();
  $("add-form").hidden = true;
  $("add-open").hidden = false;
}

function showAddError(text) {
  $("add-error").textContent = text;
  $("add-error").hidden = false;
}

$("add-open").addEventListener("click", openAddForm);
$("add-cancel").addEventListener("click", closeAddForm);
$("add-form").addEventListener("submit", (e) => {
  e.preventDefault();
  $("add-error").hidden = true;
  pendingAdd = true;
  request({ type: "folders:add", path: $("add-path").value, name: $("add-name").value });
});
$("refresh").addEventListener("click", () => request({ type: "folders:list" }));

// ---------- header ----------
function renderHeader() {
  const sel = selectedProject();
  $("running-scope").textContent = `${state.tasks.filter((t) => ACTIVE.has(t.status)).length} agent`;
  $("agents-active").textContent = `${state.tasks.filter((t) => ACTIVE.has(t.status)).length} agent aktif`;
  const needs = state.permissions.length + state.tasks.filter((t) => t.status === "review").length;
  $("review-pill").hidden = needs === 0;
  $("review-pill").textContent = `${needs} perlu perhatian`;
  $("perm-count").textContent = state.permissions.length ? `${state.permissions.length} menunggu` : "";
  $("task-open").disabled = !sel?.isGit;
  $("task-open").title = sel?.isGit ? `Task baru di ${sel.name}` : "Pilih project (repo git) di kolom Folder";
}

// ---------- tasks (Agentic Running) ----------
const STATUS = {
  starting: { label: "Menyiapkan", cls: "run" },
  running: { label: "Running", cls: "run" },
  waiting: { label: "Menunggu izin", cls: "warn" },
  review: { label: "Need review", cls: "warn" },
  // sesi tetap terbuka setelah agent menjawab — dev bisa lanjut chat kapan saja
  done: { label: "Menunggu instruksi", cls: "idle" },
  stopped: { label: "Dihentikan · bisa lanjut", cls: "muted" },
  interrupted: { label: "Terputus · bisa lanjut", cls: "muted" },
  error: { label: "Error", cls: "bad" },
  approved: { label: "Approved · bisa lanjut", cls: "ok" },
};
const MODEL_LABEL = { "claude-sonnet-5-5": "Sonnet", "claude-opus-5-5": "Opus", "claude-haiku-4-5-20251001": "Haiku" };
const drafts = new Map(); // taskId -> pesan chat yang sedang diketik (bertahan saat render ulang)

function renderTasks() {
  const list = $("task-list");
  // simpan posisi scroll thread & fokus kotak pesan — render ulang terjadi tiap ada update agent
  const oldThread = list.querySelector(".thread");
  const stick = !oldThread || oldThread.scrollHeight - oldThread.scrollTop - oldThread.clientHeight < 40;
  const oldTop = oldThread?.scrollTop ?? 0;
  const input = list.querySelector(".composer textarea");
  const focused = input && document.activeElement === input ? { start: input.selectionStart, end: input.selectionEnd } : null;

  list.replaceChildren();
  if (!state.tasks.length) {
    const empty = el("div", "empty");
    empty.append(el("strong", null, "Belum ada agent."), el("span", null, "Pilih project di kolom Folder lalu klik + Task."));
    list.append(empty);
  }
  for (const t of state.tasks) list.append(taskCard(t));

  const thread = list.querySelector(".thread");
  if (thread) thread.scrollTop = stick ? thread.scrollHeight : oldTop;
  const newInput = list.querySelector(".composer textarea");
  if (focused && newInput) { newInput.focus(); newInput.setSelectionRange(focused.start, focused.end); }
  renderHeader();
}

function taskCard(t) {
  const st = STATUS[t.status] || { label: t.status, cls: "muted" };
  const open = t.id === state.reviewId;
  const card = el("article", `task ${st.cls}` + (open ? " selected" : ""));
  if (!open) {
    card.title = "Klik untuk membuka chat & perubahannya";
    card.addEventListener("click", (e) => { if (!e.target.closest("button")) selectReview(t.id); });
  }

  const head = el("div", "task-head");
  head.append(el("strong", "task-title", t.title), el("span", `badge ${st.cls}`, st.label));
  card.append(head);
  card.append(el("div", "task-sub", `${t.projectName} · ${MODEL_LABEL[t.model] || t.model} · ${t.branch}`));
  card.append(el("div", "task-activity", t.activity || ""));

  if (open) card.append(chatThread(t), composer(t));
  else {
    const last = t.status === "error" && t.error ? t.error : t.lastText;
    if (last) card.append(el("div", "task-text", last));
  }

  const actions = el("div", "task-actions");
  if (ACTIVE.has(t.status)) {
    const stop = el("button", "ghost small", "Hentikan agent");
    stop.addEventListener("click", () => request({ type: "task:stop", id: t.id }));
    actions.append(stop);
  } else {
    const forget = el("button", "ghost small", "Hapus dari daftar");
    forget.title = "Hanya menghapus catatan task di ADE. Worktree & branch di disk tetap ada.";
    forget.addEventListener("click", () => request({ type: "task:forget", id: t.id }));
    actions.append(forget);
  }
  if (t.costUsd != null) actions.append(el("span", "task-cost", `~$${t.costUsd.toFixed(2)}`));
  card.append(actions);
  return card;
}

const ROLE_LABEL = { user: "Kamu", assistant: "Claude" };
function chatThread(t) {
  const thread = el("div", "thread");
  for (const m of t.messages || []) {
    if (m.role === "tool") { thread.append(el("div", "msg tool", `▸ ${m.text}`)); continue; }
    if (m.role === "system") { thread.append(el("div", "msg system", m.text)); continue; }
    const bubble = el("div", `msg ${m.role}` + (m.queued ? " queued" : ""));
    bubble.append(el("div", "who", ROLE_LABEL[m.role] + (m.queued ? " · antre, dikirim setelah agent selesai" : "")), el("div", "text", m.text));
    thread.append(bubble);
  }
  if (ACTIVE.has(t.status)) thread.append(el("div", "msg system typing", "agent sedang bekerja…"));
  return thread;
}

function composer(t) {
  const box = el("div", "composer");
  const input = el("textarea");
  input.rows = 2;
  input.value = drafts.get(t.id) || "";
  input.disabled = !!t.worktreeRemoved;
  input.placeholder = t.worktreeRemoved ? "Worktree sudah dibersihkan — buat task baru untuk melanjutkan."
    : ACTIVE.has(t.status) ? "Agent sedang bekerja — pesanmu diantre dan dikirim setelah selesai."
    : "Lanjutkan chat di sesi yang sama… (Enter kirim, Shift+Enter baris baru)";
  const sendBtn = el("button", "primary small", ACTIVE.has(t.status) ? "Antre" : "Kirim");
  sendBtn.disabled = input.disabled;
  const submit = () => {
    const text = input.value.trim();
    if (!text) return input.focus();
    drafts.delete(t.id);
    input.value = "";
    request({ type: "task:send", id: t.id, text });
  };
  input.addEventListener("input", () => drafts.set(t.id, input.value));
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) { e.preventDefault(); submit(); }
  });
  sendBtn.addEventListener("click", submit);
  box.append(input, sendBtn);
  return box;
}

// ---------- form task baru ----------
function renderTaskTarget() {
  const sel = selectedProject();
  $("task-target").textContent = sel ? `${sel.name} · dari ${sel.branch || "?"}` : "—";
  renderHeader();
}

function openTaskForm() {
  renderTaskTarget();
  $("task-form").hidden = false;
  $("task-open").hidden = true;
  $("task-error").hidden = true;
  $("task-title").focus();
}

function closeTaskForm() {
  $("task-form").reset();
  $("task-form").hidden = true;
  $("task-open").hidden = false;
  $("task-submit").disabled = false;
}

function showTaskError(text) {
  $("task-error").textContent = text;
  $("task-error").hidden = false;
  $("task-submit").disabled = false;
}

$("task-open").addEventListener("click", openTaskForm);
$("task-cancel").addEventListener("click", closeTaskForm);
$("task-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const sel = selectedProject();
  if (!sel) return showTaskError("Pilih project dulu di kolom Folder.");
  $("task-error").hidden = true;
  $("task-submit").disabled = true; // cegah dobel klik saat worktree sedang dibuat
  request({
    type: "task:create", repoPath: sel.path, projectName: sel.name,
    title: $("task-title").value, prompt: $("task-prompt").value, model: $("task-model").value,
  });
});

// ---------- Saran Claude (izin aksi agent) ----------
let permKey = null;
function renderPermissions() {
  // render ulang hanya kalau daftar izin berubah — supaya alasan tolak yang sedang diketik tidak hilang
  const key = state.permissions.map((p) => p.id).join(",");
  if (key === permKey) return renderHeader();
  permKey = key;
  const list = $("perm-list");
  list.replaceChildren();
  if (!state.permissions.length) {
    const empty = el("div", "empty");
    empty.append(el("strong", null, "Tidak ada izin yang menunggu."), el("span", null, "Agent meminta izin di sini sebelum mengedit file atau menjalankan perintah."));
    list.append(empty);
  }
  for (const p of state.permissions) list.append(permCard(p));
  list.append(el("div", "perm-note", "Setiap keputusan Setuju / Tolak dicatat ke %APPDATA%\\ade\\decisions.jsonl. Edit di luar worktree ditolak otomatis."));
  renderHeader();
}

function permCard(p) {
  const card = el("article", "perm");
  card.append(el("div", "perm-task", `${p.projectName} · ${p.taskTitle}`));
  card.append(el("strong", "perm-title", p.title));
  const detail = el("pre", `perm-detail ${p.kind}`);
  for (const line of p.detail.split("\n")) {
    const cls = p.kind === "diff" ? (line.startsWith("+ ") ? "add" : line.startsWith("- ") ? "del" : "") : "";
    detail.append(el("span", cls, line + "\n"));
  }
  card.append(detail);

  const reason = el("input", "perm-reason");
  reason.placeholder = "Alasan tolak (opsional, dikirim ke agent)";
  const row = el("div", "row");
  const yes = el("button", "approve", "Setuju");
  const no = el("button", "ghost", "Tolak");
  yes.addEventListener("click", () => { yes.disabled = no.disabled = true; request({ type: "perm:decide", id: p.id, allow: true }); });
  no.addEventListener("click", () => { yes.disabled = no.disabled = true; request({ type: "perm:decide", id: p.id, allow: false, reason: reason.value.trim() }); });
  row.append(yes, no);
  card.append(reason, row);
  return card;
}

// ---------- login Claude ----------
let authPoll = null;
function renderAuth(a) {
  const pill = $("auth-pill");
  pill.hidden = false;
  pill.classList.toggle("warn", !a.loggedIn);
  pill.disabled = a.loggedIn;
  if (a.loggedIn) {
    pill.replaceChildren(el("span", "dot ok-dot"), el("span", null, "Claude login"));
    pill.title = a.method;
    clearInterval(authPoll); authPoll = null;
  } else {
    pill.textContent = "Belum login Claude — klik untuk login";
    pill.title = "Membuka jendela login Claude (claude auth login). Setelah selesai, status di sini diperbarui otomatis.";
    // cek ulang berkala sampai login selesai di jendela terpisah
    authPoll ??= setInterval(() => request({ type: "auth:status" }), 4000);
  }
}
$("auth-pill").addEventListener("click", () => request({ type: "auth:login" }));

// ---------- Perubahan (diff + Approve / Minta revisi / Bersihkan) ----------
const chg = {
  // key = taskId (worktree task) atau `repo:<path>` (repo dari kolom Folder)
  file: new Map(),       // key -> path yang sedang dibuka
  view: new Map(),       // key -> "diff" | "file" untuk file yang berubah
  extra: new Map(),      // key -> [path] file lain yang dibuka dari pohon (read-only)
  fileCache: new Map(),  // `${key}:${path}` -> isi file
  fileError: null,
  revising: false, confirmCleanup: false, busy: false, error: null,
  find: { open: false, q: "", idx: 0 }, // Ctrl+F di file / diff
  vault: new Map(),      // `${key}|${path}` -> info Brain Vault (null = tidak ada note)
  vaultOpen: new Set(),  // panel vault yang dibuka
};
const lastStatus = new Map(); // taskId -> status terakhir, untuk tahu kapan diff perlu diambil ulang

function selectReview(id) {
  if (state.reviewId !== id) Object.assign(chg, { revising: false, confirmCleanup: false, error: null });
  state.reviewId = id;
  request({ type: "task:diff", id });
  renderTasks();
  renderChanges();
}

/** Ambil ulang diff saat status task berubah; pilih otomatis task yang baru siap direview. */
function syncReview() {
  for (const t of state.tasks) {
    const prev = lastStatus.get(t.id);
    lastStatus.set(t.id, t.status);
    if (prev === undefined || prev === t.status) continue;
    if (t.id === state.reviewId) { chg.busy = false; request({ type: "task:diff", id: t.id }); }
    else if (t.status === "review" && !state.tasks.some((x) => x.id === state.reviewId && x.status === "review")) selectReview(t.id);
  }
  if (state.reviewId && !state.tasks.some((t) => t.id === state.reviewId)) state.reviewId = null;
}

/** Root penjelajah file: worktree task yang direview, atau repo yang dipilih di kolom Folder. */
function fsTarget() {
  const t = state.tasks.find((x) => x.id === state.reviewId);
  if (t) return t.worktreeRemoved ? null : { key: t.id, msg: { id: t.id }, label: `worktree · ${t.title}`, path: t.worktree };
  const sel = selectedProject();
  return sel?.exists ? { key: `repo:${sel.path}`, msg: { repo: sel.path }, label: sel.name, path: sel.path } : null;
}

function renderChanges() {
  const t = state.tasks.find((x) => x.id === state.reviewId);
  const target = fsTarget();
  const key = t ? t.id : target?.key;
  syncCol3(target);
  const body = $("chg-body"), tabs = $("chg-tabs"), foot = $("chg-foot");
  const prevScroll = body.scrollTop;
  // kotak Cari ikut dibuat ulang: simpan fokus & posisi kursornya
  const oldFind = body.querySelector(".find-input");
  const findFocus = oldFind && document.activeElement === oldFind ? { s: oldFind.selectionStart, e: oldFind.selectionEnd } : null;
  body.replaceChildren(); tabs.replaceChildren(); foot.replaceChildren();
  $("chg-title").textContent = t ? `Perubahan · ${t.title}` : target ? `Jelajah · ${target.label}` : "Perubahan";
  $("chg-status").textContent = t ? (STATUS[t.status]?.label || t.status) : "";
  $("chg-status").className = "hd-right" + (t?.status === "review" ? " amber" : "");

  renderExplorer(target);
  if (!key) {
    tabs.hidden = foot.hidden = true;
    const empty = el("div", "empty");
    empty.append(el("strong", null, "Belum ada yang dibuka."), el("span", null, "Pilih project di kolom Folder untuk menjelajah file, atau klik kartu task untuk melihat diff-nya."));
    return body.append(empty);
  }

  const d = t ? state.diffs.get(t.id) : null;
  const files = d?.files || [];
  const extra = (chg.extra.get(key) || []).filter((p) => !files.some((f) => f.path === p));
  const want = chg.file.get(key);
  const current = files.find((f) => f.path === want) || (extra.includes(want) ? { path: want, extra: true } : files[0]);

  tabs.hidden = files.length + extra.length === 0;
  for (const f of files) {
    const tab = el("button", "tab" + (current && f.path === current.path ? " active" : ""));
    tab.title = f.path;
    tab.append(el("span", `fstat s-${f.status}`, f.status), el("span", "tab-name", f.path.split("/").pop()));
    if (!f.binary) tab.append(el("span", "tab-num", `+${f.additions} −${f.deletions}`));
    tab.addEventListener("click", () => { chg.file.set(key, f.path); renderChanges(); });
    tabs.append(tab);
  }
  for (const p of extra) { // file yang dibuka dari pohon / filter — hanya dibaca
    const tab = el("button", "tab view" + (current?.path === p ? " active" : ""));
    tab.title = `${p} (hanya lihat)`;
    const close = el("span", "tab-x", "×");
    close.title = "Tutup";
    close.addEventListener("click", (e) => {
      e.stopPropagation();
      chg.extra.set(key, (chg.extra.get(key) || []).filter((x) => x !== p));
      if (chg.file.get(key) === p) chg.file.delete(key);
      renderChanges();
    });
    tab.append(el("span", "fstat", "👁"), el("span", "tab-name", p.split("/").pop()), close);
    tab.addEventListener("click", () => { chg.file.set(key, p); renderChanges(); });
    tabs.append(tab);
  }

  if (t && !d) body.append(el("div", "empty small", "Memuat diff…"));
  else if (!current) {
    const msg = !t ? "Pilih file di pohon di atas untuk melihat isinya."
      : t.worktreeRemoved ? "Worktree sudah dibersihkan."
      : t.status === "approved" ? `Semua perubahan sudah di-commit (${t.commitHash?.slice(0, 8)}) di ${t.branch}. Pilih file di pohon untuk melihat isinya.`
      : ACTIVE.has(t.status) ? "Agent masih bekerja — diff muncul saat ada perubahan."
      : "Tidak ada perubahan file. Pilih file di pohon untuk melihat isinya.";
    body.append(el("div", "empty small", msg));
  } else {
    // file berubah: Diff / File lengkap; file tambahan: selalu File lengkap
    const mode = current.extra ? "file" : chg.view.get(key) || "diff";
    const bar = el("div", "view-bar");
    bar.append(el("span", "diff-path", current.path));
    const badge = target && vaultBadge(target, current.path);
    if (badge) bar.append(badge);
    const findBtn = el("button", "seg" + (chg.find.open ? " on" : ""), "⌕ Cari");
    findBtn.title = "Cari di file (Ctrl+F)";
    findBtn.addEventListener("click", () => { chg.find.open = !chg.find.open; renderChanges(); $("chg-body").querySelector(".find-input")?.focus(); });
    bar.append(findBtn);
    if (!current.extra) {
      for (const [m, label] of [["diff", "Diff"], ["file", "File lengkap"]]) {
        const b = el("button", "seg" + (mode === m ? " on" : ""), label);
        b.disabled = m === "file" && current.status === "D";
        b.title = b.disabled ? "File ini dihapus agent" : "";
        b.addEventListener("click", () => { chg.view.set(key, m); renderChanges(); });
        bar.append(b);
      }
    }
    body.append(bar);
    const panel = target && vaultPanel(target, current.path);
    if (panel) body.append(panel);
    if (chg.find.open) body.append(findBar());
    if (mode === "diff") {
      if (current.binary) body.append(el("div", "empty small", "File biner — tidak ditampilkan."));
      else renderPatch(body, current.patch, langOf(current.path));
      if (current.truncated) body.append(el("div", "empty small", "Diff dipotong (terlalu besar)."));
    } else renderFileView(body, target, current.path);
    // render ulang tiap update agent: jangan lompatkan scroll kalau yang dilihat masih sama
    const viewKey = `${key}|${current.path}|${mode}`;
    if (viewKey === chg.viewKey) body.scrollTop = prevScroll;
    chg.viewKey = viewKey;
    applyFind(false);
    if (findFocus) { const inp = body.querySelector(".find-input"); inp?.focus(); inp?.setSelectionRange(findFocus.s, findFocus.e); }
  }
  if (t) renderChangeActions(t, files, foot);
  else foot.hidden = true;
}

/** Isi lengkap file (dengan nomor baris). Diambil dari sidecar sekali, lalu di-cache. */
function renderFileView(body, target, path) {
  if (!target) return body.append(el("div", "empty small", "Worktree sudah dibersihkan."));
  const f = chg.fileCache.get(`${target.key}:${path}`);
  if (!f) {
    request({ type: "fs:read", ...target.msg, path });
    return body.append(el("div", "empty small", chg.fileError || "Memuat file…"));
  }
  if (f.missing) return body.append(el("div", "empty small", "File tidak ada di disk (dihapus)."));
  if (f.binary) return body.append(el("div", "empty small", `File biner (${Math.round(f.size / 1024)} KB) — tidak ditampilkan.`));
  // DOM hasil highlight disimpan bersama cache file: render ulang (tiap update agent) tidak menghitung ulang
  if (!f.pre) {
    const lang = f.content.length <= HL_FILE_MAX ? langOf(path) : null;
    const state = {};
    f.pre = el("pre", "patch code");
    f.content.replace(/\r\n/g, "\n").split("\n").forEach((line, i) => {
      const row = el("span");
      row.append(el("i", "ln", String(i + 1)));
      appendCode(row, line, lang, state);
      row.append(document.createTextNode("\n"));
      f.pre.append(row);
    });
  }
  body.append(f.pre);
  if (f.truncated) body.append(el("div", "empty small", "File dipotong di 1 MB."));
}

// ---------- pohon file (penjelajah) ----------
const ex = {
  open: new Map(),     // key -> Set folder yang terbuka ("" = root)
  dirs: new Map(),     // `${key}|${dir}` -> isi folder dari sidecar
  pending: new Set(),  // `${key}|${dir}` yang sedang diminta
  found: null,         // hasil filter (null = tampilkan pohon)
  hidden: false, error: null, lastKey: null,
};
try { ex.hidden = localStorage.getItem("ade.treeHidden") === "1"; } catch {}

const openDirs = (key) => ex.open.get(key) || ex.open.set(key, new Set([""])).get(key);

function loadDir(target, dir) {
  const k = `${target.key}|${dir}`;
  if (ex.pending.has(k)) return;
  ex.pending.add(k);
  request({ type: "fs:list", ...target.msg, dir });
}

/** Muat ulang folder yang terbuka; isi lama tetap tampil sampai yang baru datang (tidak berkedip). */
function refreshTree() {
  const target = fsTarget();
  if (!target) return;
  for (const dir of openDirs(target.key)) loadDir(target, dir);
}

function renderExplorer(target) {
  $("explorer").hidden = !target;
  if (!target) return;
  $("ex-label").textContent = target.label;
  $("ex-toggle").title = target.path;
  $("ex-chev").textContent = ex.hidden ? "▸" : "▾";
  $("ex-pane").hidden = ex.hidden;
  if (ex.lastKey !== target.key) { // ganti root: filter lama tidak berlaku
    ex.lastKey = target.key;
    $("ex-filter").value = "";
    ex.found = null; ex.error = null;
  }
  renderTree(target);
}

function renderTree(target = fsTarget()) {
  const box = $("ex-tree");
  const top = box.scrollTop;
  box.replaceChildren();
  if (!target || ex.hidden) return;
  if (ex.error) box.append(el("div", "err ex-msg", ex.error));
  const active = chg.file.get(target.key);
  if (ex.found) {
    if (!ex.found.length) box.append(el("div", "muted ex-msg", "Tidak ada file yang cocok."));
    for (const p of ex.found) {
      const b = el("button", "ex-item" + (p === active ? " active" : ""));
      const slash = p.lastIndexOf("/");
      b.title = p;
      b.append(el("span", "ex-name", p.slice(slash + 1)), el("span", "ex-dir", slash > 0 ? p.slice(0, slash) : ""));
      b.addEventListener("click", () => openExtraFile(p));
      box.append(b);
    }
  } else treeLevel(box, target, "", 0, active);
  box.scrollTop = top;
}

function treeLevel(box, target, dir, depth, active) {
  const d = ex.dirs.get(`${target.key}|${dir}`);
  if (!d) {
    loadDir(target, dir);
    const wait = el("div", "muted ex-msg", "memuat…");
    wait.style.paddingLeft = `${22 + depth * 14}px`;
    return box.append(wait);
  }
  const open = openDirs(target.key);
  for (const e of d.entries) {
    const b = el("button", "ex-item" + (e.dir ? " dir" : "") + (e.path === active ? " active" : ""));
    b.style.paddingLeft = `${8 + depth * 14}px`;
    b.title = e.path;
    b.append(el("span", "chev", e.dir ? (open.has(e.path) ? "▾" : "▸") : ""), el("span", "ex-name" + (e.status === "D" ? " gone" : ""), e.name));
    if (e.status) b.append(el("span", `fstat s-${e.status}`, e.dir ? "•" : e.status));
    b.addEventListener("click", () => {
      if (!e.dir) return openExtraFile(e.path);
      open.has(e.path) ? open.delete(e.path) : open.add(e.path);
      renderTree(target);
    });
    box.append(b);
    if (e.dir && open.has(e.path)) treeLevel(box, target, e.path, depth + 1, active);
  }
  if (d.truncated) box.append(el("div", "muted ex-msg", "…folder terlalu besar, sebagian tidak ditampilkan. Pakai filter."));
}

$("ex-toggle").addEventListener("click", () => {
  ex.hidden = !ex.hidden;
  try { localStorage.setItem("ade.treeHidden", ex.hidden ? "1" : "0"); } catch {}
  renderExplorer(fsTarget());
});
$("ex-refresh").addEventListener("click", () => {
  const target = fsTarget();
  if (!target) return;
  for (const k of chg.fileCache.keys()) if (k.startsWith(`${target.key}:`)) chg.fileCache.delete(k);
  for (const k of chg.vault.keys()) if (k.startsWith(`${target.key}|`)) chg.vault.delete(k);
  refreshTree();
  renderChanges();
});
$("ex-term").addEventListener("click", () => openTerminal());

let findTimer = null;
$("ex-filter").addEventListener("input", () => {
  clearTimeout(findTimer);
  const q = $("ex-filter").value.trim();
  const target = fsTarget();
  if (q.length < 2 || !target) { ex.found = null; return renderTree(); }
  findTimer = setTimeout(() => request({ type: "fs:find", ...target.msg, q }), 200);
});
$("ex-filter").addEventListener("keydown", (e) => {
  if (e.key === "Escape") { $("ex-filter").value = ""; ex.found = null; renderTree(); }
  if (e.key === "Enter") $("ex-tree").querySelector(".ex-item:not(.dir)")?.click();
});

function openExtraFile(path) {
  const target = fsTarget();
  if (!target) return;
  const key = target.key;
  const list = chg.extra.get(key) || [];
  if (!list.includes(path)) chg.extra.set(key, [...list, path]);
  chg.fileCache.delete(`${key}:${path}`); // ambil versi terbaru
  chg.fileError = null;
  chg.file.set(key, path);
  renderChanges();
}

function renderPatch(container, patch, lang = null) {
  const pre = el("pre", "patch");
  const lines = patch.split("\n");
  const start = lines.findIndex((l) => l.startsWith("@@")); // header diff --git/index/---/+++ tidak perlu
  let state = {};
  for (const line of lines.slice(start < 0 ? 0 : start)) {
    if (line.startsWith("@@")) { state = {}; pre.append(el("span", "hunk", line + "\n")); continue; }
    const cls = line.startsWith("+") ? "add" : line.startsWith("-") ? "del" : "";
    const row = el("span", cls);
    row.append(document.createTextNode(line.slice(0, 1)));
    appendCode(row, line.slice(1), lang, state);
    row.append(document.createTextNode("\n"));
    pre.append(row);
  }
  container.append(pre);
}

// ---------- syntax highlighting ringan (tanpa library) ----------
const HL_KEYWORDS = {
  php: "abstract and array as break callable case catch class clone const continue declare default do echo else elseif empty enddeclare endfor endforeach endif endswitch endwhile enum extends final finally fn for foreach function global goto if implements include include_once instanceof insteadof interface isset list match namespace new or print private protected public readonly require require_once return static switch throw trait try unset use var while xor yield null true false self parent",
  js: "async await break case catch class const continue debugger default delete do else export extends finally for from function if import in instanceof let new of return static super switch this throw try typeof var void while with yield null true false undefined",
  sql: "select from where and or not in is null join left right inner outer on as group by order having limit offset insert into values update set delete create alter table drop index view primary key foreign references union all distinct case when then else end exists between like asc desc",
  py: "and as assert async await break class continue def del elif else except finally for from global if import in is lambda nonlocal not or pass raise return try while with yield None True False self",
};
HL_KEYWORDS.ts = HL_KEYWORDS.js + " interface type enum implements private public protected readonly declare namespace abstract any number string boolean never unknown";
const HL_EXT = {
  php: "php", js: "js", mjs: "js", cjs: "js", jsx: "js", vue: "js", ts: "ts", tsx: "ts", json: "json",
  css: "css", scss: "css", sql: "sql", py: "py", html: "html", htm: "html", xml: "html", sh: "sh", env: "sh", yml: "yaml", yaml: "yaml",
};
const HL_LINE_MAX = 1000;     // baris lebih panjang (minified) ditampilkan polos
const HL_FILE_MAX = 400_000;  // file lebih besar ditampilkan polos

function langOf(path) {
  const p = (path || "").toLowerCase();
  if (p.endsWith(".blade.php")) return "blade";
  return HL_EXT[p.split(".").pop()] || null;
}
const hlSets = new Map();
function hlKeywords(lang) {
  const k = lang === "blade" ? "php" : lang;
  if (!hlSets.has(k)) hlSets.set(k, new Set((HL_KEYWORDS[k] || "").split(" ").filter(Boolean)));
  return hlSets.get(k);
}

/** Pecah 1 baris jadi token [kelas|null, teks]. state.block = penutup komentar blok yang ditunggu. */
function hlLine(line, lang, state) {
  const out = [];
  let plain = "";
  const flush = () => { if (plain) { out.push([null, plain]); plain = ""; } };
  const tok = (cls, text) => { flush(); if (text) out.push([cls, text]); };
  const kw = hlKeywords(lang);
  const slashCmt = ["php", "blade", "js", "ts"].includes(lang);
  const blockCmt = slashCmt || ["css", "sql", "json"].includes(lang);
  const hashCmt = ["php", "py", "sh", "yaml"].includes(lang);
  const markup = lang === "html" || lang === "blade";
  let i = 0;
  const closeBlock = (close, from) => {
    const e = line.indexOf(close, from);
    if (e < 0) { tok("hl-c", line.slice(i)); state.block = close; i = line.length; return; }
    tok("hl-c", line.slice(i, e + close.length));
    i = e + close.length;
  };
  if (state.block) { const close = state.block; state.block = null; closeBlock(close, 0); }
  while (i < line.length) {
    const ch = line[i], prev = line[i - 1] || "";
    if (lang === "blade" && line.startsWith("{{--", i)) { closeBlock("--}}", i + 4); continue; }
    if (blockCmt && line.startsWith("/*", i)) { closeBlock("*/", i + 2); continue; }
    if (markup && line.startsWith("<!--", i)) { closeBlock("-->", i + 4); continue; }
    if ((slashCmt && line.startsWith("//", i) && prev !== ":") || (hashCmt && ch === "#" && !(lang === "php" && line[i + 1] === "["))
      || (lang === "sql" && line.startsWith("--", i))) { tok("hl-c", line.slice(i)); break; }
    if (ch === '"' || ch === "'" || (ch === "`" && (lang === "js" || lang === "ts"))) {
      let j = i + 1;
      while (j < line.length && line[j] !== ch) j += line[j] === "\\" ? 2 : 1;
      tok("hl-s", line.slice(i, j + 1)); i = j + 1; continue;
    }
    const rest = line.slice(i, i + 80);
    let m;
    if (ch === "$" && (lang === "php" || lang === "blade" || lang === "sh") && (m = /^\$[A-Za-z_]\w*/.exec(rest))) { tok("hl-v", m[0]); i += m[0].length; continue; }
    if (ch === "@" && lang === "blade" && (m = /^@[A-Za-z]\w*/.exec(rest))) { tok("hl-d", m[0]); i += m[0].length; continue; }
    if (ch === "<" && markup && (m = /^<\/?[A-Za-z][\w:.-]*/.exec(rest))) { tok("hl-d", m[0]); i += m[0].length; continue; }
    if (/\d/.test(ch) && !/[\w$]/.test(prev) && (m = /^\d+(\.\d+)?/.exec(rest))) { tok("hl-n", m[0]); i += m[0].length; continue; }
    if (/[A-Za-z_]/.test(ch) && !/[\w$]/.test(prev)) {
      const w = /^[A-Za-z_]\w*/.exec(line.slice(i))[0];
      if (kw.has(lang === "sql" ? w.toLowerCase() : w)) tok("hl-k", w);
      else if (line[i + w.length] === "(") tok("hl-f", w);
      else plain += w;
      i += w.length; continue;
    }
    plain += ch; i++;
  }
  flush();
  return out;
}

function appendCode(parent, line, lang, state) {
  if (!lang || line.length > HL_LINE_MAX) return parent.append(document.createTextNode(line));
  for (const [cls, text] of hlLine(line, lang, state)) parent.append(cls ? el("span", cls, text) : document.createTextNode(text));
}

// ---------- cari di file / diff (Ctrl+F) ----------
function findRows() {
  return [...$("chg-body").querySelectorAll("pre.patch > span")];
}

/** Tandai baris yang memuat kata dicari; `scroll` = lompat ke hasil aktif. */
function applyFind(scroll) {
  const f = chg.find;
  const rows = findRows();
  for (const r of rows) r.classList.remove("hit", "hit-cur");
  const count = $("chg-body").querySelector(".find-count");
  const q = f.q.trim().toLowerCase();
  if (!f.open || !q) { if (count) count.textContent = ""; return; }
  const hits = rows.filter((r) => {
    const ln = r.firstChild?.classList?.contains("ln") ? r.firstChild.textContent.length : 0;
    return r.textContent.slice(ln).toLowerCase().includes(q);
  });
  hits.forEach((r) => r.classList.add("hit"));
  if (!hits.length) { if (count) count.textContent = "0 hasil"; return; }
  f.idx = ((f.idx % hits.length) + hits.length) % hits.length;
  hits[f.idx].classList.add("hit-cur");
  if (count) count.textContent = `${f.idx + 1}/${hits.length}`;
  if (scroll) hits[f.idx].scrollIntoView({ block: "center" });
}

function findBar() {
  const f = chg.find;
  const bar = el("div", "find-bar");
  const input = el("input", "find-input");
  input.placeholder = "Cari di file… (Enter berikutnya, Shift+Enter sebelumnya)";
  input.value = f.q;
  input.addEventListener("input", () => { f.q = input.value; f.idx = 0; applyFind(true); });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Enter") { e.preventDefault(); f.idx += e.shiftKey ? -1 : 1; applyFind(true); }
    if (e.key === "Escape") { e.preventDefault(); f.open = false; renderChanges(); }
  });
  const prev = el("button", "icon-btn", "↑"); prev.title = "Sebelumnya (Shift+Enter)";
  prev.addEventListener("click", () => { f.idx--; applyFind(true); });
  const next = el("button", "icon-btn", "↓"); next.title = "Berikutnya (Enter)";
  next.addEventListener("click", () => { f.idx++; applyFind(true); });
  const close = el("button", "icon-btn", "×"); close.title = "Tutup (Esc)";
  close.addEventListener("click", () => { f.open = false; renderChanges(); });
  bar.append(input, el("span", "find-count"), prev, next, close);
  return bar;
}

window.addEventListener("keydown", (e) => {
  if (!(e.ctrlKey && e.key.toLowerCase() === "f") || e.target.closest?.(".xterm")) return;
  if ($("pane-files").hidden || !findRows().length) return;
  e.preventDefault();
  chg.find.open = true;
  renderChanges();
  const input = $("chg-body").querySelector(".find-input");
  input?.focus(); input?.select();
});

// ---------- info Brain Vault untuk file simlab-v2 ----------
function vaultBadge(target, path) {
  const vk = `${target.key}|${path}`;
  if (!chg.vault.has(vk)) {
    chg.vault.set(vk, undefined); // sedang diminta
    request({ type: "vault:lookup", ...target.msg, path });
  }
  const v = chg.vault.get(vk);
  if (!v || (!v.hotspot && !v.bugCount)) return null;
  const b = el("button", "vault-badge" + (v.hotspot ? " hot" : ""), v.hotspot ? `🔥 hotspot · ${v.bugCount} bug` : `🐞 ${v.bugCount} bug`);
  b.title = "Riwayat bug dari Brain Vault — klik untuk detail";
  b.addEventListener("click", () => { chg.vaultOpen.has(vk) ? chg.vaultOpen.delete(vk) : chg.vaultOpen.add(vk); renderChanges(); });
  return b;
}

function vaultPanel(target, path) {
  const vk = `${target.key}|${path}`;
  const v = chg.vault.get(vk);
  if (!v || !chg.vaultOpen.has(vk)) return null;
  const box = el("div", "vault-panel" + (v.hotspot ? " hot" : ""));
  box.append(el("div", "vault-title", `Brain Vault · ${v.note} (${v.type})`));
  if (v.hotspot) box.append(el("div", "vault-warn", "Hotspot: sering kena bug / ada bug high yang masih open. Konfirmasi dulu sebelum mengubah file ini."));
  box.append(el("div", null, `${v.bugCount} bug tercatat${v.open ? ` · ${v.open} belum fixed` : ""}. Terbaru:`));
  const list = el("ul", "vault-bugs");
  for (const bug of v.bugs) {
    const li = el("li");
    const title = bug.slug.replace(/^wl-\d+-\d+-/, "").replaceAll("-", " ");
    li.title = bug.slug;
    li.append(el("span", "muted", `${bug.date || "?"} · ${bug.severity}/${bug.status} · `), document.createTextNode(title));
    list.append(li);
  }
  box.append(list);
  box.append(el("div", "vault-note",
    `Vault = petunjuk awal, bukan bukti — verifikasi ke source code. Snapshot generate ${v.generated}; ` +
    "bug_count hanya menghitung type bug; severity n/a bukan berarti ringan. Refresh vault: jalankan _generator (lihat CLAUDE.md)."));
  return box;
}


function renderChangeActions(t, files, foot) {
  foot.hidden = false;
  if (chg.error) foot.append(el("div", "err", chg.error));

  if (ACTIVE.has(t.status)) {
    foot.append(el("div", "muted note", "Agent masih bekerja. Approve / revisi tersedia setelah selesai."));
    const refresh = el("button", "ghost small", "Muat ulang diff");
    refresh.addEventListener("click", () => request({ type: "task:diff", id: t.id }));
    return foot.append(refresh);
  }
  if (t.worktreeRemoved) {
    return foot.append(el("div", "muted note", `Worktree dibersihkan. Branch ${t.branch} tetap ada untuk di-merge manual.`));
  }
  if (t.status === "approved" && !files.length) {
    foot.append(el("div", "muted note", `Commit ${t.commitHash?.slice(0, 8)} ada di branch ${t.branch}. Merge ke branch kerja dilakukan manual.`));
    if (!chg.confirmCleanup) {
      const clean = el("button", "ghost block", "Bersihkan worktree");
      clean.addEventListener("click", () => { chg.confirmCleanup = true; renderChanges(); });
      return foot.append(clean);
    }
    foot.append(el("div", "confirm", `Hapus folder ${t.worktree}? Branch ${t.branch} beserta commit-nya tetap ada.`));
    const row = el("div", "row");
    const yes = el("button", "danger", "Ya, hapus folder worktree");
    const no = el("button", "ghost", "Batal");
    yes.disabled = chg.busy;
    yes.addEventListener("click", () => { chg.busy = true; chg.error = null; chg.confirmCleanup = false; request({ type: "task:cleanup", id: t.id }); renderChanges(); });
    no.addEventListener("click", () => { chg.confirmCleanup = false; renderChanges(); });
    row.append(yes, no);
    return foot.append(row);
  }

  if (chg.revising) {
    const note = el("textarea", "revise-input");
    note.rows = 4;
    note.placeholder = "Catatan revisi untuk agent (agent melanjutkan sesi yang sama).";
    const row = el("div", "row");
    const send = el("button", "primary", "Kirim revisi");
    const cancel = el("button", "ghost", "Batal");
    send.addEventListener("click", () => {
      if (!note.value.trim()) return note.focus();
      chg.revising = false; chg.error = null;
      request({ type: "task:revise", id: t.id, feedback: note.value });
    });
    cancel.addEventListener("click", () => { chg.revising = false; renderChanges(); });
    row.append(send, cancel);
    foot.append(note, row);
    return setTimeout(() => note.focus(), 0);
  }

  const row = el("div", "row");
  const approve = el("button", "primary", files.length ? `Approve perubahan (${files.length} file)` : "Approve perubahan");
  approve.disabled = !files.length || chg.busy;
  approve.title = "Commit semua perubahan ke branch task. Merge tetap manual.";
  approve.addEventListener("click", () => { chg.busy = true; chg.error = null; request({ type: "task:approve", id: t.id }); renderChanges(); });
  const revise = el("button", "ghost", "Minta revisi");
  revise.disabled = !t.sessionId || chg.busy;
  revise.addEventListener("click", () => { chg.revising = true; renderChanges(); });
  row.append(approve, revise);
  foot.append(row);
}

// ---------- Terminal (shell milik dev di sidecar — bukan agent, tidak lewat Saran Claude) ----------
const term = {
  list: [],      // { ref, tid, label, cwd, xterm, fit, view, exited }
  active: null,  // ref terminal yang tampil
  seq: 0,
  height: 280,
};
try { term.height = Number(localStorage.getItem("ade.termHeight")) || 280; } catch {}

const XTERM_THEME = {
  background: "#101318", foreground: "#E6E8EB", cursor: "#5AA9FF", selectionBackground: "#24476d",
  black: "#1B1F26", brightBlack: "#4A5361", red: "#FF8A80", green: "#4CC38A", yellow: "#F2A93B",
  blue: "#5AA9FF", magenta: "#C792EA", cyan: "#7FDBCA", white: "#C9CFD8", brightWhite: "#FFFFFF",
};

function showDock(show) {
  $("term-dock").hidden = !show;
  $("term-dock").style.height = `${term.height}px`;
  $("term-toggle").classList.toggle("ok", show);
  if (show) requestAnimationFrame(fitActive);
}

function toggleDock() {
  const show = $("term-dock").hidden;
  showDock(show);
  if (show && !term.list.length) openTerminal();
  else if (show) activeTerm()?.xterm.focus();
}

const activeTerm = () => term.list.find((x) => x.ref === term.active);

function openTerminal() {
  showDock(true);
  const target = fsTarget();
  if (!target) {
    $("term-views").replaceChildren(el("div", "empty small", "Pilih project di kolom Folder (atau task) dulu — terminal dibuka di folder itu."));
    return;
  }
  const view = el("div", "term-view");
  $("term-views").querySelector(".empty")?.remove();
  $("term-views").append(view);
  const xterm = new Terminal({
    fontFamily: '"IBM Plex Mono", Consolas, monospace', fontSize: 13, cursorBlink: true,
    scrollback: 5000, theme: XTERM_THEME, allowProposedApi: false,
  });
  const fit = new FitAddon.FitAddon();
  xterm.loadAddon(fit);
  xterm.open(view);
  const entry = { ref: ++term.seq, tid: null, label: target.label, cwd: target.path, xterm, fit, view, exited: false };
  term.list.push(entry);
  // Ctrl+` dibiarkan naik ke window untuk sembunyi/tampil panel
  xterm.attachCustomKeyEventHandler((e) => !(e.ctrlKey && e.key === "`"));
  xterm.onData((data) => entry.tid && !entry.exited && request({ type: "term:input", tid: entry.tid, data }));
  xterm.onResize(({ cols, rows }) => entry.tid && !entry.exited && request({ type: "term:resize", tid: entry.tid, cols, rows }));
  selectTerm(entry.ref);
  request({ type: "term:open", ...target.msg, ref: entry.ref, cols: xterm.cols, rows: xterm.rows });
}

function selectTerm(ref) {
  term.active = ref;
  for (const t of term.list) t.view.hidden = t.ref !== ref;
  renderTermTabs();
  requestAnimationFrame(() => { fitActive(); activeTerm()?.xterm.focus(); });
}

function closeTerm(ref) {
  const t = term.list.find((x) => x.ref === ref);
  if (!t) return;
  if (t.tid && !t.exited) request({ type: "term:close", tid: t.tid });
  t.xterm.dispose();
  t.view.remove();
  term.list = term.list.filter((x) => x !== t);
  if (term.active === ref) term.active = term.list.at(-1)?.ref ?? null;
  if (term.active) selectTerm(term.active);
  else { renderTermTabs(); showDock(false); }
}

function renderTermTabs() {
  const bar = $("term-tabs");
  bar.replaceChildren();
  for (const t of term.list) {
    const tab = el("button", "term-tab" + (t.ref === term.active ? " active" : "") + (t.exited ? " exited" : ""));
    tab.title = t.cwd;
    const x = el("span", "tab-x", "×");
    x.title = "Tutup terminal";
    x.addEventListener("click", (e) => { e.stopPropagation(); closeTerm(t.ref); });
    tab.append(el("span", null, t.label), x);
    tab.addEventListener("click", () => selectTerm(t.ref));
    bar.append(tab);
  }
}

function fitActive() {
  const t = activeTerm();
  if (!t || $("term-dock").hidden) return;
  try { t.fit.fit(); } catch {} // view tersembunyi belum punya ukuran
}

function handleTerm(m) {
  if (m.type === "term:opened") {
    const t = term.list.find((x) => x.ref === m.ref);
    if (!t) return request({ type: "term:close", tid: m.tid }); // tab sudah ditutup sebelum shell siap
    t.tid = m.tid;
    request({ type: "term:resize", tid: t.tid, cols: t.xterm.cols, rows: t.xterm.rows });
  } else if (m.type === "term:data") {
    term.list.find((x) => x.tid === m.tid)?.xterm.write(m.data);
  } else if (m.type === "term:exit") {
    const t = term.list.find((x) => x.tid === m.tid);
    if (!t) return;
    t.exited = true;
    t.xterm.write(`\r\n\x1b[90m[shell selesai, kode ${m.code}] — tutup tab ini atau klik + untuk terminal baru\x1b[0m\r\n`);
    renderTermTabs();
  } else if (m.type === "error") { // gagal membuka shell
    const t = term.list.find((x) => !x.tid && !x.exited);
    if (!t) return;
    t.exited = true;
    t.xterm.write(`\x1b[31mGagal membuka terminal: ${m.error}\x1b[0m\r\n`);
    renderTermTabs();
  }
}

/** Sidecar terputus: semua shell di sana sudah mati. */
function termsLost() {
  for (const t of term.list) {
    if (t.exited) continue;
    t.exited = true;
    t.xterm.write("\r\n\x1b[90m[koneksi sidecar putus — shell berhenti]\x1b[0m\r\n");
  }
  renderTermTabs();
}

$("term-toggle").addEventListener("click", toggleDock);
$("term-new").addEventListener("click", () => openTerminal());
$("term-hide").addEventListener("click", () => showDock(false));
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.key === "`") { e.preventDefault(); toggleDock(); }
});
new ResizeObserver(() => fitActive()).observe($("term-views"));

// tarik garis atas panel untuk mengubah tinggi
$("term-grip").addEventListener("pointerdown", (e) => {
  e.preventDefault();
  const grip = e.currentTarget;
  grip.setPointerCapture(e.pointerId);
  const move = (ev) => {
    term.height = Math.round(Math.min(window.innerHeight - 220, Math.max(120, window.innerHeight - ev.clientY)));
    $("term-dock").style.height = `${term.height}px`;
  };
  const up = () => {
    grip.removeEventListener("pointermove", move);
    grip.removeEventListener("pointerup", up);
    try { localStorage.setItem("ade.termHeight", String(term.height)); } catch {}
  };
  grip.addEventListener("pointermove", move);
  grip.addEventListener("pointerup", up);
});

// ---------- Tab Git (history + stage + commit; push/pull tetap lewat terminal) ----------
const gitv = {
  tab: "files",          // tab kolom ke-3: "files" | "git"
  all: false,            // graph semua branch
  data: new Map(),       // key -> { log, rows, status }
  sel: new Map(),        // key -> hash commit yang dibuka di panel bawah
  shows: new Map(),      // `${key}|${hash}` -> detail commit
  open: new Set(),       // `${key}|${hash|"wt"}|${path}` file yang diff-nya dibuka
  patches: new Map(),    // kunci sama dengan `open` -> patch
  drafts: new Map(),     // key -> pesan commit yang sedang diketik
  key: null, busy: false, error: null, notice: null,
};
try {
  gitv.tab = localStorage.getItem("ade.col3Tab") === "git" ? "git" : "files";
  gitv.all = localStorage.getItem("ade.gitAll") === "1";
} catch {}

const gitData = (key) => gitv.data.get(key) || gitv.data.set(key, {}).get(key);

/** Tab Jelajah / Git di kolom ke-3. Dipanggil dari renderChanges. */
function syncCol3(target) {
  $("col3-tabs").hidden = !target;
  const tab = target ? gitv.tab : "files";
  for (const b of $("col3-tabs").querySelectorAll(".col-tab")) b.classList.toggle("on", b.dataset.tab === tab);
  $("pane-files").hidden = tab !== "files";
  $("pane-git").hidden = tab !== "git";
  if (tab === "git" && gitv.key !== target.key) { // root berganti → muat history root itu
    gitv.key = target.key;
    gitv.error = gitv.notice = null;
    loadGit(target);
    renderGit();
  }
}

function loadGit(target, more = false) {
  const d = gitData(target.key);
  request({ type: "git:log", ...target.msg, all: gitv.all, skip: more ? d.log?.commits.length || 0 : 0 });
  if (!more) request({ type: "git:status", ...target.msg });
}

function handleGit(m) {
  const target = fsTarget();
  const current = m.key && m.key === target?.key;
  if (m.type === "git:log") {
    if (m.all !== gitv.all) return; // balasan untuk mode yang sudah diganti
    const d = gitData(m.key);
    d.log = m.skip && d.log ? { ...m, commits: [...d.log.commits, ...m.commits] } : m;
    d.rows = layoutGraph(d.log.commits);
  } else if (m.type === "git:status") {
    gitData(m.key).status = m;
    // isi file bisa berubah → diff yang di-cache basi (yang terbuka diminta ulang saat render)
    for (const k of gitv.patches.keys()) if (k.startsWith(`${m.key}|wt|`)) gitv.patches.delete(k);
  } else if (m.type === "git:show") {
    gitv.shows.set(`${m.key}|${m.hash}`, m);
  } else if (m.type === "git:fileDiff") {
    gitv.patches.set(`${m.key}|wt|${m.path}`, m);
  } else if (m.type === "git:commitFile") {
    gitv.patches.set(`${m.key}|${m.hash}|${m.path}`, m);
  } else if (m.type === "git:committed") {
    gitv.busy = false;
    gitv.error = null;
    gitv.notice = `Commit ${m.hash.slice(0, 8)} dibuat (${m.files} file).`;
    gitv.drafts.delete(m.key);
    if (current) loadGit(target);
  } else if (m.type === "error") {
    gitv.busy = false;
    gitv.error = m.error;
    gitv.notice = null;
  }
  if (current || m.type === "error") renderGit();
}

// ----- graph: tiap commit dapat kolom (lane); garis = hubungan anak → parent -----
const ROW_H = 28, LANE_W = 14, LANE_MAX = 16;
const LANE_COLORS = ["#5AA9FF", "#4CC38A", "#F2A93B", "#C792EA", "#FF8A80", "#7FDBCA", "#E6C07B", "#8EC5FF"];

function layoutGraph(commits) {
  const lanes = []; // lanes[i] = hash commit yang "ditunggu" kolom i
  return commits.map((c) => {
    const before = lanes.slice();
    let col = lanes.indexOf(c.hash);
    if (col < 0) { col = lanes.indexOf(null); if (col < 0) col = lanes.length; } // ujung branch baru
    lanes[col] = null;
    const edges = c.parents.map((p, k) => {
      let j = lanes.indexOf(p); // parent sudah ditunggu kolom lain → garis bergabung ke sana
      if (j < 0) { j = k === 0 ? col : lanes.indexOf(null); if (j < 0) j = lanes.length; lanes[j] = p; }
      return j;
    });
    while (lanes.length && lanes.at(-1) === null) lanes.pop();
    return { col, before, edges, after: lanes.slice(), incoming: before[col] === c.hash };
  });
}

function graphSvg(row, width) {
  const ns = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(ns, "svg");
  svg.setAttribute("width", width); svg.setAttribute("height", ROW_H);
  svg.setAttribute("class", "git-svg");
  const x = (i) => 7 + Math.min(i, LANE_MAX - 1) * LANE_W;
  const mid = ROW_H / 2;
  const line = (x1, y1, x2, y2, color) => {
    const p = document.createElementNS(ns, "path");
    // diagonal dibuat lengkung supaya garis cabang/merge mudah diikuti
    p.setAttribute("d", x1 === x2 ? `M${x1} ${y1}V${y2}` : `M${x1} ${y1}C${x1} ${(y1 + y2) / 2} ${x2} ${(y1 + y2) / 2} ${x2} ${y2}`);
    p.setAttribute("stroke", color); p.setAttribute("fill", "none"); p.setAttribute("stroke-width", "1.6");
    svg.append(p);
  };
  row.before.forEach((h, i) => { // garis yang lewat saja
    if (!h || i === row.col && row.incoming) return;
    const j = row.after.indexOf(h);
    if (j >= 0) line(x(i), 0, x(j), ROW_H, LANE_COLORS[j % LANE_COLORS.length]);
  });
  const color = LANE_COLORS[row.col % LANE_COLORS.length];
  if (row.incoming) line(x(row.col), 0, x(row.col), mid, color);
  for (const j of row.edges) line(x(row.col), mid, x(j), ROW_H, LANE_COLORS[j % LANE_COLORS.length]);
  const dot = document.createElementNS(ns, "circle");
  dot.setAttribute("cx", x(row.col)); dot.setAttribute("cy", mid); dot.setAttribute("r", row.edges.length > 1 ? 4.5 : 3.5);
  dot.setAttribute("fill", row.edges.length > 1 ? "#101318" : color); dot.setAttribute("stroke", color); dot.setAttribute("stroke-width", "2");
  svg.append(dot);
  return svg;
}

function ago(ms) {
  const s = Math.max(0, (Date.now() - ms) / 1000);
  if (s < 60) return "baru saja";
  if (s < 3600) return `${Math.floor(s / 60)} mnt`;
  if (s < 86400) return `${Math.floor(s / 3600)} jam`;
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} hari`;
  return new Date(ms).toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "2-digit" });
}

function refBadges(refs) {
  const frag = document.createDocumentFragment();
  for (const r of refs) {
    const head = r.startsWith("HEAD -> ");
    const name = head ? r.slice(8) : r.replace(/^tag: /, "");
    const cls = r.startsWith("tag: ") ? "tag" : head ? "head" : name.includes("/") ? "remote" : "local";
    frag.append(el("span", `git-ref ${cls}`, head ? `● ${name}` : name));
  }
  return frag;
}

function renderGit() {
  const target = fsTarget();
  if (!target || gitv.tab !== "git") return;
  const d = gitData(target.key);
  renderBranch(d.status);
  $("git-all").checked = gitv.all;
  renderGraph(target, d);
  renderGitDetail(target, d);
}

/** Nama branch + ↑ahead ↓behind terhadap upstream (data fetch terakhir). */
function renderBranch(st) {
  const box = $("git-branch");
  box.replaceChildren();
  box.title = "";
  if (!st) return;
  box.append(el("span", null, `⎇ ${st.branch}`));
  if (!st.upstream) {
    box.append(el("span", "git-sync muted", "tanpa upstream"));
    box.title = "Branch ini belum punya upstream — push pertama lewat terminal: git push -u origin <branch>";
    return;
  }
  const sync = el("span", "git-sync" + (st.ahead || st.behind ? " warn" : ""), st.ahead || st.behind ? `↑${st.ahead} ↓${st.behind}` : "✓ sinkron");
  box.append(sync);
  box.title = `Terhadap ${st.upstream} per fetch terakhir.
↑ = commit lokal belum di-push, ↓ = commit remote belum di-pull.
Fetch / pull / push lewat terminal.`;
}

function renderGraph(target, d) {
  const box = $("git-graph");
  const top = box.scrollTop;
  box.replaceChildren();
  if (!d.log) return box.append(el("div", "muted ex-msg", "Memuat history…"));
  if (!d.log.commits.length) return box.append(el("div", "muted ex-msg", "Belum ada commit."));
  const lanes = Math.min(LANE_MAX, Math.max(1, ...d.rows.map((r) => Math.max(r.before.length, r.after.length, r.col + 1))));
  const width = lanes * LANE_W + 4;
  const sel = gitv.sel.get(target.key);
  d.log.commits.forEach((c, i) => {
    const row = el("button", "git-row" + (c.hash === sel ? " active" : ""));
    row.title = `${c.hash}\n${c.author} <${c.email}>\n${new Date(c.at).toLocaleString("id-ID")}`;
    const text = el("span", "git-subj");
    text.append(refBadges(c.refs), document.createTextNode(c.subject));
    row.append(graphSvg(d.rows[i], width), el("span", "git-hash", c.hash.slice(0, 7)), text,
      el("span", "git-author", c.author), el("span", "git-time", ago(c.at)));
    row.addEventListener("click", () => {
      if (sel === c.hash) gitv.sel.delete(target.key);
      else {
        gitv.sel.set(target.key, c.hash);
        if (!gitv.shows.has(`${target.key}|${c.hash}`)) request({ type: "git:show", ...target.msg, hash: c.hash });
      }
      renderGit();
    });
    box.append(row);
  });
  if (d.log.hasMore) {
    const more = el("button", "ghost small git-more", "Muat 200 commit lagi");
    more.addEventListener("click", () => { more.disabled = true; loadGit(target, true); });
    box.append(more);
  }
  box.scrollTop = top;
}

/** Baris file + diff yang bisa dibuka/tutup (dipakai detail commit & perubahan belum di-commit). */
function fileRow(box, target, scope, f, lead, onOpen) {
  const k = `${target.key}|${scope}|${f.path}`;
  const open = gitv.open.has(k);
  const row = el("div", "gd-file" + (open ? " open" : ""));
  if (lead) row.append(lead);
  const name = el("button", "gd-name");
  name.title = f.orig ? `${f.orig} → ${f.path}` : f.path;
  const slash = f.path.lastIndexOf("/");
  name.append(el("span", `fstat s-${f.st}`, f.st), el("span", "ex-name", f.path.slice(slash + 1)), el("span", "ex-dir", slash > 0 ? f.path.slice(0, slash) : ""));
  if (f.additions != null && !f.binary) name.append(el("span", "tab-num", `+${f.additions} −${f.deletions}`));
  name.addEventListener("click", () => { open ? gitv.open.delete(k) : gitv.open.add(k); renderGit(); });
  row.append(name);
  box.append(row);
  if (!open) return;
  const p = gitv.patches.get(k);
  if (!p) { onOpen(); return box.append(el("div", "muted ex-msg", "Memuat diff…")); }
  if (p.binary) return box.append(el("div", "muted ex-msg", "File biner — tidak ditampilkan."));
  const wrap = el("div", "gd-patch");
  if (p.patch) renderPatch(wrap, p.patch, langOf(f.path)); else wrap.append(el("div", "muted ex-msg", "Tidak ada perubahan isi."));
  if (p.truncated) wrap.append(el("div", "muted ex-msg", "Diff dipotong (terlalu besar)."));
  box.append(wrap);
}

function renderGitDetail(target, d) {
  const box = $("git-detail");
  // simpan fokus & isi kotak pesan commit — render ulang bisa terjadi saat sedang mengetik
  const old = box.querySelector(".gd-msg");
  const focused = old && document.activeElement === old ? { s: old.selectionStart, e: old.selectionEnd } : null;
  const scroller = box.querySelector(".gd-scroll");
  const top = scroller?.scrollTop ?? 0;
  box.replaceChildren();
  const scroll = el("div", "gd-scroll");
  box.append(scroll);
  const hash = gitv.sel.get(target.key);

  if (hash) { // ---- detail 1 commit ----
    const c = gitv.shows.get(`${target.key}|${hash}`);
    const head = el("div", "gd-head");
    const back = el("button", "ghost small", "← Perubahan belum di-commit");
    back.addEventListener("click", () => { gitv.sel.delete(target.key); renderGit(); });
    head.append(back);
    scroll.append(head);
    if (!c) { scroll.append(el("div", "muted ex-msg", "Memuat commit…")); }
    else {
      const meta = el("div", "gd-meta");
      meta.append(el("div", "git-hash", c.hash), el("div", null, `${c.author} <${c.email}> · ${new Date(c.at).toLocaleString("id-ID")}`));
      if (c.parents.length > 1) meta.append(el("div", "muted", `Merge — dibanding parent pertama ${c.parents[0].slice(0, 7)}`));
      if (c.refs.length) { const r = el("div", "gd-refs"); r.append(refBadges(c.refs)); meta.append(r); }
      scroll.append(meta, el("pre", "gd-body", c.body));
      scroll.append(el("div", "gd-title", `${c.files.length} file berubah`));
      for (const f of c.files) {
        fileRow(scroll, target, hash, { ...f, st: f.status }, null,
          () => request({ type: "git:commitFile", ...target.msg, hash, path: f.path }));
      }
    }
    scroll.scrollTop = top;
    return;
  }

  // ---- perubahan belum di-commit + form commit ----
  const st = d.status;
  if (!st) { scroll.append(el("div", "muted ex-msg", "Memuat status…")); return; }
  if (st.inProgress) scroll.append(el("div", "gd-warn", `Repo sedang dalam proses ${st.inProgress}. Selesaikan lewat terminal — commit dari ASAP diblok.`));
  const staged = st.files.filter((f) => f.x !== " " && f.x !== "?");
  const title = el("div", "gd-title");
  title.append(el("span", null, st.files.length ? `Perubahan belum di-commit (${st.files.length})` : "Tidak ada perubahan — working tree bersih."));
  if (st.files.length) {
    const allOn = staged.length === st.files.length;
    const b = el("button", "ghost small", allOn ? "Unstage semua" : "Stage semua");
    b.addEventListener("click", () => request({ type: "git:stage", ...target.msg, paths: st.files.map((f) => f.path), on: !allOn }));
    title.append(b);
  }
  scroll.append(title);
  for (const f of st.files) {
    const box2 = el("input");
    box2.type = "checkbox";
    box2.checked = f.x !== " " && f.x !== "?";
    box2.indeterminate = box2.checked && f.y !== " "; // sebagian di-stage, sebagian belum
    box2.title = box2.checked ? "Unstage" : "Stage";
    box2.addEventListener("change", () => request({ type: "git:stage", ...target.msg, paths: [f.path], on: box2.checked }));
    const letter = f.x === "?" ? "A" : f.x !== " " ? f.x : f.y;
    fileRow(scroll, target, "wt", { ...f, st: letter === "R" ? "M" : letter }, box2,
      () => request({ type: "git:fileDiff", ...target.msg, path: f.path }));
  }
  scroll.scrollTop = top;

  const form = el("div", "gd-form");
  if (gitv.error) form.append(el("div", "err", gitv.error));
  if (gitv.notice) form.append(el("div", "gd-ok", gitv.notice));
  const msg = el("textarea", "gd-msg");
  msg.rows = 3;
  msg.placeholder = `Pesan commit untuk ${st.branch} (Ctrl+Enter untuk commit)`;
  msg.value = gitv.drafts.get(target.key) || "";
  msg.addEventListener("input", () => gitv.drafts.set(target.key, msg.value));
  const btn = el("button", "primary", gitv.busy ? "Meng-commit…" : `Commit (${staged.length} file)`);
  btn.disabled = gitv.busy || !staged.length || !!st.inProgress;
  btn.title = !staged.length ? "Centang file yang mau di-commit dulu" : `Commit ke ${st.branch}. Push tetap manual lewat terminal.`;
  const doCommit = () => {
    if (btn.disabled) return;
    if (!msg.value.trim()) { gitv.error = "Pesan commit masih kosong."; return renderGit(); }
    gitv.busy = true; gitv.error = gitv.notice = null;
    request({ type: "git:commit", ...target.msg, message: msg.value });
    renderGit();
  };
  btn.addEventListener("click", doCommit);
  msg.addEventListener("keydown", (e) => { if (e.key === "Enter" && e.ctrlKey) { e.preventDefault(); doCommit(); } });
  form.append(msg, btn);
  box.append(form);
  if (focused) { msg.focus(); msg.setSelectionRange(focused.s, focused.e); }
}

$("col3-tabs").addEventListener("click", (e) => {
  const tab = e.target.closest(".col-tab")?.dataset.tab;
  if (!tab || tab === gitv.tab) return;
  gitv.tab = tab;
  gitv.key = null; // masuk tab Git = muat ulang history
  try { localStorage.setItem("ade.col3Tab", tab); } catch {}
  renderChanges();
});
$("git-all").addEventListener("change", () => {
  gitv.all = $("git-all").checked;
  try { localStorage.setItem("ade.gitAll", gitv.all ? "1" : "0"); } catch {}
  const target = fsTarget();
  if (!target) return;
  gitData(target.key).log = null;
  loadGit(target, false);
  renderGit();
});
$("git-refresh").addEventListener("click", () => {
  const target = fsTarget();
  if (!target) return;
  gitv.error = gitv.notice = null;
  loadGit(target);
});

// ---------- Todo (laci kanan, default tertutup) + pengingat ----------
const todo = {
  items: [],
  filter: "all",      // "all" | "project"
  showDone: false,
  noTime: false,      // dev membuang jam hasil tebakan di pratinjau
  noProject: false,   // dev membuang label project di pratinjau
  editing: null,      // id task yang sedang diedit
};
try { todo.showDone = localStorage.getItem("ade.todoShowDone") === "1"; } catch {}

const isOverdue = (x, now = Date.now()) => !x.done && x.dueAt && Date.parse(x.dueAt) <= now;

function todoProject() {
  const sel = selectedProject();
  return sel ? { name: sel.name, path: sel.path } : null;
}

function handleTodos(m) {
  todo.items = m.items || [];
  renderTodo();
}

function renderTodoPill() {
  const open = todo.items.filter((x) => !x.done).length;
  const due = todo.items.filter((x) => isOverdue(x)).length;
  $("todo-count").textContent = open ? String(open) : "";
  $("todo-due").hidden = !due;
  $("todo-due").textContent = due ? `${due} lewat` : "";
  $("todo-toggle").classList.toggle("warn-soft", !!due);
  $("todo-toggle").classList.toggle("ok", !$("todo-drawer").hidden);
}

function renderTodoPreview() {
  const box = $("todo-preview");
  box.replaceChildren();
  const text = $("todo-input").value.trim();
  if (!text) { todo.noTime = todo.noProject = false; return; }
  const due = todo.noTime ? null : parseDue(text);
  const proj = todo.noProject ? null : todoProject();
  const chip = (cls, label, title, onRemove) => {
    const c = el("span", `todo-chip ${cls}`, label);
    c.title = title;
    if (onRemove) {
      const x = el("button", "chip-x", "×");
      x.type = "button";
      x.title = "Buang";
      x.addEventListener("click", () => { onRemove(); renderTodoPreview(); $("todo-input").focus(); });
      c.append(x);
    }
    box.append(c);
  };
  if (due) chip("time", `⏰ ${dueLabel(due.dueAt)}${due.rolled ? " (jam itu sudah lewat hari ini)" : ""}`, "Waktu pengingat yang terbaca dari teks", () => { todo.noTime = true; });
  else if (todo.noTime) chip("muted", "tanpa pengingat", "Klik × di sini untuk membaca jam lagi", () => { todo.noTime = false; });
  if (proj) chip("proj", proj.name, "Label project terpilih", () => { todo.noProject = true; });
  box.append(el("span", "todo-hint", "Enter untuk simpan"));
}

function renderTodo() {
  renderTodoPill();
  const list = $("todo-list");
  if ($("todo-drawer").hidden) return;
  const editingInput = list.querySelector(".todo-edit");
  const editFocus = editingInput && document.activeElement === editingInput ? editingInput.selectionStart : null;
  list.replaceChildren();
  $("todo-f-all").classList.toggle("on", todo.filter === "all");
  $("todo-f-proj").classList.toggle("on", todo.filter === "project");
  $("todo-show-done").checked = todo.showDone;

  const sel = selectedProject();
  let items = todo.items.filter((x) => todo.showDone || !x.done);
  if (todo.filter === "project") items = items.filter((x) => sel && x.project && normPath(x.project.path) === normPath(sel.path));
  // belum selesai dulu; yang ada jam diurut paling dekat; sisanya urut dibuat
  items.sort((a, b) => (a.done - b.done)
    || ((a.dueAt ? 0 : 1) - (b.dueAt ? 0 : 1))
    || (a.dueAt && b.dueAt ? Date.parse(a.dueAt) - Date.parse(b.dueAt) : 0)
    || Date.parse(a.createdAt) - Date.parse(b.createdAt));

  if (!items.length) {
    const empty = el("div", "empty small");
    empty.append(el("strong", null, todo.filter === "project" ? "Tidak ada task untuk project ini." : "Belum ada task."),
      el("span", null, "Ketik di atas, mis. \"deploy prod jam 5\" — jam dikenali otomatis dan diingatkan lewat notifikasi Windows."));
    list.append(empty);
  }
  for (const x of items) list.append(todoItem(x));
  const again = list.querySelector(".todo-edit");
  if (again && editFocus !== null) { again.focus(); again.setSelectionRange(editFocus, editFocus); }
}

function todoItem(x) {
  const row = el("div", "todo-item" + (x.done ? " done" : "") + (isOverdue(x) ? " overdue" : ""));
  const cb = el("input");
  cb.type = "checkbox";
  cb.checked = x.done;
  cb.title = x.done ? "Tandai belum selesai" : "Tandai selesai";
  cb.addEventListener("change", () => request({ type: "todo:update", id: x.id, fields: { done: cb.checked } }));
  const main = el("div", "todo-main");
  if (todo.editing === x.id) {
    const input = el("input", "todo-edit");
    input.value = x.text;
    const finish = (save) => {
      todo.editing = null;
      const text = input.value.trim();
      if (save && text && text !== x.text) {
        // teks diubah → jam dibaca ulang dari teks baru (tidak ada jam = pengingat lama tetap)
        const due = parseDue(text);
        request({ type: "todo:update", id: x.id, fields: due ? { text, dueAt: due.dueAt } : { text } });
      } else renderTodo();
    };
    input.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); finish(true); }
      if (e.key === "Escape") { e.preventDefault(); e.stopPropagation(); finish(false); }
    });
    input.addEventListener("blur", () => todo.editing === x.id && finish(true));
    main.append(input);
    setTimeout(() => { if (document.activeElement !== input) input.focus(); }, 0);
  } else {
    const text = el("div", "todo-text", x.text);
    text.title = "Double-click untuk edit";
    text.addEventListener("dblclick", () => { todo.editing = x.id; renderTodo(); });
    main.append(text);
  }
  const meta = el("div", "todo-meta");
  if (x.dueAt) {
    const t = el("span", "todo-chip time" + (isOverdue(x) ? " late" : ""), `⏰ ${dueLabel(x.dueAt)}`);
    t.title = new Date(x.dueAt).toLocaleString("id-ID");
    const clear = el("button", "chip-x", "×");
    clear.title = "Hapus pengingat";
    clear.addEventListener("click", () => request({ type: "todo:update", id: x.id, fields: { dueAt: null } }));
    t.append(clear);
    meta.append(t);
  }
  if (x.project) {
    const p = el("span", "todo-chip proj", x.project.name);
    p.title = x.project.path || "";
    meta.append(p);
  }
  if (meta.childNodes.length) main.append(meta);
  const rm = el("button", "icon-btn todo-rm", "×");
  rm.title = "Hapus task";
  rm.addEventListener("click", () => request({ type: "todo:remove", id: x.id }));
  row.append(cb, main, rm);
  return row;
}

function toggleTodo(show = $("todo-drawer").hidden) {
  $("todo-drawer").hidden = !show;
  renderTodo();
  if (show) { renderTodoPreview(); $("todo-input").focus(); }
}

$("todo-toggle").addEventListener("click", () => toggleTodo());
$("todo-close").addEventListener("click", () => toggleTodo(false));
$("todo-input").addEventListener("input", renderTodoPreview);
$("todo-form").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = $("todo-input").value.trim();
  if (!text) return;
  const due = todo.noTime ? null : parseDue(text);
  request({ type: "todo:add", text, dueAt: due?.dueAt ?? null, project: todo.noProject ? null : todoProject() });
  $("todo-input").value = "";
  todo.noTime = todo.noProject = false;
  renderTodoPreview();
});
$("todo-f-all").addEventListener("click", () => { todo.filter = "all"; renderTodo(); });
$("todo-f-proj").addEventListener("click", () => { todo.filter = "project"; renderTodo(); });
$("todo-show-done").addEventListener("change", () => {
  todo.showDone = $("todo-show-done").checked;
  try { localStorage.setItem("ade.todoShowDone", todo.showDone ? "1" : "0"); } catch {}
  renderTodo();
});
window.addEventListener("keydown", (e) => {
  if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === "t") { e.preventDefault(); toggleTodo(); }
  else if (e.key === "Escape" && !$("todo-drawer").hidden && e.target.closest?.("#todo-drawer") && !e.target.classList.contains("todo-edit")) toggleTodo(false);
});
// status "lewat" berubah seiring waktu walau tidak ada pesan dari sidecar
setInterval(renderTodo, 30_000);

// ---------- Mode fokus: 1 kartu tampil selebar layar ----------
const COL_NAMES = ["Folder", "Agentic Running", "Perubahan", "Saran Claude"];
let focusCol = null;
try { const v = localStorage.getItem("ade.focusCol"); focusCol = v === null || v === "" ? null : Number(v); } catch {}

function applyFocus() {
  const cols = [...document.querySelectorAll(".ade > .col")];
  document.querySelector(".ade").classList.toggle("focus", focusCol !== null);
  cols.forEach((c, i) => {
    c.classList.toggle("focused", i === focusCol);
    const b = c.querySelector(".focus-btn");
    b.textContent = i === focusCol ? "⤡" : "⤢";
    b.title = i === focusCol ? "Keluar mode fokus (Esc)" : `Mode fokus: tampilkan ${COL_NAMES[i]} selebar layar`;
  });
  try { localStorage.setItem("ade.focusCol", focusCol ?? ""); } catch {}
  requestAnimationFrame(fitActive); // lebar berubah → terminal ikut menyesuaikan
}

document.querySelectorAll(".ade > .col").forEach((col, i) => {
  const b = el("button", "icon-btn focus-btn");
  b.addEventListener("click", () => { focusCol = focusCol === i ? null : i; applyFocus(); });
  col.querySelector(".hd").append(b);
});
window.addEventListener("keydown", (e) => {
  // Esc di kotak isian / terminal tetap milik elemen itu
  if (e.key !== "Escape" || focusCol === null || e.target.closest("input, textarea, select, .xterm")) return;
  focusCol = null;
  applyFocus();
});
applyFocus();

connect();
