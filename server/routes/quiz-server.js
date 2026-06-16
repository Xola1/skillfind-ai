// ============================================
// SKILLFIND AI - SIMPLIFIED QUIZ MODULE BACKEND
// No database dependencies - pure AI generation
// ============================================

import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ============================================
// AUTH MIDDLEWARE
// ============================================

async function requireSupabaseUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token)
    throw Object.assign(new Error("Missing Authorization Bearer token."), { status: 401 });

  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user)
    throw Object.assign(new Error("Invalid/expired session."), { status: 401 });

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

    if (error || prof.role !== "student")
      throw Object.assign(new Error("Forbidden: Students only."), { status: 403 });

    req.user = user;
    next();
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Auth error" });
  }
}

// ============================================
// GET CHAPTER CONTENT FROM DATABASE
// ============================================

async function getChapterContent(chapterId) {
  const { data: chunks, error } = await sbAdmin
    .from("chapter_chunks")
    .select("text, chunk_index")
    .eq("chapter_id", chapterId)
    .order("chunk_index", { ascending: true });

  if (error) throw new Error(error.message);
  if (!chunks || chunks.length === 0) return "";
  return chunks.map(c => c.text).join(" ");
}

function shuffle(values) {
  return [...values].sort(() => Math.random() - 0.5);
}

function normalizeQuestionType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "mcq") return "multiple_choice";
  if (value === "truefalse") return "true_false";
  if (value === "short_answer") return "short_question";
  return value || "multiple_choice";
}

function normalizeDifficulty(value) {
  const difficulty = String(value || "").trim().toLowerCase();
  if (["easy", "medium", "hard", "expert"].includes(difficulty)) return difficulty;
  if (["intermediate", "moderate", "normal"].includes(difficulty)) return "medium";
  if (["difficult", "advanced", "challenging"].includes(difficulty)) return "hard";
  if (["simple", "basic", "beginner"].includes(difficulty)) return "easy";
  return "medium";
}

function optionArray(options) {
  if (Array.isArray(options)) return options.map(String).filter(Boolean);
  if (options && typeof options === "object") return Object.values(options).map(String).filter(Boolean);
  return [];
}

function adaptBankQuestion(row) {
  const questionType = normalizeQuestionType(row.question_type);
  let options = optionArray(row.options);
  let correctAnswer = String(row.correct_answer || row.missing_word || row.term || "").trim();
  let text = row.question_text;

  if (questionType === "true_false") options = ["True", "False"];

  if (questionType === "missing_word") {
    correctAnswer = correctAnswer || String(row.missing_word || "").trim();
    if (!options.length) {
      options = shuffle([correctAnswer, "Not applicable", "Unknown", "None of these"].filter(Boolean));
    }
  }

  if (questionType === "term_definition") {
    correctAnswer = String(row.term || correctAnswer).trim();
    text = row.definition || row.question_text;
    if (!options.includes(correctAnswer)) options = [correctAnswer, ...options];
    options = shuffle([...new Set(options.filter(Boolean))]).slice(0, 6);
  }

  if (questionType === "multiple_choice" && !options.includes(correctAnswer) && correctAnswer) {
    options = [correctAnswer, ...options];
  }

  if (!options.length) options = [correctAnswer, "Review the notes", "Not covered", "None of these"].filter(Boolean);

  let correct = options.findIndex(option => option.toLowerCase().trim() === correctAnswer.toLowerCase());
  if (correct < 0) correct = 0;

  return {
    id: row.id,
    type: questionType === "multiple_choice" ? "mcq" : questionType === "true_false" ? "truefalse" : questionType,
    text,
    options,
    correct,
    correct_answer: correctAnswer,
    explanation: row.explanation || "",
    difficulty: row.difficulty_level || "medium",
    topic_tags: row.topic_tags || [],
    source: row.source || "database"
  };
}

function normalizeRequestedTypes(questionTypes) {
  const values = Array.isArray(questionTypes) ? questionTypes : [];
  const normalized = values.map(normalizeQuestionType).filter(Boolean);
  return normalized.length ? normalized : ["multiple_choice", "true_false", "missing_word"];
}

