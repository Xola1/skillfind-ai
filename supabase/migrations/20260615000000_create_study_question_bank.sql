-- Reusable question bank for AI-generated-once chapter questions,
-- uploaded question-paper questions, and predicted mock questions.
-- This lets quizzes, predictors, and games retrieve random saved questions
-- instead of asking AI to generate every question on every play.

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'study_question_type') THEN
    CREATE TYPE public.study_question_type AS ENUM (
      'multiple_choice',
      'true_false',
      'missing_word',
      'term_definition',
      'long_question',
      'short_question'
    );
  END IF;

  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'study_question_source') THEN
    CREATE TYPE public.study_question_source AS ENUM (
      'chapter_generated',
      'exam_extracted',
      'mock_predicted',
      'admin_manual'
    );
  END IF;
END $$;

CREATE TABLE IF NOT EXISTS public.study_question_bank (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),

  course_id uuid REFERENCES public.courses(id) ON DELETE CASCADE,
  module_id uuid NOT NULL REFERENCES public.modules(id) ON DELETE CASCADE,
  chapter_id uuid REFERENCES public.chapters(id) ON DELETE CASCADE,
  exam_id uuid REFERENCES public.exams(id) ON DELETE CASCADE,

  source public.study_question_source NOT NULL DEFAULT 'chapter_generated',
  question_type public.study_question_type NOT NULL,

  question_text text NOT NULL,
  correct_answer text NOT NULL,
  explanation text,

  -- For multiple_choice / true_false / term_definition game options.
  -- Example: ["Encapsulation", "Inheritance", "Polymorphism", "Abstraction"]
  options jsonb NOT NULL DEFAULT '[]'::jsonb,

  -- For missing_word questions.
  -- Example: "A database ____ uniquely identifies each row."
  missing_word text,

  -- For term_definition questions.
  -- Store the term separately so Invader Challenge can show the definition
  -- and let the learner choose the correct term.
  term text,
  definition text,

  marks integer NOT NULL DEFAULT 1 CHECK (marks > 0),
  difficulty_level text NOT NULL DEFAULT 'medium'
    CHECK (difficulty_level IN ('easy', 'medium', 'hard', 'expert')),

  topic_tags text[] NOT NULL DEFAULT '{}',
  keywords text[] NOT NULL DEFAULT '{}',
  bloom_level text,

  quality_score numeric(4,2) NOT NULL DEFAULT 0
    CHECK (quality_score >= 0 AND quality_score <= 1),
  ai_confidence numeric(4,2) NOT NULL DEFAULT 0
    CHECK (ai_confidence >= 0 AND ai_confidence <= 1),

  times_used integer NOT NULL DEFAULT 0 CHECK (times_used >= 0),
  times_answered integer NOT NULL DEFAULT 0 CHECK (times_answered >= 0),
  times_correct integer NOT NULL DEFAULT 0 CHECK (times_correct >= 0),

  is_active boolean NOT NULL DEFAULT true,
  created_by uuid REFERENCES public.profiles(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT study_question_bank_options_array_chk
    CHECK (jsonb_typeof(options) = 'array'),

  CONSTRAINT study_question_bank_multiple_choice_chk
    CHECK (
      question_type <> 'multiple_choice'
      OR jsonb_array_length(options) >= 2
    ),

  CONSTRAINT study_question_bank_true_false_chk
    CHECK (
      question_type <> 'true_false'
      OR lower(correct_answer) IN ('true', 'false')
    ),

  CONSTRAINT study_question_bank_missing_word_chk
    CHECK (
      question_type <> 'missing_word'
      OR missing_word IS NOT NULL
    ),

  CONSTRAINT study_question_bank_term_definition_chk
    CHECK (
      question_type <> 'term_definition'
      OR (term IS NOT NULL AND definition IS NOT NULL)
    )
);

CREATE INDEX IF NOT EXISTS study_question_bank_module_idx
  ON public.study_question_bank(module_id);

