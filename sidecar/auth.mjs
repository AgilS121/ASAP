// Status login Claude untuk agent ADE + membuka jendela login.
// Hanya memeriksa KEBERADAAN kredensial — isi token tidak pernah dibaca keluar / dikirim ke UI.
import { existsSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const CREDENTIALS = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), ".credentials.json");
const HERE = dirname(fileURLToPath(import.meta.url));
// claude.exe bawaan Agent SDK = Claude Code CLI; tim tidak perlu memasang Claude Code terpisah
const CLAUDE_EXE = join(HERE, "node_modules", "@anthropic-ai", "claude-agent-sdk-win32-x64", "claude.exe");

export function authStatus() {
  if (process.env.ANTHROPIC_API_KEY) return { loggedIn: true, method: "API key (ANTHROPIC_API_KEY)" };
  try {
    const oauth = JSON.parse(readFileSync(CREDENTIALS, "utf8")).claudeAiOauth;
    if (oauth?.refreshToken || oauth?.accessToken) {
      return { loggedIn: true, method: oauth.subscriptionType ? `langganan Claude (${oauth.subscriptionType})` : "akun Claude" };
    }
  } catch {}
  return { loggedIn: false, method: null };
}

/** Buka jendela konsol yang menjalankan `claude auth login` (alur login di browser). */
export function openLogin() {
  if (!existsSync(CLAUDE_EXE)) throw new Error(`claude.exe tidak ditemukan: ${CLAUDE_EXE}`);
  // `start` membuka konsol baru yang terpisah dari sidecar (sidecar sendiri tidak punya jendela)
  spawn("cmd.exe", ["/c", "start", "ASAP - Login Claude", CLAUDE_EXE, "auth", "login"], { detached: true, stdio: "ignore", windowsHide: false }).unref();
}
