// ============================================
// SKILLFIND AI - PURE AI TUTOR SERVER
// ============================================

import "dotenv/config";
import express from "express";
import multer from "multer";
import cors from "cors";
import FormData from "form-data";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import path from "path";
import { createClient } from "@supabase/supabase-js";

// Import route modules
import quizRouter from "./routes/quiz-server.js";
import flashcardRouter from "./routes/flashcard-server.js";
import studyRouter from "./routes/study-server.js";
import questionExtractorRouter from "./routes/question-extractor.js";
import aiTrainingRouter from "./routes/ai-training.js";
import examRoutes from "./routes/exam-server.js";
import testRoutes from "./routes/test-server.js";
import moduleSkillsRouter from "./routes/module-skills-server.js";
import gameRouter from "./routes/game-server.js";
import wordBuilderRouter from "./routes/word-builder-server.js";
import examPracticeRouter from "./routes/exam-practice-server.js";
import activityRouter from "./routes/activity-server.js";
import adminDeleteRouter from "../frontend/admin/routes/admin-delete.js";  // <-- ADD THIS

const app = express();
app.use(cors());
app.use(express.json({ limit: "10mb" }));
app.use(express.static(path.join(process.cwd(), "frontend")));

// ============================================
// HEALTH CHECK ENDPOINTS
// ============================================

app.get("/health", (req, res) => res.json({ ok: true }));

app.get("/health/keys", (req, res) => {
  res.json({
    groqKeyLoaded: Boolean(process.env.GROQ_API_KEY),
    supabaseUrlLoaded: Boolean(process.env.SUPABASE_URL),
    supabaseServiceLoaded: Boolean(process.env.SUPABASE_SERVICE_ROLE_KEY),
    architecture: "SkillFind AI - Pure AI Tutor",
    groqModel: process.env.GROQ_MODEL || "llama-3.1-8b-instant"
  });
});

app.get("/.well-known/appspecific/com.chrome.devtools.json", (req, res) =>
  res.status(204).end()
);

// ============================================
// MULTER CONFIGURATION
// ============================================

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10_000_000 }
});

// ============================================
// SUPABASE CLIENT
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { 
    persistSession: false,
    autoRefreshToken: false,  // Disable auto refresh to reduce requests
    detectSessionInUrl: false
  },
  // Add these to handle connection issues better
  global: {
    headers: { 'x-application-name': 'skillfind-ai-server' }
  }
});

// Add a health check for Supabase connection
async function checkSupabaseConnection() {
  try {
    const { error } = await sbAdmin.from('profiles').select('id').limit(1);
    if (error) throw error;
    console.log('✅ Supabase connection healthy');
    return true;
  } catch (error) {
    console.error('❌ Supabase connection failed:', error.message);
    return false;
  }
}

// Run it occasionally
setInterval(async () => {
  await checkSupabaseConnection();
}, 60000); // Check every minute
// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

async function requireSupabaseUser(req) {
  return await withRetry(async () => {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) throw new Error("Missing Authorization Bearer token.");

    const { data, error } = await sbAdmin.auth.getUser(token);
    if (error || !data?.user) throw new Error("Invalid/expired session.");
    return data.user;
  });
}


async function requireStudent(req, res, next) {
  try {
    const user = await requireSupabaseUser(req);
    const { data: prof, error } = await sbAdmin
      .from("profiles")
      .select("role, full_name, education_level")
      .eq("id", user.id)
      .single();

    if (error)
      throw Object.assign(new Error("Profile not found for this user."), {
        status: 403
      });
    if (prof.role !== "student")
      throw Object.assign(new Error("Forbidden: Students only."), {
        status: 403
      });

    req.user = user;
    req.profile = prof;
    next();
  } catch (e) {
    res
      .status(e.status || 500)
      .json({ ok: false, error: e.message || "Auth error" });
  }
}

// ============================================
// UTILITY FUNCTIONS
// ============================================

function isPdf(file) {
  const name = (file?.originalname || "").toLowerCase();
  const mime = (file?.mimetype || "").toLowerCase();
  return mime === "application/pdf" || name.endsWith(".pdf");
}

function isImage(file) {
  const mime = (file?.mimetype || "").toLowerCase();
  return mime.startsWith("image/");
}

function normalizeText(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

function chunkText(text, chunkSize = 900, overlap = 150) {
  const t = normalizeText(text);
  if (!t) return [];
  const chunks = [];
  let i = 0;
  while (i < t.length) {
    const end = Math.min(t.length, i + chunkSize);
    chunks.push(t.slice(i, end));
    i = end - overlap;
    if (i < 0) i = 0;
    if (end === t.length) break;
  }
  return chunks;
}

// ============================================
// PDF TEXT EXTRACTION
// ============================================

async function extractPdfText(buffer, password = "") {
  const loadingTask = pdfjsLib.getDocument({
    data: new Uint8Array(buffer),
    password: password || undefined
  });
  const doc = await loadingTask.promise;

  let fullText = "";
  for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
    const page = await doc.getPage(pageNum);
    const content = await page.getTextContent();

    const pageText = content.items
      .map((item) => (item?.str ? item.str : ""))
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();

    if (pageText) fullText += (fullText ? "\n\n" : "") + pageText;
  }

  return { text: fullText.trim(), meta: { pages: doc.numPages } };
}

// ============================================
// OCR.SPACE FALLBACK
// ============================================

function getOcrSpaceFiletypeAndName(file) {
  const originalName = (file?.originalname || "").toLowerCase();
  const mime = (file?.mimetype || "").toLowerCase();
  if (mime === "application/pdf" || originalName.endsWith(".pdf"))
    return { filetype: "PDF", filename: "upload.pdf" };
  if (mime === "image/png" || originalName.endsWith(".png"))
    return { filetype: "PNG", filename: "upload.png" };
  if (
    mime === "image/jpeg" ||
    mime === "image/jpg" ||
    originalName.endsWith(".jpg") ||
    originalName.endsWith(".jpeg")
  )
    return { filetype: "JPG", filename: "upload.jpg" };
  return { filetype: "", filename: "upload" };
}

async function ocrWithOcrSpace({
  file,
  language = "eng",
  isOverlayRequired = "false",
  OCREngine = ""
}) {
  const apiKey = process.env.OCR_SPACE_API_KEY;
  if (!apiKey)
    return {
      ok: false,
      status: 500,
      json: { error: "Missing OCR_SPACE_API_KEY in .env" }
    };

  const { filetype, filename } = getOcrSpaceFiletypeAndName(file);

  const form = new FormData();
  form.append("file", file.buffer, {
    filename,
    contentType: file.mimetype || "application/octet-stream"
  });
  form.append("language", language);
  form.append(
    "isOverlayRequired",
    isOverlayRequired === "true" ? "true" : "false"
  );

  const safeEngine = OCREngine === "1" || OCREngine === "2" ? OCREngine : "";
  if (safeEngine) form.append("OCREngine", safeEngine);
  if (filetype) form.append("filetype", filetype);

  const resp = await fetch("https://api.ocr.space/parse/image", {
    method: "POST",
    headers: { apikey: apiKey, ...form.getHeaders() },
    body: form
  });

  const raw = await resp.text();
  let json;
  try {
    json = JSON.parse(raw);
  } catch {
    return {
      ok: false,
      status: 502,
      json: { error: "Non-JSON response from OCR.space", status: resp.status, raw }
    };
  }

  return { ok: resp.ok, status: resp.status, json };
}