async function getRandomSavedQuizQuestions(chapterId, count, questionTypes) {
  const allowedTypes = normalizeRequestedTypes(questionTypes);
  const { data, error } = await sbAdmin
    .from("study_question_bank")
    .select("*")
    .eq("chapter_id", chapterId)
    .eq("is_active", true)
    .in("question_type", allowedTypes)
    .limit(100);

  if (error) {
    console.warn("Saved quiz question lookup failed:", error.message);
    return [];
  }

  return shuffle(data || []).slice(0, count).map(adaptBankQuestion);
}

async function saveQuestionsToBank({ moduleId, chapterId, chapterTitle, questions, source = "chapter_generated" }) {
  if (!moduleId || !chapterId || !Array.isArray(questions) || !questions.length) return 0;

  const rows = questions.map(question => {
    const options = optionArray(question.options);
    const correctIndex = Number.isInteger(question.correct) ? question.correct : 0;
    const correctAnswer = question.correct_answer || question.answer || options[correctIndex] || "";
    return {
      module_id: moduleId,
      chapter_id: chapterId,
      source,
      question_type: normalizeQuestionType(question.type || question.question_type),
      question_text: question.text || question.question_text || `Question from ${chapterTitle || "chapter"}`,
      correct_answer: String(correctAnswer || "Review the notes"),
      options,
      missing_word: question.missing_word || null,
      term: question.term || null,
      definition: question.definition || null,
      explanation: question.explanation || null,
      difficulty_level: normalizeDifficulty(question.difficulty || question.difficulty_level),
      topic_tags: question.topic_tags || [],
      keywords: question.keywords || [],
      quality_score: 0.8,
      ai_confidence: source === "chapter_generated" ? 0.75 : 0.6
    };
  });

  const { error } = await sbAdmin.from("study_question_bank").insert(rows);
  if (error) {
    console.warn("Could not save generated quiz questions:", error.message);
    return 0;
  }
  return rows.length;
}

// ============================================
// AI QUESTION GENERATION WITH GROQ
// ============================================

async function generateAIQuestions(content, chapterTitle, questionCount, difficulty, questionTypes = []) {
  const apiKeysStr = process.env.GROQ_API_KEY || "";
  const apiKeys = apiKeysStr.split(',').map(k => k.trim()).filter(k => k.length > 0);
  
  if (!apiKeys.length) {
    console.log("❌ No GROQ_API_KEY found");
    return null;
  }

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  
  const difficultyDesc = {
    easy: "basic recall and simple comprehension",
    medium: "application and analysis requiring understanding",
    hard: "synthesis, evaluation, and complex problem-solving"
  };

  const allowedTypes = normalizeRequestedTypes(questionTypes);
  const allowedTypesText = allowedTypes.join(", ");

  const systemPrompt = `You are an expert quiz creator. Generate ${questionCount} questions based STRICTLY on the provided chapter content.

Each question must be:
- Directly based on the chapter text provided and Ai intelligence
- Educational and meaningful
- Test real understanding, not trivia
- Use only these question_type values: ${allowedTypesText}


Format your response as a JSON array ONLY, with no extra text. Example:
[
  {
    "type": "true_false",
    "text": "What is the main concept discussed in this chapter?",
    "options": ["True", "False"],
    "correct": 0,
    "explanation": "Based on the chapter, this is correct because...",
    "difficulty": "medium"
  }
]

IMPORTANT: 
- Make questions SPECIFIC to the content provided
- Use exact terms and concepts from the chapter
- Ensure the correct answer is clearly supported by the text
- For missing_word, put the missing answer in "missing_word" and use a short sentence with ____ in "text"
- For term_definition, put the definition in "definition", the correct term in "term", and use short term names as options
- Difficulty: ${difficultyDesc[difficulty] || difficultyDesc.medium}`;

  const userPrompt = `Chapter Title: ${chapterTitle}
Chapter Content:
${content.substring(0, 6000)}

Create ${questionCount} questions that test understanding of this specific content using only these types: ${allowedTypesText}.`;

  // Try each API key
  for (let keyIndex = 0; keyIndex < apiKeys.length; keyIndex++) {
    const apiKey = apiKeys[keyIndex];
    console.log(`🤖 Trying API key ${keyIndex + 1}/${apiKeys.length} to generate ${questionCount} ${difficulty} questions...`);
    
    try {
      const resp = await fetch("https://api.groq.com/openai/v1/chat/completions", {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: systemPrompt },
            { role: "user", content: userPrompt }
          ],
          temperature: 0.6,
          max_tokens: 4000
        })
      });

      const json = await resp.json();
      
      if (!resp.ok) {
        console.log(`❌ API key ${keyIndex + 1} failed:`, json.error?.message || "Unknown error");
        continue; // Try next key
      }
      
      const content_response = json?.choices?.[0]?.message?.content || "[]";
      console.log(`✅ API key ${keyIndex + 1} succeeded! Response length:`, content_response.length);
      
      // Extract JSON array
      const jsonMatch = content_response.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        const questions = JSON.parse(jsonMatch[0]);
        console.log(`✅ Generated ${questions.length} AI questions`);
        return questions.slice(0, questionCount);
      }
      
      console.log("No JSON array found in response");
      return null;
      
    } catch (e) {
      console.error(`❌ API key ${keyIndex + 1} error:`, e.message);
      continue; // Try next key
    }
  }
  
  console.log("❌ All API keys failed");
  return null;
}
// ============================================
// FALLBACK QUESTIONS (Context-aware, not generic)
// ============================================

