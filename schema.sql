-- ==============================================================================
-- DATABASE SCHEMA: GANESPIC XXV (Event & Ulang Tahun)
-- Kompatibel dengan: SQLite / Cloudflare D1, MySQL / MariaDB, PostgreSQL / Supabase
-- ==============================================================================

-- 1. Buat Tabel Agenda (Event & Ulang Tahun)
CREATE TABLE IF NOT EXISTS agendas (
    id VARCHAR(64) PRIMARY KEY,
    tipe VARCHAR(20) NOT NULL,              -- 'event' atau 'ultah'
    nama_judul VARCHAR(255) NOT NULL,        -- Judul Event atau Nama Anggota
    deskripsi_nis TEXT,                      -- Deskripsi Event atau No ID / NIS Siswa
    tanggal DATE NOT NULL,                   -- Tanggal format YYYY-MM-DD (contoh: 2008-08-29)
    foto_cdn_url TEXT,                       -- Link URL Foto dari CDN (ImgBB, Cloudinary, dll)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Index untuk mempercepat query pencarian tanggal
CREATE INDEX IF NOT EXISTS idx_agendas_tanggal ON agendas (tanggal);
CREATE INDEX IF NOT EXISTS idx_agendas_tipe ON agendas (tipe);

-- ==============================================================================
-- CONTOH DATA AWAL (SAMPLE SEED DATA)
-- ==============================================================================

INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url) VALUES 
('seed-1', 'event', 'Dies Natalis Ganespic XXV', 'Perayaan hari jadi angkatan XXV bersama seluruh anggota.', '2026-08-29', 'Logo_xxvganespic.png'),
('seed-2', 'ultah', 'Rafli Adzanur Ramadhan', '20230323', '2008-08-29', '20230323.jpg'),
('seed-3', 'event', 'Makrab & Gathering Angkatan', 'Malam keakraban dan temu alumni angkatan XXV.', '2026-09-15', 'Logo_xxvganespic.png');