function safeExtractParsedText(ocrJson) {
  const parsed = ocrJson?.ParsedResults;
  if (Array.isArray(parsed) && parsed.length > 0) {
    return parsed
      .map((r) => (r?.ParsedText || "").trim())
      .filter(Boolean)
      .join("\n\n---\n\n")
      .trim();
  }
  return "";
}

// ============================================
// GROQ AI - PRIMARY TUTOR ENGINE
// ============================================

async function callGroqChat(messages, temperature = 0.5) {
  const apiKeysStr = [process.env.GROQ_API_KEY, process.env.GROQ_API_KEYS].filter(Boolean).join(",");
  const apiKeys = apiKeysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
  
  if (!apiKeys.length) throw new Error("Missing GROQ_API_KEY in .env");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const url = "https://api.groq.com/openai/v1/chat/completions";
  
  let lastError = null;
  
  for (const apiKey of apiKeys) {
    try {
      const resp = await fetch(url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({ 
          model, 
          messages, 
          temperature,
          max_tokens: 5000,
          top_p: 0.95
        })
      });

      const raw = await resp.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response from Groq: ${raw.slice(0, 300)}`);
      }

      if (!resp.ok) {
        const msg = json?.error?.message || json?.message || raw;
        if (resp.status === 401) {
          console.warn(`Groq key failed (401), trying next key...`);
          lastError = new Error(`[Groq Error 401]: ${msg}`);
          continue;
        }
        throw new Error(`[Groq Error ${resp.status}]: ${msg}`);
      }

      return (json?.choices?.[0]?.message?.content || "").trim();
      
    } catch (error) {
      if (!error.message.includes('401')) throw error;
      lastError = error;
    }
  }
  
  throw lastError || new Error("All Groq API keys failed");
}

async function callOpenRouterChat(messages, temperature = 0.35) {
  const apiKeysStr = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEYS].filter(Boolean).join(",");
  const apiKeys = apiKeysStr.split(",").map(k => k.trim()).filter(Boolean);
  if (!apiKeys.length) throw new Error("Missing OPENROUTER_API_KEY");

  const model = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";
  let lastError = null;

  for (const apiKey of apiKeys) {
    try {
      const resp = await fetch("https://openrouter.ai/api/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          "HTTP-Referer": process.env.APP_PUBLIC_URL || "http://localhost:5050",
          "X-Title": "SkillFind AI"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: 5000
        })
      });

      const raw = await resp.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response from OpenRouter: ${raw.slice(0, 300)}`);
      }

      if (!resp.ok) {
        const msg = json?.error?.message || json?.message || raw;
        throw new Error(`[OpenRouter Error ${resp.status}]: ${msg}`);
      }

      const content = (json?.choices?.[0]?.message?.content || "").trim();
      if (content) return content;
      throw new Error("OpenRouter returned no content");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All OpenRouter API keys failed");
}

async function callDeepSeekChat(messages, temperature = 0.35) {
  const apiKeysStr = [process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_API_KEYS].filter(Boolean).join(",");
  const apiKeys = apiKeysStr.split(",").map(k => k.trim()).filter(Boolean);
  if (!apiKeys.length) throw new Error("Missing DEEPSEEK_API_KEY");

  const model = process.env.DEEPSEEK_MODEL || "deepseek-chat";
  let lastError = null;

  for (const apiKey of apiKeys) {
    try {
      const resp = await fetch("https://api.deepseek.com/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages,
          temperature,
          max_tokens: 5000
        })
      });

      const raw = await resp.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response from DeepSeek: ${raw.slice(0, 300)}`);
      }

      if (!resp.ok) {
        const msg = json?.error?.message || json?.message || raw;
        throw new Error(`[DeepSeek Error ${resp.status}]: ${msg}`);
      }

      const content = (json?.choices?.[0]?.message?.content || "").trim();
      if (content) return content;
      throw new Error("DeepSeek returned no content");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All DeepSeek API keys failed");
}

function parseJsonArray(text) {
  try {
    return JSON.parse(text);
  } catch {
    const match = String(text || "").match(/\[[\s\S]*\]/);
    if (!match) return [];
    try {
      return JSON.parse(match[0]);
    } catch {
      return [];
    }
  }
}

function normalizeStudyQuestionType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "mcq") return "multiple_choice";
  if (value === "truefalse") return "true_false";
  if (value === "short_answer") return "short_question";
  if (value === "essay") return "long_question";
  return value || "short_question";
}

function optionsToArray(options) {
  if (Array.isArray(options)) return options.map(String).filter(Boolean);
  if (options && typeof options === "object") return Object.values(options).map(String).filter(Boolean);
  return [];
}

function hasAnyAiQuestionProvider() {
  return Boolean(
    process.env.OPENROUTER_API_KEY ||
    process.env.OPENROUTER_API_KEYS ||
    process.env.GROQ_API_KEY ||
    process.env.GROQ_API_KEYS ||
    process.env.DEEPSEEK_API_KEY ||
    process.env.DEEPSEEK_API_KEYS
  );
}

async function generateChapterQuestionBank({ moduleId, chapterId, chapterTitle, content, chunks = [], createdBy }) {
  const sourceText = Array.isArray(chunks) && chunks.length
    ? chunks.slice(0, 8).join("\n\n--- CHUNK ---\n\n")
    : content;

  if (!moduleId || !chapterId || !sourceText || sourceText.length < 200 || !hasAnyAiQuestionProvider()) return 0;

  const { data: moduleRow } = await sbAdmin
    .from("modules")
    .select("course_id")
    .eq("id", moduleId)
    .maybeSingle();

  const { data: chapterRow, error: chapterLookupError } = await sbAdmin
    .from("chapters")
    .select("id, module_id")
    .eq("id", chapterId)
    .maybeSingle();

  if (chapterLookupError || !chapterRow) {
    console.warn(
      "Skipping chapter question-bank insert because chapter_id was not found:",
      chapterId,
      chapterLookupError?.message || ""
    );
    return 0;
  }

  const systemPrompt = `Create a reusable study question bank from the chapter.
Return only a JSON array. Include these categories:
- multiple_choice
- true_false
- missing_word
- term_definition
- long_question
- short_question

Each item must have:
question_type, question_text, correct_answer, options, explanation, difficulty_level, topic_tags.

