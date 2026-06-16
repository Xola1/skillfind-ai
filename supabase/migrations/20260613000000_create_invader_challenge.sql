-- Invader Challenge is additive: it stores game outcomes, XP, and badges
-- without changing existing quiz, predictor, enrollment, or profile tables.

CREATE TABLE IF NOT EXISTS public.game_scores (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  chapter_id uuid NOT NULL REFERENCES public.chapters(id) ON DELETE CASCADE,
  score integer NOT NULL DEFAULT 0 CHECK (score >= 0),
  accuracy double precision NOT NULL DEFAULT 0 CHECK (accuracy >= 0 AND accuracy <= 100),
  time_taken integer NOT NULL DEFAULT 0 CHECK (time_taken >= 0),
  xp_earned integer NOT NULL DEFAULT 0 CHECK (xp_earned >= 0),
  level_reached integer NOT NULL DEFAULT 1 CHECK (level_reached >= 1),
  game_mode text NOT NULL DEFAULT 'standard' CHECK (game_mode IN ('standard', 'boss')),
  created_at timestamp with time zone NOT NULL DEFAULT now()
);

CREATE INDEX IF NOT EXISTS game_scores_student_idx ON public.game_scores(student_id);
CREATE INDEX IF NOT EXISTS game_scores_chapter_score_idx ON public.game_scores(chapter_id, score DESC);
CREATE INDEX IF NOT EXISTS game_scores_chapter_accuracy_idx ON public.game_scores(chapter_id, accuracy DESC);
CREATE INDEX IF NOT EXISTS game_scores_chapter_time_idx ON public.game_scores(chapter_id, time_taken ASC);

CREATE TABLE IF NOT EXISTS public.student_skill_xp (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  skill_name text NOT NULL,
  xp integer NOT NULL DEFAULT 0 CHECK (xp >= 0),
  created_at timestamp with time zone NOT NULL DEFAULT now(),
  updated_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(student_id, skill_name)
);

CREATE INDEX IF NOT EXISTS student_skill_xp_student_idx ON public.student_skill_xp(student_id);

CREATE TABLE IF NOT EXISTS public.student_badges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  student_id uuid NOT NULL REFERENCES public.profiles(id) ON DELETE CASCADE,
  badge_code text NOT NULL,
  badge_name text NOT NULL,
  earned_at timestamp with time zone NOT NULL DEFAULT now(),
  UNIQUE(student_id, badge_code)
);

CREATE INDEX IF NOT EXISTS student_badges_student_idx ON public.student_badges(student_id);
