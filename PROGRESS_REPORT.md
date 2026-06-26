# SkillFind AI Progress Report

## 1. Current MVP Progress and Development Status

SkillFind AI is currently at a working MVP/prototype stage. The project already includes a student learning interface, an administrator dashboard, a Node.js/Express backend, Supabase integration, and AI-assisted study features.

The MVP is focused on helping students study from uploaded course material. Administrators can manage courses, modules, chapters, students, enrollments, module guides, and exam/test files. Students can log in, view only the modules they are enrolled in, select a chapter, ask an AI tutor questions, and access supporting study tools such as quizzes, flashcards, chapter study, exam study, test study, question prediction, and a learning resource library.

The prototype has also started real-world validation. Three real students have been onboarded so far, which means the MVP is no longer only a technical demo; it is beginning to receive real user feedback from actual learners.

### Implemented MVP Features

- Student authentication through Supabase.
- Student role validation before accessing the learning interface.
- Student dashboard with enrolled modules and chapters.
- Mobile-friendly student learning shell with sidebar navigation, embedded study pages, and quick chapter actions.
- Chapter-based AI tutor chat using uploaded chapter content.
- Chat history storage through the `chat_messages` table.
- Quiz, flashcard, chapter-study, exam-study, test-study, and question-predictor pages.
- Exam question paper predictor and test question paper predictor.
- Predictor goal: generate practice/mock question papers that predict approximately 75% of likely real exam/test coverage by analyzing uploaded notes, previous exam papers, previous test papers, extracted question banks, and topic patterns.
- My Library page that reads module guide content and recommends external learning resources.
- Shared frontend configuration through `config.js` and `frontend/config.js`, with local API fallback and a production API URL.
- Admin login and admin dashboard.
- Admin course creation and deletion.
- Admin module creation, editing, and deletion.
- Admin chapter upload, extraction/chunking, listing, and deletion.
- Admin student listing, course assignment, and module enrollment management.
- Enrollment request approval and rejection.
- Module guide PDF upload and storage.
- Exam/test upload, listing, viewing, deletion, and AI question extraction flow.
- Student gamified challenge pages and leaderboard tracking.
- Student vocabulary word-builder practice page.
- Quiz and flashcard activity attempt tracking with per-chapter leaderboards.
- Invader Challenge game mode with score, XP, accuracy, badges, module skills, and leaderboard pages.
- Module skills and AI learning skills pages with corresponding backend routes.
- Admin leaderboard and learning analytics panel.
- Supabase PostgreSQL data model for courses, modules, profiles, enrollments, chapters, chunks, exams, question banks, module guides, progress, and predictions.
- Backend health endpoints and route debugging support.

### Current Development Status

The application has moved beyond a static mockup. It has real frontend pages, backend routes, database tables, authentication checks, and storage workflows. The main remaining work is testing, polishing, deployment, and strengthening reliability around AI/OCR outputs.

The current project supports local development and a hosted backend API configuration. Shared frontend configuration files define:

```text
Local API URL: http://localhost:5050
Production API URL: https://skillfind-ai.onrender.com
```

The backend hosts static assets from `frontend/` while the repository also includes root-level HTML pages for student and admin flows.

Backend API groups currently mounted by `server/server.js` include:
- `/admin`
- `/quiz`
- `/flashcard`
- `/study`
- `/game`
- `/activity`
- `/word-builder`
- `/exam-practice`
- `/api/questions`
- `/student/module-skills`
- `/student`

The planned frontend deployment remains Netlify free tier for the prototype, while the backend is configured separately as a Node.js/Express API. The HTML pages now read API settings from shared frontend config files instead of directly hardcoding `localhost:5050` in each page. Production readiness still requires confirming the deployed frontend URL, CORS allowlist, Supabase environment variables, and hosted backend health in the target environment.

Key project files reviewed:

