// ============================================
// SKILLFIND AI - CHAPTER STUDY MODULE BACKEND
// Optimized for free tier rate limits
// ============================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import crypto from "crypto";

const router = express.Router();

// Supabase client
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
    throw Object.assign(new Error("Missing Authorization Bearer token."), {
      status: 401
    });

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
// HELPER FUNCTIONS
// ============================================

async function getChapterContent(chapterId) {
  const { data: chunks, error } = await sbAdmin
    .from("chapter_chunks")
    .select("text, chunk_index")
    .eq("chapter_id", chapterId)
    .order("chunk_index", { ascending: true });

  if (error) throw new Error(error.message);
  
  const fullText = chunks.map(c => c.text).join(" ");
  return {
    text: fullText,
    chunkCount: chunks.length,
    charCount: fullText.length,
    sourceHash: hashText(fullText)
  };
}

function hashText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

function extractMarkdownSection(markdown, headingPattern) {
  const pattern = new RegExp(`(?:^|\\n)#{2,3}\\s+.*${headingPattern}.*\\n([\\s\\S]*?)(?=\\n#{2,3}\\s+|$)`, "i");
  const match = String(markdown || "").match(pattern);
  return match && typeof match[1] === "string" ? match[1].trim() : "";
}

function extractBullets(markdown, headingPattern, limit = 8) {
  return extractMarkdownSection(markdown, headingPattern)
    .split("\n")
    .map(line => line.replace(/^\s*(?:[-*]|\u2022|\u00e2\u20ac\u00a2)\s+/, "").replace(/\*\*/g, "").trim())
    .filter(Boolean)
    .slice(0, limit);
}

function extractSummary(markdown) {
  const section = extractMarkdownSection(markdown, "summary");
  if (section) return section.replace(/\s+/g, " ").trim().slice(0, 1200);
  return String(markdown || "").split("\n").find(line => line.trim().length > 40)?.trim().slice(0, 1200) || "";
}

function extractStudyQuestions(markdown) {
  const questions = extractMarkdownSection(markdown, "study questions|questions");
  return questions
    .split("\n")
    .map(line => line.replace(/^\s*(?:[-*]|\d+[.)])\s+/, "").trim())
    .filter(line => line.includes("?"))
    .slice(0, 10)
    .map(text => ({ text }));
}

async function getCachedStudyGuide({ chapterId, sourceHash }) {
  const { data, error } = await sbAdmin
    .from("chapter_study_guides")
    .select("*")
    .eq("chapter_id", chapterId)
    .maybeSingle();

  if (error) {
    console.warn("Chapter study guide cache lookup skipped:", error.message);
    return null;
  }

  if (!data?.guide_text) return null;
  if (sourceHash && data.source_hash && data.source_hash !== sourceHash) return null;
  return data;
}

async function saveStudyGuideCache({ moduleId, chapterId, chapterTitle, guideText, sourceMeta, userId, generatedBy = "ai" }) {
  if (!moduleId || !chapterId || !guideText) return null;

  const row = {
    module_id: moduleId,
    chapter_id: chapterId,
    title: chapterTitle || "Chapter Study Guide",
    guide_text: guideText,
    summary: extractSummary(guideText),
    key_concepts: extractBullets(guideText, "key concepts|concepts", 10),
    study_questions: extractStudyQuestions(guideText),
    source_hash: sourceMeta?.sourceHash || null,
    source_chunk_count: sourceMeta?.chunkCount || 0,
    source_char_count: sourceMeta?.charCount || 0,
    generated_by: generatedBy,
    updated_by: userId || null
  };

  const { data: existing, error: existingError } = await sbAdmin
    .from("chapter_study_guides")
    .select("id, version")
    .eq("chapter_id", chapterId)
    .maybeSingle();

  if (existingError) {
    console.warn("Chapter study guide cache write skipped:", existingError.message);
    return null;
  }

  if (existing?.id) {
    const { data, error } = await sbAdmin
      .from("chapter_study_guides")
      .update({ ...row, version: (existing.version || 1) + 1 })
      .eq("id", existing.id)
      .select("*")
      .single();
    if (error) {
      console.warn("Chapter study guide cache update skipped:", error.message);
      return null;
    }
    return data;
  }

  const { data, error } = await sbAdmin
    .from("chapter_study_guides")
    .insert([{ ...row, created_by: userId || null }])
    .select("*")
    .single();

  if (error) {
    console.warn("Chapter study guide cache insert skipped:", error.message);
    return null;
  }
  return data;
}

// Delay function to respect rate limits
function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ============================================
// GROQ API CALL WITH RETRY AND DELAY
// ============================================

