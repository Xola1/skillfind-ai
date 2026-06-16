// ============================================
// QUESTION EXTRACTOR - API Pipeline: OpenRouter → Groq → Hugging Face → Local
// ============================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import FormData from "form-data";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";
import dotenv from "dotenv";

dotenv.config();

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
const OCR_SPACE_API_KEY = process.env.OCR_SPACE_API_KEY || "";

// AI API Keys
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY || "";
const OPENROUTER_MODEL = process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat";
const GROQ_API_KEY = process.env.GROQ_API_KEY || "";
const GROQ_MODEL = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
const HF_TOKEN = process.env.HF_TOKEN || "";
const HF_MODEL = process.env.HF_MODEL || "meta-llama/Llama-3.2-3B-Instruct";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function normalizeStudyQuestionType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "mcq") return "multiple_choice";
  if (value === "truefalse") return "true_false";
  if (value === "short_answer") return "short_question";
  if (value === "essay") return "long_question";
  if (value === "calculation" || value === "practical") return "long_question";
  return value || "short_question";
}

function optionsToArray(options) {
  if (Array.isArray(options)) return options.map(String).filter(Boolean);
  if (options && typeof options === "object") return Object.values(options).map(String).filter(Boolean);
  return [];
}

function toStudyQuestionRow({ q, exam, examId, source = "exam_extracted" }) {
  if (!exam?.module_id) return null;
  const questionType = normalizeStudyQuestionType(q.question_type || q.type);
  const options = optionsToArray(q.options);
  const correctAnswer = q.correct_answer || q.suggested_answer || q.answer || options[0] || "Review the source material";

  return {
    exam_id: examId || null,
    course_id: exam.course_id || null,
    module_id: exam.module_id,
    chapter_id: q.chapter_id || null,
    source,
    question_type: questionType,
    question_text: q.question_text || q.text || "Generated question",
    correct_answer: String(correctAnswer),
    options,
    missing_word: q.missing_word || null,
    term: q.term || null,
    definition: q.definition || null,
    explanation: q.explanation || q.prediction_reason || null,
    marks: Number(q.marks) || 1,
    difficulty_level: q.difficulty || q.difficulty_level || "medium",
    topic_tags: q.topic_tags || q.topics || [],
    keywords: q.keywords || q.concepts || [],
    bloom_level: q.bloom_level || q.bloom_taxonomy_level || null,
    quality_score: source === "exam_extracted" ? 0.85 : 0.75,
    ai_confidence: 0.75
  };
}

function adaptStudyPrediction(row) {
  return {
    id: row.id,
    question_text: row.question_text,
    question_type: row.question_type,
    options: row.options,
    correct_answer: row.correct_answer,
    suggested_answer: row.correct_answer,
    explanation: row.explanation,
    difficulty: row.difficulty_level,
    topic_tags: row.topic_tags || [],
    prediction_reason: row.explanation || `Saved ${row.source || "question-bank"} question retrieved randomly from the database.`,
    source: row.source || "database"
  };
}

async function getSavedPredictorQuestions({ moduleId, chapterId, count }) {
  let query = sbAdmin
    .from("study_question_bank")
    .select("*")
    .eq("module_id", moduleId)
    .eq("is_active", true)
    .in("question_type", [
      "multiple_choice",
      "true_false",
      "missing_word",
      "term_definition",
      "long_question",
      "short_question"
    ])
    .limit(150);

  if (chapterId) query = query.or(`chapter_id.eq.${chapterId},chapter_id.is.null`);

  const { data, error } = await query;
  if (error) {
    console.warn("Saved predictor question lookup failed:", error.message);
    return [];
  }
  return [...(data || [])].sort(() => Math.random() - 0.5).slice(0, count).map(adaptStudyPrediction);
}

async function savePredictionsToStudyBank({ predictions, exam }) {
  if (!exam?.module_id || !Array.isArray(predictions) || !predictions.length) return 0;
  const rows = predictions
    .map(q => toStudyQuestionRow({ q, exam, examId: null, source: "mock_predicted" }))
    .filter(Boolean);

  if (!rows.length) return 0;
  const { error } = await sbAdmin.from("study_question_bank").insert(rows);
  if (error) {
    console.warn("Could not save predicted questions to reusable bank:", error.message);
    return 0;
  }
  return rows.length;
}

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
// PDF TEXT EXTRACTION
// ============================================

async function extractPdfText(buffer, password = "") {
  try {
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

    return { text: fullText.trim(), pages: doc.numPages };
  } catch (e) {
    console.error("PDF extraction error:", e);
    return { text: "", pages: 0 };
  }
}

// ============================================
// OCR.SPACE FALLBACK
// ============================================

function getOcrSpaceFiletypeAndName(fileName) {
  const name = fileName.toLowerCase();
  if (name.endsWith(".pdf")) return { filetype: "PDF", filename: "upload.pdf" };
  if (name.endsWith(".png")) return { filetype: "PNG", filename: "upload.png" };
  if (name.endsWith(".jpg") || name.endsWith(".jpeg")) return { filetype: "JPG", filename: "upload.jpg" };
  return { filetype: "", filename: "upload" };
}

async function ocrWithOcrSpace(fileBuffer, originalName) {
  if (!OCR_SPACE_API_KEY) {
    console.log("⚠️ OCR_SPACE_API_KEY not found, skipping OCR");
    return null;
  }

  const { filetype, filename } = getOcrSpaceFiletypeAndName(originalName);
  if (!filetype) return null;

  const form = new FormData();
  form.append("file", fileBuffer, {
    filename: filename,
    contentType: "application/octet-stream"
  });
  form.append("language", "eng");
  form.append("isOverlayRequired", "false");
  form.append("OCREngine", "2");
  if (filetype) form.append("filetype", filetype);

  try {
    console.log("🔍 Sending to OCR.space for extraction...");
    const resp = await fetch("https://api.ocr.space/parse/image", {
      method: "POST",
      headers: { apikey: OCR_SPACE_API_KEY, ...form.getHeaders() },
      body: form
    });

    const json = await resp.json();

    if (json.IsErroredOnProcessing) {
      console.error("OCR.space error:", json.ErrorMessage);
      return null;
    }

    if (json.ParsedResults && json.ParsedResults.length > 0) {
      const extractedText = json.ParsedResults[0].ParsedText;
      console.log(`✅ OCR.space extracted ${extractedText.length} characters`);
      return extractedText;
    }

    return null;
  } catch (error) {
    console.error("OCR.space request failed:", error);
    return null;
  }
}

