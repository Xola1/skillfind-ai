// ============================================
// SKILLFIND AI - FLASHCARD MODULE BACKEND
// Multi-provider AI version:
// OpenRouter = main generator
// Groq = fast validator / cleaner
// Hugging Face = optional backup
// Local extraction = final safety fallback
// ============================================

import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

// ============================================
// ENV CONFIG
// ============================================

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "openrouter/free";

const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const GROQ_TEMPERATURE = Number(process.env.GROQ_TEMPERATURE || 0.4);

const HF_TOKEN = process.env.HF_TOKEN || "";
const HF_MODEL = process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct";
const HF_TEMPERATURE = Number(process.env.HF_TEMPERATURE || 0.5);

// ============================================
// SUPABASE ADMIN CLIENT
// ============================================

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: {
    persistSession: false
  }
});

// ============================================
// AUTH MIDDLEWARE
// ============================================

async function requireSupabaseUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";

  if (!token) {
    throw Object.assign(new Error("Missing Authorization Bearer token."), {
      status: 401
    });
  }

  const { data, error } = await sbAdmin.auth.getUser(token);

  if (error || !data?.user) {
    throw Object.assign(new Error("Invalid or expired session."), {
      status: 401
    });
  }

  return data.user;
}

async function requireStudent(req, res, next) {
  try {
    const user = await requireSupabaseUser(req);

    const { data: profile, error } = await sbAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.id)
      .single();

    if (error || !profile || profile.role !== "student") {
      throw Object.assign(new Error("Forbidden: students only."), {
        status: 403
      });
    }

    req.user = user;
    next();
  } catch (error) {
    return res.status(error.status || 500).json({
      ok: false,
      error: error.message || "Authentication error."
    });
  }
}

// ============================================
// DATABASE HELPERS
// ============================================

async function getChapterContent(chapterId) {
  const { data: chunks, error } = await sbAdmin
    .from("chapter_chunks")
    .select("text, chunk_index")
    .eq("chapter_id", chapterId)
    .order("chunk_index", { ascending: true });

  if (error) {
    throw new Error(error.message);
  }

  return (chunks || [])
    .map(chunk => chunk.text)
    .filter(Boolean)
    .join("\n\n");
}

async function saveFlashcardProgress({ studentId, chapterId, cardId, known }) {
  try {
    const { error } = await sbAdmin
      .from("flashcard_progress")
      .upsert(
        [
          {
            student_id: studentId,
            chapter_id: chapterId,
            card_id: cardId,
            known,
            reviewed_at: new Date().toISOString()
          }
        ],
        {
          onConflict: "student_id,chapter_id,card_id"
        }
      );

    if (error) {
      console.error("Failed to save flashcard progress:", error.message);
      return { success: false };
    }

    return { success: true };
  } catch (error) {
    console.error("Error saving flashcard progress:", error.message);
    return { success: false };
  }
}

async function getFlashcardProgress(studentId, chapterId) {
  try {
    const { data, error } = await sbAdmin
      .from("flashcard_progress")
      .select("card_id, known")
      .eq("student_id", studentId)
      .eq("chapter_id", chapterId);

    if (error || !data) {
      return {};
    }

    const progress = {};

    data.forEach(item => {
      progress[item.card_id] = item.known;
    });

    return progress;
  } catch {
    return {};
  }
}

// ============================================
// PROMPTS
// ============================================

function buildFlashcardGenerationPrompt({ content, chapterTitle, cardCount }) {
  return `
Chapter Title:
${chapterTitle || "Chapter"}

Number of Flashcards:
${cardCount}

Chapter Content:
${content.slice(0, 7000)}

Task:
Create ${cardCount} high-quality study flashcards based strictly on the chapter content.

Rules:
1. Use only information found in the chapter content.
2. Do not invent facts.
3. Each flashcard must help a student study for a test.
4. Use clear student-friendly language.
5. Mix definitions, concepts, processes, and application questions.
6. Avoid duplicate cards.
7. Return only valid JSON.

Required JSON format:
[
  {
    "term": "Question or key term here",
    "definition": "Clear answer or definition here"
  }
]
`.trim();
}

function buildFlashcardReviewPrompt({ flashcards, content, cardCount }) {
  return `
You are reviewing AI-generated study flashcards.

Original chapter content:
${content.slice(0, 5000)}

Flashcards to review:
${JSON.stringify(flashcards, null, 2)}

Task:
Improve and validate the flashcards.

Rules:
1. Keep only accurate cards supported by the chapter content.
2. Fix unclear wording.
3. Remove duplicates.
4. Ensure there are no invented facts.
5. Return exactly ${cardCount} flashcards where possible.
6. Return only valid JSON.

Required JSON format:
[
  {
    "term": "Question or key term here",
    "definition": "Clear answer or definition here"
  }
]
`.trim();
}

