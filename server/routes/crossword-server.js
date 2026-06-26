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

function cleanUuidArray(values) {
  const raw = Array.isArray(values) ? values : String(values || "").split(",");
  return raw.map(value => String(value || "").trim()).filter(value => /^[0-9a-f-]{36}$/i.test(value));
}

function cleanWord(value) {
  return String(value || "").replace(/[^a-zA-Z]/g, "").toUpperCase();
}

function escapeRegExp(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clueWithBlank(text, answer) {
  const sentence = String(text || "").replace(/\s+/g, " ").trim();
  const cleanAnswer = String(answer || "").trim();
  if (sentence.includes("____")) return sentence;
  if (cleanAnswer && sentence.toLowerCase().includes(cleanAnswer.toLowerCase())) {
    return sentence.replace(new RegExp(`\\b${escapeRegExp(cleanAnswer)}\\b`, "i"), "_____");
  }
  return sentence || "Key term from this chapter.";
}

function normalizeLevel(value) {
  return Math.max(1, Math.min(Number(value) || 1, 3));
}

function wordCountForLevel(level) {
  return ({ 1: 5, 2: 8, 3: 10 })[normalizeLevel(level)] || 5;
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

function splitKeys(value) {
  return String(value || "")
    .split(",")
    .map(key => key.trim())
    .filter(Boolean);
}

function aiProviders() {
  return [
    ...splitKeys([process.env.GROQ_API_KEY, process.env.GROQ_API_KEYS].filter(Boolean).join(",")).map(apiKey => ({
      name: "Groq",
      apiKey,
      url: "https://api.groq.com/openai/v1/chat/completions",
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      extraHeaders: {}
    })),
    ...splitKeys([process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEYS].filter(Boolean).join(",")).map(apiKey => ({
      name: "OpenRouter",
      apiKey,
      url: "https://openrouter.ai/api/v1/chat/completions",
      model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat",
      extraHeaders: {
        "HTTP-Referer": process.env.APP_PUBLIC_URL || "http://localhost:5050",
        "X-Title": "SkillFind AI"
      }
    })),
    ...splitKeys([process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_API_KEYS].filter(Boolean).join(",")).map(apiKey => ({
      name: "DeepSeek",
      apiKey,
      url: "https://api.deepseek.com/v1/chat/completions",
      model: process.env.DEEPSEEK_MODEL || "deepseek-chat",
      extraHeaders: {}
    }))
  ];
}

function hasAiProvider() {
  return aiProviders().length > 0;
}

function termRejectReason(term) {
  const answer = cleanWord(term.answer || term.word);
  const clue = String(term.clue || term.question || term.text || "").replace(/\s+/g, " ").trim();
  if (answer.length < 3) return "answer_too_short";
  if (answer.length > 12) return "answer_too_long";
  if (/\s/.test(String(term.answer || term.word || "").trim())) return "answer_not_single_word";
  if (clue.length < 12) return "clue_too_short";
  if (clue.length > 220) return "clue_too_long";
  return "";
}

function isStrongTerm(term) {
  return !termRejectReason(term);
}

function addUniqueTerm(terms, seen, term, debug = null) {
  const word = cleanWord(term.answer || term.word);
  const reason = termRejectReason({ ...term, answer: word });
  if (reason) {
    if (debug) debug.rejected[reason] = (debug.rejected[reason] || 0) + 1;
    return;
  }
  if (seen.has(word)) {
    if (debug) debug.rejected.duplicate = (debug.rejected.duplicate || 0) + 1;
    return;
  }
  seen.add(word);
  terms.push({
    id: term.id || `term-${terms.length}`,
    answer: word,
    clue: clueWithBlank(term.clue || term.question || term.text, term.answer || term.word),
    explanation: term.explanation || "",
    difficulty: term.difficulty || "medium",
    source: term.source || "crossword"
  });
  if (debug) debug.accepted += 1;
}

async function generateAiTerms({ chapterTitle, content, count }) {
  const providers = aiProviders();

  if (!providers.length || !content || content.length < 200 || count <= 0) return [];

  const prompt = `Create ${count} strong crossword clue entries from this chapter.
Return only a JSON array.
Each item must have:
- answer: one important course term, one word only, 3 to 12 letters, letters only
- clue: a concise clue, 18 to 160 characters

Rules:
- Use important technical/course terms only.
- Do not use filler words, generic words, or duplicate answers.
- The clue must clearly point to the answer.
- The clue may contain one _____ blank, but must not reveal the answer.
- Prefer terms that share common letters so they can intersect in a crossword.

Chapter title: ${chapterTitle || "Chapter"}

Chapter content:
${String(content || "").slice(0, 5200)}`;

  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
          ...provider.extraHeaders
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: "You create high-quality educational crossword clues. Return valid JSON only." },
            { role: "user", content: prompt }
          ],
          temperature: 0.2,
          max_tokens: 1400
        })
      });

      const raw = await response.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON ${provider.name} response: ${raw.slice(0, 160)}`);
      }
      if (!response.ok) throw new Error(json?.error?.message || `${provider.name} HTTP ${response.status}`);

      const rows = parseJsonArray(json?.choices?.[0]?.message?.content || "");
      const terms = [];
      const seen = new Set();
      for (const item of rows) {
        addUniqueTerm(terms, seen, {
          answer: item.answer,
          clue: item.clue,
          explanation: item.explanation || "",
          source: `ai_crossword_${provider.name.toLowerCase()}`
        });
        if (terms.length >= count) break;
      }
      if (terms.length) return terms;
    } catch (error) {
      console.warn(`Crossword AI term generation failed via ${provider.name}:`, error.message);
    }
  }

  return [];
}

function bankRowToTerm(row) {
  if (row.question_type === "term_definition") {
    return {
      id: row.id,
      answer: row.term || row.correct_answer,
      clue: row.definition || row.question_text,
      explanation: row.explanation,
      difficulty: row.difficulty_level,
      source: row.source || "question_bank"
    };
  }

  return {
    id: row.id,
    answer: row.missing_word || row.term || row.correct_answer,
    clue: row.question_text || row.definition || row.explanation,
    explanation: row.explanation,
    difficulty: row.difficulty_level,
    source: row.source || "question_bank"
  };
}

async function reviewBankTermsWithAi({ terms, count }) {
  const providers = aiProviders();
  if (!providers.length || !terms.length) return [];

  const prompt = `Review these question-bank rows for crossword use.