- `index.html` - main student learning interface.
- `library.html` - student resource recommendation library.
- `quiz.html`, `flashcard.html`, `chapter-study.html`, `exam-study.html`, `test-study.html`, `test_study.html`, `question-predictor.html`, `invader-challenge.html`, `leaderboard.html`, `word-builder.html` - student study and game tools.
- `frontend/module-skills.html` - module skills / AI skill-building page.
- `frontend/admin/*.html` and `frontend/admin/admin.js` - admin dashboard and management screens.
- `config.js` and `frontend/config.js` - frontend API and Supabase browser configuration.
- `server/server.js` - main Express backend and API route mounting.
- `server/routes/*.js` - quiz, flashcard, study, exam, test, question extraction, AI training, activity, game, module skills, and word-builder APIs.
- `mySchema.sql` and `supabase/migrations/*` - database schema and migrations.
- `docs/ARCHITECTURE.md`, `docs/FLOW_ADMIN_STUDENT.md`, `docs/MIGRATION_PLAN.md`, `docs/AIoverview.md` - architecture and planning notes.

## 2. Functional Requirements Document

### Purpose

The system must support an AI-powered learning platform where administrators upload structured learning material and students use that material for guided study, revision, quizzes, flashcards, and exam preparation.

### User Roles

| Role | Description |
| --- | --- |
| Student | Uses the platform to access enrolled modules, study chapters, ask questions, revise, and prepare for tests/exams. |
| Admin | Manages courses, modules, chapters, module guides, students, enrollments, exams, and uploaded learning content. |

### Student Functional Requirements

| ID | Requirement | Status |
| --- | --- | --- |
| FR-S01 | Students must be able to sign in using Supabase authentication. | Implemented |
| FR-S02 | Students must only access the student interface if their profile role is `student`. | Implemented |
| FR-S03 | Students must view only modules they are enrolled in. | Implemented |
| FR-S04 | Students must be able to select a module and then select a chapter. | Implemented |
| FR-S05 | Students must be able to ask AI questions about a selected chapter. | Implemented |
| FR-S06 | AI answers should be grounded in uploaded chapter notes/chunks. | Implemented/prototype |
| FR-S07 | Student questions and AI responses should be saved as chat history. | Implemented |
| FR-S08 | Students must be able to open quiz mode for a selected chapter. | Implemented/prototype |
| FR-S09 | Students must be able to open flashcard mode for a selected chapter. | Implemented/prototype |
| FR-S10 | Students must be able to open chapter-study mode. | Implemented/prototype |
| FR-S11 | Students must be able to access exam-study and test-study modes. | Implemented/prototype |
| FR-S12 | Students must be able to access a resource library based on module guides. | Implemented/prototype |
| FR-S13 | Students should be able to receive predicted exam question paper support. | Implemented/prototype |
| FR-S14 | Students should be able to receive predicted test question paper support. | Implemented/prototype |
| FR-S15 | The predictor should aim to cover approximately 75% of likely real exam/test content using uploaded notes, previous papers, tests, and AI pattern analysis. | Implemented/prototype; needs validation |
| FR-S16 | Students should be able to access gamified practice activities, including Word Builder and Invader Challenge. | Implemented/prototype |
| FR-S17 | Students should be able to see chapter-level quiz, flashcard, and game leaderboards. | Implemented/prototype |
| FR-S18 | Students should be able to review module skills generated from module guide content. | Implemented/prototype |

### Admin Functional Requirements

| ID | Requirement | Status |
| --- | --- | --- |
| FR-A01 | Admins must be able to sign in and access an admin dashboard. | Implemented |
| FR-A02 | Admins must be able to create and list courses. | Implemented |
| FR-A03 | Admins must be able to delete courses and related data safely. | Implemented |
| FR-A04 | Admins must be able to create, edit, list, and delete modules. | Implemented |
| FR-A05 | Admins must be able to upload chapter files. | Implemented |
| FR-A06 | Uploaded chapter content must be extracted and stored as chapter chunks. | Implemented/prototype |
| FR-A07 | Admins must be able to list and delete chapters. | Implemented |
| FR-A08 | Admins must be able to view students. | Implemented |
| FR-A09 | Admins must be able to assign a course to a student. | Implemented |
| FR-A10 | Admins must be able to enroll and remove students from modules. | Implemented |
| FR-A11 | Admins must be able to review, approve, and reject enrollment requests. | Implemented |
| FR-A12 | Admins must be able to upload module guide PDFs. | Implemented |
| FR-A13 | Admins must be able to upload previous exams, tests, and mock exams. | Implemented |
| FR-A14 | Admins must be able to process exam files and extract questions using AI. | Implemented/prototype |
| FR-A15 | Admins must be able to delete exams and related stored data. | Implemented |
| FR-A16 | Admins should be able to view learning analytics and leaderboard summaries. | Implemented/prototype |

