// Fase 0 spike: cek login SDK, intersepsi canUseTool, dan RAM proses agent.
//   node spike.mjs <cwd-kosong>
import { query } from "@anthropic-ai/claude-agent-sdk";
import { execSync } from "node:child_process";

const cwd = process.argv[2];
if (!cwd) throw new Error("usage: node spike.mjs <cwd>");

const permissionLog = [];
let peakMb = 0;

function sampleRam() {
  // total working set semua proses turunan spike ini (agent CLI dkk)
  try {
    const out = execSync(
      `powershell -NoProfile -Command "$p=Get-CimInstance Win32_Process; function kids($id){ $p | ? ParentProcessId -eq $id | % { $_; kids $_.ProcessId } }; (kids ${process.pid} | ? { $_.Name -notmatch '^(powershell|cmd|conhost)' } | % { (Get-Process -Id $_.ProcessId -EA SilentlyContinue).WorkingSet64 } | Measure-Object -Sum).Sum"`,
      { encoding: "utf8" }
    );
    const mb = Math.round(Number(out.trim() || 0) / 1048576);
    if (mb > peakMb) peakMb = mb;
  } catch {}
}
const timer = setInterval(sampleRam, 1500);

const q = query({
  prompt: "Buat file hello.txt berisi kata 'halo'. Lalu jawab satu kalimat: selesai atau tidak.",
  options: {
    cwd,
    maxTurns: 3,
    permissionMode: "default",
    ...(process.env.ADE_MODEL ? { model: process.env.ADE_MODEL } : {}),
    canUseTool: async (toolName, input) => {
      permissionLog.push({ toolName, input });
      return { behavior: "deny", message: "Ditolak oleh spike ADE (uji canUseTool)." };
    },
  },
});

let initInfo = null;
let result = null;
for await (const msg of q) {
  if (msg.type === "system" && msg.subtype === "init") {
    initInfo = { model: msg.model, apiKeySource: msg.apiKeySource, permissionMode: msg.permissionMode };
  }
  if (msg.type === "result") result = msg;
}
clearInterval(timer);
sampleRam();

console.log(JSON.stringify({
  init: initInfo,
  permissionRequests: permissionLog.map((p) => p.toolName),
  resultSubtype: result?.subtype,
  isError: result?.is_error,
  answer: result?.result,
  costUsd: result?.total_cost_usd,
  durationMs: result?.duration_ms,
  peakAgentRamMb: peakMb,
}, null, 2));
