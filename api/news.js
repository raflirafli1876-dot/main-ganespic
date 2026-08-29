import { sql } from '@vercel/postgres';

export default async function handler(req, res) {
  // CORS Headers
  res.setHeader('Access-Control-Allow-Credentials', true);
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

  // Helper cek otorisasi admin
  const isAuthorized = () => {
    const authHeader = req.headers.authorization || '';
    return authHeader === `Bearer ${ADMIN_PASSWORD}`;
  };

  // Pastikan tabel agendas otomatis dibuat jika belum ada
  async function initTable() {
    try {
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
    } catch (e) {
      console.warn('Database init check:', e.message);
    }
  }

  // ── 1. GET: Ambil semua agenda ──
  if (req.method === 'GET') {
    try {
      await initTable();
      const { rows } = await sql`
        SELECT 
          id, 
          tipe, 
          nama_judul as judul, 
          nama_judul as nama, 
          deskripsi_nis as deskripsi, 
          deskripsi_nis as "noId", 
          tanggal, 
          foto_cdn_url as "fotoUrl", 
          created_at as dibuat 
        FROM agendas 
        ORDER BY tanggal ASC;
      `;
      return res.status(200).json({ news: rows || [] });
    } catch (error) {
      console.error('Database query error:', error);
      // Fallback jika belum tersambung ke database Postgres
      return res.status(200).json({ 
        news: [],
        warning: 'Belum terhubung ke Vercel Postgres. Tambahkan Postgres di Vercel Dashboard Storage.' 
      });
    }
  }

  // ── 2. POST: Tambah Event / Ulang Tahun baru ──
  if (req.method === 'POST') {
    if (!isAuthorized()) {
      return res.status(401).json({ error: 'Unauthorized: Password admin salah' });
    }

    try {
      await initTable();
      const body = req.body || {};
      const id = 'agenda-' + Date.now() + '-' + Math.random().toString(36).substring(2, 7);
      const tipe = body.tipe || 'event';
      const namaJudul = (tipe === 'event' ? body.judul : body.nama) || '';
      const deskripsiNis = (tipe === 'event' ? body.deskripsi : (body.id || body.noId)) || '';
      const tanggal = body.tanggal || ''; // YYYY-MM-DD
      const fotoCdnUrl = body.fotoUrl || body.foto_cdn_url || '';

      await sql`
        INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url)
        VALUES (${id}, ${tipe}, ${namaJudul}, ${deskripsiNis}, ${tanggal}, ${fotoCdnUrl});
      `;

      return res.status(200).json({ ok: true, id });
    } catch (error) {
      console.error('Database insert error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  // ── 3. DELETE: Hapus Event / Ulang Tahun ──
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
      console.error('Database delete error:', error);
      return res.status(500).json({ error: error.message });
    }
  }

  return res.status(405).json({ error: 'Method Not Allowed' });
}

