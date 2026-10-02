// ═══════════════════════════════════════════════════════════════════════
// API AI · Jembatan AI Generatif Ganespic XXV — v3 (multi-source, API only)
// ═══════════════════════════════════════════════════════════════════════
// TANPA fallback offline/JS. Kalau AI generatif tidak aktif, error, atau
// timeout, API hanya mengembalikan pesan error — tidak ada jawaban cadangan.
// Konteks yang diambil tiap request (cache 5 menit):
//   1. Anggota + Agenda  → database Neon (Postgres)
//   2. Kas Angkatan      → Supabase REST API (tabel `kas`)
//   3. Galeri Angkatan   → scrape HTML galery.ganespic.workers.dev
//   4. Struktural MPK    → scrape script.js dari mpk-ganespic.vercel.app
// ==============================================================================
import { neon } from '@neondatabase/serverless';

const KAS_SUPA_URL = process.env.KAS_SUPABASE_URL || 'https://suuchcvorzzgyjqivfvo.supabase.co';
const KAS_SUPA_KEY = process.env.KAS_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InN1dWNoY3Zvcnp6Z3lqcWl2ZnZvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODU4NzQ0NDcsImV4cCI6MjEwMTQ1MDQ0N30._thrDYitpRFmdL8D9mZ1hvqaB5BAwgOOBwPAAg4Ztlk';
const GALERI_URL = process.env.GALERI_URL || 'https://galery.ganespic.workers.dev/';
const MPK_URL = process.env.MPK_URL || 'https://mpk-ganespic.vercel.app/';

let cache = { ts: 0, data: null };
const CACHE_TTL = 5 * 60 * 1000;

// Helper: fetch dengan timeout
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const id = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    return res;
  } finally {
    clearTimeout(id);
  }
}

async function fetchKasData() {
  try {
    const res = await fetchWithTimeout(
      `${KAS_SUPA_URL}/rest/v1/kas?select=*&order=tanggal.desc&limit=100`,
      { headers: { 'apikey': KAS_SUPA_KEY, 'Authorization': `Bearer ${KAS_SUPA_KEY}` } },
      8000
    );
    if (!res.ok) return null;
    return await res.json();
  } catch (e) { console.warn('fetchKasData error:', e.message); return null; }
}

function stripHtml(html) {
  return String(html || '')
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>')
    .replace(/"/g, '"').replace(/'/g, "'")
    .replace(/\s+/g, ' ').trim();
}

async function fetchGaleriText() {
  try {
    // Galeri adalah SPA (React) - ambil halaman & cari data di script tags atau fallback ke URL
    const res = await fetchWithTimeout(GALERI_URL, { headers: { 'Accept': 'text/html' } }, 8000);
    if (!res.ok) return null;
    const html = await res.text();
    // Coba cari JSON data di script tags (next.js/vite data)
    const jsonMatches = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/i) ||
                        html.match(/<script[^>]*type="application\/json"[^>]*>([\s\S]*?)<\/script>/i);
    if (jsonMatches) {
      try {
        const data = JSON.parse(jsonMatches[1]);
        return JSON.stringify(data).slice(0, 5000);
      } catch (e) { /* fallback */ }
    }
    // Fallback: strip HTML tapi berikan URL galeri
    return `Galeri Ganespic XXV (SPA - data dinamis). Buka langsung: ${GALERI_URL}\nAlbum: Kelas 8 MTs, Kelas 9 MTs, Kelas 10 MA, Football Usman vs Tansri, dll.\n${stripHtml(html).slice(0, 2000)}`;
  } catch (e) { console.warn('fetchGaleriText error:', e.message); return `Galeri: ${GALERI_URL} (tidak dapat di-scrape, SPA)`; }
}

async function fetchMPKData() {
  try {
    const res = await fetchWithTimeout(MPK_URL + 'script.js', {}, 8000);
    if (!res.ok) return null;
    const js = await res.text();
    // Cari dataMPK object - lebih robust
    const start = js.indexOf('const dataMPK');
    if (start === -1) return null;
    // Cari akhir object - handle nested braces
    let braceCount = 0;
    let end = start;
    let foundFirstBrace = false;
    for (let i = start; i < js.length; i++) {
      if (js[i] === '{') { braceCount++; foundFirstBrace = true; }
      else if (js[i] === '}') { braceCount--; if (foundFirstBrace && braceCount === 0) { end = i + 1; break; } }
    }
    if (end <= start) end = start + 6000;
    return js.slice(start, end).slice(0, 8000);
  } catch (e) { console.warn('fetchMPKData error:', e.message); return null; }
}

