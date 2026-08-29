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
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
      );
    `;
  }

  // ── 1. GET: Ambil semua agenda dari database ──
  if (req.method === 'GET') {
    try {
      await initTable();
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

      if (!namaJudul || !tanggal) {
        return res.status(400).json({ error: 'Judul/Nama dan Tanggal wajib diisi' });
      }

      await sql`
        INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url)
        VALUES (${id}, ${tipe}, ${namaJudul}, ${deskripsiNis}, ${tanggal}, ${fotoCdnUrl});
      `;

      return res.status(200).json({ ok: true, id });
    } catch (error) {
      console.error('Database POST error:', error);
      return res.status(500).json({ error: 'Gagal menyimpan ke database: ' + error.message });
    }
  }

  // ── 3. DELETE: Hapus Event / Ulang Tahun dari database ──
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