### Backend Functional Requirements

| ID | Requirement | Status |
| --- | --- | --- |
| FR-B01 | The backend must expose health check endpoints. | Implemented |
| FR-B02 | The backend must validate Supabase JWT access tokens. | Implemented |
| FR-B03 | The backend must separate student and admin authorization. | Implemented |
| FR-B04 | The backend must enforce student enrollment before returning module/chapter content. | Implemented |
| FR-B05 | The backend must support file uploads using multipart forms. | Implemented |
| FR-B06 | The backend must store files in Supabase Storage where applicable. | Implemented |
| FR-B07 | The backend must support AI provider fallback or fallback responses where possible. | Implemented/prototype |
| FR-B08 | The backend should minimize token usage when using free AI APIs. | Partially implemented; ongoing limitation |
| FR-B09 | The backend should gracefully handle cases where token limits prevent large inserts, long prompts, or complete AI processing. | Partially implemented; needs improvement |
| FR-B10 | The frontend should use a shared API configuration instead of page-specific hardcoded API URLs. | Implemented |
| FR-B11 | The backend should support student activity attempts, game scores, badges, and leaderboards. | Implemented/prototype |

## 3. Non-Functional Requirements Document

| Category | Requirement |
| --- | --- |
| Security | The system must protect student and admin routes using Supabase authentication and role checks. |
| Authorization | Students must only see modules where an enrollment exists. Admin-only functions must reject non-admin users. |
| Data Privacy | Student profile, enrollment, progress, and chat data must be stored securely in Supabase. |    
| Reliability | API routes should return clear success/error responses and handle missing inputs gracefully. |
| Performance | Chapter content should be chunked so AI prompts remain manageable and responses can be generated efficiently. |
| Maintainability | Backend logic should remain separated into route modules for quiz, flashcard, study, exam, test, and question extraction features. |
| Scalability | Supabase tables and storage buckets should support multiple courses, modules, students, chapters, exams, and guides. |
| Usability | Student screens should be mobile-friendly and allow a clear flow: module -> chapter -> study action. |
| Accessibility | Forms, buttons, and navigation should use clear labels and visible status messages. Further accessibility testing is still required. |
| Auditability | Uploaded content, generated chunks, chat messages, and student progress should be traceable through database records. |
| Backup and Recovery | Supabase database and storage backups should be configured before production deployment. |
| Browser Compatibility | The MVP should be tested in current Chrome/Edge browsers because the frontend uses standard HTML, CSS, JavaScript, fetch, iframes, and CDN scripts. |
| Deployment | The planned deployment is Netlify free tier for the frontend with a separately hosted Express backend. Frontend config now switches between `http://localhost:5050` locally and `https://skillfind-ai.onrender.com` for production-like browser use. Production deployment still requires environment variable review, CORS confirmation, and secured API keys. |
| API Cost Control | The MVP currently depends on free API tiers. Token limits must be controlled by chunking content, limiting prompt size, using fallback generation, and avoiding very large inserts in one request. |

## 4. Stakeholder Mapping

| Stakeholder | Role in Project | Needs / Expectations |
| --- | --- | --- |
| Students | Primary users | Easy access to enrolled modules, helpful AI explanations, quizzes, flashcards, exam preparation, and external study resources. |
| Onboarded Student Testers | Early real users | Three real students have been onboarded so far to test the MVP and provide practical feedback. |
| Administrators / Lecturers | Content managers | Ability to upload learning content, manage courses/modules/students, approve enrollments, and maintain exam/test material. |
| Project Developer | Builder and maintainer | Stable codebase, clear architecture, working APIs, manageable database schema, and deployable prototype. |
| Institution / Training Provider | Sponsor or owner | A learning platform that improves student support and can scale across courses/modules. |
| Assessors / Reviewers | Evaluate the MVP | Clear proof of progress, functional requirements, non-functional requirements, working prototype, and documented challenges. |
| Supabase Platform | Infrastructure dependency | Provides authentication, database, storage, and role-linked data access. |
| AI API Providers | External service dependencies | Provide AI responses, study planning, OCR/question extraction, summarization, and learning assistance. |

