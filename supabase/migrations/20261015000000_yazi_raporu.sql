-- =====================================================================
-- Kelime: yazılara IELTS analiz raporu (yapay zekâ değerlendirmesi)
-- Supabase SQL Editor'de bir kez çalıştırılır.
-- =====================================================================

alter table public.essays
  add column report jsonb check (report is null or char_length(report::text) <= 60000),
  add column report_at bigint;
