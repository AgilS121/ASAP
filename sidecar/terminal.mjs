// Terminal interaktif (PTY) untuk panel Terminal di UI. Ini shell milik dev, BUKAN agent:
// input tidak lewat Saran Claude. Kanalnya WebSocket sidecar yang sudah dikunci token sesi.
import pty from "node-pty";
import { existsSync, statSync } from "node:fs";
import { randomUUID } from "node:crypto";

const SHELLS = {
  powershell: { file: "powershell.exe", args: ["-NoLogo"] },
  cmd: { file: "cmd.exe", args: [] },
};

export class Terminals {
  constructor() {
    this.items = new Map(); // id -> { pty, ws }
  }

  /** @param send (obj) => void — kirim ke klien pemilik terminal */
  open(ws, send, { cwd, cols, rows, shell }) {
    if (!cwd || !existsSync(cwd) || !statSync(cwd).isDirectory()) throw new Error(`Folder tidak ditemukan: ${cwd}`);
    const sh = SHELLS[shell] || SHELLS.powershell;
    const id = randomUUID();
    const p = pty.spawn(sh.file, sh.args, {
      name: "xterm-256color", cwd,
      cols: Math.max(2, cols | 0 || 80), rows: Math.max(2, rows | 0 || 24),
      env: process.env, useConpty: true,
    });
    this.items.set(id, { pty: p, ws });
    p.onData((data) => send({ type: "term:data", tid: id, data }));
    p.onExit(({ exitCode }) => {
      this.items.delete(id);
      send({ type: "term:exit", tid: id, code: exitCode });
    });
    return id;
  }

  get(id) {
    const t = this.items.get(id);
    if (!t) throw new Error("Terminal sudah ditutup.");
    return t.pty;
  }

  write(id, data) { this.get(id).write(String(data)); }

  resize(id, cols, rows) {
    if (cols > 1 && rows > 1) this.get(id).resize(cols | 0, rows | 0);
  }

  close(id) {
    const t = this.items.get(id);
    if (!t) return;
    this.items.delete(id);
    try { t.pty.kill(); } catch {}
  }

  /** Klien terputus / UI di-reload → shell-nya ikut dimatikan supaya tidak jadi proses yatim. */
  closeFor(ws) {
    for (const [id, t] of this.items) if (t.ws === ws) this.close(id);
  }

  closeAll() {
    for (const id of [...this.items.keys()]) this.close(id);
  }
}