async function callGroq(messages, temperature = 0.5, retryCount = 0) {
  const apiKey = process.env.GROQ_API_KEY || "";
  if (!apiKey) throw new Error("Missing GROQ_API_KEY in .env");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const url = "https://api.groq.com/openai/v1/chat/completions";

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
        max_tokens: 1500,  // Reduced from 2000 to save tokens
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
      // Check if it's a rate limit error
      if (resp.status === 429 && retryCount < 3) {
        const waitTime = (retryCount + 1) * 2000; // 2, 4, 6 seconds
        console.log(`Rate limited. Waiting ${waitTime}ms before retry ${retryCount + 1}...`);
        await delay(waitTime);
        return callGroq(messages, temperature, retryCount + 1);
      }
      throw new Error(`[Groq Error]: ${json?.error?.message || raw}`);
    }

    return json?.choices?.[0]?.message?.content || "";
  } catch (e) {
    if (retryCount < 3 && e.message.includes("Rate limit")) {
      const waitTime = (retryCount + 1) * 2000;
      console.log(`Rate limited. Waiting ${waitTime}ms before retry ${retryCount + 1}...`);
      await delay(waitTime);
      return callGroq(messages, temperature, retryCount + 1);
    }
    throw e;
  }
}

async function callOpenRouter(messages, temperature = 0.35) {
  const apiKeys = [process.env.OPENROUTER_API_KEY, process.env.OPENROUTER_API_KEYS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(key => key.trim())
    .filter(Boolean);
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
          max_tokens: 1800,
          top_p: 0.95
        })
      });

      const raw = await resp.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response from OpenRouter: ${raw.slice(0, 300)}`);
      }

      if (!resp.ok) throw new Error(`[OpenRouter Error ${resp.status}]: ${json?.error?.message || raw}`);
      const content = json?.choices?.[0]?.message?.content || "";
      if (content.trim()) return content.trim();
      throw new Error("OpenRouter returned no content");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All OpenRouter API keys failed");
}

async function callDeepSeek(messages, temperature = 0.35) {
  const apiKeys = [process.env.DEEPSEEK_API_KEY, process.env.DEEPSEEK_API_KEYS]
    .filter(Boolean)
    .join(",")
    .split(",")
    .map(key => key.trim())
    .filter(Boolean);
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
          max_tokens: 1800,
          top_p: 0.95
        })
      });

      const raw = await resp.text();
      let json;
      try {
        json = JSON.parse(raw);
      } catch {
        throw new Error(`Non-JSON response from DeepSeek: ${raw.slice(0, 300)}`);
      }

      if (!resp.ok) throw new Error(`[DeepSeek Error ${resp.status}]: ${json?.error?.message || raw}`);
      const content = json?.choices?.[0]?.message?.content || "";
      if (content.trim()) return content.trim();
      throw new Error("DeepSeek returned no content");
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError || new Error("All DeepSeek API keys failed");
}

function getStudyGuideProviders() {
  const preferred = String(process.env.AI_PROVIDER || "openrouter").toLowerCase().trim();
  return [...new Set([preferred, "openrouter", "groq", "deepseek"])].filter(provider => provider && provider !== "none");
}

// ============================================
// SINGLE COMBINED STUDY GUIDE GENERATION
// (One API call instead of 5)
// ============================================

async function generateCompleteStudyGuide(content, chapterTitle) {
  const systemPrompt = `You are an expert study guide creator. Create a complete, well-structured study guide for this chapter in ONE response.

Include ALL of these sections with clear headers:

## 🎯 Learning Objectives (4-6 bullet points starting with action verbs)

## 📖 Chapter Summary (concise overview + key bullet points)

## 🔑 Key Concepts (5-8 important terms with **bold** names and brief explanations)

## ❓ Study Questions (5 questions with answers and brief explanations)

## 💡 Study Tips (3-4 practical tips for mastering this material)

Format with markdown. Keep explanations clear and focused on the chapter content.`;

  const userPrompt = `Chapter Title: ${chapterTitle}

Chapter Content:
${content.substring(0, 3500)}  // Reduced to save tokens

Create a complete study guide with all sections as specified.`;

  const messages = [
    { role: "system", content: systemPrompt },
    { role: "user", content: userPrompt }
  ];

  const failures = [];
  for (const provider of getStudyGuideProviders()) {
    try {
      if (provider === "openrouter") {
        const response = await callOpenRouter(messages, 0.35);
        return { studyGuide: response, providerUsed: "OpenRouter" };
      }
      if (provider === "groq") {
        const response = await callGroq(messages, 0.4);
        return { studyGuide: response, providerUsed: "Groq" };
      }
      if (provider === "deepseek") {
        const response = await callDeepSeek(messages, 0.35);
        return { studyGuide: response, providerUsed: "DeepSeek" };
      }
    } catch (error) {
      failures.push(`${provider}: ${error.message}`);
    }
  }

  throw new Error(`All study guide AI providers failed: ${failures.join(" | ")}`);
}

// ============================================
// FALLBACK (when API fails or rate limited)
// ============================================

function generateFallbackStudyGuide(content, chapterTitle) {
  // Extract first few sentences as a basic summary
  const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 30);
  const firstParagraph = sentences.slice(0, 3).join(". ") + ".";
  
  return `## 📚 Study Guide: ${chapterTitle}

### 📖 Summary
${firstParagraph}

### 🔑 Key Concepts
Review your chapter materials for key terms and definitions. Pay attention to:
• **Bold or highlighted terms** in your reading
• **Definitions** provided in the text
• **Examples** that illustrate important concepts