## 5. User Stories

### Student User Stories

- As a student, I want to sign in securely so that only my learning data is shown.
- As a student, I want to see the modules I am enrolled in so that I can study the correct subjects.
- As a student, I want to select a chapter so that my questions are answered in the right context.
- As a student, I want to ask an AI tutor questions so that I can understand difficult concepts.
- As a student, I want quick actions for summaries, key concepts, and quizzes so that I can revise faster.
- As a student, I want flashcards so that I can memorize important terms and definitions.
- As a student, I want exam-study and test-study modes so that I can prepare for assessments.
- As a student, I want recommended external websites from my module guides so that I can learn from extra resources.
- As a student, I want predicted or practice questions so that I can prepare for likely exam topics.
- As a student, I want an exam question paper predictor that can generate a likely mock paper based on notes and previous exams.
- As a student, I want a test question paper predictor that can generate likely test questions based on notes and previous tests.
- As a student, I want gamified practice modes so that revision feels more engaging.
- As a student, I want leaderboards, badges, and skill XP so that I can track progress and compare performance.
- As a student, I want module-skill guidance so that I understand which skills the module is building.

### Admin User Stories

- As an admin, I want to create courses so that learning content is organized by qualification or subject area.
- As an admin, I want to create modules under courses so that students can be enrolled in specific subjects.
- As an admin, I want to upload chapter files so that students can ask questions based on course notes.
- As an admin, I want uploaded chapters to be extracted into chunks so that the AI tutor can use the content.
- As an admin, I want to upload module guides so that the platform can recommend relevant learning resources.
- As an admin, I want to upload past exams and tests so that students can prepare using real assessment material.
- As an admin, I want to process exams using AI so that questions can be extracted into a question bank.
- As an admin, I want to manage student enrollments so that students only access the modules assigned to them.
- As an admin, I want to approve or reject enrollment requests so that module access is controlled.
- As an admin, I want safe delete actions so that removed courses/modules/chapters also clean up related data.
- As an admin, I want to view leaderboard and learning analytics so that I can monitor student engagement.

## 6. Challenges or Support Required

### Current Challenges

- The frontend now uses shared API config files, but the hosted frontend and backend still need deployment verification together.
- The planned frontend deployment is Netlify free tier, but the Express backend must remain separately hosted or selected APIs must be converted to Netlify Functions.
- The production backend URL currently points to `https://skillfind-ai.onrender.com`; health checks, CORS, environment variables, and Supabase credentials must be verified after deployment.
- AI and OCR quality depends on external providers and API keys, so fallback behavior and error handling need more testing.
- The MVP currently uses free API tiers, which creates token and rate-limit constraints. Because of those limits, the system cannot always send strong/large prompts to AI endpoints, cannot always process all document content at once, and may not be able to insert all generated data in one pass.
- Some large flows, especially exam/test question extraction and prediction, need batching or summarization because full notes, previous papers, tests, and extracted questions can exceed free API token limits.
- The predictor target is approximately 75% likely coverage of real exam/test content, but this still needs evidence from real student usage and comparison against actual assessment papers.
- Uploaded PDFs and extracted text need validation to confirm accuracy before relying on AI answers.
- Some documents show older planning notes mentioning local JSON storage, while the code now uses Supabase. Documentation should be updated to avoid confusion.
- Full end-to-end testing is still required for student login, admin login, uploads, enrollment, AI chat, quiz, flashcard, exam extraction, and deletion flows.
- Security review is needed before production, especially around service-role keys, admin routes, CORS, and storage bucket permissions.
- The UI is functional and includes mobile styling across the student tool pages, but final accessibility testing and cross-device verification are still needed.
- Duplicate test-study files exist: `test-study.html` and `test_study.html` currently have identical content. The app links to `test_study.html`, so the duplicate should be intentionally kept, redirected, or removed before final cleanup.

### Support Required