CREATE INDEX IF NOT EXISTS study_question_bank_chapter_idx
  ON public.study_question_bank(chapter_id);

CREATE INDEX IF NOT EXISTS study_question_bank_exam_idx
  ON public.study_question_bank(exam_id);

CREATE INDEX IF NOT EXISTS study_question_bank_type_idx
  ON public.study_question_bank(question_type);

CREATE INDEX IF NOT EXISTS study_question_bank_source_idx
  ON public.study_question_bank(source);

CREATE INDEX IF NOT EXISTS study_question_bank_random_pool_idx
  ON public.study_question_bank(module_id, chapter_id, question_type, is_active);

CREATE INDEX IF NOT EXISTS study_question_bank_topics_gin_idx
  ON public.study_question_bank USING gin(topic_tags);

CREATE OR REPLACE FUNCTION public.touch_study_question_bank_updated_at()
RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS trg_study_question_bank_updated_at
  ON public.study_question_bank;

CREATE TRIGGER trg_study_question_bank_updated_at
BEFORE UPDATE ON public.study_question_bank
FOR EACH ROW
EXECUTE FUNCTION public.touch_study_question_bank_updated_at();

-- Random question pools for each feature.
-- Quiz: multiple choice, true/false, missing word.
CREATE OR REPLACE FUNCTION public.get_random_quiz_questions(
  p_chapter_id uuid,
  p_limit integer DEFAULT 10
)
RETURNS SETOF public.study_question_bank
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.study_question_bank
  WHERE chapter_id = p_chapter_id
    AND is_active = true
    AND question_type IN ('multiple_choice', 'true_false', 'missing_word')
  ORDER BY random()
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- Question Predictor: all supported question categories.
CREATE OR REPLACE FUNCTION public.get_random_predictor_questions(
  p_module_id uuid,
  p_limit integer DEFAULT 20,
  p_chapter_ids uuid[] DEFAULT NULL
)
RETURNS SETOF public.study_question_bank
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.study_question_bank
  WHERE module_id = p_module_id
    AND is_active = true
    AND question_type IN (
      'multiple_choice',
      'true_false',
      'missing_word',
      'term_definition',
      'long_question',
      'short_question'
    )
    AND (p_chapter_ids IS NULL OR chapter_id = ANY(p_chapter_ids))
  ORDER BY
    CASE
      WHEN source IN ('exam_extracted', 'mock_predicted') THEN 0
      ELSE 1
    END,
    random()
  LIMIT LEAST(GREATEST(p_limit, 1), 100);
$$;

-- Invader Challenge: multiple choice, true/false, missing word, term definition.
CREATE OR REPLACE FUNCTION public.get_random_invader_questions(
  p_chapter_id uuid,
  p_limit integer DEFAULT 10
)
RETURNS SETOF public.study_question_bank
LANGUAGE sql
STABLE
AS $$
  SELECT *
  FROM public.study_question_bank
  WHERE chapter_id = p_chapter_id
    AND is_active = true
    AND question_type IN (
      'multiple_choice',
      'true_false',
      'missing_word',
      'term_definition'
    )
  ORDER BY random()
  LIMIT LEAST(GREATEST(p_limit, 1), 50);
$$;

-- Optional compatibility: allow the existing exam_question_bank table
-- to store the new categories if your current exam extraction route keeps using it.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.tables
    WHERE table_schema = 'public'
      AND table_name = 'exam_question_bank'
  ) THEN
    ALTER TABLE public.exam_question_bank
      DROP CONSTRAINT IF EXISTS exam_question_bank_question_type_check;

    ALTER TABLE public.exam_question_bank
      ADD CONSTRAINT exam_question_bank_question_type_check
      CHECK (question_type = ANY (ARRAY[
        'multiple_choice'::text,
        'true_false'::text,
        'missing_word'::text,
        'term_definition'::text,
        'long_question'::text,
        'short_question'::text,
        'short_answer'::text,
        'essay'::text,
        'practical'::text,
        'calculation'::text
      ]));
  END IF;
END $$;
