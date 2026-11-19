-- ============================================================================
-- SQL SETUP SUPABASE UNTUK APLIKASI POST-TEST PRAKTIKUM SISTEM OPERASI (LTD)
-- Jalankan script ini di menu "SQL Editor" -> "New Query" pada Dashboard Supabase
-- ============================================================================

-- 1. Buat Tabel Token Kelas (A, B, C, D, E)
CREATE TABLE IF NOT EXISTS public.posttest_tokens (
    kelas TEXT PRIMARY KEY,
    token TEXT NOT NULL,
    active BOOLEAN NOT NULL DEFAULT true,
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- Isi Data Awal Token Kelas A s/d E
INSERT INTO public.posttest_tokens (kelas, token, active) VALUES
    ('A', 'OSA-401', true),
    ('B', 'OSB-402', true),
    ('C', 'OSC-403', true),
    ('D', 'OSD-404', true),
    ('E', 'OSE-405', true)
ON CONFLICT (kelas) DO NOTHING;

-- 2. Buat Tabel Nilai Post-Test Praktikan
CREATE TABLE IF NOT EXISTS public.posttest_students (
    npm TEXT PRIMARY KEY,
    id TEXT NOT NULL,
    nama TEXT NOT NULL,
    kelas TEXT NOT NULL,
    paket TEXT NOT NULL DEFAULT '-',
    completed_tasks INTEGER NOT NULL DEFAULT 0,
    score INTEGER NOT NULL DEFAULT 0,
    timestamp TEXT NOT NULL DEFAULT 'Selesai Semua',
    updated_at TIMESTAMPTZ DEFAULT now()
);

-- 3. Aktifkan Row Level Security (RLS) & Izinkan Akses Read/Write dari Web
ALTER TABLE public.posttest_tokens ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.posttest_students ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "Allow public full access on posttest_tokens" ON public.posttest_tokens;
CREATE POLICY "Allow public full access on posttest_tokens"
    ON public.posttest_tokens
    FOR ALL
    USING (true)
    WITH CHECK (true);

DROP POLICY IF EXISTS "Allow public full access on posttest_students" ON public.posttest_students;
CREATE POLICY "Allow public full access on posttest_students"
    ON public.posttest_students
    FOR ALL
    USING (true)
    WITH CHECK (true);

