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

// ── Fallback offline: jawab pakai DATA ASLI yang sudah diambil (kas, MPK, anggota, agenda, galeri) ──
// Dipakai ketika API AI generatif error/401/tidak aktif agar user tetap dapat jawaban akurat,
// bukan sekadar link maupun pesan error.
function escServer(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

function cariDiBaris(lines, q, minLen) {
  const tokens = String(q).toLowerCase().replace(/[^a-z0-9\s]/gi, ' ').trim().split(/\s+/).filter(t => t.length > (minLen || 2));
  let bestLine = null, bestScore = 0;
  for (const l of lines) {
    const ll = String(l).toLowerCase();
    let hit = 0;
    tokens.forEach(t => { if (ll.includes(t)) hit++; });
    if (hit > bestScore && (hit >= 2 || tokens.some(t => t.length >= 5 && ll.includes(t)))) {
      bestScore = hit; bestLine = l;
    }
  }
  return { line: bestLine, score: bestScore };
}

function fallbackAnswer(ctx, question) {
  const q = String(question || '').toLowerCase();
  const esc = escServer;

  // 💰 SALDO KAS
  if (/(saldo|uang kas|kas.{0,15}(berapa|saldo|total)|berapa.{0,10}kas|pemasukan|pengeluaran|transaksi)/.test(q)) {
    const saldo = /(?:- )?Saldo Kas: ?(Rp ?[\d.,]+)/.exec(ctx.kasTxt || '');
    const masuk = /(?:- )?Total Pemasukan: ?(Rp ?[\d.,]+)/.exec(ctx.kasTxt || '');
    const keluar = /(?:- )?Total Pengeluaran: ?(Rp ?[\d.,]+)/.exec(ctx.kasTxt || '');
    if (saldo) {
      return '💰 Saldo kas Angkatan XXV saat ini: <b>' + saldo[1] + '</b>\n<br>• Pemasukan: ' + (masuk ? masuk[1] : '-') +
        '\n<br>• Pengeluaran: ' + (keluar ? keluar[1] : '-') +
        '\n<br><small>Detail transaksi: <a href="https://kas-ganespic.vercel.app/">Kas Angkatan</a></small>';
    }
    return 'Data kas sedang tidak tersedia saat ini. Coba langsung di <a href="https://kas-ganespic.vercel.app/">Kas Angkatan</a>.';
  }

  // 🏛️ KETUA ANGKATAN / STRUKTURAL MPK
  if (/(ketua|pimpinan|mpk|struktural|struktur|gedung|wakil|bendahara|sekretaris|divisi)/.test(q)) {
    const mpkTxt = ctx.mpkTxt || '';
    const ketua = /["']?ketuaAngkatan["']?\s*:\s*["']([^"']+)["']/.exec(mpkTxt);
    if (/(ketua\s*angkatan|pimpinan|ketua\s*xxv|ketua\s*ganespic)/.test(q) && ketua) {
      return '🏛️ Ketua Angkatan XXV Ganespic sekarang adalah <b>' + esc(ketua[1]) + '</b>.\n<br><small>Struktur lengkap: <a href="https://mpk-ganespic.vercel.app/">Struktural MPK</a></small>';
    }
    const gedung = /tansri/.test(q) ? 'tansri' : /uts?man|ust?man/.test(q) ? 'utsman' : null;
    if (gedung) {
      // Ekstrak blok gedung dgn brace-matching (mpkTxt adalah JS object: gedung: { ... })
      let gStart = mpkTxt.indexOf(gedung);
      if (gStart === -1 && gedung === 'utsman') gStart = mpkTxt.indexOf('ustman'); // dukung dua ejaan
      if (gStart !== -1) {
        const colonIdx = mpkTxt.indexOf(':', gStart);
        const openIdx = mpkTxt.indexOf('{', colonIdx);
        if (colonIdx !== -1 && openIdx !== -1) {
          let bc = 0, end = openIdx, inStr = false;
          for (let i = openIdx; i < mpkTxt.length; i++) {
            const ch = mpkTxt[i];
            if (inStr) { if (ch === '"' && mpkTxt[i - 1] !== '\\') inStr = false; continue; }
            if (ch === '"') { inStr = true; continue; }
            if (ch === '{') bc++;
            else if (ch === '}') { bc--; if (bc === 0) { end = i + 1; break; } }
          }
          const blok = mpkTxt.slice(openIdx, end);
          const ambil = (key) => {
            const km = new RegExp('["\']?' + key + '["\']?\\s*:\\s*({[^{}]*}|[^,}]+)', 'i').exec(blok);
            if (!km) return null;
            return km[1].replace(/^{|}$/g, '').replace(/["']/g, '').trim();
          };
          const nama = ambil('nama') || ambil('ketua') || null;
          const ketuaRaw = ambil('ketua');
          const det = (ketuaRaw && ketuaRaw.includes('nama')) ? ambil('nama') : ketuaRaw;
          const ket = det || nama;
          if (ket) {
            return (gedung === 'utsman' ? '🇺 Gedung <b>Utsman</b> — Ketua: ' : '🇹 Gedung <b>Tansri</b> — Ketua: ') + esc(ket);
          }
        }
      }
    }
    const jb = /(bendahara|sekretaris|wakil)/.exec(q);
    if (jb) {
      const key = jb[1];
      const km = new RegExp('["\']' + key + '["\']\\s*:\\s*([^,}]+)', 'i').exec(mpkTxt);
      if (km) {
        return '👤 <b>' + key.charAt(0).toUpperCase() + key.slice(1) + '</b> MPK: ' + esc(km[1].replace(/^["']|["']$/g, ''));
      }
    }
    if (ketua) {
      return '🏛️ Ketua Angkatan XXV: <b>' + esc(ketua[1]) + '</b>.\n<br><small>Data detail MPK: <a href="https://mpk-ganespic.vercel.app/">Struktural MPK</a></small>';
    }
  }

  // 👥 JUMLAH ANGGOTA
  if (/(berapa|total|jumlah).{0,15}(anggota|orang)|anggota.{0,15}(berapa|total|jumlah)/.test(q)) {
    const n = (ctx.anggotaTxt || '').split('\n').filter(l => l.trim().startsWith('-')).length;
    if (n) {
      return 'Angkatan XXV Ganespic saat ini terdaftar <b>' + n + ' anggota</b> di database. 👥\n<br>Lihat profil lengkap di <a href="/anggota">halaman Anggota</a>.';
    }
    return 'Data anggota belum tersedia di database. Hubungi pengurus ya. 🙏';
  }

  // 🎂 ULTAH
  if (/(ultah|ulang\s*tahun|lahir|birthday|hbd)/.test(q)) {
    const aLines = (ctx.anggotaTxt || '').split('\n').filter(l => l.trim().startsWith('-'));
    const c = cariDiBaris(aLines, q, 2);
    if (c.line) {
      const nama = c.line.replace(/^-\s*/, '').split(' | ')[0];
      const tgl = /Lahir ([0-9-]+)/.exec(c.line);
      if (tgl) {
        return '🎂 Ultah <b>' + esc(nama) + '</b> jatuh pada <b>' + esc(tgl[1]) + '</b>.\n<br><small>Kalender lengkap: <a href="/kalender">Kalender</a></small>';
      }
    }
    const nLines = (ctx.agendaTxt || '').split('\n').filter(l => l.includes('[ultah]'));
    const cn = cariDiBaris(nLines, q, 2);
    if (cn.line) {
      const nama = cn.line.replace(/^-\s*\[ultah\]\s*/, '').split(' | ')[0];
      const tgl = /([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(cn.line);
      if (tgl) {
        return '🎂 Ultah <b>' + esc(nama) + '</b> jatuh pada <b>' + esc(tgl[1]) + '</b>.\n<br><small>Kalender: <a href="/kalender">Kalender</a></small>';
      }
    }
    return 'Aku belum menemukan data ultah itu. Coba tanya nama yang terdaftar di <a href="/anggota">halaman Anggota</a>. 🙂';
  }

  // 📅 EVENT
  if (/(event|acara|agenda|kegiatan|makrab|dies|gathering|pentas|jadwal|tahun\s*ini|tahun\s*depan|bulan\s*ini|bulan\s*depan)/.test(q)) {
    const thn = /tahun\s*depan/.test(q) ? new Date().getFullYear() + 1 : new Date().getFullYear();
    const baris = (ctx.agendaTxt || '').split('\n').filter(l => l.includes('[event]') && l.includes(String(thn)));
    const c = cariDiBaris(baris, q, 2);
    if (c.line) {
      const judul = c.line.replace(/^-\s*\[event\]\s*/, '').split(' | ')[0];
      const tgl = /([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(c.line);
      return '📅 Event <b>' + esc(judul) + '</b>' + (tgl ? ' pada <b>' + esc(tgl[1]) + '</b>' : '') + '.';
    }
    if (baris.length) {
      const rows = baris.slice(0, 10).map(b => {
        const jd = b.replace(/^-\s*\[event\]\s*/, '').split(' | ')[0];
        const t = /([0-9]{4}-[0-9]{2}-[0-9]{2})/.exec(b);
        return '• ' + esc(jd) + (t ? ' (tanggal ' + esc(t[1]) + ')' : '');
      }).join('\n<br>');
      return '📅 Event tahun ' + thn + ' ada <b>' + baris.length + '</b>:\n<br>' + rows +
        '\n<br><small>Lihat <a href="/kalender">Kalender</a> untuk lengkapnya.</small>';
    }
    return 'Belum ada data event untuk tahun ' + thn + '. Cek <a href="/kalender">Kalender</a>.';
  }

  // 🖼️ GALERI
  if (/(galeri|galery|foto|album|dokumentasi|kenangan|gambar)/.test(q)) {
    const g = ctx.galeriTxt || '';
    const albumM = /(\d+)\s*album/i.exec(g) || /album[:\s]+(\d+)/i.exec(g);
    if (albumM) {
      return '🖼️ Galeri Ganespic XXV menyimpan <b>' + albumM[1] + ' album</b> kegiatan.\n<br><small>Buka: <a href="https://galery.ganespic.workers.dev/">Galeri Angkatan</a></small>';
    }
    return '🖼️ Galeri Ganespic XXV bisa dibuka langsung di <a href="https://galery.ganespic.workers.dev/">Galeri Angkatan</a>.';
  }

  // 🔗 LINK / TAUTAN
  if (/(link|tautan|buka|alamat|ke mana|dimana|di mana|menu|halaman|kas|galeri|mpk|struktural)/.test(q)) {
    return '🔗 Tautan yang tersedia:\n<br>• <a href="https://galery.ganespic.workers.dev/">Galeri Angkatan</a>\n<br>• <a href="https://kas-ganespic.vercel.app/">Kas Angkatan</a>\n<br>• <a href="https://mpk-ganespic.vercel.app/">Struktural MPK</a>\n<br>• <a href="/anggota">Anggota</a>\n<br>• <a href="/kalender">Kalender</a>';
  }

  return null;
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
  const AI_MODEL = (process.env.AI_MODEL || 'llama-3.3-70b-versatile').trim().replace(/^["']+|["']+$/g, '');
  // Debug token (untuk diagnosa key di server)
  const AI_KEY_LEN = AI_API_KEY.length;
  const AI_KEY_HEAD = AI_API_KEY.slice(0, 6);

  // GET → cek status (dipakai front-end untuk tahu apakah AI generatif aktif)
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!AI_API_KEY, model: AI_API_KEY ? AI_MODEL : null, keyLen: AI_API_KEY ? AI_KEY_LEN : 0 });
  }

  if (req.method !== 'POST') return res.status(405).json({ error: 'Method Not Allowed' });

  // Kalau key belum diisi → tetap jawab dari DATA ASLI (fallback offline) supaya AI selalu merespons
  if (!AI_API_KEY) {
    try {
      const body0 = typeof req.body === 'string' ? JSON.parse(req.body) : (req.body || {});
      const q0 = String(body0.question || '').trim().slice(0, 1500);
      const ctx0 = await getContext();
      const fb = q0 ? fallbackAnswer(ctx0, q0) : null;
      return res.status(200).json({ configured: false, answer: fb, model: null });
    } catch (e) {
      return res.status(200).json({ configured: false, answer: null, model: null });
    }
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
      // Fallback: jawab dari DATA ASLI (kas/MPK/anggota/agenda/galeri) supaya AI tetap akurat
      const fb = fallbackAnswer(ctx, question);
      return res.status(200).json({
        configured: true,
        answer: fb,
        model: AI_MODEL,
        fallback: !!fb,
        debug: { keyLen: AI_KEY_LEN, keyHead: AI_KEY_HEAD, base: AI_BASE_URL, model: AI_MODEL }
      });
    }

    const data = await resp.json();
    let answer = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;

    // Kalau LLM tidak memberi jawaban → fallback data asli
    const trimmed = (answer || '').trim();
    if (!trimmed) {
      const fb = fallbackAnswer(ctx, question);
      answer = fb;
    }

    return res.status(200).json({ configured: true, answer, model: AI_MODEL, fallback: !trimmed });
  } catch (error) {
    console.error('AI bridge error:', error);
    let fb = null;
    try { if (typeof error === 'object' && error && error.__ctx) fb = fallbackAnswer(error.__ctx, ''); } catch (e) { /* abaikan */ }
    return res.status(200).json({ configured: true, answer: fb, error: error.message });
  }
}