function shouldUseMissingWordFallback(questionTypes) {
  return normalizeRequestedTypes(questionTypes).includes("missing_word");
}

function generateMissingWordFallback(chapterTitle, content, count) {
  console.log("🔤 Generating missing-word fallback questions");
  const sentences = String(content || "")
    .split(/[.!?]+/)
    .map(sentence => sentence.trim().replace(/\s+/g, " "))
    .filter(sentence => sentence.length >= 35 && sentence.length <= 180);

  const questions = [];
  const usedWords = new Set();

  for (const sentence of sentences) {
    const words = sentence.match(/\b[A-Za-z][A-Za-z-]{3,}\b/g) || [];
    const candidates = words
      .map(word => word.replace(/^-+|-+$/g, ""))
      .filter(word => word.length >= 4 && word.length <= 14)
      .filter(word => !/^(this|that|with|from|have|will|your|they|their|there|where|when|what|which|chapter|section)$/i.test(word));

    const chosen = candidates.find(word => !usedWords.has(word.toLowerCase()));
    if (!chosen) continue;

    usedWords.add(chosen.toLowerCase());
    questions.push({
      type: "missing_word",
      text: sentence.replace(new RegExp(`\\b${chosen.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "i"), "_____"),
      options: [],
      correct_answer: chosen,
      missing_word: chosen,
      explanation: `The missing word is "${chosen}" from the chapter content.`,
      difficulty: "medium"
    });

    if (questions.length >= count) break;
  }

  while (questions.length < count) {
    questions.push({
      type: "missing_word",
      text: `A key word from "${chapterTitle || "this chapter"}" is _____.`,
      options: [],
      correct_answer: "concept",
      missing_word: "concept",
      explanation: "Review the chapter and practice spelling important terms.",
      difficulty: "easy"
    });
  }

  return questions.slice(0, count);
}

function generateContextualFallback(chapterTitle, content, count, questionTypes = []) {
  console.log("📚 Generating contextual fallback questions");

  if (shouldUseMissingWordFallback(questionTypes)) {
    return generateMissingWordFallback(chapterTitle, content, count);
  }
  
  // Try to extract key phrases from content
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 30);
  const keyPhrases = sentences.slice(0, 5).map(s => s.trim().substring(0, 100));
  
  const fallbackQuestions = [];
  
  if (keyPhrases.length > 0) {
    // Create questions based on actual content
    for (let i = 0; i < Math.min(count, keyPhrases.length); i++) {
      fallbackQuestions.push({
        type: "mcq",
        text: `Based on the chapter "${chapterTitle}": "${keyPhrases[i].substring(0, 80)}..." What is the main point of this statement?`,
        options: [
          "This is a key concept explained in the chapter",
          "This is an example of practical application",
          "This describes a theoretical framework",
          "This is background information only"
        ],
        correct: 0,
        explanation: `This statement appears in your chapter and represents an important concept. Review the full context in "${chapterTitle}" for complete understanding.`,
        difficulty: "medium"
      });
    }
  }
  
  // Add general but relevant questions
  while (fallbackQuestions.length < count) {
    fallbackQuestions.push({
      type: "mcq",
      text: `What is a key takeaway from "${chapterTitle}"?`,
      options: [
        "Understanding core concepts and their practical applications",
        "Memorizing all definitions word-for-word",
        "Focusing only on theoretical aspects",
        "Skipping to the next chapter"
      ],
      correct: 0,
      explanation: `The chapter "${chapterTitle}" aims to build both understanding and practical skills. Review the material to identify specific key concepts.`,
      difficulty: "easy"
    });
  }
  
  return fallbackQuestions.slice(0, count);
}

// ============================================
// MAIN QUIZ GENERATION ENDPOINT
// ============================================

router.post("/generate", requireStudent, async (req, res) => {
  try {
    const {
      moduleId,
      chapterId,
      questionCount = 5,
      difficulty = "medium",
      chapterTitle,
      questionTypes = []
    } = req.body;

    const requestedCount = Math.max(1, Math.min(Number(questionCount) || 5, 50));
    console.log(`Quiz request: chapter=${chapterId}, count=${requestedCount}, difficulty=${difficulty}`);

    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }

    let questions = await getRandomSavedQuizQuestions(chapterId, requestedCount, questionTypes);
    const savedCount = questions.length;

    if (questions.length >= requestedCount) {
      return res.json({
        ok: true,
        questions,
        questionCount: questions.length,
        metadata: {
          difficulty,
          generatedAt: new Date().toISOString(),
          source: "database",
          savedCount,
          aiGeneratedCount: 0
        }
      });
    }

    let content = "";
    try {
      content = await getChapterContent(chapterId);
      console.log(`Retrieved chapter content length: ${content.length} characters`);
    } catch (e) {
      console.error("Error fetching content:", e.message);
    }

    let aiQuestions = [];
    const aiNeeded = Math.min(2, requestedCount - questions.length);

    if (aiNeeded > 0 && content && content.length > 200 && process.env.GROQ_API_KEY) {
      aiQuestions = await generateAIQuestions(content, chapterTitle, aiNeeded, difficulty, questionTypes) || [];
      if (aiQuestions.length > 0) {
        await saveQuestionsToBank({ moduleId, chapterId, chapterTitle, questions: aiQuestions });
        questions = [
          ...questions,
          ...aiQuestions.map((question, index) => ({
            ...question,
            id: question.id || `ai-${index}`,
            source: "ai"
          }))
        ];
      }
    }

    if (questions.length < requestedCount) {
      const remaining = requestedCount - questions.length;
      if (content && content.length > 100) {
        questions = [...questions, ...generateContextualFallback(chapterTitle, content, remaining, questionTypes)];
      } else {
        questions = [...questions, ...generateBasicFallback(chapterTitle, remaining, questionTypes)];
      }
    }

    questions = questions.slice(0, requestedCount);

    return res.json({
      ok: true,
      questions,
      questionCount: questions.length,
      metadata: {
        difficulty,
        generatedAt: new Date().toISOString(),
        source: savedCount ? "database-first" : "ai-or-fallback",
        savedCount,
        aiGeneratedCount: aiQuestions.length
      }
    });
  } catch (e) {
    console.error("Quiz generation error:", e);
    return res.status(500).json({ ok: false, error: e.message });
  }
});

router.post("/generate", requireStudent, async (req, res) => {
  try {
    const {
      moduleId,
      chapterId,
      questionCount = 5,
      difficulty = "medium",
      chapterTitle
    } = req.body;
    
    console.log(`📝 Quiz generation request: chapter=${chapterId}, count=${questionCount}, difficulty=${difficulty}`);
    
    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }
    
    // Get chapter content
    let content = "";
    try {
      content = await getChapterContent(chapterId);
      console.log(`📖 Retrieved chapter content length: ${content.length} characters`);
    } catch (e) {
      console.error("Error fetching content:", e.message);
    }
    
    let questions = [];
    
    // Try AI generation first if we have content and API key
    if (content && content.length > 200 && process.env.GROQ_API_KEY) {
      const aiQuestions = await generateAIQuestions(content, chapterTitle, questionCount, difficulty);
      if (aiQuestions && aiQuestions.length > 0) {
        questions = aiQuestions;
        console.log(`✅ Using ${questions.length} AI-generated questions`);
      }
    }
    
    // Fallback to contextual questions if AI failed
    if (questions.length === 0) {
      if (content && content.length > 100) {
        questions = generateContextualFallback(chapterTitle, content, questionCount);
        console.log(`📚 Using contextual fallback (${questions.length} questions)`);
      } else {
        // Ultimate fallback - basic questions
        questions = generateBasicFallback(chapterTitle, questionCount);
        console.log(`⚠️ Using basic fallback (${questions.length} questions)`);
      }
    }
    
    // Ensure we have the right number of questions
    if (questions.length > questionCount) {
      questions = questions.slice(0, questionCount);
    }
    
    res.json({
      ok: true,
      questions: questions,
      questionCount: questions.length,
      metadata: {
        difficulty,
        generatedAt: new Date().toISOString(),
        source: questions.length > 0 && questions[0].text.includes("Based on the chapter") ? "contextual" : "ai"
      }
    });
    
  } catch (e) {
    console.error("Quiz generation error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// Simple fallback
function generateBasicFallback(chapterTitle, count, questionTypes = []) {
  if (shouldUseMissingWordFallback(questionTypes)) {
    return generateMissingWordFallback(chapterTitle, "", count);
  }

  const questions = [];
  for (let i = 1; i <= count; i++) {
    questions.push({
      type: "mcq",
      text: `Question ${i}: What is an important concept from "${chapterTitle || "this chapter"}"?`,
      options: [
        "Understanding the core principles",
        "Memorizing without application",
        "Skipping difficult parts",
        "Only reading the summary"
      ],
      correct: 0,
      explanation: `This chapter contains important concepts. Review the material in "${chapterTitle}" to fully understand them.`,
      difficulty: i <= 2 ? "easy" : i <= 4 ? "medium" : "hard"
    });
  }
  return questions;
}

// Submit quiz results (optional - no database required)
router.post("/submit", requireStudent, async (req, res) => {
  // Just acknowledge receipt - no database storage
  console.log("Quiz results received (not stored in database)");
  res.json({ 
    ok: true, 
    message: "Quiz results received" 
  });
});

// History endpoint (returns empty - no database)
router.get("/history", requireStudent, async (req, res) => {
  res.json({ 
    ok: true, 
    history: [],
    analysis: null,
    totalQuizzes: 0,
    bestScore: 0
  });
});

// Options endpoint
router.get("/options", requireStudent, (req, res) => {
  res.json({
    ok: true,
    difficultyLevels: [
      { value: "easy", label: "Easy - Basic recall", recommended: false },
      { value: "medium", label: "Medium - Application & analysis", recommended: true },
      { value: "hard", label: "Hard - Synthesis & evaluation", recommended: false }
    ],
    questionTypes: [
      { value: "mcq", label: "Multiple Choice", recommended: true },
      { value: "truefalse", label: "True/False", recommended: false }
    ],
    defaultSettings: {
      questionCount: 5,
      difficulty: "medium",
      questionTypes: ["mcq"]
    }
  });
});

export default router;
