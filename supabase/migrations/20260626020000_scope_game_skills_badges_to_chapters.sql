ALTER TABLE public.student_skill_xp
  ADD COLUMN IF NOT EXISTS chapter_id uuid REFERENCES public.chapters(id) ON DELETE CASCADE;

ALTER TABLE public.student_badges
  ADD COLUMN IF NOT EXISTS chapter_id uuid REFERENCES public.chapters(id) ON DELETE CASCADE;

ALTER TABLE public.student_skill_xp
  DROP CONSTRAINT IF EXISTS student_skill_xp_student_id_skill_name_key;

ALTER TABLE public.student_badges
  DROP CONSTRAINT IF EXISTS student_badges_student_id_badge_code_key;

CREATE UNIQUE INDEX IF NOT EXISTS student_skill_xp_student_chapter_skill_uidx
  ON public.student_skill_xp(student_id, chapter_id, skill_name);

CREATE UNIQUE INDEX IF NOT EXISTS student_badges_student_chapter_badge_uidx
  ON public.student_badges(student_id, chapter_id, badge_code);

CREATE INDEX IF NOT EXISTS student_skill_xp_chapter_idx
  ON public.student_skill_xp(chapter_id);

CREATE INDEX IF NOT EXISTS student_badges_chapter_idx
  ON public.student_badges(chapter_id);
