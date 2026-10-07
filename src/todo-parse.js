// Baca waktu dari teks todo bebas, mis. "deploy prod jam 5", "rapat besok 09:30", "cek log jam 9 malam".
// Dipakai UI (pratinjau sebelum simpan) dan tests/run.mjs. Hasil selalu ditampilkan ke dev dulu,
// jadi tebakan yang keliru (mis. "jam 5" = 17:00) bisa dilihat dan dibuang sebelum disimpan.

const DAY_WORDS = { besok: 1, lusa: 2 };
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];
const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/**
 * @returns {{ dueAt: string, rolled: boolean } | null} rolled = jam sudah lewat hari ini → dipindah ke besok
 */
export function parseDue(text, now = new Date()) {
  const t = ` ${(text || "").toLowerCase()} `;
  let h = null, m = 0, explicit = false;

  // "jam 5", "pukul 17", "jam 5:30", "pkl 9.15"
  let mt = t.match(/(?:\bjam|\bpukul|\bpkl\.?)\s*(\d{1,2})(?:[:.](\d{2}))?(?!\d)/);
  if (mt && +mt[1] <= 23 && +(mt[2] || 0) <= 59) {
    h = +mt[1]; m = +(mt[2] || 0);
    explicit = h >= 13 || /^0\d$/.test(mt[1]);
  } else {
    // "17:00", "09.30" berdiri sendiri — bukan bagian dari angka versi seperti 0.3.0 / v1.10
    mt = t.match(/(?:^|[\s(])(\d{1,2})[:.](\d{2})(?![\d.:])/);
    if (mt && +mt[1] <= 23 && +mt[2] <= 59 && !/v$/.test(t.slice(0, mt.index + 1).trim())) {
      h = +mt[1]; m = +mt[2];
      explicit = h >= 13 || /^0\d$/.test(mt[1]);
    }
  }
  if (h === null) return null;

  const part = (t.match(/\b(pagi|siang|sore|petang|malam)\b/) || [])[1];
  if (!explicit) {
    if (part === "pagi") { if (h === 12) h = 0; }
    else if (part === "siang") { if (h < 11) h += 12; }
    else if (part === "sore" || part === "petang") { if (h < 12) h += 12; }
    else if (part === "malam") { if (h < 12 && h >= 6) h += 12; else if (h === 12) h = 0; else if (h < 6 && h > 0) h += 12; }
    else if (h >= 1 && h <= 6) h += 12; // tanpa keterangan: jam 1–6 hampir selalu siang/sore saat jam kerja
  }

  const day = Object.entries(DAY_WORDS).find(([w]) => new RegExp(`\\b${w}\\b`).test(t));
  const due = new Date(now);
  due.setHours(h, m, 0, 0);
  let rolled = false;
  if (day) due.setDate(due.getDate() + day[1]);
  else if (due <= now) { due.setDate(due.getDate() + 1); rolled = true; }
  return { dueAt: due.toISOString(), rolled };
}

const sameDay = (a, b) => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();
const hhmm = (d) => `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;

/** "hari ini 17:00", "besok 09:30", "kemarin 17:00", "Sen 13 Okt 17:00" */
export function dueLabel(iso, now = new Date()) {
  const d = new Date(iso);
  const plus = (n) => { const x = new Date(now); x.setDate(x.getDate() + n); return x; };
  if (sameDay(d, now)) return `hari ini ${hhmm(d)}`;
  if (sameDay(d, plus(1))) return `besok ${hhmm(d)}`;
  if (sameDay(d, plus(-1))) return `kemarin ${hhmm(d)}`;
  return `${HARI[d.getDay()]} ${d.getDate()} ${BULAN[d.getMonth()]} ${hhmm(d)}`;
}
