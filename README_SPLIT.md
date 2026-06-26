# SkillFind AI standalone page split

This folder contains a standalone-file version of the uploaded SkillFind AI index page.

## Files

- `index.html` — main module, chapter and chat interface.
- `quiz.html` — standalone quiz page with its own HTML, CSS and JavaScript.
- `flashcard.html` — standalone flashcard page with its own HTML, CSS and JavaScript.
- `chapter-study.html` — standalone AI study-guide page with its own HTML, CSS and JavaScript.
- `question-predictor.html` — standalone question predictor page with its own HTML, CSS and JavaScript.

## Local development

Run the frontend and backend together from the project root:

```powershell
npm run dev
```

If PowerShell blocks `npm.ps1` on your machine, use:

```powershell
npm.cmd run dev
```

This starts:

- Frontend: `http://localhost:5173`
- Backend API: `http://localhost:5050`
- Admin login: `http://localhost:5173/frontend/admin/adminlogin.html`

To run only one side:

```powershell
npm run dev:frontend
npm run dev:backend
```

The frontend config automatically uses `http://localhost:5050` when opened from `localhost`, `127.0.0.1`, or `file://`.

For the backend, copy `server/.env.example` to `server/.env` and fill in your Supabase service-role key plus the AI/OCR keys you use.

## Important

These files still expect your existing `frontend/config.js` file to exist, because that is where your Supabase URL and anon key should remain. Do not hard-code Supabase keys into every HTML file.

The pages also expect your backend API to be running at `http://localhost:5050`.

## How the pages share the selected chapter

When you select a chapter in `index.html` and click Quiz, Flashcard, Chapter Study, or Question Predictor, the selected module/chapter context is saved into localStorage and also passed as URL query parameters.
OpenRouter generates
      ↓
Groq reviews and fixes
      ↓
Hugging Face backs up if needed
      ↓
Local extraction if all APIs fail