Return only a JSON array of the strongest ${count} entries.
Each item must have:
- answer: one word, letters only, 3 to 12 letters
- clue: clear clue text, 12 to 180 characters, do not reveal the answer

Input rows:
${JSON.stringify(terms.slice(0, 40).map(term => ({
  answer: term.answer,
  clue: term.clue,
  source: term.source
}))).slice(0, 6000)}`;

  for (const provider of providers) {
    try {
      const response = await fetch(provider.url, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${provider.apiKey}`,
          "Content-Type": "application/json",
          ...provider.extraHeaders
        },
        body: JSON.stringify({
          model: provider.model,
          messages: [
            { role: "system", content: "You validate and rewrite educational crossword clues. Return valid JSON only." },
            { role: "user", content: prompt }
          ],
          temperature: 0.1,
          max_tokens: 1200
        })
      });
      const raw = await response.text();
      const json = JSON.parse(raw);
      if (!response.ok) throw new Error(json?.error?.message || `${provider.name} HTTP ${response.status}`);
      const rows = parseJsonArray(json?.choices?.[0]?.message?.content || "");
      const reviewed = [];
      const seen = new Set();
      const debug = { accepted: 0, rejected: {} };
      for (const item of rows) {
        addUniqueTerm(reviewed, seen, {
          answer: item.answer,
          clue: item.clue,
          source: `ai_review_${provider.name.toLowerCase()}`
        }, debug);
        if (reviewed.length >= count) break;
      }
      if (reviewed.length) return reviewed;
    } catch (error) {
      console.warn(`Crossword bank AI review failed via ${provider.name}:`, error.message);
    }
  }
  return [];
}

