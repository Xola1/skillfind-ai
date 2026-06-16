import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function requireSupabaseUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw Object.assign(new Error("Missing Authorization Bearer token."), { status: 401 });
  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user) throw Object.assign(new Error("Invalid/expired session."), { status: 401 });
  return data.user;
}

async function requireStudent(req, res, next) {
  try {
    const user = await requireSupabaseUser(req);
    const { data: prof, error } = await sbAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();
    if (error || prof.role !== "student") throw Object.assign(new Error("Forbidden: Students only."), { status: 403 });
    req.user = user;
    next();
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Auth error" });
  }
}

function shuffle(values) {
  return [...values].sort(() => Math.random() - 0.5);
}

function cleanUuidArray(values) {
  const raw = Array.isArray(values) ? values : String(values || "").split(",");
  return raw.map(value => String(value || "").trim()).filter(value => /^[0-9a-f-]{36}$/i.test(value));
}

function normalizeQuestionType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "mcq") return "multiple_choice";
  if (value === "truefalse") return "true_false";
  if (value === "short_answer") return "short_question";
  return value || "multiple_choice";
}

function normalizeRequestedTypes(types) {
  const normalized = (Array.isArray(types) ? types : []).map(normalizeQuestionType).filter(Boolean);
  return normalized.length ? normalized : ["multiple_choice", "true_false", "missing_word"];
}

function optionArray(options) {
  if (Array.isArray(options)) return options.map(String).filter(Boolean);
  if (options && typeof options === "object") return Object.values(options).map(String).filter(Boolean);
  return [];
}

function adaptQuestion(row) {
  const questionType = normalizeQuestionType(row.question_type);
  let options = optionArray(row.options);
  let answer = String(row.correct_answer || row.missing_word || row.term || "").trim();
  let text = row.question_text;

  if (questionType === "true_false") options = ["True", "False"];
  if (questionType === "missing_word" && !options.length) options = [answer, "Unknown", "None of these"].filter(Boolean);
  if (questionType === "term_definition") {
    answer = String(row.term || answer).trim();
    text = row.definition || row.question_text;
    if (!options.includes(answer)) options = [answer, ...options];
  }
  if (!options.length) options = [answer, "Review the notes", "Not covered", "None of these"].filter(Boolean);

  options = shuffle([...new Set(options)]).slice(0, 6);
  let correct = options.findIndex(option => option.toLowerCase().trim() === answer.toLowerCase());
  if (correct < 0) correct = 0;

  return {
    id: row.id,
    type: questionType === "multiple_choice" ? "mcq" : questionType === "true_false" ? "truefalse" : questionType,
    text,
    options,
    correct,
    correct_answer: answer,
    missing_word: row.missing_word || null,
    term: row.term || null,
    definition: row.definition || null,
    explanation: row.explanation || "",
    difficulty: row.difficulty_level || "medium",
    source: row.source || "exam_practice"
  };
}

async function loadBankQuestions({ moduleId, chapterIds, count, questionTypes }) {
  let query = sbAdmin
    .from("study_question_bank")
    .select("*")
    .eq("module_id", moduleId)
    .eq("is_active", true)
    .in("question_type", normalizeRequestedTypes(questionTypes))
    .limit(150);

  if (chapterIds.length) query = query.in("chapter_id", chapterIds);
  const { data, error } = await query;
  if (error) {
    console.warn("Exam practice bank lookup failed:", error.message);
    return [];
  }
  return shuffle(data || []).slice(0, count).map(adaptQuestion);
}

async function loadChapterContent(chapterIds) {
  if (!chapterIds.length) return "";
  const { data, error } = await sbAdmin
    .from("chapter_chunks")
    .select("text, chunk_index")
    .in("chapter_id", chapterIds)
    .order("chunk_index", { ascending: true });
  if (error) throw error;
  return (data || []).map(row => row.text).join(" ");
}

function fallbackQuizQuestions({ title, content, count, questionTypes }) {
  if (normalizeRequestedTypes(questionTypes).includes("missing_word")) {
    return fallbackWordQuestions({ title, content, count }).map(item => ({
      ...item,
      options: [item.missing_word, "Unknown", "None of these"],
      correct: 0
    }));
  }

  const sentences = String(content || "").split(/[.!?]+/).map(s => s.trim()).filter(s => s.length > 30);
  return Array.from({ length: count }, (_, index) => ({
    id: `fallback-${index}`,
    type: "mcq",
    text: sentences[index] ? `Based on the selected exam chapters: "${sentences[index].slice(0, 90)}..."` : `What is a key exam concept from "${title || "these chapters"}"?`,
    options: ["A key concept from the selected chapters", "Unrelated content", "A skipped topic", "None of these"],
    correct: 0,
    correct_answer: "A key concept from the selected chapters",
    explanation: "Review the selected chapters and exam bank for this topic.",
    difficulty: "medium",
    source: "fallback"
  }));
}

function cleanWord(value) {
  return String(value || "").replace(/[^a-zA-Z]/g, "").toUpperCase();
}

function sentenceWithBlank(text, answer) {
  const sentence = String(text || "").replace(/\s+/g, " ").trim();
  if (sentence.includes("____")) return sentence;
  if (answer && sentence.toLowerCase().includes(String(answer).toLowerCase())) {
    const escaped = String(answer).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return sentence.replace(new RegExp(`\\b${escaped}\\b`, "i"), "_____");
  }
  return sentence || "Complete the missing word: _____.";
}