For missing_word also include missing_word.
For term_definition include term and definition. The definition should be the question shown to the learner, and the correct_answer must be the term.
Multiple choice needs at least 4 options. True/false options must be ["True","False"].
Questions must be directly based on the chapter and suitable for future quizzes, mock papers, and games.`;

  const messages = [
    { role: "system", content: systemPrompt },
    {
      role: "user",
      content: `Chapter title: ${chapterTitle}\n\nChapter chunks:\n${sourceText.substring(0, 9000)}\n\nGenerate 24 high-quality saved questions across all categories.`
    }
  ];

  let providerUsed = "";
  let response = "";
  const failures = [];

  if (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEYS) {
    try {
      response = await callOpenRouterChat(messages, 0.3);
      providerUsed = "OpenRouter";
    } catch (error) {
      failures.push(`OpenRouter: ${error.message}`);
    }
  }

  if (response && (process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS)) {
    try {
      response = await callGroqChat([
        {
          role: "system",
          content: `${systemPrompt}\n\nReview and improve the supplied JSON array. Fix weak questions, invalid question_type values, missing answers, and long term-definition options. Return only the corrected JSON array.`
        },
        {
          role: "user",
          content: `Chapter title: ${chapterTitle}\n\nCurrent generated question JSON:\n${response}`
        }
      ], 0.25);
      providerUsed = `${providerUsed} + Groq review`;
    } catch (error) {
      failures.push(`Groq review: ${error.message}`);
    }
  }

  if (!response && (process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS)) {
    try {
      response = await callGroqChat(messages, 0.35);
      providerUsed = "Groq";
    } catch (error) {
      failures.push(`Groq: ${error.message}`);
    }
  }

  if (!response && (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEYS)) {
    try {
      response = await callDeepSeekChat(messages, 0.35);
      providerUsed = "DeepSeek";
    } catch (error) {
      failures.push(`DeepSeek: ${error.message}`);
    }
  }

  if (!response) {
    console.warn("Chapter question-bank AI generation failed:", failures.join(" | "));
    return 0;
  }

  const questions = parseJsonArray(response);
  if (!questions.length) {
    console.warn(`Chapter question-bank provider returned no valid JSON array: ${providerUsed}`);
    return 0;
  }

  const rows = questions.map(question => {
    const options = optionsToArray(question.options);
    const questionType = normalizeStudyQuestionType(question.question_type || question.type);
    const correctAnswer = question.correct_answer
      || question.answer
      || question.term
      || options[0]
      || "Review the chapter";

    return {
      course_id: moduleRow?.course_id || null,
      module_id: moduleId,
      chapter_id: chapterRow.id,
      source: "chapter_generated",
      question_type: questionType,
      question_text: question.question_text || question.text || `Question from ${chapterTitle}`,
      correct_answer: String(correctAnswer),
      options,
      missing_word: question.missing_word || null,
      term: question.term || (questionType === "term_definition" ? String(correctAnswer) : null),
      definition: question.definition || null,
      explanation: question.explanation || null,
      marks: Number(question.marks) || (questionType === "long_question" ? 10 : 1),
      difficulty_level: question.difficulty_level || question.difficulty || "medium",
      topic_tags: question.topic_tags || question.topics || [],
      keywords: question.keywords || [],
      bloom_level: question.bloom_level || null,
      quality_score: 0.85,
      ai_confidence: 0.8,
      created_by: createdBy || null
    };
  }).filter(row => {
    if (row.question_type === "multiple_choice" && row.options.length < 2) return false;
    if (row.question_type === "missing_word" && !row.missing_word) return false;
    if (row.question_type === "term_definition" && (!row.term || !row.definition)) return false;
    return true;
  });

  if (!rows.length) return 0;
  const { error } = await sbAdmin.from("study_question_bank").insert(rows);
  if (error) {
    console.warn("Chapter question bank insert failed:", error.message);
    return 0;
  }
  return rows.length;
}

// ============================================
// TUTOR SYSTEM PROMPT
// ============================================

function getTutorSystemPrompt() {
  return {
    role: "system",
    content: `You are SkillFind AI Tutor, a knowledgeable and patient educational assistant. Your purpose is to help students understand their course material deeply.

**Your Teaching Style:**
- Be conversational and encouraging
- Explain concepts clearly using examples from the provided notes
- When the student asks a question, ground your answer in the chapter content first
- Connect new concepts to previously discussed topics
- Use simple language but don't dumb things down

**Formatting Guidelines:**
- Use **bold** for key terms and important concepts
- Use bullet points (•) for lists
- Use > for important tips or reminders
- Keep paragraphs short and readable
- Include real-world examples when relevant

**Follow-up Questions:**
After answering, suggest 2-3 relevant follow-up questions based on:
1. What the student just asked
2. Key concepts from the notes that relate to their question
3. Logical next questions to deepen understanding

**Important:** 
- Always reference the provided notes when answering
- If something isn't in the notes, say so honestly but try to help based on general knowledge
- Never make up information that contradicts the notes`
  };
}

// ============================================
// BUILD TUTOR RESPONSE WITH FOLLOW-UPS
// ============================================

async function generateTutorResponse({ question, notesContext, conversationHistory }) {
  const systemPrompt = getTutorSystemPrompt();
  
  const userPrompt = {
    role: "user",
    content: `## Student Question:
${question}

## Relevant Notes from the Chapter:
${notesContext}

Please answer the student's question based primarily on the notes above. After your answer, provide 2-3 follow-up questions that have answers in notes, the student might want to explore next.

Format your response with these exact markdown headings before any follow-up section:
## Direct Answer
## Key Points
## Example
## Study Moves
## Questions to Explore Next

Format your response as:
[Your detailed answer here...]

## 🔍 Questions to Explore Next
• [Follow-up question 1]
• [Follow-up question 2]
• [Follow-up question 3]`
  };

  const messages = [systemPrompt, ...conversationHistory.slice(-4), userPrompt];
  
  const failures = [];
  let response = "";
  let providerUsed = "";

  if (process.env.OPENROUTER_API_KEY || process.env.OPENROUTER_API_KEYS) {
    try {
      response = await callOpenRouterChat(messages, 0.35);
      providerUsed = "OpenRouter";
    } catch (error) {
      failures.push(`OpenRouter: ${error.message}`);
    }
  }

  if (response && (process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS)) {
    try {
      response = await callGroqChat([
        {
          role: "system",
          content: "Improve this tutor answer for clarity, accuracy, and visual structure. Keep the exact headings: Direct Answer, Key Points, Example, Study Moves, Questions to Explore Next. Return only the improved answer."
        },
        {
          role: "user",
          content: `Student question:\n${question}\n\nNotes:\n${notesContext}\n\nDraft answer:\n${response}`
        }
      ], 0.25);
      providerUsed = `${providerUsed} + Groq review`;
    } catch (error) {
      failures.push(`Groq review: ${error.message}`);
    }
  }

  if (!response && (process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS)) {
    try {
      response = await callGroqChat(messages, 0.5);
      providerUsed = "Groq";
    } catch (error) {
      failures.push(`Groq: ${error.message}`);
    }
  }

  if (!response && (process.env.DEEPSEEK_API_KEY || process.env.DEEPSEEK_API_KEYS)) {
    try {
      response = await callDeepSeekChat(messages, 0.35);
      providerUsed = "DeepSeek";
    } catch (error) {
      failures.push(`DeepSeek: ${error.message}`);
    }
  }

  if (response) {
    return { answer: response, success: true, providerUsed, failures };
  }

  console.error("Tutor AI providers failed:", failures.join(" | "));
  return {
    answer: generateFallbackAnswer(question, notesContext),
    success: false,
    providerUsed: "fallback",
    failures
  };
}

function generateFallbackAnswer(question, notesContext) {
  const relevantLines = notesContext.split('\n').filter(line => 
    line.toLowerCase().includes(question.toLowerCase().split(' ')[0]) ||
    line.length > 20
  ).slice(0, 5);
  
  if (relevantLines.length > 0) {
    return `Based on your course materials:\n\n${relevantLines.join('\n')}\n\n> 💡 **Tip**: You can ask me to explain specific terms or provide examples from the chapter.\n\n## 🔍 Questions to Explore Next\n• Can you explain that concept with an example?\n• What are the key takeaways from this section?\n• How does this connect to what we learned before?`;
  }
  
  return `I want to help you learn this topic! The notes I have access to contain information about this subject.\n\n> 💡 **Tip**: Try asking a more specific question, or ask me to summarize the key concepts from this chapter first.\n\n## 🔍 Questions to Explore Next\n• Can you summarize the key points of this chapter?\n• What are the most important terms I should know?\n• Can you give me an example of this concept in action?`;
}

