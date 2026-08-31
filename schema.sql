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
    is_tetap BOOLEAN DEFAULT TRUE,           -- TRUE = Event Tetap/Tahunan (ultah selalu TRUE)
                                             -- FALSE = Event Tidak Tetap (auto-hapus setelah hari berganti)
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

-- 2. Index untuk mempercepat query pencarian tanggal
CREATE INDEX IF NOT EXISTS idx_agendas_tanggal ON agendas (tanggal);
CREATE INDEX IF NOT EXISTS idx_agendas_tipe ON agendas (tipe);
CREATE INDEX IF NOT EXISTS idx_agendas_is_tetap ON agendas (is_tetap);

-- ==============================================================================
-- MIGRASI DATABASE LAMA (jalankan manual jika tabel sudah ada sebelum fitur ini)
-- ==============================================================================
-- PostgreSQL / Neon / Supabase:
--   ALTER TABLE agendas ADD COLUMN IF NOT EXISTS is_tetap BOOLEAN DEFAULT TRUE;
-- MySQL / MariaDB:
--   ALTER TABLE agendas ADD COLUMN IF NOT EXISTS is_tetap BOOLEAN DEFAULT TRUE;
-- SQLite / Cloudflare D1:
--   ALTER TABLE agendas ADD COLUMN is_tetap INTEGER DEFAULT 1;
--
-- Catatan: API (api/news.js) juga menjalankan migrasi ini otomatis saat pertama
-- kali diakses, jadi langkah manual di atas opsional.

-- 3. Tabel Anggota Angkatan (Profil lengkap tiap anggota)
CREATE TABLE IF NOT EXISTS anggota (
    id VARCHAR(64) PRIMARY KEY,
    no_induk VARCHAR(32) NOT NULL,           -- No Induk / NIS, dipakai untuk pengurutan
    nama_lengkap VARCHAR(255) NOT NULL,       -- Nama lengkap + bin/binti
    nama_panggilan VARCHAR(100),              -- Nama panggilan
    foto_url TEXT,                            -- Link URL Foto (CDN)
    ig_username VARCHAR(100),                 -- Link profil Instagram (atau username)
    tiktok_username VARCHAR(100),             -- Link profil TikTok (atau username)
    whatsapp VARCHAR(32),                     -- Nomor WhatsApp
    email VARCHAR(255),                       -- Email anggota
    alamat_rumah TEXT,                        -- Alamat rumah lengkap
    created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_anggota_no_induk ON anggota (no_induk);
-- Migrasi database lama:
--   ALTER TABLE anggota ADD COLUMN IF NOT EXISTS email VARCHAR(255);
-- (API juga menjalankan migrasi ini otomatis saat pertama kali diakses)

-- ==============================================================================
-- CONTOH DATA AWAL (SAMPLE SEED DATA)
-- ==============================================================================

INSERT INTO agendas (id, tipe, nama_judul, deskripsi_nis, tanggal, foto_cdn_url, is_tetap) VALUES
('seed-1', 'event', 'Dies Natalis Ganespic XXV', 'Perayaan hari jadi angkatan XXV bersama seluruh anggota.', '2026-08-29', 'Logo_xxvganespic.png', TRUE),
('seed-2', 'ultah', 'Rafli Adzanur Ramadhan', '20230323', '2008-08-29', '20230323.jpg', TRUE),
('seed-3', 'event', 'Makrab & Gathering Angkatan', 'Malam keakraban dan temu alumni angkatan XXV.', '2026-09-15', 'Logo_xxvganespic.png', FALSE);
