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

    if (error || prof.role !== "student") {
      throw Object.assign(new Error("Forbidden: Students only."), { status: 403 });
    }

    req.user = user;
    next();
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Auth error" });
  }
}

function shuffle(values) {
  return [...values].sort(() => Math.random() - 0.5);
}

function cleanWord(value) {
  return String(value || "").replace(/[^a-zA-Z]/g, "").toUpperCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function sentenceWithBlank(text, answer) {
  const sentence = String(text || "").replace(/\s+/g, " ").trim();
  if (sentence.includes("____")) return sentence;
  if (answer && sentence.toLowerCase().includes(String(answer).toLowerCase())) {
    return sentence.replace(new RegExp(`\\b${escapeRegExp(answer)}\\b`, "i"), "_____");
  }
  return sentence || "Complete the missing word: _____.";
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

function adaptBankQuestion(row) {
  const answer = row.missing_word || row.correct_answer || "";
  const word = cleanWord(answer);
  if (word.length < 2 || word.length > 14) return null;

  return {
    id: row.id,
    type: "missing_word",
    text: sentenceWithBlank(row.question_text, answer),
    missing_word: answer,
    word,
    explanation: row.explanation || "",
    difficulty: row.difficulty_level || "medium",
    source: row.source || "database"
  };
}

async function getSavedWordQuestions(chapterId, count) {
  const { data, error } = await sbAdmin
    .from("study_question_bank")
    .select("id, question_text, correct_answer, missing_word, explanation, difficulty_level, source")
    .eq("chapter_id", chapterId)
    .eq("is_active", true)
    .eq("question_type", "missing_word")
    .limit(100);

  if (error) {
    console.warn("Word Builder question lookup failed:", error.message);
    return [];
  }

  return shuffle(data || [])
    .map(adaptBankQuestion)
    .filter(Boolean)
    .slice(0, count);
}

async function getChapterContent(chapterId) {
  const { data, error } = await sbAdmin
    .from("chapter_chunks")
    .select("text, chunk_index")
    .eq("chapter_id", chapterId)
    .order("chunk_index", { ascending: true });

  if (error) throw error;
  return (data || []).map(row => row.text).join(" ");
}

async function generateAiWordQuestions({ chapterTitle, content, count }) {
  const apiKeys = String(process.env.GROQ_API_KEY || process.env.GROQ_API_KEYS || "")
    .split(",")
    .map(key => key.trim())
    .filter(Boolean);

  if (!apiKeys.length || !content || content.length < 200) return [];

  const prompt = `Create ${count} missing-word spelling game questions from this chapter.
Return only a JSON array.
Each item must have:
- text: one short sentence from the chapter with exactly one _____ blank
- missing_word: the exact word removed from the sentence
- explanation: a short explanation

Rules:
- missing_word must be a single word, 4 to 14 letters, letters only
- choose important course terms, not filler words
- each text must include _____
- do not repeat words

Chapter title: ${chapterTitle}

Chapter chunks:
${String(content).slice(0, 7000)}`;

  for (const apiKey of apiKeys) {
    try {
      const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
          messages: [
            { role: "system", content: "You create missing-word spelling questions for a learning game. Return valid JSON only." },
            { role: "user", content: prompt }
          ],
          temperature: 0.25,
          max_tokens: 2500
        })
      });

      const raw = await response.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON Groq response: ${raw.slice(0, 160)}`);
      }

      if (!response.ok) {
        throw new Error(json?.error?.message || `Groq HTTP ${response.status}`);
      }

      const contentText = json?.choices?.[0]?.message?.content || "";
      const rows = parseJsonArray(contentText)
        .map((item, index) => {
          const missing = item.missing_word || item.correct_answer || item.answer || "";
          const word = cleanWord(missing);
          if (word.length < 4 || word.length > 14) return null;
          return {
            id: `ai-${index}`,
            type: "missing_word",
            text: sentenceWithBlank(item.text || item.question_text, missing),
            missing_word: missing,
            word,
            explanation: item.explanation || `The missing word is "${missing}".`,
            difficulty: "medium",
            source: "ai_chunks"
          };
        })
        .filter(Boolean);

      if (rows.length) return rows.slice(0, count);
    } catch (error) {
      console.warn("Word Builder AI generation failed:", error.message);
    }
  }

  return [];
}

function fallbackWordQuestions({ chapterTitle, content, count }) {
  const sentences = String(content || "")
    .split(/[.!?]+/)
    .map(sentence => sentence.trim().replace(/\s+/g, " "))
    .filter(sentence => sentence.length >= 35 && sentence.length <= 180);

  const questions = [];
  const used = new Set();

  for (const sentence of sentences) {
    const words = sentence.match(/\b[A-Za-z][A-Za-z-]{3,}\b/g) || [];
    const candidates = words
      .map(word => word.replace(/^-+|-+$/g, ""))
      .filter(word => word.length >= 4 && word.length <= 14)
      .filter(word => !/^(this|that|with|from|have|will|your|they|their|there|where|when|what|which|chapter|section|about|using|into|were|been)$/i.test(word));

    const chosen = candidates.find(word => !used.has(word.toLowerCase()));
    if (!chosen) continue;

    used.add(chosen.toLowerCase());
    questions.push({
      id: `fallback-${questions.length}`,
      type: "missing_word",
      text: sentenceWithBlank(sentence, chosen),
      missing_word: chosen,
      word: cleanWord(chosen),
      explanation: `The missing word is "${chosen}" from the chapter content.`,
      difficulty: "medium",
      source: "chapter_chunks"
    });

    if (questions.length >= count) break;
  }

  while (questions.length < count) {
    questions.push({
      id: `basic-${questions.length}`,
      type: "missing_word",
      text: `A key word from "${chapterTitle || "this chapter"}" is _____.`,
      missing_word: "concept",
      word: "CONCEPT",
      explanation: "Review the chapter and practice spelling important terms.",
      difficulty: "easy",
      source: "fallback"
    });
  }

  return questions.slice(0, count);
}

router.post("/generate", requireStudent, async (req, res) => {
  try {
    const chapterId = String(req.body?.chapterId || "").trim();
    const chapterTitle = String(req.body?.chapterTitle || "Chapter").trim();
    const requestedCount = Math.max(4, Math.min(Number(req.body?.questionCount) || 5, 20));

    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }

    console.log(`Word Builder request: chapter=${chapterId}, requested=${requestedCount}`);

    let questions = await getSavedWordQuestions(chapterId, requestedCount);
    const savedCount = questions.length;
    let aiCount = 0;
    let fallbackCount = 0;

    console.log(`Word Builder DB questions found: ${savedCount}/${requestedCount}`);

    if (questions.length < requestedCount) {
      const content = await getChapterContent(chapterId);
      console.log(`Word Builder chapter content length: ${content.length} characters`);
      const aiQuestions = await generateAiWordQuestions({
        chapterTitle,
        content,
        count: requestedCount - questions.length
      });
      const usedWords = new Set(questions.map(question => question.word));
      const freshAiQuestions = aiQuestions.filter(question => {
        if (usedWords.has(question.word)) return false;
        usedWords.add(question.word);
        return true;
      });
      aiCount = freshAiQuestions.length;
      console.log(`Word Builder AI questions created: ${aiCount}`);
      questions = [...questions, ...freshAiQuestions];

      if (questions.length < requestedCount) {
        const fallback = fallbackWordQuestions({
          chapterTitle,
          content,
          count: requestedCount - questions.length
        }).filter(question => {
          if (usedWords.has(question.word)) return false;
          usedWords.add(question.word);
          return true;
        });
        fallbackCount = fallback.length;
        console.log(`Word Builder fallback questions created: ${fallbackCount}`);
        questions = [...questions, ...fallback];
      }
    }

    const returnedQuestions = questions.slice(0, requestedCount);
    console.log(
      `Word Builder returned: ${returnedQuestions.length}/${requestedCount} ` +
      `(db=${savedCount}, ai=${aiCount}, fallback=${fallbackCount})`
    );

    res.json({
      ok: true,
      questions: returnedQuestions,
      questionCount: returnedQuestions.length,
      metadata: {
        source: savedCount ? "database-ai-chunks" : "ai-chunks",
        savedCount,
        aiCount,
        fallbackCount,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error("Word Builder generation error:", error);
    res.status(500).json({ ok: false, error: error.message || "Word Builder generation failed" });
  }
});

export default router;
