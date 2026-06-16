// ============================================
// AI TRAINING & QUESTION PREDICTOR
// Uses exam question patterns + chapter chunks
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

async function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user) return res.status(401).json({ ok: false, error: "Invalid token" });

  const { data: prof } = await sbAdmin.from("profiles").select("role").eq("id", data.user.id).single();
  if (prof?.role !== "admin") return res.status(403).json({ ok: false, error: "Admin only" });

  next();
}

// ============================================
// GET CHAPTER CHUNKS (Key content from the chapter)
// ============================================

async function getChapterChunks(chapterId, limit = 20) {
  const { data: chunks, error } = await sbAdmin
    .from("chapter_chunks")
    .select("text, chunk_index")
    .eq("chapter_id", chapterId)
    .order("chunk_index", { ascending: true })
    .limit(limit);
  
  if (error) throw error;
  return chunks || [];
}

// ============================================
// EXTRACT KEY CONCEPTS FROM CHAPTER CHUNKS
// ============================================

async function extractKeyConceptsFromChunks(chunks) {
  const fullText = chunks.map(c => c.text).join(" ");
  
  // Extract important keywords and concepts
  const importantKeywords = [
    "important", "key", "critical", "essential", "main", "primary",
    "purpose", "goal", "objective", "step", "process", "method",
    "definition", "concept", "principle", "function", "role"
  ];
  
  const sentences = fullText.split(/[.!?]+/).filter(s => s.trim().length > 30);
  
  const importantSentences = sentences.filter(s => 
    importantKeywords.some(kw => s.toLowerCase().includes(kw))
  );
  
  // Extract potential topics from chunks
  const potentialTopics = [];
  const words = fullText.toLowerCase().split(/\s+/);
  const wordFreq = {};
  
  for (const word of words) {
    if (word.length > 5 && !importantKeywords.includes(word)) {
      wordFreq[word] = (wordFreq[word] || 0) + 1;
    }
  }
  
  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
  
  return {
    key_sentences: importantSentences.slice(0, 10),
    key_topics: [...new Set([...topWords])],
    full_content: fullText.substring(0, 3000)
  };
}

// ============================================
// GET QUESTION PATTERNS FROM EXAM BANK
// ============================================

async function getQuestionPatterns(courseId, moduleId, chapterId) {
  let query = sbAdmin.from("exam_question_bank").select("*");
  
  if (courseId) query = query.eq("course_id", courseId);
  if (moduleId) query = query.eq("module_id", moduleId);
  if (chapterId) query = query.eq("chapter_id", chapterId);
  
  const { data: questions, error } = await query;
  if (error) throw error;
  
  if (!questions || questions.length === 0) {
    return null;
  }
  
  // Analyze patterns
  const patterns = {
    total_questions: questions.length,
    frequent_topics: {},
    difficulty_distribution: { easy: 0, medium: 0, hard: 0, expert: 0 },
    question_types: {},
    common_patterns: []
  };
  
  for (const q of questions) {
    // Topic frequency
    for (const topic of q.topic_tags || []) {
      patterns.frequent_topics[topic] = (patterns.frequent_topics[topic] || 0) + 1;
    }
    
    // Difficulty distribution
    if (q.difficulty_level) patterns.difficulty_distribution[q.difficulty_level]++;
    
    // Question types
    if (q.question_type) patterns.question_types[q.question_type] = (patterns.question_types[q.question_type] || 0) + 1;
    
    // Extract common question patterns
    const questionLower = q.question_text.toLowerCase();
    if (questionLower.includes("explain") || questionLower.includes("describe")) {
      patterns.common_patterns.push("explain/describe");
    }
    if (questionLower.includes("compare") || questionLower.includes("contrast")) {
      patterns.common_patterns.push("compare/contrast");
    }
    if (questionLower.includes("calculate") || questionLower.includes("compute")) {
      patterns.common_patterns.push("calculation");
    }
    if (questionLower.includes("define") || questionLower.includes("what is")) {
      patterns.common_patterns.push("definition");
    }
    if (questionLower.includes("list") || questionLower.includes("identify")) {
      patterns.common_patterns.push("list/identify");
    }
  }
  
  // Get unique pattern types
  patterns.common_patterns = [...new Set(patterns.common_patterns)];
  
  return patterns;
}

// ============================================
// PREDICT QUESTIONS USING GROQ (Combines exam patterns + chapter chunks)
// ============================================

