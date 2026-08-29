const json = (data, status = 200, origin = '*') =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
    },
  });

export default {
  async fetch(request, env) {
    const origin = env.ALLOWED_ORIGIN || '*';
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, {
        headers: {
          'Access-Control-Allow-Origin': origin,
          'Access-Control-Allow-Headers': 'Content-Type, Authorization',
          'Access-Control-Allow-Methods': 'GET, POST, DELETE, OPTIONS',
        },
      });
    }

    // Helper cek otorisasi admin
    const checkAdmin = (req) => {
      const auth = req.headers.get('Authorization') || '';
      return auth === `Bearer ${env.ADMIN_PASSWORD || 'admininformasipublikasi'}`;
    };

    // ── 1. GET /news (Ambil semua data agenda) ──
    if (request.method === 'GET' && url.pathname === '/news') {
      // Jika menggunakan Cloudflare D1 SQL (env.DB)
      if (env.DB) {
        try {
          const { results } = await env.DB.prepare(
            'SELECT id, tipe, nama_judul as judul, nama_judul as nama, deskripsi_nis as deskripsi, deskripsi_nis as noId, tanggal, foto_cdn_url as fotoUrl, created_at as dibuat FROM agendas ORDER BY tanggal ASC'
          ).all();
          return json({ news: results || [] }, 200, origin);
        } catch (err) {
          return json({ error: err.message }, 500, origin);
        }
      }

      // Fallback: Jika menggunakan R2 Bucket JSON
      if (env.FOTOS) {
        const obj = await env.FOTOS.get('news.json');
        if (!obj) return json({ news: [] }, 200, origin);
        const data = await obj.json();
        return json(data, 200, origin);
      }

      return json({ news: [] }, 200, origin);
    }

    // ── 2. POST /news (Simpan data event / ultah dengan link CDN) ──
    if (request.method === 'POST' && url.pathname === '/news') {
      if (!checkAdmin(request)) return json({ error: 'Unauthorized' }, 401, origin);

      let payload = {};
      const contentType = request.headers.get('content-type') || '';

      if (contentType.includes('application/json')) {
        payload = await request.json();
      } else {
        const formData = await request.formData();
        payload = {
          tipe: formData.get('tipe'),
          tanggal: formData.get('tanggal'),
          judul: formData.get('judul'),
          deskripsi: formData.get('deskripsi'),
          nama: formData.get('nama'),
          id: formData.get('id'),
          fotoUrl: formData.get('fotoUrl') || formData.get('foto_cdn_url') || '',
        };
      }

      const id = crypto.randomUUID();
      const tipe = payload.tipe; // 'event' atau 'ultah'
      const tanggal = payload.tanggal || ''; // YYYY-MM-DD
      const namaJudul = (tipe === 'event' ? payload.judul : payload.nama) || '';
      const deskripsiNis = (tipe === 'event' ? payload.deskripsi : (payload.id || payload.noId)) || '';
      const fotoUrl = payload.fotoUrl || payload.foto_cdn_url || '';

      // Jika menggunakan D1 SQL Database
      if (env.DB) {
        try {
          await env.DB.prepare(
            'INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url) VALUES (?, ?, ?, ?, ?, ?)'
          ).bind(id, tipe, namaJudul, deskripsiNis, tanggal, fotoUrl).run();
          return json({ ok: true, id }, 200, origin);
        } catch (err) {
          return json({ error: err.message }, 500, origin);
        }
      }

      // Fallback: Simpan ke R2 JSON
      if (env.FOTOS) {
        const obj = await env.FOTOS.get('news.json');
        const data = obj ? await obj.json() : { news: [] };
        data.news.push({
          id,
          tipe,
          tanggal,
          judul: tipe === 'event' ? namaJudul : undefined,
          deskripsi: tipe === 'event' ? deskripsiNis : undefined,
          nama: tipe === 'ultah' ? namaJudul : undefined,
          noId: tipe === 'ultah' ? deskripsiNis : undefined,
          fotoUrl,
          dibuat: new Date().toISOString(),
        });
        await env.FOTOS.put('news.json', JSON.stringify(data));
        return json({ ok: true, id }, 200, origin);
      }

      return json({ ok: true, id }, 200, origin);
    }

    // ── 3. DELETE /news/:id (Hapus data berdasarkan ID) ──
    if (request.method === 'DELETE' && url.pathname.startsWith('/news/')) {
      if (!checkAdmin(request)) return json({ error: 'Unauthorized' }, 401, origin);
      const delId = url.pathname.split('/')[2];

      if (env.DB) {
        try {
          await env.DB.prepare('DELETE FROM agendas WHERE id = ?').bind(delId).run();
          return json({ ok: true }, 200, origin);
        } catch (err) {
          return json({ error: err.message }, 500, origin);
        }
      }

      if (env.FOTOS) {
        const obj = await env.FOTOS.get('news.json');
        if (obj) {
          const data = await obj.json();
          data.news = data.news.filter((n) => n.id !== delId);
          await env.FOTOS.put('news.json', JSON.stringify(data));
        }
        return json({ ok: true }, 200, origin);
      }

      return json({ ok: true }, 200, origin);
    }

    return json({ error: 'Endpoint tidak ditemukan' }, 404, origin);
  },
};