function formatKas(rows, question) {
  if (!rows || !rows.length) return '(belum ada transaksi kas tercatat)';
  let masuk = 0, keluar = 0;
  rows.forEach(r => { if (r.jenis === 'masuk') masuk += (r.nominal || 0); else keluar += (r.nominal || 0); });
  const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');

  // Ringkasan SELALU ikut (lengkap, bukan sampel) + transaksi relevan bila ada
  let chosen = [];
  const tokens = tokenize(question);
  if (tokens.length) {
    chosen = rows.filter(r => {
      const s = ((r.keterangan || '') + ' ' + r.tanggal + ' ' + r.jenis).toLowerCase();
      return tokens.some(t => s.includes(t));
    });
  }
  const dipakai = (chosen.length ? chosen : rows).slice(0, 20);
  const rowsTxt = dipakai.map(r =>
    `- ${r.tanggal} | ${r.jenis === 'masuk' ? 'MASUK' : 'KELUAR'} | ${fmt(r.nominal)} | ${(r.keterangan || '-').slice(0, 40)}`
  ).join('\n');

  return `RINGKASAN KAS (SEMUA TRANSAKSI, total ${rows.length}):\n- Total Pemasukan: ${fmt(masuk)}\n- Total Pengeluaran: ${fmt(keluar)}\n- Saldo Kas: ${fmt(masuk - keluar)}\n\nRIWAYAT TRANSAKSI:\n${rowsTxt}`;
}

function potong(teks, max) {
  const s = String(teks || '');
  return s.length > max ? s.slice(0, max) + ' …(dipotong)' : s;
}

// Kata umum yang TIDAK boleh dipakai untuk mencocokkan nama (bikin semua baris jadi cocok)
const STOPWORD = new Set(['apa', 'saya', 'kamu', 'kau', 'dong', 'tolong', 'boleh', 'banget', 'adalah',
  'anggota', 'nama', 'ultah', 'ulang', 'tahun', 'lahir', 'event', 'acara', 'agenda', 'kegiatan', 'jadwal',
  'siapa', 'kapan', 'dimana', 'berapa', 'jumlah', 'total', 'kas', 'uang', 'saldo', 'hari', 'tanggal',
  'bulan', 'ini', 'dan', 'atau', 'itu', 'yang', 'untuk', 'dari', 'pada', 'dengan', 'bisa',
  'gimana', 'bagaimana', 'kenapa', 'mengapa', 'minta', 'mohon', 'info', 'informasi', 'data',
  'banyak', 'cek', 'lihat', 'buka', 'kasih', 'tahu', 'tau', 'contoh', 'nomor', 'panggilan', 'gelar']);

function tokenize(q) {
  return String(q || '').toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').split(/\s+/)
    .filter(t => t.length >= 3 && !STOPWORD.has(t));
}

const BULAN = ['januari', 'februari', 'maret', 'april', 'mei', 'juni', 'juli', 'agustus', 'september', 'oktober', 'november', 'desember'];

// Susun konteks SESUAI pertanyaan: data relevan dikirim LENGKAP,
// hanya data yang tidak nyambung yang tidak ikut (hemat token, tetap akurat).
function susunAnggota(anggota, question) {
  if (!anggota) return '(db belum terhubung)';
  const total = anggota.length;
  const tokens = tokenize(question);
  const fmt = (a, withPanggilan) =>
    `- ${a.nama_lengkap} | No.ID ${a.no_induk} | Lahir ${a.tanggal_lahir || '-'}` +
    (withPanggilan && a.nama_panggilan ? ' | Panggilan ' + a.nama_panggilan : '');

  // 1) Pertanyaan menyebut nama / No.ID → semua yang cocok, LENGKAP
  if (tokens.length) {
    const scored = anggota.map(a => {
      const s = ((a.nama_lengkap || '') + ' ' + (a.nama_panggilan || '') + ' ' + (a.no_induk || '')).toLowerCase();
      const hit = tokens.filter(t => s.includes(t));
      return { a, hit, skor: hit.reduce((n, t) => n + t.length, 0) };
    }).filter(x => x.hit.length);

    if (scored.length) {
      const maxSkor = Math.max.apply(null, scored.map(x => x.skor));
      const kuat = scored.filter(x => x.skor === maxSkor && x.hit.some(t => t.length >= 4));
      const pilihan = (kuat.length ? kuat : scored).slice(0, 40);
      return `TOTAL ANGGOTA: ${total} (di bawah ini ${pilihan.length} anggota yang cocok dengan pertanyaan — LENGKAP, sisanya tidak relevan)\n` +
        pilihan.map(x => fmt(x.a, true)).join('\n');
    }
  }

  // 2) Pertanyaan umum → roster LENGKAP semua anggota
  return `TOTAL ANGGOTA: ${total} (daftar lengkap semua anggota):\n` + anggota.map(a => fmt(a, false)).join('\n');
}