function fallbackWordQuestions({ title, content, count }) {
  const sentences = String(content || "").split(/[.!?]+/).map(s => s.trim().replace(/\s+/g, " ")).filter(s => s.length >= 35 && s.length <= 180);
  const used = new Set();
  const questions = [];

  for (const sentence of sentences) {
    const words = sentence.match(/\b[A-Za-z][A-Za-z-]{3,}\b/g) || [];
    const chosen = words.find(word => word.length >= 4 && word.length <= 14 && !used.has(word.toLowerCase()));
    if (!chosen) continue;
    used.add(chosen.toLowerCase());
    questions.push({
      id: `word-${questions.length}`,
      type: "missing_word",
      text: sentenceWithBlank(sentence, chosen),
      missing_word: chosen,
      word: cleanWord(chosen),
      explanation: `The missing word is "${chosen}".`,
      difficulty: "medium",
      source: "chapter_chunks"
    });
    if (questions.length >= count) break;
  }

  while (questions.length < count) {
    questions.push({
      id: `word-basic-${questions.length}`,
      type: "missing_word",
      text: `A key exam word from "${title || "these chapters"}" is _____.`,
      missing_word: "concept",
      word: "CONCEPT",
      explanation: "Review the selected exam chapters.",
      difficulty: "easy",
      source: "fallback"
    });
  }
  return questions.slice(0, count);
}

router.post("/quiz/generate", requireStudent, async (req, res) => {
  try {
    const moduleId = String(req.body?.moduleId || "").trim();
    const chapterIds = cleanUuidArray(req.body?.chapterIds || req.body?.chapterId);
    const questionCount = Math.max(1, Math.min(Number(req.body?.questionCount) || 5, 50));
    if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });

    let questions = await loadBankQuestions({ moduleId, chapterIds, count: questionCount, questionTypes: req.body?.questionTypes });
    const savedCount = questions.length;
    if (questions.length < questionCount) {
      const content = await loadChapterContent(chapterIds);
      questions = [...questions, ...fallbackQuizQuestions({
        title: req.body?.chapterTitle || "selected chapters",
        content,
        count: questionCount - questions.length,
        questionTypes: req.body?.questionTypes
      })];
    }
    questions = questions.slice(0, questionCount);
    res.json({ ok: true, questions, questionCount: questions.length, metadata: { source: "exam-practice", savedCount } });
  } catch (error) {
    console.error("Exam practice quiz error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/word-builder/generate", requireStudent, async (req, res) => {
  try {
    const moduleId = String(req.body?.moduleId || "").trim();
    const chapterIds = cleanUuidArray(req.body?.chapterIds || req.body?.chapterId);
    const questionCount = Math.max(4, Math.min(Number(req.body?.questionCount) || 5, 20));
    if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });

    const bank = await loadBankQuestions({ moduleId, chapterIds, count: questionCount, questionTypes: ["missing_word"] });
    const words = bank.map(item => ({
      id: item.id,
      type: "missing_word",
      text: sentenceWithBlank(item.text, item.correct_answer),
      missing_word: item.missing_word || item.correct_answer,
      word: cleanWord(item.missing_word || item.correct_answer),
      explanation: item.explanation,
      difficulty: item.difficulty,
      source: item.source
    })).filter(item => item.word.length >= 2 && item.word.length <= 14);

    const savedCount = words.length;
    if (words.length < questionCount) {
      const content = await loadChapterContent(chapterIds);
      words.push(...fallbackWordQuestions({ title: req.body?.chapterTitle || "selected chapters", content, count: questionCount - words.length }));
    }
    const questions = words.slice(0, questionCount);
    res.json({ ok: true, questions, questionCount: questions.length, metadata: { source: "exam-practice", savedCount } });
  } catch (error) {
    console.error("Exam practice word-builder error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

router.post("/flashcard/generate", requireStudent, async (req, res) => {
  try {
    const moduleId = String(req.body?.moduleId || "").trim();
    const chapterIds = cleanUuidArray(req.body?.chapterIds || req.body?.chapterId);
    const cardCount = Math.max(1, Math.min(Number(req.body?.cardCount) || 10, 30));
    if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });

    const rows = await loadBankQuestions({ moduleId, chapterIds, count: cardCount, questionTypes: ["term_definition", "missing_word", "short_question"] });
    let flashcards = rows.map((q, index) => ({
      id: q.id || `card-${index}`,
      term: q.term || q.correct_answer || q.missing_word || `Question ${index + 1}`,
      definition: q.definition || q.explanation || q.text || "Review the selected exam chapters.",
      known: false
    })).slice(0, cardCount);

    if (flashcards.length < cardCount) {
      const content = await loadChapterContent(chapterIds);
      const words = fallbackWordQuestions({ title: req.body?.chapterTitle || "selected chapters", content, count: cardCount - flashcards.length });
      flashcards = [...flashcards, ...words.map(w => ({ id: w.id, term: w.missing_word, definition: w.text, known: false }))];
    }

    res.json({ ok: true, flashcards: flashcards.slice(0, cardCount), cardCount: Math.min(flashcards.length, cardCount), metadata: { source: "exam-practice" } });
  } catch (error) {
    console.error("Exam practice flashcard error:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