// ============================================
// JSON HELPERS
// ============================================

function parseJsonArrayFromText(text) {
  if (!text || typeof text !== "string") {
    return null;
  }

  try {
    const parsed = JSON.parse(text);

    if (Array.isArray(parsed)) {
      return parsed;
    }
  } catch {
    // Continue to regex extraction.
  }

  const match = text.match(/\[[\s\S]*\]/);

  if (!match) {
    return null;
  }

  try {
    const parsed = JSON.parse(match[0]);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function cleanFlashcards(cards, cardCount) {
  if (!Array.isArray(cards)) {
    return [];
  }

  const seen = new Set();
  const cleaned = [];

  for (const card of cards) {
    const term = String(card?.term || "").trim();
    const definition = String(card?.definition || "").trim();

    if (!term || !definition) continue;
    if (term.length < 4 || definition.length < 8) continue;

    const key = term.toLowerCase();

    if (seen.has(key)) continue;

    seen.add(key);

    cleaned.push({
      term,
      definition
    });

    if (cleaned.length >= cardCount) {
      break;
    }
  }

  return cleaned;
}

// ============================================
// AI PROVIDERS
// ============================================

async function callOpenRouter(messages, options = {}) {
  if (!OPENROUTER_API_KEY) {
    throw new Error("OpenRouter API key missing.");
  }

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${OPENROUTER_API_KEY}`,
      "HTTP-Referer": "http://localhost:5050",
      "X-Title": "SkillFind AI"
    },
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages,
      temperature: options.temperature ?? 0.35,
      max_tokens: options.maxTokens ?? 3000
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "OpenRouter request failed.");
  }

  return data.choices?.[0]?.message?.content || "";
}

async function callGroq(messages, options = {}) {
  if (!GROQ_API_KEY) {
    throw new Error("Groq API key missing.");
  }

  if (GROQ_API_KEY.includes(",")) {
    throw new Error("GROQ_API_KEY contains commas. Use one Groq key only.");
  }

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${GROQ_API_KEY}`
    },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages,
      temperature: options.temperature ?? GROQ_TEMPERATURE,
      max_tokens: options.maxTokens ?? 2500
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Groq request failed.");
  }

  return data.choices?.[0]?.message?.content || "";
}

