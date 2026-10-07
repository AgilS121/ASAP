// Todo dev + pengingat. Disimpan di %APPDATA%\ade\todos.json; pengingat dicek sidecar tiap 20 detik
// dan dikirim sebagai notifikasi Windows (WinRT lewat PowerShell — tanpa paket tambahan).
// Pengingat hanya jalan selama ASAP terbuka; yang terlewat saat ASAP tertutup dikirim saat start.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DATA_DIR = join(process.env.APPDATA || homedir(), "ade");
const FILE = join(DATA_DIR, "todos.json");
const TICK_MS = Number(process.env.ASAP_TODO_TICK_MS) || 20_000; // env hanya untuk tes otomatis
const TEXT_MAX = 500;
// Shortcut Start Menu dari installer membawa AppUserModelID = identifier Tauri → notifikasi atas nama ASAP.
// Build dev tidak punya shortcut → pakai AUMID PowerShell (notifikasi tampil sebagai "Windows PowerShell").
const APP_ID = "id.tuvnord.ade";
const PS_APP_ID = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
const START_MENU = join(process.env.APPDATA || homedir(), "Microsoft", "Windows", "Start Menu", "Programs");

const TOAST_PS = `
[Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime] > $null
[Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime] > $null
$t = [Security.SecurityElement]::Escape($env:ASAP_TOAST_TITLE)
$b = [Security.SecurityElement]::Escape($env:ASAP_TOAST_BODY)
$xml = New-Object Windows.Data.Xml.Dom.XmlDocument
$xml.LoadXml("<toast scenario='reminder'><visual><binding template='ToastGeneric'><text>$t</text><text>$b</text></binding></visual><actions><action content='Tutup' arguments='dismiss' activationType='system'/></actions><audio src='ms-winsoundevent:Notification.Reminder'/></toast>")
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($env:ASAP_TOAST_APPID).Show([Windows.UI.Notifications.ToastNotification]::new($xml))
`;

/** Notifikasi Windows. Teks lewat env (bukan disisipkan ke script) → aman dari injeksi. */
export function toast(title, body) {
  if (process.env.ASAP_NO_TOAST) return; // tes otomatis
  const installed = existsSync(join(START_MENU, "ASAP.lnk")) || existsSync(join(START_MENU, "ASAP", "ASAP.lnk"));
  spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-WindowStyle", "Hidden", "-Command", TOAST_PS], {
    env: { ...process.env, ASAP_TOAST_TITLE: title, ASAP_TOAST_BODY: body, ASAP_TOAST_APPID: installed ? APP_ID : PS_APP_ID },
    windowsHide: true, stdio: "ignore", detached: false,
  }).on("error", () => {});
}

const validIso = (s) => typeof s === "string" && !Number.isNaN(Date.parse(s));

export class Todos {
  constructor(onChange) {
    this.onChange = onChange;
    this.items = [];
    try { this.items = JSON.parse(readFileSync(FILE, "utf8")).items || []; } catch {}
  }

  list() { return this.items; }

  save() {
    mkdirSync(DATA_DIR, { recursive: true });
    writeFileSync(FILE, JSON.stringify({ items: this.items }, null, 2));
    this.onChange(this.items);
  }

  clean(fields) {
    const out = {};
    if ("text" in fields) {
      const text = String(fields.text || "").trim().slice(0, TEXT_MAX);
      if (!text) throw new Error("Isi task masih kosong.");
      out.text = text;
    }
    if ("dueAt" in fields) out.dueAt = validIso(fields.dueAt) ? new Date(fields.dueAt).toISOString() : null;
    if ("project" in fields) {
      const p = fields.project;
      out.project = p && p.name ? { name: String(p.name).slice(0, 120), path: p.path ? String(p.path) : null } : null;
    }
    if ("done" in fields) out.done = !!fields.done;
    return out;
  }

  add(fields) {
    const item = { id: randomUUID(), text: "", dueAt: null, project: null, done: false, notified: false, createdAt: new Date().toISOString(), ...this.clean({ text: fields.text, dueAt: fields.dueAt, project: fields.project }) };
    this.items.push(item);
    this.save();
    return item;
  }

  update(id, fields) {
    const item = this.items.find((x) => x.id === id);
    if (!item) throw new Error("Task tidak ditemukan.");
    const patch = this.clean(fields);
    if ("dueAt" in patch && patch.dueAt !== item.dueAt) patch.notified = false; // jam diganti → ingatkan lagi
    if ("done" in patch) patch.doneAt = patch.done ? new Date().toISOString() : null;
    Object.assign(item, patch);
    this.save();
    return item;
  }

  remove(id) {
    this.items = this.items.filter((x) => x.id !== id);
    this.save();
  }

  /** Kirim pengingat untuk task yang sudah jatuh tempo. `now` bisa diatur untuk tes. */
  tick(now = Date.now()) {
    const due = this.items.filter((x) => !x.done && !x.notified && x.dueAt && Date.parse(x.dueAt) <= now);
    if (!due.length) return [];
    for (const x of due) x.notified = true;
    if (due.length <= 3) for (const x of due) toast("ASAP · Pengingat", x.text + (x.project ? ` (${x.project.name})` : ""));
    else toast("ASAP · Pengingat", `${due.length} task sudah waktunya: ${due.map((x) => x.text).join(" · ").slice(0, 200)}`);
    this.save();
    return due;
  }

  start() {
    setTimeout(() => this.tick(), 3000).unref(); // yang terlewat saat ASAP tertutup
    setInterval(() => this.tick(), TICK_MS).unref();
  }
}