async function predictQuestionsWithAI(chapterConcepts, examPatterns, chapterTitle, count = 8) {
  const apiKey = process.env.GROQ_API_KEY || "";
  if (!apiKey) {
    return generateFallbackPredictions(chapterConcepts, examPatterns, count);
  }

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const url = "https://api.groq.com/openai/v1/chat/completions";

  // Build context from both sources
  let contextPrompt = "";
  
  if (chapterConcepts && chapterConcepts.key_sentences.length > 0) {
    contextPrompt += `
## Current Chapter Content (Key Concepts):
${chapterConcepts.key_sentences.slice(0, 8).map((s, i) => `${i+1}. ${s}`).join('\n')}

Key Topics from Chapter: ${chapterConcepts.key_topics.slice(0, 10).join(', ')}
`;
  }
  
  if (examPatterns && examPatterns.total_questions > 0) {
    const topTopics = Object.entries(examPatterns.frequent_topics)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);
    
    contextPrompt += `
## Past Exam Patterns (${examPatterns.total_questions} questions analyzed):
Most Frequent Topics: ${topTopics.join(', ')}
Common Question Types: ${Object.keys(examPatterns.question_types).join(', ')}
Typical Difficulty: ${Object.entries(examPatterns.difficulty_distribution).sort((a,b) => b[1]-a[1])[0]?.[0] || 'medium'}
`;
  }

  const systemPrompt = `You are an expert exam question predictor. Based on the current chapter content AND past exam patterns, predict ${count} questions that are likely to appear in future exams.

IMPORTANT RULES:
1. Each question MUST be answerable using the chapter content provided
2. Question difficulty should match past exam patterns
3. Focus on topics that appear frequently in past exams AND are covered in the chapter
4. Mix question types based on historical patterns

For each predicted question, provide:
- question_text: The complete question
- question_type: multiple_choice, short_answer, essay, calculation, practical
- difficulty: easy, medium, hard, expert
- topic_tags: 2-3 relevant topics
- prediction_reason: Why this question is likely (based on chapter + exam patterns)

Return as JSON array.`;

  const userPrompt = `${contextPrompt}

Predict ${count} questions for this chapter that students should prepare for. Base your predictions on BOTH the chapter content AND past exam patterns.`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.6,
      max_tokens: 3000
    })
  });

  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("Failed to parse AI response"); }

  if (!resp.ok) throw new Error(json?.error?.message || "AI prediction failed");

  const responseText = json?.choices?.[0]?.message?.content || "[]";
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
  } catch (e) {
    console.error("Failed to parse predictions:", responseText);
    return generateFallbackPredictions(chapterConcepts, examPatterns, count);
  }
}

// ============================================
// FALLBACK PREDICTIONS (When API fails)
// ============================================

function generateFallbackPredictions(chapterConcepts, examPatterns, count) {
  const predictions = [];
  const topics = chapterConcepts?.key_topics || examPatterns?.frequent_topics || [];
  const topicList = Object.keys(topics).length > 0 ? Object.keys(topics) : 
                    (chapterConcepts?.key_topics || ["this topic"]);
  
  const questionTemplates = [
    { type: "explain", difficulty: "medium", template: "Explain the concept of {topic} and its importance in real-world applications." },
    { type: "definition", difficulty: "easy", template: "What is {topic}? Provide a clear definition and explain its purpose." },
    { type: "compare", difficulty: "hard", template: "Compare and contrast {topic} with related concepts. What are the key differences?" },
    { type: "example", difficulty: "medium", template: "Provide two real-world examples of {topic} and explain how they work." },
    { type: "list", difficulty: "easy", template: "List the key components or steps involved in {topic}." },
    { type: "analysis", difficulty: "hard", template: "Analyze the importance of {topic} in the broader context of this subject." }
  ];
  
  const typeDistribution = examPatterns?.question_types || { short_answer: 3, essay: 2, multiple_choice: 2 };
  const totalFromPatterns = Object.values(typeDistribution).reduce((a, b) => a + b, 0);
  
  for (let i = 0; i < Math.min(count, topicList.length + 2); i++) {
    const topic = topicList[i % topicList.length];
    const template = questionTemplates[i % questionTemplates.length];
    
    predictions.push({
      question_text: template.template.replace("{topic}", topic),
      question_type: template.type,
      difficulty: template.difficulty,
      topic_tags: [topic],
      prediction_reason: `This topic appears in the chapter content and ${examPatterns ? 'has been tested in past exams' : 'is a key concept to master'}.`
    });
  }
  
  return predictions;
}

