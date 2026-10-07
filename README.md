# ASAP — Agent Supervision & Approval Platform

> Agent yang kerja, kamu yang approve. Beres ASAP.

Nama produk **ASAP** (dulu *ADE*, inisial pembuat: ASAP / AGILS121). Nama internal tetap `ade`:
folder repo, `ade.exe` saat dev, identifier `id.tuvnord.ade`, data `%APPDATA%\ade\`, env `ADE_*` —
sengaja tidak diganti supaya data tim yang sudah ada tetap terbaca.

Ikon: desain dev (monogram garis lengkung, latar hitam) yang dirapikan — garis ditebalkan, glyph diperbesar, lengkung bawah beraksen biru ASAP `#5AA9FF`. Sumber `src-tauri/icons/app-icon.svg` (juga dipakai di header:
`src/assets/asap-icon.svg`). Generate ulang semua ukuran: `npx tauri icon src-tauri/icons/app-icon.svg -o <folder sementara>`,
lalu salin hanya file yang sudah ada di `src-tauri/icons/` (folder android/ios tidak dipakai).

Dashboard orkestrasi agent Claude (multi-project) tanpa Electron.
Tauri 2 (WebView2) + sidecar Node (Claude Agent SDK) via WebSocket lokal (port acak + token sesi).

```
src/            UI (vanilla JS)          → nanti 4 kolom: Folder · Agentic Running · Perubahan · Saran Claude
src-tauri/      shell Rust               → spawn sidecar saat start, kill saat window ditutup
sidecar/        server.mjs (Agent SDK)   → spike.mjs = uji login/canUseTool/RAM
```

## Jalankan (dev)
```
cd src-tauri && cargo build -j 2     # -j 2: build paralel penuh bikin rustc crash di crate `windows`
target\debug\ade.exe
```
Sidecar memakai `node` sistem + `sidecar/` di repo (belum di-bundle sebagai externalBin).

## Hasil Fase 0 (2026-10-06)
- Login: Agent SDK memakai login Claude Code yang ada (`apiKeySource: none`) — tidak perlu API key.
- `canUseTool` mencegat aksi tulis (Write) sebelum terjadi; deny → file tidak dibuat, agent dapat alasannya.
- Agent ikut memuat `~/.claude/CLAUDE.md` + hook SessionStart user (identitas, aturan, memory).
- RAM: UI (ade.exe + WebView2) ±380 MB working set; per agent aktif ±440 MB puncak.
- Gotcha: cwd yang tidak ada dilaporkan SDK sebagai "native binary failed to launch" → sidecar validasi cwd sendiri.

## Fase 1 (2026-10-06)
- Panel Folder: grup **Registry** (live dari `~/.claude/project-registry.json`) + folder manual
  (`%APPDATA%/ade/folders.json`). Folder manual yang bukan repo = **folder induk**: dipindai live
  (maks 3 level, lewati node_modules/vendor/dist/storage/folder tersembunyi) untuk mencari repo git.
