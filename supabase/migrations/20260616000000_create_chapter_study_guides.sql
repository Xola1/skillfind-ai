-- Cached per-chapter study guides.
-- These let exam/test generation reuse compact chapter summaries instead of
-- sending all chapter chunks to AI on every generation.

CREATE TABLE IF NOT EXISTS public.chapter_study_guides (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,

  title text NOT NULL,
  guide_text text NOT NULL,
  summary text,
  key_concepts text[] NOT NULL DEFAULT '{}',
  study_questions jsonb NOT NULL DEFAULT '[]'::jsonb,

  source_hash text,
  source_chunk_count integer NOT NULL DEFAULT 0 CHECK (source_chunk_count >= 0),
  source_char_count integer NOT NULL DEFAULT 0 CHECK (source_char_count >= 0),
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),

  generated_by text NOT NULL DEFAULT 'ai',
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  updated_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT chapter_study_guides_one_per_chapter UNIQUE (chapter_id),
  CONSTRAINT chapter_study_guides_questions_array_chk
    CHECK (jsonb_typeof(study_questions) = 'array')
);

CREATE INDEX IF NOT EXISTS chapter_study_guides_module_idx
  ON public.chapter_study_guides(module_id);

CREATE INDEX IF NOT EXISTS chapter_study_guides_chapter_idx
  ON public.chapter_study_guides(chapter_id);

CREATE INDEX IF NOT EXISTS chapter_study_guides_source_hash_idx
  ON public.chapter_study_guides(source_hash);

CREATE OR REPLACE FUNCTION public.touch_chapter_study_guides_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_chapter_study_guides_updated_at
  ON public.chapter_study_guides;

CREATE TRIGGER trg_chapter_study_guides_updated_at
BEFORE UPDATE ON public.chapter_study_guides
FOR EACH ROW
EXECUTE FUNCTION public.touch_chapter_study_guides_updated_at();

ALTER TABLE public.chapter_study_guides ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chapter_study_guides'
      AND policyname = 'Students can read enrolled chapter study guides'
  ) THEN
    CREATE POLICY "Students can read enrolled chapter study guides"
      ON public.chapter_study_guides
      FOR SELECT
      TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = auth.uid()
            AND p.role = 'admin'
        )
        OR EXISTS (
          SELECT 1
          FROM public.enrollments e
          WHERE e.student_id = auth.uid()
            AND e.module_id = chapter_study_guides.module_id
        )
      );
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_policies
    WHERE schemaname = 'public'
      AND tablename = 'chapter_study_guides'
      AND policyname = 'Admins can manage chapter study guides'
  ) THEN
    CREATE POLICY "Admins can manage chapter study guides"
      ON public.chapter_study_guides
      FOR ALL
      TO authenticated
      USING (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = auth.uid()
            AND p.role = 'admin'
        )
      )
      WITH CHECK (
        EXISTS (
          SELECT 1
          FROM public.profiles p
          WHERE p.id = auth.uid()
            AND p.role = 'admin'
        )
      );
  END IF;
END;
$$;