// ============================================
// MAIN PREDICT ENDPOINT (Uses both sources)
// ============================================

router.post("/predict", async (req, res) => {
  try {
    const { courseId, moduleId, chapterId, count = 8 } = req.body;
    
    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }
    
    console.log(`🔮 Generating predictions for chapter: ${chapterId}`);
    
    // Get chapter chunks (content from the chapter)
    let chapterConcepts = null;
    try {
      const chunks = await getChapterChunks(chapterId);
      if (chunks && chunks.length > 0) {
        chapterConcepts = await extractKeyConceptsFromChunks(chunks);
        console.log(`📖 Found ${chunks.length} chapter chunks with ${chapterConcepts.key_topics.length} key topics`);
      } else {
        console.log("⚠️ No chapter chunks found for this chapter");
      }
    } catch (e) {
      console.error("Error getting chapter chunks:", e);
    }
    
    // Get exam patterns from question bank
    let examPatterns = null;
    try {
      examPatterns = await getQuestionPatterns(courseId, moduleId, chapterId);
      if (examPatterns) {
        console.log(`📊 Found ${examPatterns.total_questions} exam questions for pattern analysis`);
      } else {
        console.log("⚠️ No exam patterns found for this chapter");
      }
    } catch (e) {
      console.error("Error getting exam patterns:", e);
    }
    
    // Generate predictions using both sources
    const apiKey = process.env.GROQ_API_KEY;
    let predictions = [];
    
    if (apiKey) {
      try {
        predictions = await predictQuestionsWithAI(chapterConcepts, examPatterns, chapterTitle, count);
      } catch (e) {
        console.error("AI prediction failed, using fallback:", e);
        predictions = generateFallbackPredictions(chapterConcepts, examPatterns, count);
      }
    } else {
      predictions = generateFallbackPredictions(chapterConcepts, examPatterns, count);
    }
    
    // Prepare response with analysis summary
    const analysisSummary = {
      has_chapter_content: chapterConcepts !== null && chapterConcepts.key_sentences.length > 0,
      has_exam_patterns: examPatterns !== null && examPatterns.total_questions > 0,
      chapter_topics: chapterConcepts?.key_topics.slice(0, 10) || [],
      exam_topics: examPatterns ? Object.keys(examPatterns.frequent_topics).slice(0, 10) : [],
      total_past_questions: examPatterns?.total_questions || 0,
      prediction_count: predictions.length
    };
    
    res.json({
      ok: true,
      predictions: predictions,
      analysis: analysisSummary
    });
    
  } catch (e) {
    console.error("Prediction error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GET PATTERNS ENDPOINT
// ============================================

router.get("/patterns", async (req, res) => {
  try {
    const { courseId, moduleId, chapterId } = req.query;
    
    let query = sbAdmin.from("exam_question_bank").select("*");
    if (courseId) query = query.eq("course_id", courseId);
    if (moduleId) query = query.eq("module_id", moduleId);
    if (chapterId) query = query.eq("chapter_id", chapterId);
    
    const { data: questions, error } = await query;
    if (error) throw error;
    
    let patterns = null;
    if (questions && questions.length > 0) {
      const frequentTopics = {};
      const difficultyDist = { easy: 0, medium: 0, hard: 0, expert: 0 };
      const questionTypes = {};
      
      for (const q of questions) {
        for (const topic of q.topic_tags || []) {
          frequentTopics[topic] = (frequentTopics[topic] || 0) + 1;
        }
        if (q.difficulty_level) difficultyDist[q.difficulty_level]++;
        if (q.question_type) questionTypes[q.question_type] = (questionTypes[q.question_type] || 0) + 1;
      }
      
      patterns = { frequent_topics: frequentTopics, difficulty_distribution: difficultyDist, types: questionTypes };
    }
    
    // Also get chapter chunks info
    let chunks = [];
    if (chapterId) {
      chunks = await getChapterChunks(chapterId);
    }
    
    res.json({ 
      ok: true, 
      patterns: patterns ? [patterns] : [],
      chapter_chunks_count: chunks.length,
      chapter_has_content: chunks.length > 0
    });
    
  } catch (e) {
    console.error("Error fetching patterns:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;