async function callHuggingFace(messages, options = {}) {
  if (!HF_TOKEN) {
    throw new Error("Hugging Face token missing.");
  }

  const response = await fetch("https://router.huggingface.co/v1/chat/completions", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${HF_TOKEN}`
    },
    body: JSON.stringify({
      model: HF_MODEL,
      messages,
      temperature: options.temperature ?? HF_TEMPERATURE,
      max_tokens: options.maxTokens ?? 2500
    })
  });

  const data = await response.json();

  if (!response.ok) {
    throw new Error(data?.error?.message || "Hugging Face request failed.");
  }

  return data.choices?.[0]?.message?.content || "";
}

// ============================================
// AI ORCHESTRATION
// ============================================

async function generateWithOpenRouter(content, chapterTitle, cardCount) {
  const prompt = buildFlashcardGenerationPrompt({
    content,
    chapterTitle,
    cardCount
  });

  const raw = await callOpenRouter(
    [
      {
        role: "system",
        content:
          "You are SkillFind AI, an expert educational flashcard generator. Return only valid JSON."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    {
      temperature: 0.35,
      maxTokens: 3000
    }
  );

  const parsed = parseJsonArrayFromText(raw);
  return cleanFlashcards(parsed, cardCount);
}

async function reviewWithGroq(flashcards, content, cardCount) {
  const prompt = buildFlashcardReviewPrompt({
    flashcards,
    content,
    cardCount
  });

  const raw = await callGroq(
    [
      {
        role: "system",
        content:
          "You are a fast educational content reviewer. Fix flashcards and return only valid JSON."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    {
      temperature: 0.2,
      maxTokens: 2500
    }
  );

  const parsed = parseJsonArrayFromText(raw);
  return cleanFlashcards(parsed, cardCount);
}

async function generateWithGroq(content, chapterTitle, cardCount) {
  const prompt = buildFlashcardGenerationPrompt({
    content,
    chapterTitle,
    cardCount
  });

  const raw = await callGroq(
    [
      {
        role: "system",
        content:
          "You are SkillFind AI, an expert educational flashcard generator. Return only valid JSON."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    {
      temperature: 0.4,
      maxTokens: 3000
    }
  );

  const parsed = parseJsonArrayFromText(raw);
  return cleanFlashcards(parsed, cardCount);
}

async function generateWithHuggingFace(content, chapterTitle, cardCount) {
  const prompt = buildFlashcardGenerationPrompt({
    content,
    chapterTitle,
    cardCount
  });

  const raw = await callHuggingFace(
    [
      {
        role: "system",
        content:
          "You are SkillFind AI, an expert educational flashcard generator. Return only valid JSON."
      },
      {
        role: "user",
        content: prompt
      }
    ],
    {
      temperature: 0.45,
      maxTokens: 3000
    }
  );

  const parsed = parseJsonArrayFromText(raw);
  return cleanFlashcards(parsed, cardCount);
}

async function generateFlashcardsWithAiTeam(content, chapterTitle, cardCount) {
  const providerReport = [];

  // 1. Main generator: OpenRouter
  try {
    const openRouterCards = await generateWithOpenRouter(
      content,
      chapterTitle,
      cardCount
    );

    providerReport.push({
      provider: "openrouter",
      status: "success",
      cards: openRouterCards.length
    });

    // 2. Fast reviewer: Groq
    if (openRouterCards.length) {
      try {
        const reviewedCards = await reviewWithGroq(
          openRouterCards,
          content,
          cardCount
        );

        if (reviewedCards.length) {
          providerReport.push({
            provider: "groq-review",
            status: "success",
            cards: reviewedCards.length
          });

          return {
            flashcards: reviewedCards,
            provider: "openrouter+groq",
            providerReport
          };
        }
      } catch (error) {
        providerReport.push({
          provider: "groq-review",
          status: "failed",
          error: error.message
        });
      }

      return {
        flashcards: openRouterCards,
        provider: "openrouter",
        providerReport
      };
    }
  } catch (error) {
    providerReport.push({
      provider: "openrouter",
      status: "failed",
      error: error.message
    });
  }

  // 3. Backup generator: Groq
  try {
    const groqCards = await generateWithGroq(content, chapterTitle, cardCount);

    providerReport.push({
      provider: "groq",
      status: "success",
      cards: groqCards.length
    });

    if (groqCards.length) {
      return {
        flashcards: groqCards,
        provider: "groq",
        providerReport
      };
    }
  } catch (error) {
    providerReport.push({
      provider: "groq",
      status: "failed",
      error: error.message
    });
  }

  // 4. Optional backup: Hugging Face
  try {
    const hfCards = await generateWithHuggingFace(
      content,
      chapterTitle,
      cardCount
    );

    providerReport.push({
      provider: "huggingface",
      status: "success",
      cards: hfCards.length
    });

    if (hfCards.length) {
      return {
        flashcards: hfCards,
        provider: "huggingface",
        providerReport
      };
    }
  } catch (error) {
    providerReport.push({
      provider: "huggingface",
      status: "failed",
      error: error.message
    });
  }

  // 5. Final fallback: local extraction
  const localCards = extractFlashcardsFromContent(content, cardCount);

  providerReport.push({
    provider: "local-extraction",
    status: "success",
    cards: localCards.length
  });

  return {
    flashcards: localCards,
    provider: "local-extraction",
    providerReport
  };
}

// ============================================
// LOCAL FALLBACK EXTRACTION
// ============================================

function extractFlashcardsFromContent(content, cardCount) {
  const flashcards = [];

  const sentences = String(content || "")
    .split(/[.!?]+/)
    .map(sentence => sentence.trim())
    .filter(sentence => sentence.length > 30);

  const definitionPatterns = [
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+is\s+([^.]+)/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+refers to\s+([^.]+)/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+means\s+([^.]+)/gi,
    /The term\s+"([^"]+)"\s+refers to\s+([^.]+)/gi,
    /([A-Z][a-z]+(?:\s+[A-Z][a-z]+)*)\s+are\s+([^.]+)/gi
  ];

  for (const pattern of definitionPatterns) {
    let match;

    while ((match = pattern.exec(content)) !== null && flashcards.length < cardCount) {
      const term = String(match[1] || "").trim();
      const definition = String(match[2] || "").trim();

      if (term.length > 3 && definition.length > 10 && definition.length < 250) {
        flashcards.push({
          term: `What is ${term}?`,
          definition
        });
      }
    }
  }

  if (flashcards.length < cardCount) {
    const importantKeywords = [
      "important",
      "key",
      "critical",
      "essential",
      "main",
      "primary",
      "purpose",
      "goal",
      "objective",
      "step",
      "process",
      "method",
      "actor",
      "system",
      "use case",
      "activity",
      "diagram",
      "sequence"
    ];

    for (const sentence of sentences) {
      if (flashcards.length >= cardCount) break;

      const lower = sentence.toLowerCase();
      const important = importantKeywords.some(keyword => lower.includes(keyword));

      if (important && sentence.length > 40 && sentence.length < 260) {
        const firstWords = sentence.split(/\s+/).slice(0, 7).join(" ");

        flashcards.push({
          term: `Explain: ${firstWords}...`,
          definition: sentence
        });
      }
    }
  }

  if (flashcards.length < cardCount) {
    const usableSentences = sentences.filter(
      sentence => sentence.length > 50 && sentence.length < 280
    );

    for (const sentence of usableSentences) {
      if (flashcards.length >= cardCount) break;

      const firstWords = sentence.split(/\s+/).slice(0, 7).join(" ");

      flashcards.push({
        term: `What is discussed about "${firstWords}..."?`,
        definition: sentence
      });
    }
  }

  return cleanFlashcards(flashcards, cardCount);
}

function getEmptyContentFlashcards(chapterTitle) {
  return [
    {
      term: `No content available for ${chapterTitle || "this chapter"}`,
      definition:
        "Please ask your instructor to upload chapter content. You can still use the chat feature to study generally."
    }
  ];
}

// ============================================
// ROUTES
// ============================================

router.post("/generate", requireStudent, async (req, res) => {
  try {
    const { moduleId, chapterId } = req.body;
    const chapterTitle = req.body.chapterTitle || "Chapter";
    const requestedCount = Number(req.body.cardCount || 10);
    const cardCount = Math.min(Math.max(requestedCount, 1), 25);

    if (!chapterId) {
      return res.status(400).json({
        ok: false,
        error: "chapterId is required."
      });
    }

    let content = "";

    try {
      content = await getChapterContent(chapterId);
    } catch (error) {
      console.error("Error fetching chapter content:", error.message);
    }

    let flashcards = [];
    let provider = "none";
    let providerReport = [];

    if (content && content.length > 100) {
      const result = await generateFlashcardsWithAiTeam(
        content,
        chapterTitle,
        cardCount
      );

      flashcards = result.flashcards;
      provider = result.provider;
      providerReport = result.providerReport;
    } else {
      flashcards = getEmptyContentFlashcards(chapterTitle);
      provider = "no-content";
      providerReport = [
        {
          provider: "database",
          status: "no-content",
          cards: flashcards.length
        }
      ];
    }

    const progress = await getFlashcardProgress(req.user.id, chapterId);

    const cardsWithProgress = flashcards.map((card, index) => {
      const cardId = `card_${index}`;

      return {
        id: cardId,
        term: card.term,
        definition: card.definition,
        known: progress[cardId] || false
      };
    });

    return res.json({
      ok: true,
      flashcards: cardsWithProgress,
      totalCount: cardsWithProgress.length,
      hasContent: Boolean(content && content.length > 100),
      provider,
      providerReport,
      moduleId: moduleId || null,
      chapterId
    });
  } catch (error) {
    console.error("Flashcard generation error:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Flashcard generation failed."
    });
  }
});

router.post("/progress", requireStudent, async (req, res) => {
  try {
    const { chapterId, cardId, known } = req.body;

    if (!chapterId || !cardId) {
      return res.status(400).json({
        ok: false,
        error: "chapterId and cardId are required."
      });
    }

    await saveFlashcardProgress({
      studentId: req.user.id,
      chapterId,
      cardId,
      known: Boolean(known)
    });

    return res.json({
      ok: true,
      message: "Progress saved."
    });
  } catch (error) {
    console.error("Error updating flashcard progress:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to save flashcard progress."
    });
  }
});

router.get("/chapter/:chapterId", requireStudent, async (req, res) => {
  try {
    const { chapterId } = req.params;

    const content = await getChapterContent(chapterId);

    const flashcards =
      content && content.length > 100
        ? extractFlashcardsFromContent(content, 20)
        : [];

    return res.json({
      ok: true,
      flashcards,
      hasContent: Boolean(content && content.length > 100)
    });
  } catch (error) {
    console.error("Error fetching chapter flashcards:", error);

    return res.status(500).json({
      ok: false,
      error: error.message || "Failed to fetch flashcards."
    });
  }
});

export default router;