function stripMarkdownDecorations(text) {
  return String(text || "")
    .replace(/^\s*(?:[-*]|\u2022|\u00e2\u20ac\u00a2)\s+/, "")
    .replace(/\*\*/g, "")
    .replace(/^#+\s*/, "")
    .trim();
}

function getMarkdownSection(text, heading) {
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|\\n)##\\s+(?:[^\\n\\w]*\\s*)?${escaped}\\s*\\n([\\s\\S]*?)(?=\\n##\\s+|$)`, "i");
  const match = String(text || "").match(pattern);
  return match ? match[1].trim() : "";
}

function getFollowUpSection(text) {
  return getMarkdownSection(text, "Questions to Explore Next")
    || getMarkdownSection(text, "Follow-up Questions")
    || getMarkdownSection(text, "Next Questions");
}

function sectionBullets(text) {
  return String(text || "")
    .split("\n")
    .map(stripMarkdownDecorations)
    .filter(Boolean)
    .slice(0, 5);
}

function buildTutorDisplay(answer, chunks = []) {
  const answerText = String(answer || "").trim();
  const directAnswer = stripMarkdownDecorations(getMarkdownSection(answerText, "Direct Answer"));
  const keyPoints = sectionBullets(getMarkdownSection(answerText, "Key Points"));
  const example = stripMarkdownDecorations(getMarkdownSection(answerText, "Example"));
  const studyMoves = sectionBullets(getMarkdownSection(answerText, "Study Moves"));
  const followUpQuestions = sectionBullets(getFollowUpSection(answerText)).slice(0, 3);
  const cleanAnswer = answerText
    .replace(/(?:^|\n)##\s+(?:[^\n\w]*\s*)?(?:Questions to Explore Next|Follow-up Questions|Next Questions)[\s\S]*$/i, "")
    .trim();
  const summary = directAnswer || stripMarkdownDecorations(cleanAnswer.split("\n").find(Boolean) || "");
  const cards = [];
  if (keyPoints.length) cards.push({ type: "key_points", title: "Key points", items: keyPoints });
  if (example) cards.push({ type: "example", title: "Example", text: example });
  if (studyMoves.length) cards.push({ type: "study_moves", title: "Study moves", items: studyMoves });

  return {
    version: 2,
    responseFormat: "tutor_visual_v2",
    answer: cleanAnswer,
    summary,
    cards,
    followUpQuestions
  };
}

// ============================================
// RETRIEVAL FUNCTIONS
// ============================================

async function verifyEnrollment({ studentId, moduleId }) {
  const { data: enr, error: eerr } = await sbAdmin
    .from("enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("module_id", moduleId)
    .maybeSingle();

  if (eerr) throw new Error(eerr.message);
  if (!enr)
    throw Object.assign(new Error("Not enrolled in this module."), { status: 403 });
}

async function listChapters({ moduleId, chapterId = null }) {
  let q = sbAdmin
    .from("chapters")
    .select("id, chapter_title, chapter_number")
    .eq("module_id", moduleId)
    .order("chapter_number", { ascending: true });

  if (chapterId) q = q.eq("id", chapterId);

  const { data, error } = await q;
  if (error) throw new Error(error.message);
  return data || [];
}

async function retrieveRelevantChunks({ chapterIds, question, limit = 6 }) {
  const { data: tsData, error: tsError } = await sbAdmin
    .from("chapter_chunks")
    .select("chapter_id, chunk_index, text, chapters!inner(chapter_title, chapter_number)")
    .in("chapter_id", chapterIds)
    .textSearch("search_text", question, { type: "plain", config: "english" })
    .limit(limit);

  if (!tsError && tsData && tsData.length > 0) {
    return tsData.map(chunk => ({
      ...chunk,
      text: chunk.text.length > 500 ? chunk.text.substring(0, 500) + "..." : chunk.text
    }));
  }

  const keywords = question.toLowerCase().split(' ').filter(w => w.length > 3).slice(0, 5);
  let ilikeResults = [];
  
  for (const keyword of keywords) {
    const { data: kwData, error: kwError } = await sbAdmin
      .from("chapter_chunks")
      .select("chapter_id, chunk_index, text, chapters!inner(chapter_title, chapter_number)")
      .in("chapter_id", chapterIds)
      .ilike("text", `%${keyword}%`)
      .limit(3);
    
    if (!kwError && kwData) ilikeResults.push(...kwData);
    if (ilikeResults.length >= limit) break;
  }
  
  const uniqueResults = [];
  const seen = new Set();
  for (const r of ilikeResults) {
    const key = `${r.chapter_id}_${r.chunk_index}`;
    if (!seen.has(key)) { seen.add(key); uniqueResults.push(r); }
  }
  
  if (uniqueResults.length > 0) {
    return uniqueResults.slice(0, limit).map(chunk => ({
      ...chunk,
      text: chunk.text.length > 500 ? chunk.text.substring(0, 500) + "..." : chunk.text
    }));
  }

  const { data: fallbackData, error: fallbackError } = await sbAdmin
    .from("chapter_chunks")
    .select("chapter_id, chunk_index, text, chapters!inner(chapter_title, chapter_number)")
    .in("chapter_id", chapterIds)
    .order("chunk_index", { ascending: true })
    .limit(limit);

  if (!fallbackError && fallbackData) {
    return fallbackData.map(chunk => ({
      ...chunk,
      text: chunk.text.length > 500 ? chunk.text.substring(0, 500) + "..." : chunk.text
    }));
  }

  return [];
}

function buildNotesContext(chunks) {
  if (!chunks || chunks.length === 0) return "No specific notes found for this question.";
  return chunks.map((chunk, i) => {
    const chapterInfo = chunk.chapters;
    const header = `[From ${chapterInfo?.chapter_title || "Chapter"}${chapterInfo?.chapter_number ? ` (Ch ${chapterInfo.chapter_number})` : ""}]\n`;
    return header + chunk.text;
  }).join("\n\n---\n\n");
}

// ============================================
// CONVERSATION MEMORY
// ============================================

async function saveChatMessage({ userId, conversationId, moduleId, chapterId = null, role, content }) {
  await sbAdmin.from("chat_messages").insert([{ 
    user_id: userId, 
    conversation_id: conversationId, 
    module_id: moduleId, 
    chapter_id: chapterId, 
    role, 
    content 
  }]);
}

async function loadChatHistory({ userId, conversationId, limit = 5 }) {
  const { data, error } = await sbAdmin
    .from("chat_messages")
    .select("role, content, created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);
  if (error) return [];
  return (data || []).map((r) => ({ role: r.role, content: r.content }));
}

async function loadConversationMessages({ userId, conversationId, limit = 100 }) {
  const { data, error } = await sbAdmin
    .from("chat_messages")
    .select("id, conversation_id, module_id, chapter_id, role, content, created_at")
    .eq("user_id", userId)
    .eq("conversation_id", conversationId)
    .order("created_at", { ascending: true })
    .limit(limit);

  if (error) throw error;
  return data || [];
}

// ============================================
// STUDENT ROUTES
// ============================================

const studentRouter = express.Router();
studentRouter.use(requireStudent);

studentRouter.get("/modules", async (req, res) => {
  const studentId = req.user.id;
  const { data, error } = await sbAdmin
    .from("enrollments")
    .select("module_id, modules(code, name, course_id, courses(name))")
    .eq("student_id", studentId);
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const modules = (data || []).map(r => ({ 
    module_id: r.module_id, 
    code: r.modules?.code || "", 
    name: r.modules?.name || "", 
    course_name: r.modules?.courses?.name || "" 
  }));
  res.json({ ok: true, modules });
});

studentRouter.get("/chapters", async (req, res) => {
  try {
    const studentId = req.user.id;
    const moduleId = (req.query?.moduleId || "").toString();
    if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });
    await verifyEnrollment({ studentId, moduleId });
    const { data, error } = await sbAdmin
      .from("chapters")
      .select("id, chapter_number, chapter_title")
      .eq("module_id", moduleId)
      .order("chapter_number", { ascending: true });
    if (error) return res.status(400).json({ ok: false, error: error.message });
    const chapters = (data || []).map(c => ({ 
      chapter_id: c.id, 
      chapter_number: c.chapter_number, 
      chapter_title: c.chapter_title 
    }));
    res.json({ ok: true, chapters });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Server error" });
  }
});

studentRouter.get("/chat/conversations", async (req, res) => {
  try {
    const studentId = req.user.id;
    const limit = Math.min(parseInt(req.query?.limit || "200", 10) || 200, 500);
    const { data, error } = await sbAdmin
      .from("chat_messages")
      .select("conversation_id, module_id, chapter_id, role, content, created_at")
      .eq("user_id", studentId)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) throw error;

    const grouped = new Map();
    for (const row of data || []) {
      if (!row.conversation_id) continue;
      const existing = grouped.get(row.conversation_id);
      if (!existing) {
        grouped.set(row.conversation_id, {
          conversationId: row.conversation_id,
          moduleId: row.module_id || null,
          chapterId: row.chapter_id || null,
          lastMessage: row.content || "",
          lastRole: row.role || "",
          lastAt: row.created_at,
          firstUserMessage: row.role === "user" ? row.content || "" : "",
          messageCount: 1
        });
      } else {
        existing.messageCount += 1;
        if (row.role === "user") existing.firstUserMessage = row.content || existing.firstUserMessage;
      }
    }

    res.json({ ok: true, conversations: Array.from(grouped.values()) });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

studentRouter.get("/chat/messages", async (req, res) => {
  try {
    const studentId = req.user.id;
    const conversationId = (req.query?.conversationId || "").toString().trim();
    if (!conversationId) {
      return res.status(400).json({ ok: false, error: "conversationId is required" });
    }

    const messages = await loadConversationMessages({ userId: studentId, conversationId });
    res.json({ ok: true, messages });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

studentRouter.post("/ask", async (req, res) => {
  try {
    const studentId = req.user.id;
    const question = (req.body?.keyword || "").toString().trim();
    const moduleId = (req.body?.moduleId || "").toString().trim();
    const chapterId = (req.body?.chapterId || null) ? (req.body.chapterId || "").toString().trim() : null;
    const conversationId = (req.body?.conversationId || "").toString().trim() || `conv_${studentId}_${moduleId}`;
    if (!question || !moduleId) return res.status(400).json({ ok: false, error: "Missing required fields" });
    await verifyEnrollment({ studentId, moduleId });
    await saveChatMessage({ userId: studentId, conversationId, moduleId, chapterId, role: "user", content: question });
    const chapters = await listChapters({ moduleId, chapterId });
    const allowedChapterIds = chapters.map(c => c.id);
    if (allowedChapterIds.length === 0) return res.json({ ok: true, conversationId, answer: "No chapters with notes yet.", followUpQuestions: [] });
    const relevantChunks = await retrieveRelevantChunks({ chapterIds: allowedChapterIds, question, limit: 6 });
    const notesContext = buildNotesContext(relevantChunks);
    const history = await loadChatHistory({ userId: studentId, conversationId, limit: 5 });
    const { answer, providerUsed } = await generateTutorResponse({ question, notesContext, conversationHistory: history });
    const display = buildTutorDisplay(answer, relevantChunks);
    await saveChatMessage({ userId: studentId, conversationId, moduleId, chapterId, role: "assistant", content: display.answer || answer });
    const followUpMatch = answer.match(/## 🔍 Questions to Explore Next\n([\s\S]+?)(?=\n##|$)/);
    let followUpQuestions = [];
    let cleanAnswer = answer;
    if (followUpMatch) {
      followUpQuestions = followUpMatch[1].split('\n').filter(line => line.trim().startsWith('•')).map(line => line.replace('•', '').trim());
      cleanAnswer = answer.replace(/## 🔍 Questions to Explore Next[\s\S]*$/, '').trim();
    }
    res.json({
      ok: true,
      conversationId,
      answer: display.answer || cleanAnswer,
      followUpQuestions: display.followUpQuestions.length ? display.followUpQuestions : followUpQuestions.slice(0, 3),
      display,
      provider: providerUsed || "unknown",
      endpoint: "/student/ask",
      alternatives: {
        chatAsk: "/student/chat/ask",
        conversations: "/student/chat/conversations",
        messages: "/student/chat/messages"
      }
    });
  } catch (e) {
    console.error("Ask error:", e);
    res.status(e.status || 500).json({ ok: false, error: e.message });
  }
});

studentRouter.post("/chat/ask", (req, res) => {
  res.redirect(307, "/student/ask");
});

app.use("/student/module-skills", moduleSkillsRouter);
app.use("/student", studentRouter);

// ============================================
// ADMIN ROUTES (without delete functions)
// ============================================

async function requireAdmin(req, res, next) {
  try {
    const user = await requireSupabaseUser(req);
    const { data: prof, error } = await sbAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
      
    if (error || prof?.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Forbidden: Admins only" });
    }
    req.user = user;
    next();
  } catch (e) {
    console.error("Admin auth error:", e.message);
    
    // Check if it's a connection error
    if (e.message.includes('ECONNRESET') || e.message.includes('fetch failed')) {
      return res.status(503).json({ 
        ok: false, 
        error: "Service temporarily unavailable. Please try again.",
        retryable: true
      });
    }
    
    res.status(500).json({ ok: false, error: e.message || "Auth error" });
  }
}
// Add this utility function
async function withRetry(fn, retries = 3, delay = 1000) {
  for (let i = 0; i < retries; i++) {
    try {
      return await fn();
    } catch (error) {
      const isConnectionError = error.message?.includes('ECONNRESET') || 
                                error.message?.includes('fetch failed');
      
      if (isConnectionError && i < retries - 1) {
        console.log(`Connection error, retrying in ${delay}ms... (${i + 1}/${retries})`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
}

// Use it in your auth middleware

const adminRouter = express.Router();
adminRouter.use(requireAdmin);

// GET routes only (no DELETE)
adminRouter.get("/courses", async (req, res) => {
  const { data, error } = await sbAdmin
    .from("courses")
    .select("*")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, courses: data });
});

adminRouter.post("/courses", async (req, res) => {
  const { code = null, name } = req.body || {};
  if (!name) return res.status(400).json({ ok: false, error: "name is required" });
  const { data, error } = await sbAdmin
    .from("courses")
    .insert([{ code, name }])
    .select("*")
    .single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, course: data });
});

adminRouter.get("/modules", async (req, res) => {
  const { courseId = "" } = req.query;
  let q = sbAdmin
    .from("modules")
    .select("id, course_id, code, name, created_at, courses(name, code)");
  if (courseId) q = q.eq("course_id", courseId);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const modules = (data || []).map(m => ({ 
    id: m.id, 
    course_id: m.course_id, 
    code: m.code, 
    name: m.name, 
    created_at: m.created_at, 
    course_name: m.courses?.name || "" 
  }));
  res.json({ ok: true, modules });
});

adminRouter.post("/modules", async (req, res) => {
  const { courseId, code = null, name } = req.body || {};
  if (!courseId) return res.status(400).json({ ok: false, error: "courseId is required" });
  if (!name) return res.status(400).json({ ok: false, error: "name is required" });
  const { data, error } = await sbAdmin
    .from("modules")
    .insert([{ course_id: courseId, code, name }])
    .select("*")
    .single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, module: data });
});

adminRouter.patch("/modules/:moduleId", async (req, res) => {
  const { moduleId } = req.params;
  const { courseId, code = null, name } = req.body || {};
  if (!courseId) return res.status(400).json({ ok: false, error: "courseId is required" });
  if (!name) return res.status(400).json({ ok: false, error: "name is required" });
  const { data, error } = await sbAdmin
    .from("modules")
    .update({ course_id: courseId, code: code || null, name })
    .eq("id", moduleId)
    .select("*")
    .single();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true, module: data });
});

adminRouter.get("/chapters", async (req, res) => {
  const { moduleId = "" } = req.query;
  let q = sbAdmin
    .from("chapters")
    .select(`id, module_id, chapter_number, chapter_title, method, created_at, modules(name), chapter_chunks(count)`);
  if (moduleId) q = q.eq("module_id", moduleId);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const chapters = (data || []).map(c => ({ 
    chapter_id: c.id, 
    module_name: c.modules?.name || "", 
    chapter_number: c.chapter_number, 
    chapter_title: c.chapter_title, 
    chunk_count: Array.isArray(c.chapter_chunks)
      ? Number(c.chapter_chunks[0]?.count || 0)
      : Number(c.chapter_chunks?.count || 0),
    method: c.method, 
    created_at: c.created_at 
  }));
  res.json({ ok: true, chapters });
});

adminRouter.post("/chapters/upload", upload.single("file"), async (req, res) => {
  try {
    const moduleId = (req.body?.moduleId || "").toString();
    const chapterTitle = (req.body?.chapterTitle || "").toString().trim();
    const chapterNumber = req.body?.chapterNumber ? Number(req.body.chapterNumber) : null;
    const pdfPassword = (req.body?.pdfPassword || "").toString();
    if (!moduleId || !chapterTitle || !req.file) throw new Error("Missing required fields");
    let extracted = "", method = "";
    if (isPdf(req.file)) {
      const { text } = await extractPdfText(req.file.buffer, pdfPassword);
      if (text && text.length > 60) { 
        extracted = text; 
        method = "pdf-text"; 
      } else { 
        const ocr = await ocrWithOcrSpace({ file: req.file }); 
        extracted = safeExtractParsedText(ocr.json); 
        method = "ocr"; 
      }
    } else if (isImage(req.file)) {
      const ocr = await ocrWithOcrSpace({ file: req.file });
      extracted = safeExtractParsedText(ocr.json);
      method = "ocr";
    }
    if (!extracted) throw new Error("No text extracted");
    const chunks = chunkText(extracted);
    const { data: ch, error: chErr } = await sbAdmin
      .from("chapters")
      .insert([{ 
        module_id: moduleId, 
        chapter_number: chapterNumber, 
        chapter_title: chapterTitle, 
        source_filename: req.file.originalname, 
        method, 
        created_by: req.user.id 
      }])
      .select("*")
      .single();
    if (chErr) throw chErr;
    const chunkRows = chunks.map((t, idx) => ({ chapter_id: ch.id, chunk_index: idx, text: t }));
    for (let i = 0; i < chunkRows.length; i += 150) {
      await sbAdmin.from("chapter_chunks").insert(chunkRows.slice(i, i + 150));
    }

    let questionsInserted = 0;
    try {
      questionsInserted = await generateChapterQuestionBank({
        moduleId,
        chapterId: ch.id,
        chapterTitle,
        content: extracted,
        chunks,
        createdBy: req.user.id
      });
    } catch (questionError) {
      console.warn("Chapter uploaded, but question-bank generation failed:", questionError.message);
    }

    res.json({ ok: true, chapterId: ch.id, chunksInserted: chunks.length, questionsInserted });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

adminRouter.get("/students", async (req, res) => {
  const { data, error } = await sbAdmin
    .from("profiles")
    .select("id, full_name, role, course_id, created_at, courses(name)")
    .eq("role", "student")
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const studentIds = (data || []).map(s => s.id);
  const enrollmentCounts = new Map();
  if (studentIds.length > 0) {
    const { data: enrollmentRows, error: enrollmentErr } = await sbAdmin
      .from("enrollments")
      .select("student_id")
      .in("student_id", studentIds);
    if (enrollmentErr) return res.status(400).json({ ok: false, error: enrollmentErr.message });
    for (const row of enrollmentRows || []) {
      enrollmentCounts.set(row.student_id, (enrollmentCounts.get(row.student_id) || 0) + 1);
    }
  }
  const students = (data || []).map(s => ({ 
    student_id: s.id, 
    student_name: s.full_name || "", 
    course_name: s.courses?.name || "",
    enrolled_modules_count: enrollmentCounts.get(s.id) || 0
  }));
  res.json({ ok: true, students });
});

adminRouter.get("/students/:studentId/course", async (req, res) => {
  const { studentId } = req.params;
  const { data, error } = await sbAdmin
    .from("profiles")
    .select("course_id, courses(id, name, code)")
    .eq("id", studentId)
    .eq("role", "student")
    .maybeSingle();
  if (error) return res.status(400).json({ ok: false, error: error.message });
  if (!data) return res.status(404).json({ ok: false, error: "Student not found" });
  res.json({ ok: true, course: data.courses || null, course_id: data.course_id || null });
});

adminRouter.patch("/students/:studentId/course", async (req, res) => {
  const { studentId } = req.params;
  const { courseId } = req.body;
  await sbAdmin.from("profiles").update({ course_id: courseId || null }).eq("id", studentId);
  res.json({ ok: true });
});

adminRouter.get("/students/:studentId/enrollments", async (req, res) => {
  const { studentId } = req.params;
  const { data, error } = await sbAdmin
    .from("enrollments")
    .select("module_id, created_at, modules(id, name, code, courses(name))")
    .eq("student_id", studentId)
    .order("created_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const enrollments = (data || []).map(e => ({
    module_id: e.module_id,
    module_name: e.modules?.name || "",
    module_code: e.modules?.code || "",
    course_name: e.modules?.courses?.name || "",
    created_at: e.created_at
  }));
  res.json({ ok: true, enrollments });
});

adminRouter.post("/students/:studentId/enrollments", async (req, res) => {
  const { studentId } = req.params;
  const { moduleId } = req.body;
  if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId required" });
  const { data: existing } = await sbAdmin
    .from("enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("module_id", moduleId)
    .maybeSingle();
  if (existing) return res.status(400).json({ ok: false, error: "Already enrolled" });
  await sbAdmin.from("enrollments").insert([{ student_id: studentId, module_id: moduleId }]);
  res.json({ ok: true });
});

adminRouter.delete("/students/:studentId/enrollments/:moduleId", async (req, res) => {
  const { studentId, moduleId } = req.params;
  const { error } = await sbAdmin
    .from("enrollments")
    .delete()
    .eq("student_id", studentId)
    .eq("module_id", moduleId);
  if (error) return res.status(400).json({ ok: false, error: error.message });
  res.json({ ok: true });
});

adminRouter.get("/enrollment-requests", async (req, res) => {
  const { status = "" } = req.query;
  let q = sbAdmin
    .from("enrollment_requests")
    .select(`id, status, created_at, student_id, module_id, profiles!enrollment_requests_student_id_fkey(full_name), modules(name, courses(name))`);
  if (status) q = q.eq("status", status);
  const { data, error } = await q.order("created_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const requests = (data || []).map(r => ({ 
    id: r.id, 
    status: r.status, 
    created_at: r.created_at, 
    student_name: r.profiles?.full_name || "", 
    course_name: r.modules?.courses?.name || "",
    module_name: r.modules?.name || "" 
  }));
  res.json({ ok: true, requests });
});

adminRouter.post("/enrollment-requests/:id/approve", async (req, res) => {
  const { id } = req.params;
  const { data: reqRow } = await sbAdmin
    .from("enrollment_requests")
    .select("*")
    .eq("id", id)
    .single();
  if (reqRow) {
    const { data: existing } = await sbAdmin
      .from("enrollments")
      .select("id")
      .eq("student_id", reqRow.student_id)
      .eq("module_id", reqRow.module_id)
      .maybeSingle();
    if (!existing) {
      await sbAdmin.from("enrollments").insert([{ 
        student_id: reqRow.student_id, 
        module_id: reqRow.module_id 
      }]);
    }
    await sbAdmin.from("enrollment_requests").update({ status: "approved" }).eq("id", id);
  }
  res.json({ ok: true });
});

adminRouter.post("/enrollment-requests/:id/reject", async (req, res) => {
  const { id } = req.params;
  await sbAdmin.from("enrollment_requests").update({ status: "rejected" }).eq("id", id);
  res.json({ ok: true });
});

adminRouter.get("/module-guides", async (req, res) => {
  const { moduleId = "" } = req.query;
  let q = sbAdmin
    .from("module_guides")
    .select(`
      id,
      module_id,
      title,
      description,
      guide_text,
      file_url,
      version,
      is_published,
      created_at,
      updated_at,
      modules(id, code, name, courses(name, code))
    `);
  if (moduleId) q = q.eq("module_id", moduleId);
  const { data, error } = await q.order("updated_at", { ascending: false });
  if (error) return res.status(400).json({ ok: false, error: error.message });
  const guides = (data || []).map(g => ({
    id: g.id,
    module_id: g.module_id,
    title: g.title,
    description: g.description || "",
    guide_text: g.guide_text || "",
    file_url: g.file_url || "",
    version: g.version,
    is_published: Boolean(g.is_published),
    created_at: g.created_at,
    updated_at: g.updated_at,
    module_code: g.modules?.code || "",
    module_name: g.modules?.name || "",
    course_name: g.modules?.courses?.name || ""
  }));
  res.json({ ok: true, guides });
});

adminRouter.post("/module-guides/upload", upload.single("guideFile"), async (req, res) => {
  try {
    const moduleId = (req.body?.moduleId || "").toString().trim();
    const title = (req.body?.title || "").toString().trim();
    const description = req.body?.description ? req.body.description.toString().trim() : null;
    const isPublished = req.body?.isPublished !== "false";
    const guideFile = req.file || null;

    if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });
    if (!title) return res.status(400).json({ ok: false, error: "title is required" });
    if (guideFile && !isPdf(guideFile)) {
      return res.status(400).json({ ok: false, error: "Only PDF module guides are supported" });
    }

    const { data: existing, error: existingError } = await sbAdmin
      .from("module_guides")
      .select("id, version, file_path, file_url, file_name, file_mime_type, file_size_bytes")
      .eq("module_id", moduleId)
      .maybeSingle();

    if (existingError) return res.status(400).json({ ok: false, error: existingError.message });
    if (!guideFile && !existing?.file_path && !existing?.file_url) {
      return res.status(400).json({ ok: false, error: "guideFile PDF is required" });
    }

    let fileFields = {};
    let extractedGuideText = null;
    if (guideFile) {
      const safeTitle = title.replace(/[^a-zA-Z0-9]+/g, "_").replace(/^_+|_+$/g, "") || "module_guide";
      const filePath = `module-guides/${moduleId}/${Date.now()}_${safeTitle}.pdf`;

      const { error: uploadError } = await sbAdmin.storage
        .from("module-guides")
        .upload(filePath, guideFile.buffer, {
          contentType: guideFile.mimetype || "application/pdf",
          cacheControl: "3600",
          upsert: true
        });

      if (uploadError) {
        return res.status(500).json({
          ok: false,
          error: `PDF upload failed: ${uploadError.message}`
        });
      }

      const { data: urlData } = sbAdmin.storage.from("module-guides").getPublicUrl(filePath);
      fileFields = {
        file_url: urlData?.publicUrl || null,
        file_path: filePath,
        file_name: guideFile.originalname,
        file_mime_type: guideFile.mimetype || "application/pdf",
        file_size_bytes: guideFile.size
      };

      try {
        const { text } = await extractPdfText(guideFile.buffer);
        extractedGuideText = normalizeText(text || "") || null;
      } catch (textError) {
        console.warn("Module guide text extraction failed:", textError.message);
      }
    }

    const row = {
      module_id: moduleId,
      title,
      description,
      is_published: isPublished,
      updated_by: req.user.id,
      ...fileFields
    };
    if (guideFile) row.guide_text = extractedGuideText;

    if (existing) {
      const { data, error } = await sbAdmin
        .from("module_guides")
        .update({ ...row, version: (existing.version || 1) + 1 })
        .eq("id", existing.id)
        .select("*")
        .single();
      if (error) return res.status(400).json({ ok: false, error: error.message });
      return res.json({ ok: true, guide: data });
    }

    const { data, error } = await sbAdmin
      .from("module_guides")
      .insert([{ ...row, created_by: req.user.id }])
      .select("*")
      .single();
    if (error) return res.status(400).json({ ok: false, error: error.message });
    res.json({ ok: true, guide: data });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Server error" });
  }
});

adminRouter.get("/exams", async (req, res) => {
  try {
    const { courseId, moduleId } = req.query;
    let query = sbAdmin
      .from("exams")
      .select(`
        *,
        courses!inner(id, name, code),
        modules(id, name)
      `);
    if (courseId) query = query.eq("course_id", courseId);
    if (moduleId) query = query.eq("module_id", moduleId);
    const { data, error } = await query.order("created_at", { ascending: false });
    if (error) throw error;
    const exams = (data || []).map(e => ({
      id: e.id,
      title: e.title,
      description: e.description,
      exam_type: e.exam_type,
      year: e.year,
      term: e.term,
      duration_minutes: e.duration_minutes,
      total_marks: e.total_marks,
      file_url: e.file_url,
      file_name: e.file_name,
      answer_file_url: e.answer_file_url,
      course_name: e.courses?.name,
      module_name: e.modules?.name,
      created_at: e.created_at
    }));
    res.json({ ok: true, exams });
  } catch (e) {
    console.error("Error fetching exams:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

adminRouter.post("/exams/upload", upload.fields([
  { name: "examFile", maxCount: 1 },
  { name: "answerFile", maxCount: 1 }
]), async (req, res) => {
  try {
    const { courseId, moduleId, examType, title, description, year, term, duration, totalMarks } = req.body;
    const examFile = req.files?.examFile?.[0];
    const answerFile = req.files?.answerFile?.[0];
    
    if (!courseId || !examType || !title || !examFile) {
      return res.status(400).json({ ok: false, error: "Missing required fields" });
    }
    
    const timestamp = Date.now();
    const safeTitle = title.replace(/[^a-zA-Z0-9]/g, '_');
    const fileExtension = examFile.originalname.split('.').pop();
    const examFileName = `exams/${timestamp}_${safeTitle}.${fileExtension}`;
    
    const { error: uploadError } = await sbAdmin.storage
      .from("exam-files")
      .upload(examFileName, examFile.buffer, { 
        contentType: examFile.mimetype,
        cacheControl: '3600'
      });
    
    if (uploadError) {
      return res.status(500).json({ ok: false, error: `File upload failed: ${uploadError.message}` });
    }
    
    const { data: urlData } = sbAdmin.storage.from("exam-files").getPublicUrl(examFileName);
    const publicFileUrl = urlData.publicUrl;
    
    let answerFileUrl = null;
    if (answerFile) {
      const answerExtension = answerFile.originalname.split('.').pop();
      const answerFileName = `exams/answers/${timestamp}_${safeTitle}_answer.${answerExtension}`;
      const { error: answerUploadError } = await sbAdmin.storage
        .from("exam-files")
        .upload(answerFileName, answerFile.buffer, { contentType: answerFile.mimetype });
      if (!answerUploadError) {
        const { data: answerUrlData } = sbAdmin.storage.from("exam-files").getPublicUrl(answerFileName);
        answerFileUrl = answerUrlData.publicUrl;
      }
    }
    
    const { data, error: dbError } = await sbAdmin.from("exams").insert([{
      course_id: courseId,
      module_id: moduleId || null,
      exam_type: examType,
      title: title,
      description: description || null,
      year: year ? parseInt(year) : null,
      term: term || null,
      duration_minutes: duration ? parseInt(duration) : null,
      total_marks: totalMarks ? parseInt(totalMarks) : null,
      file_url: publicFileUrl,
      file_name: examFile.originalname,
      file_size: examFile.size,
      answer_file_url: answerFileUrl,
      answers_available: !!answerFileUrl,
      created_by: req.user.id
    }]).select().single();
    
    if (dbError) {
      await sbAdmin.storage.from("exam-files").remove([examFileName]);
      return res.status(500).json({ ok: false, error: `Database error: ${dbError.message}` });
    }
    
    res.json({ ok: true, exam: data, message: "Exam uploaded successfully" });
  } catch (e) {
    console.error("Exam upload error:", e);
    res.status(500).json({ ok: false, error: e.message || "Upload failed" });
  }
});

// Study plan generation endpoint
app.post('/study/plan', async (req, res) => {
  try {
    const { moduleName, selectedChaptersCount, daysUntilExam, intensity, patterns } = req.body;
    
    const intensityHours = { light: 2, moderate: 3.5, intense: 5.5 };
    const hoursPerDay = intensityHours[intensity];
    const totalHours = Math.round(hoursPerDay * daysUntilExam);
    
    const topTopics = patterns?.frequent_topics ? 
      Object.entries(patterns.frequent_topics).sort((a,b) => b[1]-a[1]).slice(0,5).map(([t]) => t) : 
      ['key concepts'];
    
    let studyPlan = '';
    const apiKeys = process.env.GROQ_API_KEYS?.split(',') || [];
    const deepseekKeys = process.env.DEEPSEEK_API_KEYS?.split(',') || [];
    
    for (const key of apiKeys) {
      try {
        const response = await fetch('https://api.groq.com/openai/v1/chat/completions', {
          method: 'POST',
          headers: {
            'Authorization': `Bearer ${key}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'llama-3.1-8b-instant',
            messages: [
              { role: 'system', content: 'You are an expert study planner. Create a concise, actionable daily study plan.' },
              { role: 'user', content: `
                Create a ${daysUntilExam}-day study plan for ${moduleName}.
                Priority topics: ${topTopics.join(', ')}.
                Study intensity: ${intensity} (${hoursPerDay} hours/day).
                Total ${selectedChaptersCount} chapters to cover.
                
                Provide a day-by-day breakdown of what to study.
              ` }
            ],
            temperature: 0.5,
            max_tokens: 1000
          })
        });
        const data = await response.json();
        studyPlan = data.choices?.[0]?.message?.content;
        if (studyPlan) break;
      } catch(e) { continue; }
    }
    
    if (!studyPlan && deepseekKeys.length) {
      for (const key of deepseekKeys) {
        try {
          const response = await fetch('https://api.deepseek.com/v1/chat/completions', {
            method: 'POST',
            headers: {
              'Authorization': `Bearer ${key}`,
              'Content-Type': 'application/json'
            },
            body: JSON.stringify({
              model: 'deepseek-chat',
              messages: [
                { role: 'system', content: 'You are an expert study planner.' },
                { role: 'user', content: `Create a ${daysUntilExam}-day study plan for ${moduleName} with ${selectedChaptersCount} chapters. Priority topics: ${topTopics.join(', ')}.` }
              ],
              temperature: 0.5,
              max_tokens: 1000
            })
          });
          const data = await response.json();
          studyPlan = data.choices?.[0]?.message?.content;
          if (studyPlan) break;
        } catch(e) { continue; }
      }
    }
    
    res.json({ ok: true, studyPlan: studyPlan || generateFallbackPlan(daysUntilExam, selectedChaptersCount, topTopics) });
    
  } catch (error) {
    console.error('Study plan error:', error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

function generateFallbackPlan(days, chapters, topics) {
  let plan = `## ${days}-Day Study Plan\n\n`;
  const daysPerChapter = Math.max(1, Math.floor(days / chapters));
  for (let i = 1; i <= Math.min(days, 14); i++) {
    plan += `**Day ${i}:** `;
    if (i % 3 === 0) plan += `Review all previous chapters and take a practice quiz on ${topics[0] || 'key concepts'}.\n\n`;
    else plan += `Study Chapter ${Math.ceil(i / daysPerChapter)}: Focus on ${topics[i % topics.length] || 'core concepts'}.\n\n`;
  }
  return plan;
}
// Debug route to see all registered routes
app.get("/debug/routes", (req, res) => {
  const routes = [];
  app._router.stack.forEach(middleware => {
    if (middleware.route) {
      routes.push({
        path: middleware.route.path,
        methods: Object.keys(middleware.route.methods)
      });
    } else if (middleware.name === 'router') {
      middleware.handle.stack.forEach(handler => {
        if (handler.route) {
          routes.push({
            path: handler.route.path,
            methods: Object.keys(handler.route.methods)
          });
        }
      });
    }
  });
  res.json(routes);
});
// ============================================
// MOUNT ROUTERS
// ============================================

app.use("/admin", adminRouter);
app.use("/admin", adminDeleteRouter);  // DELETE routes mounted here
app.use("/quiz", quizRouter);
app.use("/flashcard", flashcardRouter);
app.use("/study", studyRouter);
app.use("/game", gameRouter);
app.use("/activity", activityRouter);
app.use("/word-builder", wordBuilderRouter);
app.use("/exam-practice", examPracticeRouter);
app.use("/api/questions", questionExtractorRouter);
app.use("/student", examRoutes);
app.use("/student", testRoutes);

// ============================================
// SERVER START
// ============================================

const port = process.env.PORT || 5050;
app.listen(port, () => {
  console.log(`
╔══════════════════════════════════════════════════════════╗
║           🎓 SKILLFIND AI - PURE AI TUTOR               ║
╠══════════════════════════════════════════════════════════╣
║  • URL: http://localhost:${port}                           ║
║  • AI Model: ${process.env.GROQ_MODEL || "llama-3.1-8b-instant"}        ║
║  • Status: ✅ AI Tutor ready                            ║
╚══════════════════════════════════════════════════════════╝
  `);
});
