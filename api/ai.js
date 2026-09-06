// ==============================================================================
// API AI · Jembatan AI Generatif Ganespic XXV (OpenAI-compatible)
// ==============================================================================
// Cara kerja:
//   1. Front-end kirim { question } ke endpoint ini.
//   2. Endpoint membaca API key dari env Vercel (TIDAK pernah terekspos ke browser).
//   3. Data anggota + agenda diambil dari database sebagai "pengetahuan" AI.
//   4. Pertanyaan + data dikirim ke LLM (OpenAI / Groq / OpenRouter / dll,
//      selama endpoint-nya OpenAI-compatible: {base}/chat/completions).
//   5. Jika AI_API_KEY belum diisi atau terjadi error → return configured:false,
//      front-end otomatis fallback ke mesin AI JavaScript (rule-based).
//
// Environment yang dibutuhkan (isi di Vercel → Settings → Environment Variables):
//   AI_API_KEY   = sk-xxx (key dari provider)
//   AI_BASE_URL  = https://api.openai.com/v1   (default, bisa diganti)
//   AI_MODEL     = gpt-4o-mini                  (default, bisa diganti)
// ==============================================================================
import { neon } from '@neondatabase/serverless';

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') return res.status(200).end();

  const AI_API_KEY = process.env.AI_API_KEY || '';
  const AI_BASE_URL = (process.env.AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '');
  const AI_MODEL = process.env.AI_MODEL || 'gpt-4o-mini';

  // GET → cek status (dipakai front-end untuk tahu apakah AI generatif aktif)
  if (req.method === 'GET') {
    return res.status(200).json({ configured: !!AI_API_KEY, model: AI_API_KEY ? AI_MODEL : null });
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

    // ── Kumpulkan konteks dari database sebagai "pengetahuan" AI ──
    const connectionString =
      process.env.POSTGRES_URL ||
      process.env.DATABASE_URL ||
      process.env.POSTGRES_PRISMA_URL ||
      process.env.DATABASE_URL_UNPOOLED ||
      process.env.POSTGRES_URL_NON_POOLING;

    let daftarAnggota = '(database belum terhubung)';
    let daftarAgenda = '(database belum terhubung)';

    if (connectionString) {
      const sql = neon(connectionString);
      try {
        const [anggota, agenda] = await Promise.all([
          sql`SELECT no_induk, nama_lengkap, nama_panggilan, whatsapp, tanggal_lahir FROM anggota ORDER BY no_induk ASC LIMIT 400;`,
          sql`SELECT tipe, nama_judul, deskripsi_nis, tanggal, is_tetap FROM agendas ORDER BY tanggal ASC LIMIT 400;`
        ]);
        daftarAnggota = (anggota || []).map(a =>
          `- ${a.nama_lengkap} | No.ID ${a.no_induk} | Lahir ${a.tanggal_lahir || '-'}` +
          (a.nama_panggilan ? ` | Panggilan ${a.nama_panggilan}` : '')
        ).join('\n') || '(data anggota kosong)';
        daftarAgenda = (agenda || []).map(n =>
          `- [${n.tipe}] ${n.nama_judul} | ${n.tanggal}` +
          (n.deskripsi_nis ? ` | ${n.deskripsi_nis}` : '') +
          (n.is_tetap ? '' : ' (event sekali pakai)')
        ).join('\n') || '(data agenda kosong)';
      } catch (dbErr) {
        console.error('AI bridge DB error:', dbErr.message);
      }
    }
    // ── System Prompt: instruksi + data sebagai pengetahuan AI ──
    const systemPrompt = `Kamu adalah "AI Ganespic XXV", asisten virtual resmi Angkatan XXV Ganespic.
Tugasmu hanya menjawab seputar website dan informasi angkatan. Jawab dalam Bahasa Indonesia yang santai, ramah, dan singkat (maksimal 150 kata).

Halaman & tautan penting website:
- Beranda: https://ganespic.vercel.app/
- Anggota Angkatan: https://ganespic.vercel.app/anggota
- Kas Angkatan: https://kas-ganespic.vercel.app/
- Struktural MPK: https://mpk-ganespic.vercel.app/
- Galeri Angkatan: https://galery.ganespic.workers.dev/
- Kalender (ultah & event): https://ganespic.vercel.app/kalender

DATA ANGGOTA (No.ID, nama, tanggal lahir):
${daftarAnggota}

DATA AGENDA (ultah & event):
${daftarAgenda}

PANDUAN:
1. Untuk pertanyaan "siapa ketua angkatan / pengurus / bendahara / sekretaris": jika data di atas tidak menyebutkan jabatan SAMA SEKALI, jangan mengarang nama. Jawab bahwa datanya belum tersedia di database, lalu arahkan ke halaman Struktural MPK: https://mpk-ganespic.vercel.app/
2. Untuk ulang tahun: sebutkan nama, tanggal lengkap (misal "29 Agustus"), dan umur jika bisa dihitung dari tahun lahir.
3. Untuk event: sebutkan judul, tanggal, dan deskripsi jika ada.
4. Jika data tidak ditemukan, katakan jujur "belum ada data" — JANGAN pernah berhalusinasi/mengarang.
5. Untuk pertanyaan tentang tautan/menu, berikan link-nya secara langsung.`;

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
      return res.status(200).json({ configured: true, answer: null, error: 'AI API error ' + resp.status });
    }

    const data = await resp.json();
    const answer = (data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || null;

    return res.status(200).json({ configured: true, answer, model: AI_MODEL });
  } catch (error) {
    console.error('AI bridge error:', error);
    return res.status(200).json({ configured: true, answer: null, error: error.message });
  }
}