- Keamanan sidecar: port acak (`ADE_READY {port, token}` di stdout → dibaca Rust → `invoke("sidecar_info")`),
  koneksi tanpa token ditolak 401 (halaman web mana pun bisa membuka ws://127.0.0.1).
- Sidecar keluar sendiri saat pipe stdin dari ADE tertutup (ADE crash / di-kill) → tidak ada agent yatim.
  Tes manual dari terminal: `ADE_STANDALONE=1 ADE_PORT=4318 node sidecar/server.mjs`.

## Fase 2+3 (2026-10-06) — agent per task + Saran Claude
- **+ Task baru** (project terpilih): judul, instruksi, model (default Sonnet). Sidecar membuat
  `git worktree` dari HEAD di `D:/HSD/.ade-worktrees/<repo>/<task>` (branch `ade/<task>`), lalu agent jalan di sana.
  Perubahan yang belum di-commit di repo asli **tidak ikut**; worktree tanpa vendor/node_modules/.env →
  agent diinstruksikan hanya membaca & mengedit kode (keputusan dev: opsi a).
- Status task: Menyiapkan → Running ⇄ Menunggu izin → Need review / Selesai / Error / Dihentikan / Terputus.
  Disimpan di `%APPDATA%/ade/tasks.json`; agent tidak bertahan saat ADE ditutup (status jadi Terputus).
- **Saran Claude** = `canUseTool`: setiap Edit/Write/Bash menunggu Setuju/Tolak (alasan tolak dikirim ke agent).
  Edit file di luar worktree **ditolak otomatis**. Semua keputusan → `%APPDATA%/ade/decisions.jsonl`.
- Tes otomatis: `ADE_DEV_TOKEN`, `ADE_WORKTREE_ROOT`, `APPDATA` bisa di-override lewat env saat menjalankan ade.exe.

## Fase 4 (2026-10-06) — kolom Perubahan
- Klik kartu task → diff per file (tab, status A/M/D, +/−) terhadap commit dasar task; task yang baru
  selesai otomatis terpilih. File baru ikut terlihat (`git add -N` di worktree).
- **Approve** = `git add -A` + commit di branch `ade/<task>` (pesan: judul + instruksi + catatan revisi;
  **tanpa** trailer/atribusi AI — preferensi dev). Merge ke branch kerja tetap manual.
- **Minta revisi** = lanjutkan sesi agent yang sama (`resume: sessionId`) di worktree yang sama.
- **Bersihkan worktree** (setelah approve, dengan konfirmasi) = `git worktree remove`; branch tetap ada.
  Ditolak kalau worktree masih berisi perubahan yang belum di-approve.
- Gotcha: pesan `result` agent tiba beberapa detik SEBELUM prosesnya tertutup → aksi lanjutan menunggu
  proses selesai (maks 15 dtk), bukan menolak.

## Pohon file + Terminal (2026-10-07)
- **Pohon file** di kolom Perubahan (ganti kotak cari): isi folder diambil per level saat dibuka,
  tanda status git A/M/D, filter nama file (`git ls-files`). Root = worktree task yang dipilih, atau
  repo yang dipilih di kolom Folder (klik folder = jelajahi repo itu). Sidecar hanya melayani repo yang
  ada di daftar Folder + worktree task; path di luar root ditolak (`sidecar/files.mjs`).
- **Terminal** (`›_ Terminal` di header / Ctrl+`): PowerShell interaktif via `node-pty` (prebuilt win32-x64)
  + xterm.js (`src/vendor/`, disalin dari `node_modules/@xterm`). Dibuka di worktree/repo terpilih,
  multi-tab, tinggi panel bisa ditarik. Ini shell milik dev — **tidak** lewat Saran Claude.
  Shell dimatikan saat koneksi UI putus / ADE ditutup (`sidecar/terminal.mjs`).
- Update xterm: `npm update @xterm/xterm @xterm/addon-fit` lalu salin ulang `xterm.js`, `xterm.css`, `addon-fit.js` ke `src/vendor/`.

## Mode fokus + tab Git (2026-10-07)
- **Mode fokus**: tombol ⤢ di header tiap kartu → kartu itu selebar layar; ⤡ / Esc kembali. Diingat per viewer.
- **Tab Git** di kolom ke-3 (`Jelajah | Git`), root sama dengan pohon file (repo terpilih / worktree task):
  - Graph commit (SVG, `git log --date-order`, 200 per halaman, toggle *Semua branch* = `--all`), label branch/tag.
    Klik commit → detail + file + diff (merge dibanding parent pertama).
  - Perubahan belum di-commit: checkbox stage/unstage per file / semua, diff per file (untracked ikut),
    pesan + **Commit** (Ctrl+Enter). Hook repo tetap jalan; tanpa trailer/atribusi AI.
  - Diblok kalau repo sedang merge/rebase/cherry-pick. Tiap commit dicatat ke `decisions.jsonl` (`action: git-commit`).
  - **Tidak ada** push/pull/checkout — tetap lewat terminal (keputusan dev).

## Ahead/behind, Brain Vault, highlight, Ctrl+F, tes (2026-10-07)
- **Ahead/behind**: tab Git menampilkan `⎇ branch ↑ahead ↓behind` terhadap upstream (data fetch terakhir;
  ADE tidak fetch sendiri). Tanpa upstream → "tanpa upstream".
- **Brain Vault** (`sidecar/vault.mjs`): file simlab-v2 (FE/BE) yang dibuka → badge `🔥 hotspot · N bug` /
  `🐞 N bug` + panel riwayat bug, selalu dengan catatan batasan vault. Repo dikenali dari registry atau nama
  folder `*simlab-v2-fe|be`; worktree task dicocokkan lewat repo asalnya. Index async, dibaca ulang tiap 60 dtk.
  Laptop tanpa `D:\HSD\brain-vault` (atau `ADE_VAULT`) → fitur diam.
- **Syntax highlighting** tanpa library (PHP, Blade, JS/TS, JSON, CSS, SQL, Python, HTML, shell/YAML) di
  File lengkap dan diff. Baris > 1000 karakter / file > 400 KB ditampilkan polos.
- **Ctrl+F / ⌕ Cari** di file & diff: tandai baris cocok, Enter / Shift+Enter pindah hasil, Esc tutup.
- **Tes**: `npm test` (repo dummy + APPDATA sementara, tidak menyentuh repo asli): protokol sidecar
  (folder, pohon, terminal, git, vault) + UI lewat Edge headless. `npm test -- --no-ui` untuk protokol saja.

## Todo + pengingat (2026-10-07)
- Tombol **☑ Todo** di header / Ctrl+Shift+T → laci kanan (default tertutup). Badge merah = task lewat waktu.
- Ketik bebas, mis. `deploy prod jam 5`; jam dibaca `src/todo-parse.js` dan **dipratinjau sebelum disimpan**
  (× di chip untuk membuang jam / label project). Aturan: `17:00`/`17.30` apa adanya; `jam 1–6` tanpa keterangan
  = siang/sore; `pagi/siang/sore/malam`, `besok`, `lusa` dikenali; jam yang sudah lewat → besok.
- Label project = project terpilih saat task dibuat; filter *Semua / Project terpilih*. Double-click untuk edit.
- Disimpan sidecar di `%APPDATA%\ade\todos.json` (`sidecar/todos.mjs`). Pengingat dicek tiap 20 dtk →
  notifikasi Windows lewat WinRT/PowerShell (tanpa paket). Hanya selama ASAP terbuka; yang terlewat dikirim
  saat start. Build dev: pengirim notifikasi tampil "Windows PowerShell"; versi terpasang: atas nama ASAP.
  Env tes: `ASAP_NO_TOAST=1`, `ASAP_TODO_TICK_MS`.

## Rilis & instalasi untuk tim DTIT
**Build installer** (di laptop yang punya Node 22 + Rust):
```
copy C:\nvm4w\nodejs\node.exe src-tauri\resources\node\node.exe   # node.exe dibawa di dalam paket
set CARGO_BUILD_JOBS=2
npm run tauri build
```
Hasil: `src-tauri\target\release\bundle\nsis\ADE_<versi>_x64-setup.exe`.
Paket berisi node.exe + sidecar + claude.exe (mesin agent) → laptop pemakai **tidak** butuh Node,
Claude Code, maupun folder repo ini.

**Pasang** (per-user, tanpa admin): jalankan setup.exe → `%LOCALAPPDATA%\Programs\ADE`.

**Pertama kali dipakai**
1. Kalau header menampilkan *Belum login Claude*, klik → jendela `claude auth login` terbuka → login
   di browser dengan akun Claude masing-masing. Status di header berubah otomatis.
2. Tambah folder induk project (mis. `D:\HSD\SIMLAB`) di kolom Folder.
3. Worktree agent: `D:\HSD\.ade-worktrees` kalau ada `D:\HSD`, selain itu `%USERPROFILE%\.ade-worktrees`.

Data per user: `%APPDATA%\ade\` (folders.json, tasks.json, decisions.jsonl).
Kuota: agent memakai langganan Claude milik yang login — dipakai bersama CLI & claude.ai.