function bulanDariPertanyaan(q) {
  const lower = String(q || '').toLowerCase();
  const byName = BULAN.findIndex(b => new RegExp('\\b' + b + '\\b').test(lower));
  if (byName !== -1) return byName;
  const m = lower.match(/bulan\s*(\d{1,2})/);
  if (m) {
    const n = parseInt(m[1], 10);
    if (n >= 1 && n <= 12) return n - 1;
  }
  return -1;
}

function susunAgenda(agenda, question) {
  if (!agenda) return '(db belum terhubung)';
  const total = agenda.length;
  const q = String(question || '').toLowerCase();
  const tokens = tokenize(question);

  // 1) Menyebut bulan → hanya agenda bulan itu, LENGKAP
  const bulanAda = bulanDariPertanyaan(q);
  if (bulanAda !== -1) {
    const mm = String(bulanAda + 1).padStart(2, '0');
    const list = agenda.filter(n => String(n.tanggal || '').slice(5, 7) === mm);
    if (list.length) {
      return `AGENDA (${total} total; semua agenda bulan ${BULAN[bulanAda]} — LENGKAP):\n` + list.map(fmtAgenda).join('\n');
    }
  }

  // 2) Menyebut ultah / event → kategori itu, LENGKAP
  const mauUltah = /\bultah\b|ulang ?tahun|birthday|\bhbd\b/.test(q);
  const mauEvent = /\bevent\b|\bacara\b|\bmakrab\b|\bdies\b|gathering|pentas|perayaan|syukuran/.test(q);
  if (mauUltah && !mauEvent) {
    const list = agenda.filter(n => n.tipe === 'ultah');
    if (list.length) return `AGENDA ULTAH (${list.length} dari ${total}; event tidak ditampilkan):\n` + list.map(fmtAgenda).join('\n');
  }
  if (mauEvent && !mauUltah) {
    const list = agenda.filter(n => n.tipe === 'event');
    if (list.length) return `AGENDA EVENT (${list.length} dari ${total}; ultah tidak ditampilkan):\n` + list.map(fmtAgenda).join('\n');
  }
  if (mauEvent && mauUltah) {
    return `AGENDA LENGKAP (${total} — ultah & event):\n` + agenda.map(fmtAgenda).join('\n');
  }

  // 3) Menyebut judul agenda → semua yang cocok, LENGKAP
  if (tokens.length) {
    const cocok = agenda.filter(n => {
      const s = ((n.nama_judul || '') + ' ' + (n.deskripsi_nis || '')).toLowerCase();
      return tokens.some(t => s.includes(t));
    });
    if (cocok.length) {
      return `AGENDA (${total} total; ${cocok.length} yang cocok — LENGKAP):\n` + cocok.map(fmtAgenda).join('\n');
    }
  }

  // 4) Pertanyaan umum → agenda LENGKAP
  return `AGENDA LENGKAP (${total} total — semua ultah & event):\n` + agenda.map(fmtAgenda).join('\n');
}

function fmtAgenda(n) {
  return `- [${n.tipe}] ${n.nama_judul} | ${n.tanggal}${n.deskripsi_nis ? ' | ' + n.deskripsi_nis : ''}${n.is_tetap ? '' : ' (sekali)'}`;
}

async function getContext(question) {
  if (!cache.data) {
    const cs = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
    const [anggota, agenda, kasRows, galeriText, mpkData] = await Promise.all([
      cs ? (async () => { try { return await neon(cs)`SELECT no_induk, nama_lengkap, nama_panggilan, tanggal_lahir FROM anggota ORDER BY no_induk ASC LIMIT 400;`; } catch (e) { return null; } })() : Promise.resolve(null),
      cs ? (async () => { try { return await neon(cs)`SELECT tipe, nama_judul, deskripsi_nis, tanggal, is_tetap FROM agendas ORDER BY tanggal ASC LIMIT 300;`; } catch (e) { return null; } })() : Promise.resolve(null),
      fetchKasData(), fetchGaleriText(), fetchMPKData()
    ]);
    cache = { ts: Date.now(), data: { anggota, agenda, kasRows, galeriText, mpkData } };
  }

  const c = cache.data;
  // ⚠️ Potongan hanya sebagai pengaman terakhir (free tier Groq ~8.000 token/menit).
  // Data relevan sudah diseleksi penuh di atas, jadi jawaban tetap akurat.
  return {
    anggotaTxt: potong(susunAnggota(c.anggota, question), 12000),
    agendaTxt: potong(susunAgenda(c.agenda, question), 5000),
    kasTxt: potong(formatKas(c.kasRows, question), 2000),
    galeriTxt: potong(c.galeriText || '(galeri tidak dapat diakses)', 800),
    mpkTxt: potong(c.mpkData || '(MPK tidak dapat diakses)', 2000)
  };
}

