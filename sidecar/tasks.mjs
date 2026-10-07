// Task = 1 agent Claude yang bekerja di git worktree sendiri.
// Permintaan izin agent (canUseTool) diantrikan sebagai "Saran Claude" sampai dev Setuju / Tolak.
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { execFile } from "node:child_process";
import { homedir } from "node:os";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { query } from "@anthropic-ai/claude-agent-sdk";

const DATA_DIR = join(process.env.APPDATA || homedir(), "ade");
const TASKS_FILE = join(DATA_DIR, "tasks.json");
const DECISIONS_FILE = join(DATA_DIR, "decisions.jsonl");
// di luar repo supaya repo project tidak kotor (keputusan dev 2026-10-06).
// Laptop tim tanpa D:\HSD → di home user.
const WORKTREE_ROOT = process.env.ADE_WORKTREE_ROOT
  || (existsSync("D:\\HSD") ? "D:\\HSD\\.ade-worktrees" : join(homedir(), ".ade-worktrees"));

export const MODELS = {
  sonnet: "claude-sonnet-5-5", // default (keputusan dev: hemat kuota)
  opus: "claude-opus-5-5",
  haiku: "claude-haiku-4-5-20251001",
};
const ACTIVE = new Set(["starting", "running", "waiting"]);
const PREVIEW_MAX = 700;
const MESSAGE_MAX = 8000;   // per pesan di log chat
const MESSAGES_KEEP = 400;  // pesan terakhir yang disimpan per task

const slugify = (s) =>
  s.toLowerCase().normalize("NFKD").replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "task";
const clip = (s, n = PREVIEW_MAX) => (s.length > n ? s.slice(0, n) + "\n…" : s);

function git(cwd, args) {
  return new Promise((ok, fail) => {
    // quotePath=false: nama file non-ASCII tidak di-escape, jadi path dari numstat bisa dipakai ulang
    execFile("git", ["-c", "core.quotePath=false", ...args], { cwd, timeout: 60000, windowsHide: true, maxBuffer: 16 * 1024 * 1024 }, (err, stdout, stderr) =>
      err ? fail(new Error((stderr || err.message).trim())) : ok(stdout.trim()));
  });
}