// ============================================
// SMART TEXT EXTRACTION
// ============================================

async function smartExtractText(fileBuffer, fileName) {
  let extractedText = "";
  let method = "";

  if (fileName.toLowerCase().endsWith(".pdf")) {
    console.log("📄 Attempting PDF text extraction...");
    const pdfResult = await extractPdfText(fileBuffer);
    
    if (pdfResult.text && pdfResult.text.length > 60) {
      extractedText = pdfResult.text;
      method = "pdf-text";
      console.log(`✅ PDF extraction successful: ${extractedText.length} chars from ${pdfResult.pages} pages`);
    } else {
      console.log("⚠️ PDF extraction yielded little text, trying OCR.space...");
      const ocrText = await ocrWithOcrSpace(fileBuffer, fileName);
      if (ocrText && ocrText.length > 60) {
        extractedText = ocrText;
        method = "ocr-space";
        console.log(`✅ OCR.space extraction successful: ${extractedText.length} chars`);
      }
    }
  } 
  else if (fileName.match(/\.(jpg|jpeg|png)$/i)) {
    console.log("🖼️ Image detected, using OCR.space...");
    const ocrText = await ocrWithOcrSpace(fileBuffer, fileName);
    if (ocrText && ocrText.length > 50) {
      extractedText = ocrText;
      method = "ocr-space";
      console.log(`✅ OCR.space extraction successful: ${extractedText.length} chars`);
    }
  }

  extractedText = extractedText
    .replace(/\r\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return { text: extractedText, method };
}

// ============================================
// EXTRACT QUESTIONS USING GROQ AI
// ============================================

async function callGroqForExtraction(content, examTitle) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");

  const url = "https://api.groq.com/openai/v1/chat/completions";

  const systemPrompt = `You are an expert at extracting exam questions from educational materials.

Extract ALL questions from the provided exam paper. For each question, identify:
1. The complete question text
2. Question type (multiple_choice, true_false, short_answer, essay, practical, calculation)
3. For multiple choice: extract all options (A, B, C, D)
4. The correct answer (if visible/apparent)
5. Topic tags (2-4 relevant topics)
6. Difficulty level (easy, medium, hard, expert)
7. Key concepts being tested
8. Bloom's Taxonomy level (Remember, Understand, Apply, Analyze, Evaluate, Create)

Return as JSON array:
[
  {
    "question_text": "What is the capital of France?",
    "question_type": "multiple_choice",
    "options": {"A": "London", "B": "Berlin", "C": "Paris", "D": "Madrid"},
    "correct_answer": "C",
    "topic_tags": ["geography", "capitals"],
    "difficulty": "easy",
    "concepts": ["world capitals", "European geography"],
    "bloom_level": "Remember",
    "marks": 2
  }
]

If the correct answer is not visible in the text, set correct_answer to null.`;

  const resp = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: `Exam Title: ${examTitle}\n\nContent:\n${content.substring(0, 8000)}` }
      ],
      temperature: 0.3,
      max_tokens: 4000
    })
  });

  const raw = await resp.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("Failed to parse AI response"); }

  if (!resp.ok) throw new Error(json?.error?.message || "AI extraction failed");

  const responseText = json?.choices?.[0]?.message?.content || "[]";
  try {
    const jsonMatch = responseText.match(/\[[\s\S]*\]/);
    return jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(responseText);
  } catch (e) {
    console.error("Failed to parse extraction:", responseText);
    return [];
  }
}

// ============================================
// STEP 1: OpenRouter - Generate Initial Questions
// ============================================

async function step1_OpenRouterGenerate(chapterConcepts, examPatterns, count) {
  if (!OPENROUTER_API_KEY) throw new Error("Missing OPENROUTER_API_KEY");
  
  const workingFreeModels = [
    "deepseek/deepseek-chat",
    "google/gemini-2.0-flash-lite-preview-02-05",
    "nousresearch/hermes-3-llama-3.1-405b"
  ];
  
  let modelToUse = OPENROUTER_MODEL;
  const invalidModels = ["openrouter/free", "qwen/qwen-2.5-7b-instruct:free", "microsoft/phi-3.5-mini-128k-instruct:free"];
  
  if (invalidModels.includes(modelToUse) || !modelToUse.includes(":")) {
    console.log(`⚠️ Invalid model "${modelToUse}", falling back to: ${workingFreeModels[0]}`);
    modelToUse = workingFreeModels[0];
  }
  
  console.log(`🤖 STEP 1: OpenRouter generating with ${modelToUse}`);
  
  const systemPrompt = `You are an expert exam question generator. Create ${count} high-quality exam questions based on the chapter content.

For each question, provide:
- question_text: The complete question
- question_type: multiple_choice, true_false, short_answer, essay, calculation, or practical
- difficulty: easy, medium, hard, or expert
- topic_tags: array of 2-4 relevant topics
- suggested_answer: A brief model answer or correct response

Make questions specific, educational, and exam-appropriate. Return as JSON array.`;

  let userPrompt = "";
  
  if (chapterConcepts && chapterConcepts.key_sentences?.length > 0) {
    userPrompt += `Chapter Topics: ${chapterConcepts.key_topics.slice(0, 10).join(", ")}\n\n`;
    userPrompt += `Key Concepts:\n${chapterConcepts.key_sentences.slice(0, 8).map((s, i) => `${i+1}. ${s.substring(0, 200)}`).join("\n")}\n\n`;
  }
  
  if (examPatterns && examPatterns.total_questions > 0) {
    userPrompt += `Reference - Past exam patterns:\n`;
    userPrompt += `Frequent topics: ${examPatterns.top_topics.slice(0, 5).map(t => t.topic).join(", ")}\n`;
    userPrompt += `Common difficulty: ${examPatterns.common_difficulty}\n\n`;
  }
  
  userPrompt += `Generate ${count} exam questions based on this chapter. Return as JSON array.`;

  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${OPENROUTER_API_KEY}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "http://localhost:5050",
      "X-Title": "SkillFind AI"
    },
    body: JSON.stringify({
      model: modelToUse,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.7,
      max_tokens: 3000
    })
  });
  
  if (!response.ok) {
    throw new Error(`OpenRouter API error: ${response.status}`);
  }
  
  const raw = await response.text();
  let json;
  try { json = JSON.parse(raw); } catch { throw new Error("Failed to parse OpenRouter response"); }
  
  const responseText = json?.choices?.[0]?.message?.content || "[]";
  const jsonMatch = responseText.match(/\[[\s\S]*\]/);
  if (!jsonMatch) return [];
  
  try {
    const result = JSON.parse(jsonMatch[0]);
    console.log(`✅ STEP 1: OpenRouter generated ${result.length} questions`);
    return result;
  } catch (e) {
    console.error("Failed to parse OpenRouter JSON:", e);
    return [];
  }
}