async function loadBankTerms({ moduleId, chapterIds, count, debug }) {
  let query = sbAdmin
    .from("study_question_bank")
    .select("id, question_text, correct_answer, missing_word, term, definition, explanation, difficulty_level, source, question_type")
    .eq("module_id", moduleId)
    .eq("is_active", true)
    .limit(150);

  if (chapterIds.length) query = query.in("chapter_id", chapterIds);

  const { data, error } = await query;
  if (error) {
    console.warn("Crossword question-bank lookup failed:", error.message);
    if (debug) debug.bankError = error.message;
    return [];
  }

  if (debug) {
    debug.bankRowsFound = (data || []).length;
    debug.bankQuestionTypes = (data || []).reduce((acc, row) => {
      const type = row.question_type || "unknown";
      acc[type] = (acc[type] || 0) + 1;
      return acc;
    }, {});
  }

  const rawTerms = shuffle(data || []).map(bankRowToTerm);
  const reviewedTerms = await reviewBankTermsWithAi({ terms: rawTerms, count });
  if (reviewedTerms.length) {
    if (debug) debug.aiReviewedBankTerms = reviewedTerms.length;
    return reviewedTerms;
  }

  const terms = [];
  const seen = new Set();
  for (const term of rawTerms) {
    addUniqueTerm(terms, seen, term, debug);
    if (terms.length >= count) break;
  }
  return terms;
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

function fallbackTerms({ chapterTitle, content, count }) {
  const sentences = String(content || "")
    .split(/[.!?]+/)
    .map(sentence => sentence.trim().replace(/\s+/g, " "))
    .filter(sentence => sentence.length >= 35 && sentence.length <= 180);

  const terms = [];
  const seen = new Set();
  const blocked = /^(this|that|with|from|have|will|your|they|their|there|where|when|what|which|chapter|section|about|using|into|were|been|also|than|then|such|more|most|some|each|because)$/i;

  for (const sentence of sentences) {
    const words = sentence.match(/\b[A-Za-z][A-Za-z-]{3,}\b/g) || [];
    const candidates = words
      .map(word => word.replace(/^-+|-+$/g, ""))
      .filter(word => word.length >= 4 && word.length <= 12)
      .filter(word => !blocked.test(word));

    const chosen = candidates.find(word => !seen.has(cleanWord(word)));
    if (!chosen) continue;

    addUniqueTerm(terms, seen, {
      answer: chosen,
      clue: clueWithBlank(sentence, chosen),
      explanation: `The answer is "${chosen}" from the chapter content.`,
      source: "chapter_chunks"
    });

    if (terms.length >= count) break;
  }

  const basics = [
    ["CONCEPT", `A key idea from "${chapterTitle || "this chapter"}".`],
    ["SKILL", `Something this chapter helps you build.`],
    ["MODULE", "A course unit made up of chapters."],
    ["STUDY", "What you do to prepare for a quiz or exam."],
    ["ANSWER", "What a clue asks you to find."],
    ["REVIEW", "Reading content again to improve memory."],
    ["TOPIC", "A subject covered in a chapter."],
    ["PRACTICE", "Repeating a task to improve learning."],
    ["QUESTION", "A prompt that asks for an answer."],
    ["KNOWLEDGE", "Information and understanding gained from study."]
  ];

  for (const [answer, clue] of basics) {
    if (terms.length >= count) break;
    addUniqueTerm(terms, seen, { answer, clue, source: "fallback" });
  }

  return terms.slice(0, count);
}

router.post("/generate", requireStudent, async (req, res) => {
  try {
    const moduleId = String(req.body?.moduleId || "").trim();
    const chapterIds = cleanUuidArray(req.body?.chapterIds || req.body?.chapterId);
    const level = normalizeLevel(req.body?.level);
    const requestedCount = wordCountForLevel(level);
    const candidateCount = requestedCount + 10;
    const debug = {
      moduleId,
      chapterIds,
      level,
      requestedCount,
      candidateCount,
      bankRowsFound: 0,
      bankQuestionTypes: {},
      bankError: "",
      aiReviewedBankTerms: 0,
      accepted: 0,
      rejected: {}
    };

    if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });
    if (!chapterIds.length) return res.status(400).json({ ok: false, error: "At least one chapterId is required" });

    let terms = await loadBankTerms({ moduleId, chapterIds, count: candidateCount, debug });
    const savedCount = terms.length;
    let aiCount = 0;
    let fallbackCount = 0;
    let content = "";

    if (terms.length < candidateCount && hasAiProvider()) {
      content = await loadChapterContent(chapterIds);
      const seen = new Set(terms.map(term => term.answer));
      const aiTerms = (await generateAiTerms({
        chapterTitle: req.body?.chapterTitle || "selected chapter",
        content,
        count: candidateCount - terms.length
      })).filter(term => {
        if (seen.has(term.answer)) return false;
        seen.add(term.answer);
        return true;
      });
      aiCount = aiTerms.length;
      terms = [...terms, ...aiTerms];
    }

    if (terms.length < candidateCount) {
      if (!content) content = await loadChapterContent(chapterIds);
      const seen = new Set(terms.map(term => term.answer));
      const fallback = fallbackTerms({
        chapterTitle: req.body?.chapterTitle || "selected chapter",
        content,
        count: candidateCount - terms.length
      }).filter(term => {
        if (seen.has(term.answer)) return false;
        seen.add(term.answer);
        return true;
      });
      fallbackCount = fallback.length;
      terms = [...terms, ...fallback];
    }

    res.json({
      ok: true,
      level,
      wordCount: requestedCount,
      terms: terms.slice(0, candidateCount),
      metadata: {
        source: aiCount ? "question-bank-ai-fallback" : savedCount ? "question-bank-fallback" : "fallback",
        savedCount,
        aiCount,
        fallbackCount,
        returnedTerms: terms.slice(0, candidateCount).length,
        debug,
        generatedAt: new Date().toISOString()
      }
    });
  } catch (error) {
    console.error("Crossword generation error:", error);
    res.status(500).json({ ok: false, error: error.message || "Crossword generation failed" });
  }
});

export default router;
