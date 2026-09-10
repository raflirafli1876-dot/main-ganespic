// ==============================================================================
// API AI · Jembatan AI Generatif Ganespic XXV — v2 (multi-source)
// ==============================================================================
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

function formatKas(rows) {
  if (!rows || !rows.length) return '(belum ada transaksi kas tercatat)';
  let masuk = 0, keluar = 0;
  rows.forEach(r => { if (r.jenis === 'masuk') masuk += (r.nominal || 0); else keluar += (r.nominal || 0); });
  const fmt = n => 'Rp ' + Number(n || 0).toLocaleString('id-ID');
  const rowsTxt = rows.slice(0, 30).map(r =>
    `- ${r.tanggal} | ${r.jenis === 'masuk' ? 'MASUK' : 'KELUAR'} | ${fmt(r.nominal)} | ${r.keterangan || '-'}`
  ).join('\n');
  return `RINGKASAN KAS:\n- Total Pemasukan: ${fmt(masuk)}\n- Total Pengeluaran: ${fmt(keluar)}\n- Saldo Kas: ${fmt(masuk - keluar)}\n- Jumlah transaksi: ${rows.length}\n\nRIWAYAT TRANSAKSI (terbaru dulu):\n${rowsTxt}`;
}

async function getContext() {
  if (cache.data && (Date.now() - cache.ts) < CACHE_TTL) return cache.data;
  const cs = process.env.POSTGRES_URL || process.env.DATABASE_URL || process.env.POSTGRES_PRISMA_URL || process.env.DATABASE_URL_UNPOOLED || process.env.POSTGRES_URL_NON_POOLING;
  const [anggota, agenda, kasRows, galeriText, mpkData] = await Promise.all([
    cs ? (async () => { try { return await neon(cs)`SELECT no_induk, nama_lengkap, nama_panggilan, tanggal_lahir FROM anggota ORDER BY no_induk ASC LIMIT 400;`; } catch (e) { return null; } })() : Promise.resolve(null),
    cs ? (async () => { try { return await neon(cs)`SELECT tipe, nama_judul, deskripsi_nis, tanggal, is_tetap FROM agendas ORDER BY tanggal ASC LIMIT 300;`; } catch (e) { return null; } })() : Promise.resolve(null),
    fetchKasData(), fetchGaleriText(), fetchMPKData()
  ]);
  const result = {
    anggotaTxt: anggota ? anggota.map(a => `- ${a.nama_lengkap} | No.ID ${a.no_induk} | Lahir ${a.tanggal_lahir || '-'}${a.nama_panggilan ? ' | Panggilan ' + a.nama_panggilan : ''}`).join('\n') || '(kosong)' : '(db belum terhubung)',
    agendaTxt: agenda ? agenda.map(n => `- [${n.tipe}] ${n.nama_judul} | ${n.tanggal}${n.deskripsi_nis ? ' | ' + n.deskripsi_nis : ''}${n.is_tetap ? '' : ' (sekali)'}`).join('\n') || '(kosong)' : '(db belum terhubung)',
    kasTxt: formatKas(kasRows),
    galeriTxt: galeriText || '(galeri tidak dapat diakses)',
    mpkTxt: mpkData || '(MPK tidak dapat diakses)'
  };
  cache = { ts: Date.now(), data: result };
  return result;
}

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
  const AI_MODEL = (process.env.AI_MODEL || 'groq/compound-mini').trim().replace(/^["']+|["']+$/g, '');
  // Debug token (untuk diagnosa key di server)
  const AI_KEY_LEN = AI_API_KEY.length;
  const AI_KEY_HEAD = AI_API_KEY.slice(0, 6);

  // GET → cek status (dipakai front-end untuk tahu apakah AI generatif aktif)
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!AI_API_KEY, model: AI_API_KEY ? AI_MODEL : null, keyLen: AI_API_KEY ? AI_KEY_LEN : 0 });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Kalau key belum diisi → beri tahu front-end supaya pakai fallback JS
  if (!AI_API_KEY) {
    return res.status(200).json({ configured: false, answer: null });
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
    const ctx = await getContext();

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
6. Jika data tidak ditemukan, jujur katakan "belum ada data" — JANGAN berhalusinasi/mengarang.`;

    // ── Panggil LLM (OpenAI-compatible) ──
    const resp = await fetch(`${AI_BASE_URL}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${AI_API_KEY}`
      },
      body: JSON.stringify({
        model: AI_MODEL,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: question }
        ],
        temperature: 0.4,
        max_tokens: 500
      })
    });

    if (!resp.ok) {
      const errText = await resp.text().catch(() => '');
      console.error('AI API error', resp.status, errText.slice(0, 300));
      return res.status(200).json({ configured: true, answer: null, error: 'AI API error ' + resp.status, debug: { keyLen: AI_KEY_LEN, keyHead: AI_KEY_HEAD, base: AI_BASE_URL, model: AI_MODEL } });
    }

    const data = await resp.json();
    const answer = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;

    return res.status(200).json({ configured: true, answer, model: AI_MODEL });
  } catch (error) {
    console.error('AI bridge error:', error);
    return res.status(200).json({ configured: true, answer: null, error: error.message });
  }
}