// ============================================
// STEP 2: Groq - Review and Improve Questions
// ============================================

async function step2_GroqReviewAndFix(initialQuestions, chapterConcepts, examPatterns) {
  if (!GROQ_API_KEY) throw new Error("Missing GROQ_API_KEY");
  if (!initialQuestions || initialQuestions.length === 0) return [];
  
  console.log(`🤖 STEP 2: Groq reviewing and improving ${initialQuestions.length} questions...`);
  
  const systemPrompt = `You are an expert exam question reviewer. Review and improve the following questions to make them better.

## Your tasks:
1. Fix any grammar or clarity issues
2. Ensure questions are specific and test real understanding
3. Add a "prediction_reason" explaining why this question is likely
4. Ensure question_type is appropriate
5. Ensure difficulty matches the content

For multiple choice questions, ensure options are plausible.
For essay questions, ensure they require critical thinking.
For short answer, ensure they test key concepts.

Return the improved questions as JSON array with same structure plus "prediction_reason".`;

  const userPrompt = `Original questions to review and improve:\n${JSON.stringify(initialQuestions, null, 2)}\n\nChapter topics: ${chapterConcepts?.key_topics?.slice(0, 8).join(", ") || "General"}\n\nReturn improved JSON array.`;

  const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
    method: "POST",
    headers: { "Authorization": `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      model: GROQ_MODEL,
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: userPrompt }
      ],
      temperature: 0.4,
      max_tokens: 3000
    })
  });
  
  if (!response.ok) {
    throw new Error(`Groq review failed: ${response.status}`);
  }
  
  const json = await response.json();
  const content = json?.choices?.[0]?.message?.content || "[]";
  const jsonMatch = content.match(/\[[\s\S]*\]/);
  
  if (!jsonMatch) {
    console.error("No JSON array in Groq response");
    return initialQuestions;
  }
  
  try {
    const reviewed = JSON.parse(jsonMatch[0]);
    console.log(`✅ STEP 2: Groq reviewed and improved ${reviewed.length} questions`);
    return reviewed;
  } catch (e) {
    console.error("Failed to parse Groq JSON:", e);
    return initialQuestions;
  }
}

// ============================================
// STEP 3: Hugging Face - Backup Generation
// ============================================

async function step3_HuggingFaceBackup(chapterConcepts, examPatterns, count) {
  if (!HF_TOKEN) throw new Error("Missing HF_TOKEN");
  
  console.log(`🤖 STEP 3: Hugging Face generating backup questions...`);
  
  const topics = chapterConcepts?.key_topics?.slice(0, 8) || ["key concepts from the chapter"];
  
  const prompt = `<|begin_of_text|><|start_header_id|>user<|end_header_id|>
Generate ${count} exam questions about: ${topics.join(", ")}.

Each question must have: 
- question_text
- question_type (short_answer/essay/multiple_choice)
- difficulty (easy/medium/hard)
- topic_tags (array)
- suggested_answer (brief)
- prediction_reason (brief)

Return ONLY valid JSON array.
<|eot_id|><|start_header_id|>assistant<|end_header_id|>`;

  const response = await fetch(`https://api-inference.huggingface.co/models/${HF_MODEL}`, {
    method: "POST",
    headers: { "Authorization": `Bearer ${HF_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({
      inputs: prompt,
      parameters: { 
        max_new_tokens: 1500, 
        temperature: 0.7,
        return_full_text: false
      }
    })
  });
  
  if (!response.ok) {
    throw new Error(`Hugging Face error: ${response.status}`);
  }
  
  const result = await response.json();
  const generatedText = result?.[0]?.generated_text || result?.generated_text || "";
  const jsonMatch = generatedText.match(/\[[\s\S]*\]/);
  
  if (jsonMatch) {
    try {
      const backup = JSON.parse(jsonMatch[0]);
      console.log(`✅ STEP 3: Hugging Face generated ${backup.length} backup questions`);
      return backup;
    } catch (e) {
      console.error("Failed to parse HF JSON");
      return [];
    }
  }
  
  return [];
}

// ============================================
// STEP 4: Local Extraction - Final Fallback
// ============================================

function step4_LocalExtraction(chapterConcepts, examPatterns, count) {
  console.log("📝 STEP 4: Using local rule-based extraction (final fallback)");
  
  const predictions = [];
  
  const chapterTopics = chapterConcepts?.key_topics || [];
  const examTopics = examPatterns?.top_topics?.map(t => t.topic) || [];
  
  const allTopics = [...new Set([...chapterTopics, ...examTopics])];
  const priorityTopics = chapterTopics.filter(t => examTopics.includes(t));
  
  let usedTopics = [];
  if (priorityTopics.length > 0) {
    usedTopics = priorityTopics;
  } else if (chapterTopics.length > 0) {
    usedTopics = chapterTopics;
  } else if (examTopics.length > 0) {
    usedTopics = examTopics;
  } else {
    usedTopics = ["key concepts", "main principles", "important definitions", "core objectives"];
  }
  
  const templates = [
    { type: "short_answer", difficulty: "easy", template: "What is {topic}? Provide a clear definition." },
    { type: "short_answer", difficulty: "medium", template: "Explain the importance of {topic} in this context." },
    { type: "essay", difficulty: "medium", template: "Describe the key aspects of {topic} with relevant examples." },
    { type: "multiple_choice", difficulty: "easy", template: "Which of the following best describes {topic}?" },
    { type: "calculation", difficulty: "hard", template: "Solve a practical problem related to {topic}." },
    { type: "essay", difficulty: "hard", template: "Compare and contrast different approaches to {topic}." }
  ];
  
  for (let i = 0; i < Math.min(count, usedTopics.length + 5); i++) {
    const topic = usedTopics[i % usedTopics.length];
    const template = templates[i % templates.length];
    
    let reason = "";
    if (priorityTopics.includes(topic)) {
      reason = `This topic appears frequently in past exams and is emphasized in the current chapter.`;
    } else if (examTopics.includes(topic)) {
      reason = `Based on past exam patterns, this topic has been tested before.`;
    } else if (chapterTopics.includes(topic)) {
      reason = `This is a key concept from the chapter that is likely to be assessed.`;
    } else {
      reason = `Fundamental concept that forms the basis for understanding this subject.`;
    }
    
    predictions.push({
      question_text: template.template.replace("{topic}", topic.charAt(0).toUpperCase() + topic.slice(1)),
      question_type: template.type,
      difficulty: template.difficulty,
      topic_tags: [topic],
      prediction_reason: reason,
      suggested_answer: `Review the chapter material on ${topic} for the correct answer.`
    });
  }
  
  console.log(`✅ STEP 4: Local extraction generated ${predictions.length} questions`);
  return predictions;
}

// ============================================
// MAIN PIPELINE: OpenRouter → Groq → HF → Local
// ============================================

async function runPredictionPipeline(chapterConcepts, examPatterns, count) {
  const pipelineSteps = [];
  let finalQuestions = [];
  
  // STEP 1: OpenRouter generates initial questions
  if (OPENROUTER_API_KEY) {
    try {
      console.log("🚀 PIPELINE STEP 1: OpenRouter generating questions...");
      const generated = await step1_OpenRouterGenerate(chapterConcepts, examPatterns, count);
      if (generated && generated.length > 0) {
        finalQuestions = generated;
        pipelineSteps.push({ step: 1, provider: "OpenRouter", status: "success", count: generated.length });
        console.log(`✅ Step 1 complete: ${generated.length} questions generated`);
      } else {
        pipelineSteps.push({ step: 1, provider: "OpenRouter", status: "no_results", count: 0 });
        console.log("⚠️ Step 1: OpenRouter returned no questions");
      }
    } catch (error) {
      console.error("❌ Step 1 failed (OpenRouter):", error.message);
      pipelineSteps.push({ step: 1, provider: "OpenRouter", status: "failed", error: error.message });
    }
  } else {
    console.log("⚠️ Step 1 skipped: No OpenRouter API key");
    pipelineSteps.push({ step: 1, provider: "OpenRouter", status: "skipped" });
  }
  
  // STEP 2: Groq reviews and improves (if we have questions)
  if (finalQuestions.length > 0 && GROQ_API_KEY) {
    try {
      console.log("🔍 PIPELINE STEP 2: Groq reviewing and improving questions...");
      const reviewed = await step2_GroqReviewAndFix(finalQuestions, chapterConcepts, examPatterns);
      if (reviewed && reviewed.length > 0) {
        finalQuestions = reviewed;
        pipelineSteps.push({ step: 2, provider: "Groq", status: "success", count: reviewed.length });
        console.log(`✅ Step 2 complete: ${reviewed.length} questions reviewed and improved`);
      } else {
        pipelineSteps.push({ step: 2, provider: "Groq", status: "no_changes", count: finalQuestions.length });
        console.log("⚠️ Step 2: Groq returned no changes, keeping original");
      }
    } catch (error) {
      console.error("❌ Step 2 failed (Groq review):", error.message);
      pipelineSteps.push({ step: 2, provider: "Groq", status: "failed", error: error.message });
    }
  } else if (finalQuestions.length === 0 && GROQ_API_KEY) {
    // If OpenRouter failed, try Groq as generator (Step 1B)
    try {
      console.log("🔄 OpenRouter failed, Groq acting as generator (Step 1B)...");
      const groqGenerated = await step2_GroqReviewAndFix([], chapterConcepts, examPatterns);
      if (groqGenerated && groqGenerated.length > 0) {
        finalQuestions = groqGenerated;
        pipelineSteps.push({ step: "1B", provider: "Groq", status: "success", count: groqGenerated.length });
        console.log(`✅ Step 1B complete: ${groqGenerated.length} questions generated by Groq`);
      }
    } catch (error) {
      console.error("❌ Groq generation failed:", error.message);
      pipelineSteps.push({ step: "1B", provider: "Groq", status: "failed", error: error.message });
    }
  }
  
  // STEP 3: Hugging Face backup (if we still have no questions)
  if (finalQuestions.length === 0 && HF_TOKEN) {
    try {
      console.log("🔄 PIPELINE STEP 3: Hugging Face backup generation...");
      const backup = await step3_HuggingFaceBackup(chapterConcepts, examPatterns, count);
      if (backup && backup.length > 0) {
        finalQuestions = backup;
        pipelineSteps.push({ step: 3, provider: "HuggingFace", status: "success", count: backup.length });
        console.log(`✅ Step 3 complete: ${backup.length} backup questions generated`);
      } else {
        pipelineSteps.push({ step: 3, provider: "HuggingFace", status: "no_results", count: 0 });
        console.log("⚠️ Step 3: Hugging Face returned no questions");
      }
    } catch (error) {
      console.error("❌ Step 3 failed (Hugging Face):", error.message);
      pipelineSteps.push({ step: 3, provider: "HuggingFace", status: "failed", error: error.message });
    }
  }
  
  // STEP 4: Local extraction (final fallback)
  if (finalQuestions.length === 0) {
    console.log("🔄 PIPELINE STEP 4: Local rule-based extraction (final fallback)...");
    const local = step4_LocalExtraction(chapterConcepts, examPatterns, count);
    if (local && local.length > 0) {
      finalQuestions = local;
      pipelineSteps.push({ step: 4, provider: "LocalExtraction", status: "success", count: local.length });
      console.log(`✅ Step 4 complete: ${local.length} questions from local extraction`);
    } else {
      pipelineSteps.push({ step: 4, provider: "LocalExtraction", status: "failed", count: 0 });
      console.log("❌ All pipeline steps failed to generate questions");
    }
  }
  
  // Ensure all questions have required fields
  finalQuestions = finalQuestions.map(q => ({
    question_text: q.question_text || "Review the chapter material",
    question_type: q.question_type || "short_answer",
    difficulty: q.difficulty || "medium",
    topic_tags: q.topic_tags || ["general"],
    prediction_reason: q.prediction_reason || "Generated based on chapter content analysis",
    suggested_answer: q.suggested_answer || q.correct_answer || "Review the chapter material for this answer"
  }));
  
  return {
    questions: finalQuestions.slice(0, count),
    pipeline_steps: pipelineSteps,
    total_generated: finalQuestions.length
  };
}

// ============================================
// HELPER: Extract Key Concepts from Chunks
// ============================================

async function extractKeyConceptsFromChunks(chunks) {
  if (!chunks || chunks.length === 0) return null;
  
  const fullText = chunks.map(c => c.text).join(" ");
  
  const importantKeywords = ["important", "key", "critical", "essential", "main", "primary", "purpose", "goal", "definition", "concept", "principle", "framework", "methodology", "approach", "technique", "strategy", "process", "steps", "learning", "objective", "outcome"];
  
  const sentences = fullText.split(/[.!?]+/).filter(s => s.trim().length > 30 && s.trim().length < 300);
  const importantSentences = sentences.filter(s => 
    importantKeywords.some(kw => s.toLowerCase().includes(kw))
  );
  
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'having', 'do', 'does', 'did', 'doing', 'but', 'so', 'if', 'then', 'else', 'when', 'where', 'which', 'what', 'who', 'whom', 'whose', 'why', 'how']);
  
  const words = fullText.toLowerCase().split(/\s+/);
  const wordFreq = {};
  
  for (const word of words) {
    const cleanWord = word.replace(/[^a-z]/g, '');
    if (cleanWord.length > 4 && !stopWords.has(cleanWord)) {
      wordFreq[cleanWord] = (wordFreq[cleanWord] || 0) + 1;
    }
  }
  
  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 20)
    .map(([word]) => word);
  
  return {
    key_sentences: importantSentences.slice(0, 15),
    key_topics: [...new Set(topWords)],
    full_content: fullText.substring(0, 3000),
    chunks_count: chunks.length,
    total_length: fullText.length
  };
}

// ============================================
// HELPER: Analyze Exam Patterns
// ============================================

async function analyzeExamPatterns(questions, chapterTopics = []) {
  if (!questions || questions.length === 0) return null;
  
  const topicFrequency = {};
  const difficultyDistribution = { easy: 0, medium: 0, hard: 0, expert: 0 };
  const typeDistribution = {};
  const bloomDistribution = {};
  
  let relevantQuestions = [];
  let irrelevantQuestions = [];
  
  for (const q of questions) {
    const questionTopics = q.topic_tags || [];
    const isRelevant = chapterTopics.length === 0 || questionTopics.some(t => 
      chapterTopics.some(ct => t.toLowerCase().includes(ct.toLowerCase()) || ct.toLowerCase().includes(t.toLowerCase()))
    );
    
    if (isRelevant) {
      relevantQuestions.push(q);
    } else {
      irrelevantQuestions.push(q);
    }
    
    for (const topic of questionTopics) {
      topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
    }
    if (q.difficulty_level) difficultyDistribution[q.difficulty_level]++;
    if (q.question_type) typeDistribution[q.question_type] = (typeDistribution[q.question_type] || 0) + 1;
    if (q.bloom_taxonomy_level) bloomDistribution[q.bloom_taxonomy_level] = (bloomDistribution[q.bloom_taxonomy_level] || 0) + 1;
  }
  
  const topTopics = Object.entries(topicFrequency)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic, count]) => ({ topic, frequency: count, percentage: (count / questions.length) * 100 }));
  
  const commonDifficulty = Object.entries(difficultyDistribution)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "medium";
  
  const commonType = Object.entries(typeDistribution)
    .sort((a, b) => b[1] - a[1])[0]?.[0] || "short_answer";
  
  return {
    total_questions: questions.length,
    relevant_questions: relevantQuestions.length,
    irrelevant_questions: irrelevantQuestions.length,
    top_topics: topTopics,
    difficulty_distribution: difficultyDistribution,
    type_distribution: typeDistribution,
    bloom_distribution: bloomDistribution,
    common_difficulty: commonDifficulty,
    common_type: commonType
  };
}

// ============================================
// PROCESS EXAM ENDPOINT
// ============================================

router.post("/exams/:examId/process", requireAdmin, async (req, res) => {
  try {
    const { examId } = req.params;
    
    const { data: exam, error: examError } = await sbAdmin
      .from("exams")
      .select("*")
      .eq("id", examId)
      .single();
    
    if (examError) throw examError;
    
    console.log(`📋 Processing exam: ${exam.title}`);
    console.log(`📁 File URL: ${exam.file_url}`);
    
    let fileBuffer = null;
    
    try {
      console.log("🔍 Downloading file from public URL...");
      const response = await fetch(exam.file_url);
      
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }
      
      const arrayBuffer = await response.arrayBuffer();
      fileBuffer = Buffer.from(arrayBuffer);
      console.log(`✅ Downloaded: ${fileBuffer.length} bytes`);
      
    } catch (downloadError) {
      console.error("Download error:", downloadError);
      return res.status(500).json({ 
        ok: false, 
        error: `Failed to download file: ${downloadError.message}` 
      });
    }
    
    console.log("📄 Extracting text from exam...");
    const { text: extractedText, method } = await smartExtractText(fileBuffer, exam.file_name || "exam.pdf");
    
    if (!extractedText || extractedText.length < 60) {
      return res.json({ 
        ok: false, 
        error: "Could not extract text from the exam paper." 
      });
    }
    
    console.log(`✅ Text extracted using ${method}: ${extractedText.length} characters`);
    
    console.log("🤖 Sending to Groq for question extraction...");
    const questions = await callGroqForExtraction(extractedText, exam.title);
    
    let savedCount = 0;
    let trainingCount = 0;
    let studyBankCount = 0;
    
    for (const q of questions) {
      const { error: insertError } = await sbAdmin.from("exam_question_bank").insert([{
        exam_id: examId,
        course_id: exam.course_id,
        module_id: exam.module_id,
        question_text: q.question_text,
        question_type: q.question_type,
        options: q.options,
        correct_answer: q.correct_answer,
        topic_tags: q.topic_tags,
        difficulty_level: q.difficulty,
        concepts: q.concepts,
        bloom_taxonomy_level: q.bloom_level,
        marks: q.marks || null,
        explanation: q.explanation || null
      }]);
      
      if (!insertError) {
        savedCount++;

        const studyRow = toStudyQuestionRow({ q, exam, examId, source: "exam_extracted" });
        if (studyRow) {
          const { error: studyError } = await sbAdmin.from("study_question_bank").insert([studyRow]);
          if (studyError) {
            console.warn("Could not mirror exam question to study_question_bank:", studyError.message);
          } else {
            studyBankCount++;
          }
        }
      }
      
      const answerText = q.correct_answer || q.explanation || "Review the chapter for this answer";
      
      const { error: trainingError } = await sbAdmin.from("ai_training_data").insert([{
        question_text: q.question_text,
        answer_text: answerText,
        context_text: extractedText.substring(0, 800),
        metadata: {
          exam_id: examId,
          course_id: exam.course_id,
          module_id: exam.module_id,
          question_type: q.question_type,
          difficulty: q.difficulty,
          topic_tags: q.topic_tags,
          bloom_level: q.bloom_level,
          marks: q.marks,
          source_type: "exam",
          extracted_at: new Date().toISOString()
        },
        quality_score: 1.0,
        created_at: new Date()
      }]);
      
      if (!trainingError) trainingCount++;
    }
    
    console.log(`✅ Saved ${savedCount} questions to question bank`);
    console.log(`✅ Saved ${trainingCount} questions to AI training data`);
    
    res.json({
      ok: true,
      questions_extracted: savedCount,
      study_bank_added: studyBankCount,
      training_data_added: trainingCount,
      total_questions: questions.length,
      exam_title: exam.title
    });
    
  } catch (e) {
    console.error("Processing error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// STUDENT PREDICTION ENDPOINT
// ============================================

router.post("/student/predict", async (req, res, next) => {
  try {
    const { courseId, moduleId, chapterId, count = 8 } = req.body;

    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }

    let effectiveModuleId = moduleId;
    if (!effectiveModuleId) {
      const { data: chapterMeta } = await sbAdmin
        .from("chapters")
        .select("module_id")
        .eq("id", chapterId)
        .maybeSingle();
      effectiveModuleId = chapterMeta?.module_id || "";
    }

    const requestedCount = Math.max(1, Math.min(Number(count) || 8, 50));
    if (!effectiveModuleId) return next();

    const savedPredictions = await getSavedPredictorQuestions({
      moduleId: effectiveModuleId,
      chapterId,
      count: requestedCount
    });

    if (savedPredictions.length < requestedCount) return next();

    return res.json({
      ok: true,
      predictions: savedPredictions,
      pipeline: {
        steps: [{ step: 0, provider: "database", status: "success" }],
        final_count: savedPredictions.length,
        total_generated: 0
      },
      analysis: {
        has_chapter_content: true,
        has_exam_patterns: savedPredictions.some(q => ["exam_extracted", "mock_predicted"].includes(q.source)),
        chapter_topics: [],
        exam_topics: [],
        total_past_questions: savedPredictions.length,
        total_chunks: 0
      },
      messages: [{
        type: "success",
        text: `${savedPredictions.length} saved questions were retrieved randomly from the database.`
      }]
    });
  } catch (error) {
    console.warn("Saved predictor lookup skipped:", error.message);
    return next();
  }
});

router.post("/student/predict", async (req, res) => {
  try {
    const { courseId, moduleId, chapterId, count = 8 } = req.body;
    
    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }
    
    console.log(`🔮 Generating predictions for chapter: ${chapterId}`);
    console.log("🚀 Starting API Pipeline: OpenRouter → Groq → Hugging Face → Local");
    
    // Fetch chapter chunks
    let chapterConcepts = null;
    try {
      const { data: chunks, error } = await sbAdmin
        .from("chapter_chunks")
        .select("text, chunk_index")
        .eq("chapter_id", chapterId)
        .order("chunk_index", { ascending: true })
        .limit(30);
      
      if (!error && chunks && chunks.length > 0) {
        chapterConcepts = await extractKeyConceptsFromChunks(chunks);
        console.log(`📖 Found ${chunks.length} chapter chunks`);
        if (chapterConcepts) {
          console.log(`📚 Key topics: ${chapterConcepts.key_topics.slice(0, 8).join(", ")}`);
        }
      } else {
        console.log("⚠️ No chapter chunks found for this chapter");
      }
    } catch (e) {
      console.error("Error getting chapter chunks:", e);
    }
    
    // Fetch exam questions
    let examPatterns = null;
    let allExamQuestionsCount = 0;
    
    try {
      const { count: totalAllQuestions, error: countError } = await sbAdmin
        .from("exam_question_bank")
        .select("*", { count: "exact", head: true });
      
      if (!countError && totalAllQuestions > 0) {
        allExamQuestionsCount = totalAllQuestions;
        console.log(`📊 Total exam questions in database: ${allExamQuestionsCount}`);
      }
      
      let query = sbAdmin.from("exam_question_bank").select("*");
      if (chapterId) query = query.eq("chapter_id", chapterId);
      query = query.limit(200);
      
      const { data: questions, error } = await query;
      
      if (!error && questions && questions.length > 0) {
        examPatterns = await analyzeExamPatterns(questions, chapterConcepts?.key_topics || []);
        console.log(`📊 Found ${examPatterns.total_questions} past exam questions for this chapter`);
      } else {
        console.log(`⚠️ No exam questions found for this specific chapter`);
        if (allExamQuestionsCount > 0) {
          console.log(`ℹ️ Note: ${allExamQuestionsCount} exam questions exist in database but none are linked to this chapter`);
        }
      }
    } catch (e) {
      console.error("Error getting exam patterns:", e);
    }
    
    // Run the prediction pipeline
    const { questions: predictions, pipeline_steps, total_generated } = await runPredictionPipeline(
      chapterConcepts,
      examPatterns,
      Math.min(count, 12)
    );

    const savedPredictionCount = await savePredictionsToStudyBank({
      predictions: predictions.map(q => ({ ...q, chapter_id: chapterId })),
      exam: {
        course_id: courseId || null,
        module_id: moduleId || null
      }
    });
    
    // Build response
    const responseData = {
      ok: true,
      predictions: predictions,
      pipeline: {
        steps: pipeline_steps,
        final_count: predictions.length,
        total_generated: total_generated
      },
      analysis: {
        has_chapter_content: chapterConcepts !== null && chapterConcepts.key_sentences?.length > 0,
        has_exam_patterns: examPatterns !== null && examPatterns.total_questions > 0,
        chapter_topics: chapterConcepts?.key_topics?.slice(0, 10) || [],
        exam_topics: examPatterns?.top_topics?.slice(0, 5).map(t => t.topic) || [],
        total_past_questions: examPatterns?.total_questions || 0,
        total_chunks: chapterConcepts?.chunks_count || 0
      },
      messages: [],
      saved_to_question_bank: savedPredictionCount
    };
    
    // Add status messages
    const successfulStep = pipeline_steps.find(s => s.status === "success");
    if (successfulStep) {
      responseData.messages.push({
        type: "info",
        text: `🎯 Questions generated via: ${successfulStep.provider} (Step ${successfulStep.step})`
      });
    }
    
    if (!examPatterns || examPatterns.total_questions === 0) {
      if (allExamQuestionsCount > 0) {
        responseData.messages.push({
          type: "info",
          text: `📚 ${allExamQuestionsCount} exam questions available in database, but none linked to this chapter yet.`
        });
      }
    } else if (examPatterns.relevant_questions === 0 && examPatterns.total_questions > 0) {
      responseData.messages.push({
        type: "warning",
        text: `⚠️ ${examPatterns.total_questions} exam questions exist but none match this chapter's topics.`
      });
    }
    
    if (chapterConcepts && chapterConcepts.chunks_count > 0) {
      responseData.messages.push({
        type: "success",
        text: `📖 Loaded ${chapterConcepts.chunks_count} chapter sections for context.`
      });
    } else {
      responseData.messages.push({
        type: "warning",
        text: "⚠️ No chapter content found. Upload chapter materials for better predictions."
      });
    }
    
    console.log(`✅ Pipeline complete: ${predictions.length} predictions returned`);
    res.json(responseData);
    
  } catch (e) {
    console.error("Prediction error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GET PATTERNS ENDPOINT
// ============================================

router.get("/student/patterns", async (req, res) => {
  try {
    const { chapterId, moduleId, courseId } = req.query;
    
    if (!chapterId && !moduleId && !courseId) {
      return res.status(400).json({ ok: false, error: "At least one filter required" });
    }
    
    let patterns = [];
    let frequentTopics = {};
    let difficultyDist = { easy: 0, medium: 0, hard: 0, expert: 0 };
    let questionTypes = {};
    let bloomLevels = {};
    
    let query = sbAdmin.from("exam_question_bank").select("*");
    if (chapterId) query = query.eq("chapter_id", chapterId);
    else if (moduleId) query = query.eq("module_id", moduleId);
    else if (courseId) query = query.eq("course_id", courseId);
    
    const { data: questions, error } = await query.limit(500);
    
    let totalQuestions = 0;
    let hasExamQuestions = false;
    
    if (!error && questions && questions.length > 0) {
      totalQuestions = questions.length;
      hasExamQuestions = true;
      
      for (const q of questions) {
        for (const topic of q.topic_tags || []) {
          frequentTopics[topic] = (frequentTopics[topic] || 0) + 1;
        }
        if (q.difficulty_level) difficultyDist[q.difficulty_level]++;
        if (q.question_type) questionTypes[q.question_type] = (questionTypes[q.question_type] || 0) + 1;
        if (q.bloom_taxonomy_level) bloomLevels[q.bloom_taxonomy_level] = (bloomLevels[q.bloom_taxonomy_level] || 0) + 1;
      }
      
      patterns = [{
        total_questions: totalQuestions,
        frequent_topics: frequentTopics,
        difficulty_distribution: difficultyDist,
        question_types: questionTypes,
        bloom_levels: bloomLevels
      }];
    }
    
    let chunksCount = 0;
    if (chapterId) {
      const { count, error: chunkError } = await sbAdmin
        .from("chapter_chunks")
        .select("id", { count: "exact", head: true })
        .eq("chapter_id", chapterId);
      
      if (!chunkError) chunksCount = count || 0;
    }
    
    res.json({ 
      ok: true, 
      patterns: patterns,
      has_exam_questions: hasExamQuestions,
      total_exam_questions: totalQuestions,
      chapter_chunks_count: chunksCount,
      chapter_has_content: chunksCount > 0
    });
    
  } catch (e) {
    console.error("Error fetching patterns:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// ADMIN PREDICTION ENDPOINT
// ============================================

router.post("/predict", requireAdmin, async (req, res) => {
  try {
    const { courseId, moduleId, chapterId, count = 5 } = req.body;
    
    if (!courseId || !moduleId || !chapterId) {
      return res.status(400).json({ ok: false, error: "Missing required parameters" });
    }
    
    const { data: existingQuestions } = await sbAdmin
      .from("exam_question_bank")
      .select("*")
      .eq("course_id", courseId)
      .eq("module_id", moduleId)
      .limit(20);
    
    const { data: chunks } = await sbAdmin
      .from("chapter_chunks")
      .select("text")
      .eq("chapter_id", chapterId)
      .limit(10);
    
    const chapterContent = chunks?.map(c => c.text).join(" ") || "";
    
    if (!GROQ_API_KEY || !existingQuestions?.length) {
      return res.json({ 
        ok: true, 
        predictions: [],
        message: "Not enough data to make predictions. Upload more exam papers first."
      });
    }
    
    const topicFrequency = {};
    for (const q of existingQuestions) {
      for (const topic of q.topic_tags || []) {
        topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
      }
    }
    
    const topTopics = Object.entries(topicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic]) => topic);
    
    const systemPrompt = `You are an exam question predictor. Based on past exam patterns, predict ${count} questions that are likely to appear in future exams.

Frequent topics from past exams: ${topTopics.join(", ")}

For each predicted question, provide:
1. Question text
2. Question type
3. Difficulty level
4. Topic tags
5. Why this question is likely

Return as JSON array.`;

    const response = await fetch("https://api.groq.com/openai/v1/chat/completions", {
      method: "POST",
      headers: { Authorization: `Bearer ${GROQ_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        model: GROQ_MODEL,
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: `Chapter content for context:\n${chapterContent.substring(0, 2000)}` }
        ],
        temperature: 0.6,
        max_tokens: 2000
      })
    });
    
    const raw = await response.text();
    let json;
    try { json = JSON.parse(raw); } catch { throw new Error("Failed to parse AI response"); }
    
    const predictions = json?.choices?.[0]?.message?.content || "[]";
    let parsedPredictions = [];
    try {
      const jsonMatch = predictions.match(/\[[\s\S]*\]/);
      parsedPredictions = jsonMatch ? JSON.parse(jsonMatch[0]) : JSON.parse(predictions);
    } catch (e) {
      parsedPredictions = [];
    }
    
    res.json({ ok: true, predictions: parsedPredictions });
    
  } catch (e) {
    console.error("Prediction error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GENERATE QUIZ ENDPOINT
// ============================================

router.post("/generate-quiz", requireAdmin, async (req, res) => {
  try {
    const { courseId, moduleId, chapterId, count = 10 } = req.body;
    
    if (!courseId) {
      return res.status(400).json({ ok: false, error: "courseId is required" });
    }
    
    let query = sbAdmin.from("exam_question_bank").select("*");
    query = query.eq("course_id", courseId);
    if (moduleId) query = query.eq("module_id", moduleId);
    if (chapterId) query = query.eq("chapter_id", chapterId);
    
    const { data: questions, error } = await query;
    if (error) throw error;
    
    const shuffled = [...(questions || [])].sort(() => 0.5 - Math.random());
    const selected = shuffled.slice(0, Math.min(count, shuffled.length));
    
    const quiz = selected.map(q => ({
      id: q.id,
      text: q.question_text,
      type: q.question_type,
      options: q.options,
      correct_answer: q.correct_answer,
      marks: q.marks,
      explanation: q.explanation,
      difficulty: q.difficulty_level,
      topics: q.topic_tags
    }));
    
    res.json({ ok: true, questions: quiz, total: quiz.length });
    
  } catch (e) {
    console.error("Quiz generation error:", e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ============================================
// GET PATTERNS (Admin)
// ============================================

router.get("/patterns", requireAdmin, async (req, res) => {
  try {
    const { courseId, moduleId, chapterId } = req.query;
    
    let query = sbAdmin.from("exam_question_bank").select("*");
    if (courseId) query = query.eq("course_id", courseId);
    if (moduleId) query = query.eq("module_id", moduleId);
    if (chapterId) query = query.eq("chapter_id", chapterId);
    
    const { data: questions, error } = await query;
    if (error) throw error;
    
    const patterns = {
      total_questions: questions?.length || 0,
      frequent_topics: {},
      difficulty_distribution: { easy: 0, medium: 0, hard: 0, expert: 0 },
      question_types: {},
      bloom_levels: {}
    };
    
    for (const q of questions || []) {
      for (const topic of q.topic_tags || []) {
        patterns.frequent_topics[topic] = (patterns.frequent_topics[topic] || 0) + 1;
      }
      if (q.difficulty_level) patterns.difficulty_distribution[q.difficulty_level]++;
      if (q.question_type) patterns.question_types[q.question_type] = (patterns.question_types[q.question_type] || 0) + 1;
      if (q.bloom_taxonomy_level) patterns.bloom_levels[q.bloom_taxonomy_level] = (patterns.bloom_levels[q.bloom_taxonomy_level] || 0) + 1;
    }
    
    res.json({ ok: true, patterns });
    
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message });
  }
});

export default router;
