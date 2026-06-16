alter table if exists public.enrollments
  drop constraint if exists enrollments_module_id_fkey,
  add constraint enrollments_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.enrollment_requests
  drop constraint if exists enrollment_requests_module_id_fkey,
  add constraint enrollment_requests_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.chapters
  drop constraint if exists chapters_module_id_fkey,
  add constraint chapters_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.module_guides
  drop constraint if exists module_guides_module_id_fkey,
  add constraint module_guides_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.exams
  drop constraint if exists exams_module_id_fkey,
  add constraint exams_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.exam_question_bank
  drop constraint if exists exam_question_bank_module_id_fkey,
  add constraint exam_question_bank_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.module_skills
  drop constraint if exists module_skills_module_id_fkey,
  add constraint module_skills_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.question_patterns
  drop constraint if exists question_patterns_module_id_fkey,
  add constraint question_patterns_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.student_skills
  drop constraint if exists student_skills_source_module_id_fkey,
  add constraint student_skills_source_module_id_fkey
    foreign key (source_module_id) references public.modules(id) on delete cascade;

alter table if exists public.predicted_exams
  drop constraint if exists predicted_exams_module_id_fkey,
  add constraint predicted_exams_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.exam_pattern_analysis
  drop constraint if exists exam_pattern_analysis_module_id_fkey,
  add constraint exam_pattern_analysis_module_id_fkey
    foreign key (module_id) references public.modules(id) on delete cascade;

alter table if exists public.chapter_chunks
  drop constraint if exists chapter_chunks_chapter_id_fkey,
  add constraint chapter_chunks_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;

alter table if exists public.flashcard_progress
  drop constraint if exists flashcard_progress_chapter_id_fkey,
  add constraint flashcard_progress_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;

alter table if exists public.study_progress
  drop constraint if exists study_progress_chapter_id_fkey,
  add constraint study_progress_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;

alter table if exists public.exam_question_bank
  drop constraint if exists exam_question_bank_chapter_id_fkey,
  add constraint exam_question_bank_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;

alter table if exists public.question_patterns
  drop constraint if exists question_patterns_chapter_id_fkey,
  add constraint question_patterns_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;

alter table if exists public.predicted_exam_questions
  drop constraint if exists predicted_exam_questions_chapter_id_fkey,
  add constraint predicted_exam_questions_chapter_id_fkey
    foreign key (chapter_id) references public.chapters(id) on delete cascade;

alter table if exists public.exam_question_bank
  drop constraint if exists exam_question_bank_exam_id_fkey,
  add constraint exam_question_bank_exam_id_fkey
    foreign key (exam_id) references public.exams(id) on delete cascade;

alter table if exists public.predicted_exam_questions
  drop constraint if exists predicted_exam_questions_exam_id_fkey,
  add constraint predicted_exam_questions_exam_id_fkey
    foreign key (predicted_exam_id) references public.predicted_exams(id) on delete cascade;
