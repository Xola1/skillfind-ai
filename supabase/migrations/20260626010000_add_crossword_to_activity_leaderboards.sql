ALTER TABLE public.activity_attempts
  DROP CONSTRAINT IF EXISTS activity_attempts_activity_type_check;

ALTER TABLE public.activity_attempts
  ADD CONSTRAINT activity_attempts_activity_type_check
  CHECK (activity_type IN ('quiz', 'flashcard', 'word_builder', 'crossword', 'invader'));

ALTER TABLE public.activity_answer_events
  DROP CONSTRAINT IF EXISTS activity_answer_events_activity_type_check;

ALTER TABLE public.activity_answer_events
  ADD CONSTRAINT activity_answer_events_activity_type_check
  CHECK (activity_type IN ('quiz', 'flashcard', 'word_builder', 'crossword', 'invader'));