// ── Tanpa fallback offline ──
// Kalau AI generatif tidak aktif / error / timeout, API hanya balas error.
// Tidak ada lagi jawaban cadangan berbasis JS di server.
const PESAN_TIDAK_AKTIF = 'AI belum aktif. Pastikan env AI_API_KEY terisi di Vercel (Settings → Environment Variables).';
const PESAN_ERROR = 'AI sedang error. Gagal mendapatkan jawaban dari server. Coba lagi sebentar.';
const PESAN_TIMEOUT = 'AI timeout. Server terlalu lama merespons, coba lagi sebentar.';
const PESAN_MODEL_SALAH = 'Model AI tidak tersedia di akun ini. Coba ubah env AI_MODEL di Vercel ke: openai/gpt-oss-120b atau openai/gpt-oss-20b.';
const PESAN_SIBUK = 'AI sedang sibuk (kena rate limit). Tunggu sekitar 20 detik lalu coba lagi.';

// Model gratis Groq yang tersedia untuk key ini (fallback otomatis bila AI_MODEL tidak cocok)
const MODEL_CADANGAN = ['openai/gpt-oss-120b', 'openai/gpt-oss-20b'];

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  // Trim & sanitasi env — kebal spasi/tab/kutip tak sengaja saat isi di Vercel
  const rawKey = (process.env.AI_API_KEY || '');
  const AI_API_KEY = rawKey.trim().replace(/^["']+|["']+$/g, '').replace(/\s+/g, '');
  const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.groq.com/openai/v1').trim().replace(/^["']+|["']+$/g, '').replace(/\/+$/, '');
  const AI_MODEL = (process.env.AI_MODEL || 'openai/gpt-oss-120b').trim().replace(/^["']+|["']+$/g, '');
  // Debug token (untuk diagnosa key di server)
  const AI_KEY_LEN = AI_API_KEY.length;
  const AI_KEY_HEAD = AI_API_KEY.slice(0, 6);

  // GET → cek status (dipakai front-end untuk tahu apakah AI generatif aktif)
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!AI_API_KEY, model: AI_API_KEY ? AI_MODEL : null, keyLen: AI_API_KEY ? AI_KEY_LEN : 0 });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Kalau key belum diisi → balas error, tanpa jawaban cadangan
  if (!AI_API_KEY) {
    return res.status(200).json({ configured: false, answer: null, model: null, error: PESAN_TIDAK_AKTIF });
  }
  try {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { /* abaikan */ }
    }
    body = body || {};
    const question = String(body.question || '').trim().slice(0, 1500);
    if (!question) return res.status(400).json({ error: 'Question wajib diisi' });

    // ── Ambil konteks dari SEMUA sumber (DB + kas + galeri + MPK), cache 5 menit ──
    // Konteks disusun sesuai pertanyaan (data relevan dikirim lengkap).
    const ctx = await getContext(question);

    const systemPrompt = `Kamu adalah "AI Ganespic XXV", asisten virtual resmi Angkatan XXV Ganespic.
Tugasmu menjawab SEMUA pertanyaan seputar website & informasi angkatan: anggota, ulang tahun, event/agenda, keuangan kas, galeri foto, dan struktur organisasi MPK.
Jawab dalam Bahasa Indonesia santai & ramah (maksimal 200 kata). Gunakan poin-poin bila membantu.

HALAMAN & TAUTAN:
- Beranda: https://ganespic.vercel.app/
- Anggota: https://ganespic.vercel.app/anggota
- Kas Angkatan: https://kas-ganespic.vercel.app/
- Struktural MPK: https://mpk-ganespic.vercel.app/
- Galeri: ${GALERI_URL}
- Kalender: https://ganespic.vercel.app/kalender

DATA ANGGOTA (No.ID, nama, tanggal lahir):
${ctx.anggotaTxt}

DATA AGENDA (ultah & event):
${ctx.agendaTxt}

DATA KAS ANGKATAN:
${ctx.kasTxt}

DATA STRUKTURAL MPK (JavaScript object dari web MPK):
${ctx.mpkTxt}

DATA GALERI (teks dari halaman galeri):
${ctx.galeriTxt}

PANDUAN:
1. KAS: Jika ditanya saldo/pemasukan/pengeluaran/transaksi kas, jawab dari DATA KAS di atas dengan angka Rupiah lengkap (misal Rp 6.821.000). Jangan hanya kasih link.
2. MPK/STRUKTURAL: Jika ditanya "ketua angkatan siapa", "siapa bendahara", "divisi apa saja", jawab dari DATA STRUKTURAL MPK di atas. Ketua Angkatan ada di field ketuaAngkatan.
3. GALERI: Jika ditanya galeri/foto/album/kegiatan, jawab dari DATA GALERI di atas.
4. ULTAH: Sebutkan nama, tanggal lengkap, dan umur (hitung dari tahun lahir ke tahun sekarang).
5. EVENT: Sebutkan judul, tanggal, dan deskripsi.
6. JUMLAH: pakai angka TOTAL yang tertulis di data, bukan hasil hitung baris yang ditampilkan.
7. Data di atas sudah disaring sesuai pertanyaan — yang tidak ditampilkan TIDAK relevan.
8. Jika data yang ditanya tidak ada di daftar, jujur katakan "belum ada data" — JANGAN menebak atau berhalusinasi.`;

    // ── Panggil LLM (OpenAI-compatible) — timeout 30 detik per percobaan ──
    // Model dari env dipakai pertama; kalau provider menolak (mis. model tidak ada),
    // coba model gratis cadangan. Tetap model AI asli, bukan fallback JS.
    const daftarModel = [AI_MODEL, ...MODEL_CADANGAN.filter(m => m !== AI_MODEL)];
    let modelDipakai = AI_MODEL;
    let resp = null;
    let lastErr = null;

    for (const model of daftarModel) {
      // Model gpt-oss adalah reasoning model: pakai reasoning_effort rendah
      // supaya token tidak habis untuk "berpikir" dan jawaban tetap keluar.
      const bodyReq = {
        model,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        max_tokens: 600
      };
      if (/gpt-oss/i.test(model)) bodyReq.reasoning_effort = 'low';
      else bodyReq.temperature = 0.4;

      let percobaan;
      try {
        percobaan = await fetchWithTimeout(`${AI_BASE_URL}/chat/completions`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${AI_API_KEY}`
          },
          body: JSON.stringify(bodyReq)
        }, 20000);
      } catch (e) {
        const isTimeout = e && (e.name === 'AbortError' || /abort|timeout/i.test(e.message || ''));
        console.error('AI bridge timeout/error:', e && e.message);
        return res.status(200).json({
          configured: true, answer: null, model,
          error: isTimeout ? PESAN_TIMEOUT : PESAN_ERROR
        });
      }

      if (percobaan.ok) { resp = percobaan; modelDipakai = model; break; }

      const errText = await percobaan.text().catch(() => '');
      lastErr = { status: percobaan.status, text: errText.slice(0, 300), model };
      console.error('AI API error', percobaan.status, model, lastErr.text);
      // 400/404 = model tidak tersedia → coba model gratis berikutnya
      if (percobaan.status === 404 || percobaan.status === 400 || percobaan.status === 429) continue;
      break;
    }

    if (!resp) {
      const modelTidakAda = lastErr && /model_not_found|does not exist/i.test(lastErr.text || '');
      const kenaLimit = lastErr && (lastErr.status === 429 || /rate limit/i.test(lastErr.text || ''));
      return res.status(200).json({
        configured: true,
        answer: null,
        model: modelDipakai,
        error: modelTidakAda ? PESAN_MODEL_SALAH : (kenaLimit ? PESAN_SIBUK : PESAN_ERROR),
        debug: { status: lastErr && lastErr.status, model: lastErr && lastErr.model, base: AI_BASE_URL }
      });
    }

    const data = await resp.json();
    const msg = (data && data.choices && data.choices[0] && data.choices[0].message) || {};
    const answer = msg.content || '';

    if (!answer.trim()) {
      return res.status(200).json({ configured: true, answer: null, model: modelDipakai, error: PESAN_ERROR });
    }

    return res.status(200).json({ configured: true, answer, model: modelDipakai });
  } catch (error) {
    console.error('AI bridge error:', error);
    return res.status(200).json({ configured: true, answer: null, error: PESAN_ERROR });
  }
}