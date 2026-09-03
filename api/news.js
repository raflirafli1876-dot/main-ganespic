import { neon } from '@neondatabase/serverless';

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

  // 1. Cek Connection String (Mendukung semua format Vercel Postgres & Neon)
  const connectionString = 
    process.env.POSTGRES_URL || 
    process.env.DATABASE_URL || 
    process.env.POSTGRES_PRISMA_URL || 
    process.env.DATABASE_URL_UNPOOLED || 
    process.env.POSTGRES_URL_NON_POOLING;

  if (!connectionString) {
    console.error('Missing database connection string');
    if (req.method === 'GET') {
      return res.status(200).json({ 
        news: [], 
        error: 'Database belum terhubung. Pastikan Neon / Postgres sudah terhubung ke project Vercel kamu.' 
      });
    }
    return res.status(500).json({ 
      error: 'Database belum terhubung. Variabel DATABASE_URL atau POSTGRES_URL tidak ditemukan di Vercel.' 
    });
  }

  const sql = neon(connectionString);

  // Helper cek otorisasi admin
  const isAuthorized = () => {
    const authHeader = req.headers.authorization || '';
    return authHeader === `Bearer ${ADMIN_PASSWORD}`;
  };

  // Otomatis buat tabel jika belum ada
  async function initTable() {
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
    // Migrasi untuk database lama: tambahkan kolom is_tetap jika belum ada
    // is_tetap TRUE  = event tetap/tahunan (selalu tampil tiap tahun di tgl & bulan sama)
    // is_tetap FALSE = event tidak tetap (otomatis terhapus setelah hari pelaksanaan berakhir)
    await sql`
      ALTER TABLE agendas ADD COLUMN IF NOT EXISTS is_tetap BOOLEAN DEFAULT TRUE;
    `;
    // Kolom relasi ke tabel anggota (untuk sinkronisasi ulang tahun otomatis)
    await sql`
      ALTER TABLE agendas ADD COLUMN IF NOT EXISTS anggota_id VARCHAR(64);
    `;
  }

  // ── 1. GET: Ambil semua agenda dari database ──
  if (req.method === 'GET') {
    try {
      await initTable();

      // ── Auto-delete event "Tidak Tetap" ──
      // Begitu hari berganti (esok hari), event tidak tetap yang tanggalnya
      // sudah lewat otomatis dihapus dari database. Zona waktu: Asia/Jakarta (WIB).
      const todayJakarta = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Jakarta' });
      await sql`
        DELETE FROM agendas
        WHERE tipe = 'event'
          AND is_tetap = FALSE
          AND LENGTH(tanggal) = 10
          AND tanggal < ${todayJakarta};
      `;

      const rows = await sql`
        SELECT 
          id, 
          tipe, 
          nama_judul AS judul, 
          nama_judul AS nama, 
          deskripsi_nis AS deskripsi, 
          deskripsi_nis AS "noId", 
          tanggal, 
          foto_cdn_url AS "fotoUrl", 
          is_tetap AS "isTetap",
          anggota_id AS "anggotaId",
          created_at AS dibuat 
        FROM agendas 
        ORDER BY tanggal ASC;
      `;
      return res.status(200).json({ news: rows || [] });
    } catch (error) {
      console.error('Database GET error:', error);
      return res.status(500).json({ error: 'Gagal mengambil data dari database: ' + error.message, news: [] });
    }
  }

  // ── 2. POST: Tambah Event / Ulang Tahun ke database ──
  if (req.method === 'POST') {
    if (!isAuthorized()) {
      return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    }

    try {
      await initTable();
      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {}
      }
      body = body || {};

      const id = 'agenda-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
      const tipe = body.tipe || 'event';
      const namaJudul = (tipe === 'event' ? body.judul : body.nama) || '';
      const deskripsiNis = (tipe === 'event' ? body.deskripsi : (body.id || body.noId)) || '';
      const tanggal = body.tanggal || ''; // YYYY-MM-DD
      const fotoCdnUrl = body.fotoUrl || body.foto_cdn_url || '';
      const anggotaId = body.anggotaId || body.anggota_id || '';
      // Ulang tahun selalu "tetap" (berulang tiap tahun). Event mengikuti pilihan admin.
      const isTetap = tipe === 'ultah' ? true : (body.isTetap === undefined ? true : Boolean(body.isTetap));

      if (!namaJudul || !tanggal) {
        return res.status(400).json({ error: 'Judul/Nama dan Tanggal wajib diisi' });
      }

      // Jika data berasal dari sinkronisasi anggota (sudah punya anggota_id),
      // jangan membuat duplikat — cukup update agenda yang sudah ada.
      if (anggotaId) {
        const existing = await sql`
          SELECT id FROM agendas WHERE anggota_id = ${anggotaId} LIMIT 1;
        `;
        const found = existing && existing.length > 0 ? existing[0] : null;
        if (found) {
          await sql`
            UPDATE agendas
            SET tipe = 'ultah',
                nama_judul = ${namaJudul},
                deskripsi_nis = ${deskripsiNis},
                tanggal = ${tanggal},
                foto_cdn_url = ${fotoCdnUrl},
                is_tetap = TRUE
            WHERE anggota_id = ${anggotaId};
          `;
          return res.status(200).json({ ok: true, id: found.id });
        }
        // Belum ada → insert dengan anggota_id
        await sql`
          INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url, is_tetap, anggota_id)
          VALUES (${id}, ${tipe}, ${namaJudul}, ${deskripsiNis}, ${tanggal}, ${fotoCdnUrl}, ${isTetap}, ${anggotaId});
        `;
        return res.status(200).json({ ok: true, id });
      }

      await sql`
        INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url, is_tetap)
        VALUES (${id}, ${tipe}, ${namaJudul}, ${deskripsiNis}, ${tanggal}, ${fotoCdnUrl}, ${isTetap});
      `;

      return res.status(200).json({ ok: true, id });
    } catch (error) {
      console.error('Database POST error:', error);
      return res.status(500).json({ error: 'Gagal menyimpan ke database: ' + error.message });
    }
  }

  // ── 3. PUT/PATCH: Ubah (Edit) Event / Ulang Tahun ──
  if (req.method === 'PUT' || req.method === 'PATCH') {
    if (!isAuthorized()) {
      return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    }

    try {
      await initTable();
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'Parameter ID diperlukan' });
      }

      let body = req.body;
      if (typeof body === 'string') {
        try { body = JSON.parse(body); } catch(e) {}
      }
      body = body || {};

      const tipe = body.tipe || 'event';
      const namaJudul = (tipe === 'event' ? body.judul : body.nama) || '';
      const deskripsiNis = (tipe === 'event' ? body.deskripsi : (body.id || body.noId)) || '';
      const tanggal = body.tanggal || '';
      const fotoCdnUrl = body.fotoUrl || body.foto_cdn_url || '';
      // Ulang tahun selalu "tetap" (berulang tiap tahun). Event mengikuti pilihan admin.
      const isTetap = tipe === 'ultah' ? true : (body.isTetap === undefined ? true : Boolean(body.isTetap));

      if (!namaJudul || !tanggal) {
        return res.status(400).json({ error: 'Judul/Nama dan Tanggal wajib diisi' });
      }

      await sql`
        UPDATE agendas
        SET tipe = ${tipe},
            nama_judul = ${namaJudul},
            deskripsi_nis = ${deskripsiNis},
            tanggal = ${tanggal},
            foto_cdn_url = ${fotoCdnUrl},
            is_tetap = ${isTetap}
        WHERE id = ${id};
      `;

      return res.status(200).json({ ok: true, id });
    } catch (error) {
      console.error('Database PUT error:', error);
      return res.status(500).json({ error: 'Gagal memperbarui data: ' + error.message });
    }
  }

  // ── 4. DELETE: Hapus Event / Ulang Tahun dari database ──
  if (req.method === 'DELETE') {
    if (!isAuthorized()) {
      return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    }

    try {
      const { id } = req.query;
      if (!id) {
        return res.status(400).json({ error: 'Parameter ID diperlukan' });
      }

      await sql`
        DELETE FROM agendas WHERE id = ${id};
      `;

      return res.status(200).json({ ok: true });
    } catch (error) {
      console.error('Database DELETE error:', error);
      return res.status(500).json({ error: 'Gagal menghapus dari database: ' + error.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}