function isInside(child, parent) {
  const rel = relative(resolve(parent), resolve(child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

/** Path file yang mau disentuh sebuah tool (null kalau tool itu tidak bekerja per file). */
function targetPath(input) {
  return input.file_path || input.notebook_path || null;
}

/** Ringkasan aksi agent untuk kartu "Saran Claude". */
function describe(toolName, input, cwd) {
  const rel = (p) => (p ? relative(cwd, resolve(cwd, p)).replaceAll("\\", "/") : "?");
  switch (toolName) {
    case "Edit":
      return { title: `Edit ${rel(input.file_path)}`, detail: clip(`- ${input.old_string ?? ""}\n+ ${input.new_string ?? ""}`), kind: "diff" };
    case "MultiEdit":
      return {
        title: `Edit ${rel(input.file_path)} (${input.edits?.length ?? 0} bagian)`,
        detail: clip((input.edits || []).map((e) => `- ${e.old_string}\n+ ${e.new_string}`).join("\n\n")),
        kind: "diff",
      };
    case "Write":
      return { title: `Tulis file ${rel(input.file_path)}`, detail: clip(input.content ?? ""), kind: "code" };
    case "NotebookEdit":
      return { title: `Edit notebook ${rel(input.notebook_path)}`, detail: clip(input.new_source ?? ""), kind: "code" };
    case "Bash":
    case "PowerShell":
      return { title: `Jalankan perintah (${toolName})`, detail: clip([input.description, input.command].filter(Boolean).join("\n\n")), kind: "code" };
    default:
      return { title: toolName, detail: clip(JSON.stringify(input, null, 2)), kind: "code" };
  }
}

/** Satu baris "sedang apa" untuk kartu task. */
function activityOf(block, cwd) {
  const i = block.input || {};
  const p = targetPath(i) || i.path;
  const rel = p ? relative(cwd, resolve(cwd, p)).replaceAll("\\", "/") : "";
  if (["Read", "Edit", "MultiEdit", "Write"].includes(block.name)) return `${block.name} ${rel}`;
  if (block.name === "Grep") return `Grep "${i.pattern ?? ""}"`;
  if (block.name === "Glob") return `Glob ${i.pattern ?? ""}`;
  if (block.name === "Bash" || block.name === "PowerShell") return `$ ${(i.command ?? "").split("\n")[0].slice(0, 80)}`;
  return block.name;
}

export class TaskManager {
  /** @param {() => void} onChange dipanggil setiap ada perubahan state (untuk broadcast ke UI) */
  constructor(onChange) {
    this.onChange = onChange;
    this.tasks = new Map();       // id -> task (data yang dipersist)
    this.runtime = new Map();     // id -> { abort } (tidak dipersist)
    this.permissions = new Map(); // requestId -> { req, resolve }
    this.load();
  }

  // ---------- persistence ----------
  load() {
    let saved = [];
    try { saved = JSON.parse(readFileSync(TASKS_FILE, "utf8")).tasks || []; } catch {}
    for (const t of saved) {
      // task dari versi lama belum punya log chat
      t.messages ??= [{ id: "m0", role: "user", text: t.prompt, at: t.createdAt }];
      t.queue ??= [];
      // agent tidak bertahan saat ADE ditutup; worktree & perubahannya tetap ada
      if (ACTIVE.has(t.status)) {
        Object.assign(t, { status: "interrupted", activity: "ASAP ditutup saat agent masih berjalan" });
        this.say(t, "system", "ASAP ditutup saat agent masih berjalan. Kirim pesan untuk melanjutkan sesi.");
      }
      this.tasks.set(t.id, t);
    }
  }

  /** Tambah satu entri ke log chat task (tidak memicu save/broadcast sendiri). */
  say(task, role, text, extra = {}) {
    if (!text) return;
    task.messages.push({ id: randomUUID().slice(0, 8), role, text: clip(String(text), MESSAGE_MAX), at: new Date().toISOString(), ...extra });
    if (task.messages.length > MESSAGES_KEEP) task.messages.splice(0, task.messages.length - MESSAGES_KEEP);
  }

  save() {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(TASKS_FILE, JSON.stringify({ tasks: [...this.tasks.values()] }, null, 2));
  }

  changed() { this.save(); this.onChange(); }

  logDecision(entry) {
    mkdirSync(DATA_DIR, { recursive: true });
    appendFileSync(DECISIONS_FILE, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + "\n");
  }

  // ---------- views for UI ----------
  listTasks() {
    return [...this.tasks.values()].sort((a, b) =>
      (ACTIVE.has(b.status) - ACTIVE.has(a.status)) || b.createdAt.localeCompare(a.createdAt));
  }

  listPermissions() {
    return [...this.permissions.values()].map((p) => p.req).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  // ---------- lifecycle ----------
  async create({ repoPath, projectName, title, prompt, model }) {
    title = (title || "").trim();
    prompt = (prompt || "").trim();
    if (!title) throw new Error("Judul task wajib diisi.");
    if (!prompt) throw new Error("Instruksi untuk agent wajib diisi.");
    if (!existsSync(join(repoPath || "", ".git"))) throw new Error(`Bukan repo git: ${repoPath}`);
    const modelId = MODELS[model] || MODELS.sonnet;

    const id = randomUUID().slice(0, 8);
    const slug = `${slugify(title)}-${id}`;
    const branch = `ade/${slug}`;
    const worktree = join(WORKTREE_ROOT, slugify(basename(repoPath)), slug);
    const baseBranch = await git(repoPath, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const baseCommit = await git(repoPath, ["rev-parse", "HEAD"]);
    mkdirSync(join(WORKTREE_ROOT, slugify(basename(repoPath))), { recursive: true });
    // worktree dari HEAD: perubahan yang belum di-commit di repo asli TIDAK ikut
    await git(repoPath, ["worktree", "add", "-b", branch, worktree, baseCommit]);

    const now = new Date().toISOString();
    const task = {
      id, title, prompt, model: modelId, repoPath, projectName, branch, worktree, baseBranch, baseCommit,
      status: "starting", activity: "menyiapkan agent…", lastText: "", result: null, error: null,
      costUsd: null, changedFiles: 0, sessionId: null, createdAt: now, updatedAt: now,
      messages: [], queue: [],
    };
    this.say(task, "user", prompt);
    this.tasks.set(id, task);
    this.changed();
    this.run(task, { prompt }); // jalan di background; progres dikirim lewat onChange
    return task;
  }

  update(task, patch) {
    Object.assign(task, patch, { updatedAt: new Date().toISOString() });
    this.changed();
  }

  async run(task, { prompt, resume = null }) {
    const abort = new AbortController();
    // done: selesai saat proses agent benar-benar tutup — bisa beberapa detik SETELAH pesan
    // "result" (status sudah review/done). Aksi lanjutan menunggu ini, bukan menolak.
    let finished;
    const done = new Promise((r) => { finished = r; });
    this.runtime.set(task.id, { abort, done });
    const append = [
      `Kamu dijalankan oleh ASAP di git worktree terpisah: ${task.worktree}`,
      `(branch ${task.branch}, dibuat dari ${task.baseBranch} @ ${task.baseCommit.slice(0, 8)}).`,
      `Repo asli ada di ${task.repoPath} — JANGAN mengubah file di sana; semua perubahan hanya di worktree ini.`,
      "Worktree tidak berisi vendor/, node_modules/, maupun .env, jadi jangan menjalankan aplikasi, test, artisan, atau npm.",
      "Fokus membaca dan mengedit kode. Developer akan mereview perubahan sebagai diff.",
    ].join("\n");

    try {
      const q = query({
        prompt,
        options: {
          cwd: task.worktree,
          ...(resume ? { resume } : {}), // Minta revisi: lanjutkan sesi yang sama (konteks tetap)
          model: task.model,
          abortController: abort,
          systemPrompt: { type: "preset", preset: "claude_code", append },
          canUseTool: (toolName, input, opts) => this.askPermission(task, toolName, input, opts),
        },
      });
      for await (const msg of q) {
        if (msg.session_id) task.sessionId = msg.session_id;
        if (msg.type === "system" && msg.subtype === "init") {
          this.update(task, { status: "running", activity: `agent mulai · ${msg.model}` });
        } else if (msg.type === "assistant") {
          for (const block of msg.message.content) {
            if (block.type === "tool_use") {
              const activity = activityOf(block, task.worktree);
              this.say(task, "tool", activity);
              this.update(task, { activity });
            } else if (block.type === "text" && block.text.trim()) {
              this.say(task, "assistant", block.text.trim());
              this.update(task, { lastText: block.text.trim() });
            }
          }
        } else if (msg.type === "result") {
          const changedFiles = await this.countChanges(task);
          if (msg.is_error) this.say(task, "system", `Agent berhenti: ${msg.subtype}`);
          this.update(task, {
            status: msg.is_error ? "error" : changedFiles ? "review" : "done",
            activity: msg.is_error ? `berhenti: ${msg.subtype}` : changedFiles ? `${changedFiles} file berubah — siap direview` : "selesai tanpa perubahan file",
            result: msg.result ?? null,
            error: msg.is_error ? msg.subtype : null,
            costUsd: msg.total_cost_usd ?? null,
            changedFiles,
          });
        }
      }
    } catch (e) {
      const stopped = abort.signal.aborted;
      this.say(task, "system", stopped ? "Agent dihentikan oleh dev." : `Error: ${e?.message || e}`);
      this.update(task, {
        status: stopped ? "stopped" : "error",
        activity: stopped ? "dihentikan oleh dev" : "error",
        error: stopped ? null : String(e?.message || e),
        changedFiles: await this.countChanges(task),
      });
    } finally {
      this.runtime.delete(task.id);
      finished();
      // izin yang masih menggantung untuk task ini tidak relevan lagi
      for (const [rid, p] of this.permissions) {
        if (p.req.taskId === task.id) { this.permissions.delete(rid); p.resolve({ behavior: "deny", message: "Task sudah berakhir." }); }
      }
      this.onChange();
      // pesan yang dikirim dev selama agent bekerja → lanjutkan sesi otomatis
      // (kecuali dev sendiri yang menghentikan agent: antrean menunggu dev mengirim lagi)
      if (task.queue.length && !abort.signal.aborted && !task.worktreeRemoved) this.flushQueue(task);
    }
  }

  // ---------- chat lanjutan di sesi yang sama ----------
  /** Kirim pesan dev ke agent. Agent sedang bekerja → masuk antrean, dikirim otomatis setelah selesai. */
  async send(taskId, text) {
    const task = this.get(taskId);
    text = (text || "").trim();
    if (!text) throw new Error("Pesan kosong.");
    if (task.worktreeRemoved) throw new Error("Worktree task ini sudah dibersihkan — buat task baru untuk melanjutkan.");
    if (ACTIVE.has(task.status) || this.runtime.has(task.id)) {
      const id = randomUUID().slice(0, 8);
      task.queue.push({ id, text });
      this.say(task, "user", text, { queued: true, queueId: id });
      return this.changed();
    }
    this.say(task, "user", text);
    this.continueRun(task, text);
  }

  flushQueue(task) {
    const items = task.queue.splice(0);
    const ids = new Set(items.map((q) => q.queueId ?? q.id));
    for (const m of task.messages) if (m.queued && ids.has(m.queueId)) m.queued = false;
    this.continueRun(task, items.map((q) => q.text).join("\n\n"));
  }

  /** Lanjutkan sesi agent (resume) — atau sesi baru kalau sesi pertama gagal sebelum sempat terbentuk. */
  continueRun(task, prompt) {
    this.update(task, { status: "starting", activity: "melanjutkan sesi…", result: null, error: null });
    this.run(task, { prompt, resume: task.sessionId || null });
  }

  async countChanges(task) {
    try {
      const out = await git(task.worktree, ["status", "--porcelain"]);
      return out ? out.split("\n").length : 0;
    } catch { return 0; }
  }

  // ---------- Saran Claude (canUseTool) ----------
  askPermission(task, toolName, input, { signal } = {}) {
    // Pagar: tool yang menyentuh file hanya boleh di dalam worktree — otomatis ditolak tanpa tanya dev.
    const target = targetPath(input);
    if (target && !isInside(resolve(task.worktree, target), task.worktree)) {
      const message = `Ditolak otomatis oleh ASAP: ${target} berada di luar worktree. Ubah file hanya di ${task.worktree}.`;
      this.logDecision({ taskId: task.id, project: task.projectName, tool: toolName, target, decision: "auto-deny" });
      this.say(task, "system", `Ditolak otomatis: ${toolName} ${target} (di luar worktree)`);
      this.update(task, { activity: `ditolak otomatis: ${toolName} di luar worktree` });
      return Promise.resolve({ behavior: "deny", message });
    }

    const id = randomUUID().slice(0, 8);
    const req = {
      id, taskId: task.id, taskTitle: task.title, projectName: task.projectName, toolName,
      ...describe(toolName, input, task.worktree), createdAt: new Date().toISOString(),
    };
    return new Promise((resolvePermission) => {
      this.permissions.set(id, { req, resolve: resolvePermission, input });
      this.update(task, { status: "waiting", activity: `menunggu izin: ${req.title}` });
      signal?.addEventListener("abort", () => {
        if (this.permissions.delete(id)) { resolvePermission({ behavior: "deny", message: "Dibatalkan." }); this.onChange(); }
      });
    });
  }

  decide(requestId, allow, reason) {
    const p = this.permissions.get(requestId);
    if (!p) throw new Error("Permintaan izin ini sudah tidak berlaku.");
    this.permissions.delete(requestId);
    const task = this.tasks.get(p.req.taskId);
    this.logDecision({
      taskId: p.req.taskId, project: p.req.projectName, tool: p.req.toolName, title: p.req.title,
      decision: allow ? "allow" : "deny", reason: reason || null,
    });
    p.resolve(allow
      ? { behavior: "allow", updatedInput: p.input }
      : { behavior: "deny", message: reason ? `Ditolak dev: ${reason}` : "Ditolak oleh developer." });
    if (task) this.say(task, "system", `${allow ? "Disetujui" : "Ditolak"}: ${p.req.title}${reason ? ` — "${reason}"` : ""}`);
    if (task && ACTIVE.has(task.status)) {
      const stillWaiting = this.listPermissions().some((r) => r.taskId === task.id);
      this.update(task, { status: stillWaiting ? "waiting" : "running", activity: `${allow ? "disetujui" : "ditolak"}: ${p.req.title}` });
    } else this.onChange();
  }

  // ---------- Fase 4: Perubahan ----------
  get(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) throw new Error("Task tidak ditemukan.");
    return task;
  }

  async assertIdle(task, aksi) {
    if (ACTIVE.has(task.status)) throw new Error(`Agent masih bekerja — tunggu selesai atau hentikan dulu sebelum ${aksi}.`);
    if (task.worktreeRemoved) throw new Error("Worktree task ini sudah dibersihkan.");
    // agent sudah mengirim hasil tapi prosesnya mungkin masih menutup diri — tunggu sebentar
    const rt = this.runtime.get(task.id);
    if (rt) {
      const timeout = new Promise((r) => setTimeout(() => r("timeout"), 15000));
      if ((await Promise.race([rt.done, timeout])) === "timeout") {
        throw new Error("Proses agent sebelumnya belum tertutup. Coba lagi sebentar.");
      }
    }
  }

  /** Diff worktree terhadap commit dasar task, per file. */
  async diff(taskId) {
    const task = this.get(taskId);
    if (task.worktreeRemoved) return { files: [], note: "Worktree sudah dibersihkan." };
    // intent-to-add: file baru (untracked) ikut muncul di git diff; hanya mengubah index worktree ini
    await git(task.worktree, ["add", "-N", "--", "."]);
    // HEAD worktree = commit dasar, atau commit Approve terakhir → yang tampil hanya yang BELUM di-approve
    const base = await git(task.worktree, ["rev-parse", "HEAD"]);
    // tanpa deteksi rename (-M): rename tampil sebagai hapus + tambah, path selalu utuh
    const numstat = await git(task.worktree, ["diff", "--numstat", base, "--"]);
    const names = await git(task.worktree, ["diff", "--name-status", base, "--"]);
    const statusOf = new Map(names.split("\n").filter(Boolean).map((l) => {
      const [st, path] = l.split("\t");
      return [path, st[0]];
    }));
    const files = [];
    for (const line of numstat.split("\n").filter(Boolean)) {
      const [add, del, path] = line.split("\t");
      const binary = add === "-";
      let patch = binary ? "" : await git(task.worktree, ["diff", base, "--", path]);
      const truncated = patch.length > 200_000;
      if (truncated) patch = patch.slice(0, 200_000);
      files.push({ path, status: statusOf.get(path) || "M", additions: binary ? null : +add, deletions: binary ? null : +del, binary, truncated, patch });
    }
    return { files, base: base.slice(0, 8), branch: task.branch, commit: task.commitHash || null };
  }

  /** Approve = commit semua perubahan di branch ade/<task>. Merge ke branch kerja tetap manual. */
  async approve(taskId) {
    const task = this.get(taskId);
    await this.assertIdle(task, "approve");
    await git(task.worktree, ["add", "-A"]);
    const staged = await git(task.worktree, ["diff", "--cached", "--name-only"]);
    if (!staged) throw new Error("Tidak ada perubahan untuk di-commit.");
    // Tanpa trailer Co-Authored-By / atribusi AI: riwayat commit repo kerja dev tidak boleh menampilkan Claude.
    // Isi pesan = instruksi dev sejak approve sebelumnya (instruksi awal + chat lanjutan).
    const clipText = (s) => (s.length > 1500 ? s.slice(0, 1500) + " …" : s);
    const since = task.messages.slice(task.approvedUpTo || 0).filter((m) => m.role === "user" && !m.queued).map((m) => m.text);
    const [first, ...rest] = since.length ? since : [task.prompt];
    const args = ["commit", "-m", task.commitHash ? `${task.title} (lanjutan)` : task.title, "-m", clipText(first)];
    if (rest.length) args.push("-m", `Instruksi lanjutan:\n${rest.map((t) => `- ${clipText(t)}`).join("\n")}`);
    await git(task.worktree, args);
    const commitHash = await git(task.worktree, ["rev-parse", "HEAD"]);
    this.logDecision({ taskId, project: task.projectName, tool: "approve", decision: "commit", commit: commitHash });
    this.say(task, "system", `Approve: di-commit ${commitHash.slice(0, 8)} di ${task.branch}. Merge ke branch kerja manual.`);
    task.approvedUpTo = task.messages.length;
    this.update(task, { status: "approved", activity: `di-commit ${commitHash.slice(0, 8)} di ${task.branch} — merge manual`, commitHash, changedFiles: 0 });
  }

  /** Minta revisi (dari kolom Perubahan) = pesan chat biasa di sesi yang sama, ditandai sebagai revisi. */
  async revise(taskId, feedback) {
    feedback = (feedback || "").trim();
    if (!feedback) throw new Error("Tulis catatan revisi untuk agent.");
    const task = this.get(taskId);
    this.logDecision({ taskId, project: task.projectName, tool: "revise", decision: "revise", reason: feedback });
    await this.send(taskId, `Catatan revisi dari developer:\n${feedback}`);
  }

  /** Hapus folder worktree (branch tetap ada). Ditolak kalau masih ada perubahan yang belum di-commit. */
  async cleanup(taskId) {
    const task = this.get(taskId);
    await this.assertIdle(task, "membersihkan worktree");
    const dirty = await git(task.worktree, ["status", "--porcelain"]);
    if (dirty) throw new Error("Worktree masih berisi perubahan yang belum di-approve. Approve dulu, atau hentikan & buang secara manual.");
    await git(task.repoPath, ["worktree", "remove", task.worktree]);
    this.logDecision({ taskId, project: task.projectName, tool: "cleanup", decision: "worktree-removed", path: task.worktree });
    this.say(task, "system", `Worktree dibersihkan. Branch ${task.branch} tetap ada.`);
    this.update(task, { worktreeRemoved: true, activity: `worktree dibersihkan — branch ${task.branch} tetap ada` });
  }

  // ---------- lihat file di worktree (read-only) ----------
  /** Isi lengkap satu file di worktree. Path di luar worktree ditolak. */
  stop(taskId) {
    const rt = this.runtime.get(taskId);
    if (!rt) throw new Error("Task ini tidak sedang berjalan.");
    rt.abort.abort();
  }

  /** Hapus catatan task dari ADE. Worktree & branch di disk TIDAK dihapus (itu keputusan di Fase 4). */
  forget(taskId) {
    const task = this.tasks.get(taskId);
    if (!task) return;
    if (this.runtime.has(taskId)) throw new Error("Hentikan agent dulu sebelum menghapus task.");
    this.tasks.delete(taskId);
    this.changed();
  }
}
