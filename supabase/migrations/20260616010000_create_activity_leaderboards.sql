-- Shared activity attempts for quiz, flashcards, and future games.
-- Invader Challenge can keep using game_scores; this table covers the study tools.

CREATE TABLE IF NOT EXISTS public.activity_attempts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  activity_type text NOT NULL CHECK (activity_type IN ('quiz', 'flashcard', 'word_builder', 'invader')),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module_id uuid REFERENCES public.modules(id) ON DELETE CASCADE,
  chapter_id uuid REFERENCES public.chapters(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  max_score integer NOT NULL DEFAULT 0 CHECK (max_score >= 0),
  accuracy double precision NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  correct_count integer NOT NULL DEFAULT 0 CHECK (correct_count >= 0),
  incorrect_count integer NOT NULL DEFAULT 0 CHECK (incorrect_count >= 0),
  participation_count integer NOT NULL DEFAULT 1 CHECK (participation_count >= 0),
  time_taken integer NOT NULL DEFAULT 0 CHECK (time_taken >= 0),
  metadata jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_attempts_type_score_idx
  ON public.activity_attempts(activity_type, score DESC);

CREATE INDEX IF NOT EXISTS activity_attempts_chapter_type_score_idx
  ON public.activity_attempts(chapter_id, activity_type, score DESC);

CREATE INDEX IF NOT EXISTS activity_attempts_student_idx
  ON public.activity_attempts(student_id);

CREATE INDEX IF NOT EXISTS activity_attempts_created_idx
  ON public.activity_attempts(created_at DESC);

CREATE TABLE IF NOT EXISTS public.activity_answer_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  attempt_id uuid NOT NULL REFERENCES public.activity_attempts(id) ON DELETE CASCADE,
  activity_type text NOT NULL CHECK (activity_type IN ('quiz', 'flashcard', 'word_builder', 'invader')),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  module_id uuid REFERENCES public.modules(id) ON DELETE CASCADE,
  chapter_id uuid REFERENCES public.chapters(id) ON DELETE CASCADE,
  question_id uuid REFERENCES public.study_question_bank(id) ON DELETE SET NULL,
  question_text text,
  topic_tags text[] NOT NULL DEFAULT '{}',
  selected_answer text,
  correct_answer text,
  is_correct boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS activity_answer_events_attempt_idx
  ON public.activity_answer_events(attempt_id);

CREATE INDEX IF NOT EXISTS activity_answer_events_student_idx
  ON public.activity_answer_events(student_id);

CREATE INDEX IF NOT EXISTS activity_answer_events_chapter_idx
  ON public.activity_answer_events(chapter_id);

CREATE INDEX IF NOT EXISTS activity_answer_events_topics_gin_idx
  ON public.activity_answer_events USING gin(topic_tags);