### 💡 Study Tips
• **Active Recall**: Cover the material and try to remember key points
• **Spaced Repetition**: Review this chapter multiple times over several days
• **Practice Questions**: Use the chat feature to generate practice questions
• **Teach Someone Else**: Explain concepts to a study partner

### 📌 Next Steps
1. Use the chat feature to ask specific questions about this chapter
2. Try the Quiz mode to test your knowledge
3. Use Flashcards to memorize key terms

> 💡 **Tip**: For a more detailed study guide, try again in a few moments when the AI service is less busy.`;
}

// ============================================
// MAIN STUDY GUIDE ENDPOINT
// ============================================

router.post("/generate", requireStudent, async (req, res) => {
  try {
    const { moduleId, chapterId, chapterTitle } = req.body;
    
    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }
    
    console.log(`📖 Generating study guide for chapter: ${chapterTitle}`);
    
    // Get chapter content
    let contentMeta = { text: "", chunkCount: 0, charCount: 0, sourceHash: "" };
    try {
      contentMeta = await getChapterContent(chapterId);
    } catch (e) {
      console.error("Error fetching chapter content:", e);
    }
    
    const content = contentMeta.text || "";
    const hasContent = content && content.length > 100;
    const displayTitle = chapterTitle || "This Chapter";
    
    if (!hasContent) {
      return res.json({
        ok: true,
        hasContent: false,
        studyGuide: `## 📚 Study Guide: ${displayTitle}

### 📖 No Content Available
This chapter doesn't have content uploaded yet.

### 💡 What you can do:
- Ask your instructor to upload the chapter PDF or text
- Use the chat feature to ask questions about topics you're learning
- Check with your classmates for study materials

### 📌 Next Steps
Once content is uploaded, this study guide will automatically generate summaries, key concepts, and practice questions!`
      });
    }
    
    const forceRegenerate = Boolean(req.body?.force || req.body?.forceRegenerate);
    if (!forceRegenerate) {
      const cachedGuide = await getCachedStudyGuide({ chapterId, sourceHash: contentMeta.sourceHash });
      if (cachedGuide) {
        return res.json({
          ok: true,
          hasContent: true,
          cached: true,
          studyGuide: cachedGuide.guide_text,
          guide: cachedGuide
        });
      }
    }

    // Make a single API call instead of 5 parallel calls
    let studyGuide;
    let generatedBy = "ai";
    let providerUsed = "unknown";
    try {
      const result = await generateCompleteStudyGuide(content, displayTitle);
      studyGuide = result.studyGuide;
      providerUsed = result.providerUsed;
      console.log("✅ Study guide generated successfully");
    } catch (e) {
      console.error("API call failed, using fallback:", e.message);
      studyGuide = generateFallbackStudyGuide(content, displayTitle);
      generatedBy = "fallback";
      providerUsed = "fallback";
    }

    const cachedGuide = await saveStudyGuideCache({
      moduleId,
      chapterId,
      chapterTitle: displayTitle,
      guideText: studyGuide,
      sourceMeta: contentMeta,
      userId: req.user.id,
      generatedBy: providerUsed || generatedBy
    });
    
    res.json({
      ok: true,
      hasContent: true,
      cached: false,
      studyGuide: studyGuide,
      guide: cachedGuide,
      provider: providerUsed
    });
    
  } catch (e) {
    console.error("Study guide generation error:", e);
    
    res.json({
      ok: true,
      hasContent: true,
      studyGuide: generateFallbackStudyGuide("", "Chapter")
    });
  }
});

// ============================================
// QUICK SUMMARY ONLY (uses fewer tokens)
// ============================================

router.post("/summary", requireStudent, async (req, res) => {
  try {
    const { chapterId, chapterTitle } = req.body;
    
    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }
    
    let contentMeta = { text: "", sourceHash: "" };
    try {
      contentMeta = await getChapterContent(chapterId);
    } catch (e) {
      console.error("Error fetching chapter content:", e);
    }
    
    const content = contentMeta.text || "";
    if (!content || content.length < 100) {
      return res.json({
        ok: true,
        summary: "No chapter content available to summarize."
      });
    }

    const cachedGuide = await getCachedStudyGuide({ chapterId, sourceHash: contentMeta.sourceHash });
    if (cachedGuide?.summary) {
      return res.json({ ok: true, cached: true, summary: cachedGuide.summary });
    }
    
    const systemPrompt = `Create a concise summary of this chapter. Include the main topic and 3-5 key points. Keep it under 300 words.`;
    
    const userPrompt = `Chapter Title: ${chapterTitle}\n\nContent:\n${content.substring(0, 2000)}`;
    
    let summary;
    try {
      summary = await callGroq([
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ], 0.3);
    } catch (e) {
      const sentences = content.split(/[.!?]+/).filter(s => s.trim().length > 30);
      summary = sentences.slice(0, 3).join(". ") + ".";
    }
    
    res.json({ ok: true, summary });
    
  } catch (e) {
    console.error("Summary generation error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// EXPORT ROUTER
// ============================================

export default router;
