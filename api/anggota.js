import { neon } from '@neondatabase/serverless';

// ── API Anggota Angkatan (CRUD) ──
// Tabel: anggota — data lengkap anggota angkatan XXV Ganespic.
// Public  : GET  → daftar semua anggota (terurut no_induk ASC)
// Admin   : POST / PUT / DELETE (Bearer ADMIN_PASSWORD)
//
// ── Sinkronisasi Ulang Tahun Otomatis ──
// Setiap anggota yang punya TANGGAL LAHIR otomatis disinkronkan ke tabel agendas
// sebagai data ulang tahun (tipe='ultah', is_tetap=TRUE, anggota_id=<id anggota>).
// - POST  → saat anggota baru ditambahkan, agendas dibuat sekaligus.
// - PUT   → saat tanggal lahir/nama anggota diubah, agendas ikut diperbarui.
// - DELETE→ saat anggota dihapus, agenda ultah terkait ikut terhapus.
// Jadi admin TIDAK perlu entry data ulang tahun satu per satu lagi.

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader(
    'Access-Control-Allow-Headers',
    'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version, Authorization'
  );

  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }

  const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'admininformasipublikasi';

  const connectionString =
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL ||
    process.env.POSTGRES_PRISMA_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    const msg = 'Database belum terhubung. Pastikan Neon / Postgres sudah terhubung ke project Vercel.';
    if (req.method === 'GET') return res.status(200).json({ anggota: [], error: msg });
    return res.status(500).json({ error: msg });
  }

  const sql = neon(connectionString);

  const isAuthorized = () => {
    const authHeader = req.headers.authorization || '';
    return authHeader === `Bearer ${ADMIN_PASSWORD}`;
  };

  // Buat tabel otomatis jika belum ada + migrasi kolom baru
  async function initTable() {
    await sql`
      CREATE TABLE IF NOT EXISTS anggota (
        id VARCHAR(64) PRIMARY KEY,
        no_induk VARCHAR(32) NOT NULL,
        nama_lengkap VARCHAR(255) NOT NULL,
        nama_panggilan VARCHAR(100),
        foto_url TEXT,
        ig_username VARCHAR(100),
        tiktok_username VARCHAR(100),
        whatsapp VARCHAR(32),
        email VARCHAR(255),
        alamat_rumah TEXT,
        tanggal_lahir VARCHAR(20),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    await sql`ALTER TABLE anggota ADD COLUMN IF NOT EXISTS tiktok_username VARCHAR(100);`;
    await sql`ALTER TABLE anggota ADD COLUMN IF NOT EXISTS whatsapp VARCHAR(32);`;
    await sql`ALTER TABLE anggota ADD COLUMN IF NOT EXISTS email VARCHAR(255);`;
    // Kolom tanggal lahir (sumber data otomatis ulang tahun di kalender)
    await sql`ALTER TABLE anggota ADD COLUMN IF NOT EXISTS tanggal_lahir VARCHAR(20);`;
    await sql`CREATE INDEX IF NOT EXISTS idx_anggota_no_induk ON anggota (no_induk);`;
  }

  function parseBody(req) {
    let body = req.body;
    if (typeof body === 'string') {
      try { body = JSON.parse(body); } catch (e) { }
    }
    return body || {};
  }

  // ── Helper Sinkronisasi Ulang Tahun → Tabel agendas ──
  // Pastikan tabel agendas ada (skema sama seperti di api/news.js).
  async function initAgendaTable() {
    await sql`
      CREATE TABLE IF NOT EXISTS agendas (
        id VARCHAR(64) PRIMARY KEY,
        tipe VARCHAR(20) NOT NULL,
        nama_judul VARCHAR(255) NOT NULL,
        deskripsi_nis TEXT,
        tanggal VARCHAR(20) NOT NULL,
        foto_cdn_url TEXT,
        is_tetap BOOLEAN DEFAULT TRUE,
        anggota_id VARCHAR(64),
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
    // Migrasi kolom relasi ke anggota (untuk database lama)
    await sql`ALTER TABLE agendas ADD COLUMN IF NOT EXISTS anggota_id VARCHAR(64);`;
  }

  // Validasi tanggal lahir format YYYY-MM-DD (atau kosong)
  function normalizeTanggalLahir(value) {
    const v = String(value || '').trim();
    if (!v) return '';
    if (/^\d{4}-\d{2}-\d{2}$/.test(v)) return v;
    return ''; // nilai tidak valid dianggap kosong agar tidak merusak data
  }

  // Simpan / perbarui agenda ultah yang ditautkan ke anggota.
  // Jika anggota TANPA tanggal lahir (kosong), agenda ultah terkait dihapus.
  // Return: agenda id yang dipakai (atau null jika tanpa tanggal lahir).
  async function upsertAgendaUltah({ anggotaId, noInduk, namaLengkap, fotoUrl, tanggalLahir }) {
    if (!anggotaId) return null;
    await initAgendaTable();

    // Anggota tidak punya tanggal lahir → bersihkan agenda ultah yang lama (jika ada).
    if (!tanggalLahir) {
      await hapusAgendaUltah(anggotaId);
      return null;
    }

    const agendaId = 'ultah-' + anggotaId.replace(/[^a-zA-Z0-9_-]/g, '');
    // NIS dipakai pada deskripsi_nis, tanggal lahir di kolom tanggal.
    const nama = namaLengkap || 'Anggota Ganespic';
    const noId = noInduk || '';
    const foto = fotoUrl || '';

    const existing = await sql`
      SELECT id FROM agendas WHERE anggota_id = ${anggotaId} LIMIT 1;
    `;
    const found = existing && existing.length > 0 ? existing[0] : null;

    if (found) {
      await sql`
        UPDATE agendas
        SET tipe = 'ultah',
            nama_judul = ${nama},
            deskripsi_nis = ${noId},
            tanggal = ${tanggalLahir},
            foto_cdn_url = ${foto},
            is_tetap = TRUE
        WHERE anggota_id = ${anggotaId};
      `;
    } else {
      await sql`
        INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url, is_tetap, anggota_id)
        VALUES (${agendaId}, 'ultah', ${nama}, ${noId}, ${tanggalLahir}, ${foto}, TRUE, ${anggotaId});
      `;
    }
    return agendaId;
  }

  // Hapus agenda ultah yang ditautkan ke anggota (dipakai saat DELETE anggota).
  async function hapusAgendaUltah(anggotaId) {
    if (!anggotaId) return;
    await initAgendaTable();
    await sql`DELETE FROM agendas WHERE anggota_id = ${anggotaId};`;
  }

  // ── 1. GET: daftar anggota terurut no induk ──
  if (req.method === 'GET') {
    try {
      await initTable();
      const rows = await sql`
        SELECT
          id,
          no_induk AS "noInduk",
          nama_lengkap AS "namaLengkap",
          nama_panggilan AS "namaPanggilan",
          foto_url AS "fotoUrl",
          ig_username AS "igUsername",
          tiktok_username AS "tiktokUsername",
          whatsapp,
          email,
          alamat_rumah AS "alamatRumah",
          tanggal_lahir AS "tanggalLahir",
          created_at AS dibuat
        FROM anggota
        ORDER BY no_induk ASC;
      `;
      return res.status(200).json({ anggota: rows || [] });
    } catch (error) {
      console.error('Anggota GET error:', error);
      return res.status(500).json({ error: 'Gagal mengambil data anggota: ' + error.message, anggota: [] });
    }
  }

  // ── 2. POST: tambah anggota ──
  if (req.method === 'POST') {
    if (!isAuthorized()) return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    try {
      await initTable();
      const body = parseBody(req);
      const noInduk = (body.noInduk || '').trim();
      const namaLengkap = (body.namaLengkap || '').trim();
      if (!noInduk || !namaLengkap) {
        return res.status(400).json({ error: 'No Induk dan Nama Lengkap wajib diisi' });
      }
      const id = 'anggota-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
      const tanggalLahir = normalizeTanggalLahir(body.tanggalLahir);
      await sql`
        INSERT INTO anggota (id, no_induk, nama_lengkap, nama_panggilan, foto_url, ig_username, tiktok_username, whatsapp, email, alamat_rumah, tanggal_lahir)
        VALUES (
          ${id}, ${noInduk}, ${namaLengkap},
          ${body.namaPanggilan || ''},
          ${body.fotoUrl || ''},
          ${body.igUsername || ''},
          ${body.tiktokUsername || ''},
          ${body.whatsapp || ''},
          ${body.email || ''},
          ${body.alamatRumah || ''},
          ${tanggalLahir || null}
        );
      `;
      // Auto-sinkron: tanggal lahir anggota → data ulang tahun di kalender.
      await upsertAgendaUltah({
        anggotaId: id,
        noInduk,
        namaLengkap,
        fotoUrl: body.fotoUrl || '',
        tanggalLahir: tanggalLahir || ''
      });
      return res.status(200).json({ ok: true, id });
    } catch (error) {
      console.error('Anggota POST error:', error);
      return res.status(500).json({ error: 'Gagal menyimpan anggota: ' + error.message });
    }
  }

  // ── 3. PUT/PATCH: edit anggota ──
  if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!isAuthorized()) return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    try {
      await initTable();
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parameter ID diperlukan' });
      const body = parseBody(req);
      const noInduk = (body.noInduk || '').trim();
      const namaLengkap = (body.namaLengkap || '').trim();
      if (!noInduk || !namaLengkap) {
        return res.status(400).json({ error: 'No Induk dan Nama Lengkap wajib diisi' });
      }
      const tanggalLahir = normalizeTanggalLahir(body.tanggalLahir);
      await sql`
        UPDATE anggota
        SET no_induk = ${noInduk},
      nama_lengkap = ${namaLengkap},
      nama_panggilan = ${body.namaPanggilan || ''},
      foto_url = ${body.fotoUrl || ''},
      ig_username = ${body.igUsername || ''},
      tiktok_username = ${body.tiktokUsername || ''},
      whatsapp = ${body.whatsapp || ''},
      email = ${body.email || ''},
      alamat_rumah = ${body.alamatRumah || ''},
      tanggal_lahir = ${tanggalLahir || null}
        WHERE id = ${id};
      `;
      // Auto-sinkron: perbarui data ulang tahun di kalender mengikuti data terbaru anggota.
      await upsertAgendaUltah({
        anggotaId: id,
        noInduk,
        namaLengkap,
        fotoUrl: body.fotoUrl || '',
        tanggalLahir: tanggalLahir || ''
      });
      return res.status(200).json({ ok: true, id });
    } catch (error) {
      console.error('Anggota PUT error:', error);
      return res.status(500).json({ error: 'Gagal memperbarui anggota: ' + error.message });
    }
  }

  // ── 4. DELETE: hapus anggota ──
  if (req.method === 'DELETE') {
    if (!isAuthorized()) return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    try {
      const { id } = req.query;
      if (!id) return res.status(400).json({ error: 'Parameter ID diperlukan' });
      // Hapus juga data ulang tahun terkait di tabel agendas agar tidak tersisa
      await hapusAgendaUltah(id);
      await sql`DELETE FROM anggota WHERE id = ${id}; `;
      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Anggota DELETE error:', error);
      return res.status(500).json({ error: 'Gagal menghapus anggota: ' + error.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