- Supabase production project setup, including tables, migrations, RLS policies, storage buckets, and backups.
- Production hosting verification for the Node.js backend, or conversion of selected API routes into Netlify Functions if a single Netlify-only deployment is required.
- Netlify free tier deployment setup for the static frontend, including final confirmation of the public frontend URL.
- Environment/config review so frontend pages, backend CORS settings, and Supabase browser keys match the deployed domains.
- API keys for selected AI/OCR providers.
- Better paid or higher-limit AI/OCR API access if the predictor and extraction flows must process full documents reliably.
- Batching strategy for large inserts and AI-generated exam/test question data.
- Sample course material, module guides, past papers, tests, and answer memos for realistic testing.
- User acceptance testing with real students/admins.
- Review of legal/privacy requirements for storing student data and uploaded academic material.

## 7. Screenshots, Demo Links, and Prototype Updates

### Prototype Pages Available

The following pages exist in the repository and can be used for screenshots or a demo walkthrough:

- Student learning dashboard: `index.html`
- Student login: `login.html`
- Student library: `library.html`
- Quiz mode: `quiz.html`
- Flashcard mode: `flashcard.html`
- Chapter study mode: `chapter-study.html`
- Exam study mode: `exam-study.html`
- Test study mode: `test_study.html`
- Duplicate test study entry file: `test-study.html`
- Question predictor: `question-predictor.html`
- Word Builder practice game: `word-builder.html`
- Invader Challenge game: `invader-challenge.html`
- Practice leaderboard/profile page: `leaderboard.html`
- Module skills page: `frontend/module-skills.html`
- Admin login: `frontend/admin/adminlogin.html`
- Admin dashboard: `frontend/admin/admin.html`
- Admin courses: `frontend/admin/admin.html` and `frontend/admin/course.html`
- Admin modules: `frontend/admin/module.html`
- Admin chapters: `frontend/admin/chapter.html`
- Admin module guides: `frontend/admin/module-guide.html`
- Admin exams/tests: `frontend/admin/exam.html`
- Admin enrollment requests: `frontend/admin/request.html`
- Admin students/enrollments: `frontend/admin/students.html`
- Admin student redirect/helper page: `frontend/admin/student.html`

### Suggested Demo Flow

1. Start the backend server.
2. Log in as an admin.
3. Create a course and module.
4. Upload a chapter PDF or supported chapter file.
5. Upload a module guide.
6. Upload an exam/test paper.
7. Enroll a student in the module.
8. Log in as the student.
9. Select the enrolled module and chapter.
10. Ask the AI tutor a chapter-specific question.
11. Open quiz, flashcard, chapter study, exam study, test study, Word Builder, Invader Challenge, and My Library pages.
12. Submit a quiz/flashcard/game attempt and review leaderboard or analytics results.

### Screenshot Checklist

- Student module selection screen.
- Student chapter selection screen.
- AI tutor chat response.
- Quiz or flashcard screen.
- Exam study or test study screen.
- Word Builder practice screen.
- Invader Challenge gameplay screen.
- Invader leaderboard, badges, and skill XP screen.
- My Library recommendations screen.
- Module skills page.
- Admin dashboard.
- Admin chapter upload/list screen.
- Admin students/enrollment management screen.
- Admin exam upload/list screen.
- Admin leaderboard and learning analytics panel.

### Demo Link

Current local prototype URL:

```text
http://localhost:5050
```

Planned hosted prototype:

```text
Netlify free tier frontend URL: https://skillfinderai.netlify.app/login.html
Backend API URL: https://skillfind-ai.onrender.com
```

If the frontend is opened directly from files, use the relevant `.html` pages in the project root and `frontend/admin` folder. The frontend config chooses the local API URL for `file:`, `localhost`, and `127.0.0.1`, and the production API URL for hosted browser use. For a final hosted demo, verify the Netlify frontend URL, Render backend health endpoint, and CORS settings.

## 8. Overall Summary

The SkillFind AI MVP has made strong progress. The repository contains a functional prototype with real student and admin workflows, Supabase-backed data storage, authentication, role checks, uploaded learning content, AI tutoring, study tools, and exam preparation features.

The MVP has also onboarded three real students so far, and the exam/test predictor is a key differentiator because it aims to predict approximately 75% of likely real assessment coverage from notes, past exams, past tests, and extracted question patterns.

The next milestone should focus on production readiness: Netlify free tier frontend deployment, hosted backend verification, CORS and environment review, testing all flows, cleaning up documentation, securing environment variables and admin routes, improving error handling, validating AI/OCR accuracy, and designing around free API token limits.
