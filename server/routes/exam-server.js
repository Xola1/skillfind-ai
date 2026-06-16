// ============================================
// EXAM-SERVER.JS - Exam Study Mode API Routes
// ============================================

import express from "express";
import { createClient } from "@supabase/supabase-js";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
 
dotenv.config({ path: fileURLToPath(new URL("../.env", import.meta.url)) });
const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

// ============================================
// AUTH MIDDLEWARE
// ============================================

async function requireAuth(req, res, next) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  
  if (!token) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const { data, error } = await sbAdmin.auth.getUser(token);
  
  if (error || !data?.user) {
    return res.status(401).json({ ok: false, error: "Invalid token" });
  }

  req.user = data.user;
  next();
}

function isValidUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || "").trim());
}

function cleanUuidArray(values) {
  return Array.isArray(values) ? values.map(value => String(value || "").trim()).filter(isValidUuid) : [];
}

function getSourceExamTypes(input = {}) {
  const allowedTypes = new Set(["previous_exam", "practice_test", "mock_exam", "quiz"]);
  if (Array.isArray(input.examTypes)) {
    const types = input.examTypes.map(type => String(type || "").trim()).filter(type => allowedTypes.has(type));
    if (types.length) return types;
  }

  const examType = String(input.examType || "").trim();
  if (allowedTypes.has(examType)) return [examType];

  const studyMode = String(input.studyMode || input.mode || "").toLowerCase().trim();
  if (studyMode === "test") return ["practice_test"];
  if (studyMode === "quiz") return ["quiz"];
  if (studyMode === "exam") return ["previous_exam"];
  return ["previous_exam"];
}

function getStudyModeLabel(sourceExamTypes) {
  if (sourceExamTypes.includes("practice_test")) return "test";
  if (sourceExamTypes.includes("quiz")) return "quiz";
  return "exam";
}

function adaptSavedQuestionForPrediction(row) {
  return {
    id: row.id,
    question_text: row.question_text,
    text: row.question_text,
    question_type: row.question_type,
    type: row.question_type,
    options: row.options,
    correct_answer: row.correct_answer,
    term: row.term,
    definition: row.definition,
    explanation: row.explanation,
    marks: row.marks || 1,
    difficulty_level: row.difficulty_level,
    difficulty: row.difficulty_level,
    topic_tags: row.topic_tags || [],
    chapter_id: row.chapter_id,
    prediction_reason: row.explanation || `Saved ${row.source || "question-bank"} question retrieved randomly from the database.`,
    source: row.source || "database"
  };
}

function normalizeStudyQuestionType(type) {
  const value = String(type || "").trim().toLowerCase();
  if (value === "mcq") return "multiple_choice";
  if (value === "truefalse") return "true_false";
  if (value === "short_answer") return "short_question";
  if (value === "essay" || value === "practical" || value === "calculation") return "long_question";
  return value || "short_question";
}

function optionsToArray(options) {
  if (Array.isArray(options)) return options.map(String).filter(Boolean);
  if (options && typeof options === "object") return Object.values(options).map(String).filter(Boolean);
  return [];
}

async function saveMockPredictionsToStudyBank({ module, predictions }) {
  if (!module?.id || !Array.isArray(predictions) || !predictions.length) return 0;

  const rows = predictions.map(question => {
    const options = optionsToArray(question.options);
    const correctAnswer = question.correct_answer || question.suggested_answer || question.answer || options[0] || "Review the chapter";
    return {
      course_id: module.course_id || null,
      module_id: module.id,
      chapter_id: question.chapter_id || null,
      source: "mock_predicted",
      question_type: normalizeStudyQuestionType(question.question_type || question.type),
      question_text: question.question_text || question.text || "Predicted question",
      correct_answer: String(correctAnswer),
      options,
      missing_word: question.missing_word || null,
      term: question.term || null,
      definition: question.definition || null,
      explanation: question.explanation || question.prediction_reason || null,
      marks: Number(question.marks) || 1,
      difficulty_level: question.difficulty_level || question.difficulty || "medium",
      topic_tags: question.topic_tags || [],
      keywords: question.keywords || [],
      bloom_level: question.bloom_level || null,
      quality_score: 0.8,
      ai_confidence: 0.75
    };
  });

  const { error } = await sbAdmin.from("study_question_bank").insert(rows);
  if (error) {
    console.warn("Could not save mock predictions to study_question_bank:", error.message);
    return 0;
  }
  return rows.length;
}

async function getSavedExamPredictionQuestions({ moduleId, chapterIds, count }) {
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
    .limit(200);

  const { data, error } = await query;
  if (error) {
    console.warn("Saved exam predictor lookup failed:", error.message);
    return [];
  }

  return [...(data || [])]
    .sort(() => Math.random() - 0.5)
    .slice(0, count)
    .map(adaptSavedQuestionForPrediction);
}

async function getRecentPredictedExamQuestions({ moduleId, chapterIds, count }) {
  const { data: exams, error: examError } = await sbAdmin
    .from("predicted_exams")
    .select("id")
    .eq("module_id", moduleId)
    .order("created_at", { ascending: false })
    .limit(8);

  if (examError || !exams?.length) {
    if (examError) console.warn("Predicted exam lookup failed:", examError.message);
    return [];
  }

  let query = sbAdmin
    .from("predicted_exam_questions")
    .select("*")
    .in("predicted_exam_id", exams.map(exam => exam.id))
    .limit(Math.max(count * 3, 30));

  if (chapterIds?.length) {
    query = query.or(`chapter_id.in.(${chapterIds.join(",")}),chapter_id.is.null`);
  }

  const { data, error } = await query;
  if (error) {
    console.warn("Predicted exam question lookup failed:", error.message);
    return [];
  }

  return [...(data || [])]
    .sort(() => Math.random() - 0.5)
    .slice(0, count)
    .map(row => ({
      id: row.id,
      question_text: row.question_text,
      text: row.question_text,
      question_type: row.question_type,
      type: row.question_type,
      options: row.options || [],
      correct_answer: row.correct_answer,
      marks: row.marks || 1,
      difficulty_level: row.difficulty_level || "medium",
      difficulty: row.difficulty_level || "medium",
      topic_tags: row.topic_tags || [],
      chapter_id: row.chapter_id || null,
      explanation: row.explanation || "Question reused from a previous predicted mock paper.",
      prediction_reason: row.explanation || "Question reused from a previous predicted mock paper.",
      source: "predicted_exam_questions"
    }));
}

// ============================================
// GENERATE COMPLETE MOCK EXAM PAPER
// ============================================

router.post("/api/exam/study-guide", requireAuth, async (req, res) => {
  try {
    const moduleId = String(req.body.moduleId || "").trim();
    const chapterIds = cleanUuidArray(req.body.chapterIds);
    const sourceExamTypes = getSourceExamTypes(req.body);
    const studyModeLabel = getStudyModeLabel(sourceExamTypes);

    if (!isValidUuid(moduleId) || chapterIds.length === 0) {
      return res.status(400).json({ ok: false, error: "A valid moduleId and at least one valid chapterId are required" });
    }

    const [moduleResult, chaptersResult, guidesResult, savedResult, examsResult, pastQuestionsResult] = await Promise.all([
      sbAdmin
        .from("modules")
        .select("id, name, code, course_id, courses (code, name)")
        .eq("id", moduleId)
        .single(),
      sbAdmin
        .from("chapters")
        .select("id, chapter_number, chapter_title")
        .in("id", chapterIds)
        .order("chapter_number", { ascending: true }),
      sbAdmin
        .from("chapter_study_guides")
        .select("chapter_id, title, guide_text, summary, key_concepts, study_questions, updated_at")
        .in("chapter_id", chapterIds),
      sbAdmin
        .from("study_question_bank")
        .select("*")
        .eq("module_id", moduleId)
        .eq("is_active", true)
        .or(`chapter_id.in.(${chapterIds.join(",")}),chapter_id.is.null`)
        .limit(80),
      sbAdmin
        .from("exams")
        .select("id, title, description, year, term, duration_minutes, total_marks, exam_type")
        .eq("module_id", moduleId)
        .in("exam_type", sourceExamTypes)
        .order("year", { ascending: false }),
      sbAdmin
        .from("exam_question_bank")
        .select("id, exam_id, chapter_id, question_text, question_type, marks, difficulty_level, topic_tags, explanation")
        .eq("module_id", moduleId)
        .limit(300)
    ]);

    if (moduleResult.error) throw moduleResult.error;
    if (chaptersResult.error) throw chaptersResult.error;
    if (guidesResult.error) console.warn("Chapter study guide lookup skipped:", guidesResult.error.message);
    if (savedResult.error) console.warn("Study question bank lookup skipped:", savedResult.error.message);
    if (examsResult.error) console.warn("Exam lookup skipped:", examsResult.error.message);
    if (pastQuestionsResult.error) console.warn("Past question lookup skipped:", pastQuestionsResult.error.message);

    const module = moduleResult.data;
    const chapters = chaptersResult.data || [];
    const guides = guidesResult.data || [];
    const savedQuestions = savedResult.data || [];
    const exams = examsResult.data || [];
    const sourceExamIds = new Set(exams.map(exam => exam.id));
    const pastQuestions = (pastQuestionsResult.data || []).filter(q => !q.exam_id || sourceExamIds.has(q.exam_id));
    const chapterSet = new Set(chapterIds);
    const scopedPastQuestions = pastQuestions.filter(q => !q.chapter_id || chapterSet.has(q.chapter_id));
    const patternAnalysis = analyzeCompleteExamPattern(exams, scopedPastQuestions.length ? scopedPastQuestions : pastQuestions, chapters);
    const guideByChapter = new Map(guides.map(guide => [guide.chapter_id, guide]));
    const predictedQuestions = [
      ...savedQuestions.map(adaptSavedQuestionForPrediction),
      ...(scopedPastQuestions.length ? scopedPastQuestions : pastQuestions).slice(0, 20).map(q => ({
        question_text: q.question_text,
        question_type: q.question_type,
        marks: q.marks || 1,
        difficulty: q.difficulty_level || "medium",
        topic_tags: q.topic_tags || [],
        prediction_reason: q.explanation || `Seen in past ${studyModeLabel} material.`
      }))
    ].slice(0, 30);

    const guideMarkdown = buildExamStudyGuideMarkdown({
      module,
      chapters,
      guideByChapter,
      predictedQuestions,
      patternAnalysis,
      studyModeLabel,
      exams
    });

    res.json({
      ok: true,
      study_guide: guideMarkdown,
      predictions: predictedQuestions,
      pattern_analysis: patternAnalysis,
      cached_chapter_guides: guides.length,
      missing_chapter_guides: chapters.length - guides.length,
      source: "chapter_study_guides+question_banks"
    });
  } catch (error) {
    console.error("Error generating exam/test study guide:", error);
    res.status(500).json({ ok: false, error: error.message || "Study guide generation failed" });
  }
});

router.post("/api/exam/predict-questions", requireAuth, async (req, res, next) => {
  try {
    const moduleId = String(req.body.moduleId || "").trim();
    const chapterIds = cleanUuidArray(req.body.chapterIds);
    const requestedCount = Math.max(1, Math.min(Number(req.body.count || req.body.questionCount || 20) || 20, 100));

    if (!isValidUuid(moduleId) || chapterIds.length === 0) return next();

    const [savedQuestions, recentPredictedQuestions] = await Promise.all([
      getSavedExamPredictionQuestions({
        moduleId,
        chapterIds,
        count: requestedCount
      }),
      getRecentPredictedExamQuestions({
        moduleId,
        chapterIds,
        count: requestedCount
      })
    ]);
    const combinedQuestions = [...recentPredictedQuestions, ...savedQuestions]
      .filter((question, index, all) => all.findIndex(item => normalizeQuestionTextKey(item.question_text || item.text) === normalizeQuestionTextKey(question.question_text || question.text)) === index)
      .slice(0, requestedCount);

    if (combinedQuestions.length < Math.min(requestedCount, 5)) return next();

    const paper = normalizeCompleteExamPaper({
      exam_title: "Saved Mock Question Paper",
      instructions: "Questions were retrieved from previous predicted papers and the saved study question bank.",
      sections: [{
        section_id: "A",
        title: "Predicted Questions",
        instructions: "Answer all questions.",
        total_marks: combinedQuestions.reduce((sum, q) => sum + (Number(q.marks) || 1), 0),
        questions: combinedQuestions
      }]
    }, { name: "Selected Module", code: "" }, {
      ...defaultPatternAnalysis(),
      section_structure: [{
        section_id: "A",
        title: "Predicted Questions",
        question_type: "short_answer",
        question_count: combinedQuestions.length,
        marks_per_question: 1,
        total_marks: combinedQuestions.length
      }]
    });

    return res.json({
      ok: true,
      exam_paper: paper,
      predictions: flattenExamPaperQuestions(paper),
      pattern_analysis: defaultPatternAnalysis(),
      predicted_exam_id: null,
      total_generated: countExamPaperQuestions(paper),
      model_used: null,
      source: "database",
      quality: {
        acceptable: true,
        expected_total: requestedCount,
        actual_total: countExamPaperQuestions(paper),
        issues: []
      },
      diagnostics: [{ stage: "database_lookup", study_bank: savedQuestions.length, predicted_exam_questions: recentPredictedQuestions.length }]
    });
  } catch (error) {
    console.warn("Saved exam predictor lookup skipped:", error.message);
    return next();
  }
});

router.post("/api/exam/predict-questions", requireAuth, async (req, res) => {
  const { examDate = null, intensity = "moderate" } = req.body;
  const moduleId = String(req.body.moduleId || "").trim();
  const chapterIds = cleanUuidArray(req.body.chapterIds);
  const sourceExamTypes = getSourceExamTypes(req.body);
  const studyModeLabel = getStudyModeLabel(sourceExamTypes);

  try {
    if (!isValidUuid(moduleId) || chapterIds.length === 0) {
      return res.status(400).json({ ok: false, error: "A valid moduleId and at least one valid chapterId are required" });
    }

    const [moduleResult, examsResult, questionsResult, chaptersResult] = await Promise.all([
      sbAdmin
        .from("modules")
        .select("id, name, code, course_id, courses (code, name)")
        .eq("id", moduleId)
        .single(),
      sbAdmin
        .from("exams")
        .select("id, title, description, year, term, duration_minutes, total_marks, file_url, exam_type")
        .eq("module_id", moduleId)
        .in("exam_type", sourceExamTypes)
        .order("year", { ascending: false }),
      sbAdmin
        .from("exam_question_bank")
        .select("id, exam_id, chapter_id, question_text, question_type, options, correct_answer, marks, difficulty_level, topic_tags, bloom_taxonomy_level, explanation")
        .eq("module_id", moduleId)
        .limit(500),
      sbAdmin
        .from("chapters")
        .select("id, chapter_number, chapter_title")
        .in("id", chapterIds)
        .order("chapter_number", { ascending: true })
    ]);

    if (moduleResult.error) throw moduleResult.error;
    if (examsResult.error) throw examsResult.error;
    if (questionsResult.error) throw questionsResult.error;
    if (chaptersResult.error) throw chaptersResult.error;

    const module = moduleResult.data;
    const pastExams = examsResult.data || [];
    const pastQuestions = questionsResult.data || [];
    const selectedChapters = chaptersResult.data || [];
    const sourceExamIds = new Set(pastExams.map(exam => exam.id));
    const sourceQuestions = pastQuestions.filter(q => !q.exam_id || sourceExamIds.has(q.exam_id));
    const selectedChapterSet = new Set(chapterIds);
    const selectedQuestions = sourceQuestions.filter(q => !q.chapter_id || selectedChapterSet.has(q.chapter_id));
    const [savedStudyQuestions, recentPredictedQuestions] = await Promise.all([
      getSavedExamPredictionQuestions({ moduleId, chapterIds, count: 80 }),
      getRecentPredictedExamQuestions({ moduleId, chapterIds, count: 80 })
    ]);
    const intelligenceQuestions = [
      ...selectedQuestions,
      ...recentPredictedQuestions,
      ...savedStudyQuestions,
      ...sourceQuestions
    ].filter((question, index, all) => {
      const key = normalizeQuestionTextKey(question.question_text || question.text);
      return key && all.findIndex(item => normalizeQuestionTextKey(item.question_text || item.text) === key) === index;
    });
    const patternAnalysis = analyzeCompleteExamPattern(pastExams, selectedQuestions.length ? selectedQuestions : sourceQuestions, selectedChapters);
    const chapterContent = await loadChapterContext(selectedChapters);

    let examPaper = generateFallbackExamPaper(module, selectedChapters, patternAnalysis);
    let source = "fallback";
    let modelUsed = null;
    let generationDiagnostics = [];
    try {
      const aiResult = await generateChunkedExamPaper({
        module,
        pastExams,
        pastQuestions: intelligenceQuestions.length ? intelligenceQuestions : (selectedQuestions.length ? selectedQuestions : sourceQuestions),
        selectedChapters,
        chapterContent,
        patternAnalysis,
        studyModeLabel
      });
      examPaper = aiResult.examPaper;
      source = aiResult.source;
      modelUsed = aiResult.models;
      generationDiagnostics = aiResult.diagnostics;
    } catch (aiError) {
      console.error("Chunked AI generation failed; using fallback exam paper:", aiError.message);
      generationDiagnostics.push({ stage: "chunked_generation", error: aiError.message });
    }

    examPaper = normalizeCompleteExamPaper(examPaper, module, patternAnalysis);
    const predictions = flattenExamPaperQuestions(examPaper);
    const predictedExamId = await savePredictedExam({
      userId: req.user.id,
      moduleId,
      examDate,
      intensity,
      chapterIds,
      examPaper,
      patternAnalysis,
      predictions
    });
    const savedToQuestionBank = await saveMockPredictionsToStudyBank({ module, predictions });

    res.json({
      ok: true,
      exam_paper: examPaper,
      predictions,
      pattern_analysis: patternAnalysis,
      predicted_exam_id: predictedExamId,
      total_generated: predictions.length,
      model_used: modelUsed,
      source,
      saved_to_question_bank: savedToQuestionBank,
      quality: inspectExamPaperQuality(examPaper, patternAnalysis),
      diagnostics: generationDiagnostics
    });
  } catch (error) {
    console.error("Error generating complete exam paper:", error);

    try {
      const { data: chapters } = await sbAdmin
        .from("chapters")
        .select("id, chapter_number, chapter_title")
        .in("id", chapterIds);
      const fallbackPaper = generateFallbackExamPaper({ name: "Selected Module", code: "" }, chapters || [], defaultPatternAnalysis());
      return res.json({
        ok: true,
        exam_paper: fallbackPaper,
        predictions: flattenExamPaperQuestions(fallbackPaper),
        pattern_analysis: defaultPatternAnalysis(),
        source: "fallback",
        error: error.message
      });
    } catch {
      return res.status(500).json({ ok: false, error: error.message });
    }
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function defaultPatternAnalysis() {
  return {
    total_papers_analyzed: 0,
    question_type_distribution: { multiple_choice: 0.3, short_answer: 0.4, essay: 0.3 },
    section_structure: [
      { section_id: "A", title: "Multiple Choice Questions", question_type: "multiple_choice", question_count: 10, marks_per_question: 2, total_marks: 20 },
      { section_id: "B", title: "Short Answer Questions", question_type: "short_answer", question_count: 6, marks_per_question: 5, total_marks: 30 },
      { section_id: "C", title: "Essay Questions", question_type: "essay", question_count: 2, marks_per_question: 25, total_marks: 50 }
    ],
    average_total_marks: 100,
    average_duration: 180,
    difficulty_distribution: { easy: 0.3, medium: 0.5, hard: 0.2 },
    bloom_distribution: { remember: 0.2, understand: 0.25, apply: 0.25, analyze: 0.2, evaluate: 0.1 },
    marking_patterns: { multiple_choice: [2], short_answer: [5], essay: [25] },
    common_instructions: "Answer ALL questions. Marks are indicated in brackets. Show all working where applicable.",
    recurring_elements: []
  };
}

function buildExamStudyGuideMarkdown({ module, chapters, guideByChapter, predictedQuestions, patternAnalysis, studyModeLabel, exams }) {
  const modeTitle = studyModeLabel === "test" ? "Test" : "Exam";
  const moduleTitle = [module?.code, module?.name].filter(Boolean).join(" - ") || "Selected Module";
  const questionExamples = (predictedQuestions || []).slice(0, 12);
  const topicCounts = {};

  for (const question of questionExamples) {
    for (const topic of question.topic_tags || []) {
      topicCounts[topic] = (topicCounts[topic] || 0) + 1;
    }
  }

  const topTopics = Object.entries({
    ...(patternAnalysis?.topic_frequency || {}),
    ...topicCounts
  })
    .sort((a, b) => b[1] - a[1])
    .slice(0, 10)
    .map(([topic]) => topic);

  let markdown = `# ${modeTitle} Study Guide\n\n`;
  markdown += `## Module\n${moduleTitle}\n\n`;
  markdown += `## Scope\n`;
  for (const chapter of chapters || []) {
    markdown += `- Chapter ${chapter.chapter_number || ""}: ${chapter.chapter_title || "Untitled chapter"}\n`;
  }
  markdown += `\n`;

  markdown += `## How to Study This Scope\n`;
  markdown += `- Start with the chapter summaries below, then test yourself using the predicted questions.\n`;
  markdown += `- Prioritize topics that appear in past ${studyModeLabel} questions and saved question banks.\n`;
  markdown += `- Use the Mock Paper tab only after reviewing the guide once.\n\n`;

  markdown += `## Chapter Study Guide Summary\n`;
  for (const chapter of chapters || []) {
    const guide = guideByChapter.get(chapter.id);
    markdown += `\n### Chapter ${chapter.chapter_number || ""}: ${chapter.chapter_title || "Untitled chapter"}\n`;
    if (guide?.summary) {
      markdown += `${guide.summary}\n`;
    } else if (guide?.guide_text) {
      markdown += `${String(guide.guide_text).split("\n").filter(Boolean).slice(0, 4).join("\n")}\n`;
    } else {
      markdown += `No saved chapter study guide exists yet. Generate the Chapter Study Guide for this chapter to improve this section.\n`;
    }
    if (guide?.key_concepts?.length) {
      markdown += `\nKey concepts:\n`;
      for (const concept of guide.key_concepts.slice(0, 8)) markdown += `- ${concept}\n`;
    }
  }

  markdown += `\n## High-Probability Topics\n`;
  if (topTopics.length) {
    for (const topic of topTopics) markdown += `- ${topic}\n`;
  } else {
    markdown += `- Review all selected chapter headings and key concepts.\n`;
  }

  markdown += `\n## Predicted Questions to Practise\n`;
  if (questionExamples.length) {
    questionExamples.forEach((question, index) => {
      markdown += `${index + 1}. ${question.question_text || question.text || "Practice question"}\n`;
      markdown += `   - Type: ${normalizeQuestionType(question.question_type || question.type)}; Marks: ${question.marks || 1}; Difficulty: ${question.difficulty || question.difficulty_level || "medium"}\n`;
    });
  } else {
    markdown += `No saved question-bank or past-paper questions were found yet. Generate chapter questions or upload past papers to improve predictions.\n`;
  }

  markdown += `\n## Past ${modeTitle} Pattern\n`;
  markdown += `- Past papers analyzed: ${patternAnalysis?.total_papers_analyzed || exams?.length || 0}\n`;
  markdown += `- Typical duration: ${patternAnalysis?.average_duration || "N/A"} minutes\n`;
  markdown += `- Typical total: ${patternAnalysis?.average_total_marks || "N/A"} marks\n`;
  markdown += `- Common instruction pattern: ${patternAnalysis?.common_instructions || "Answer all questions and show working where required."}\n`;

  markdown += `\n## Final Revision Checklist\n`;
  markdown += `- Explain every selected chapter summary without reading it.\n`;
  markdown += `- Answer the predicted questions under timed conditions.\n`;
  markdown += `- Open the Past Papers tab and compare question wording.\n`;
  markdown += `- Generate a mock paper only when you are ready to practise the full assessment.\n`;

  return markdown;
}

function getConfiguredProviders() {
  const preferred = String(process.env.AI_PROVIDER || "openrouter").toLowerCase().trim();
  const freeFirst = ["openrouter", "groq", "huggingface"];
  const providers = preferred === "openai"
    ? ["openai", ...freeFirst]
    : [preferred, ...freeFirst];
  return [...new Set(providers)].filter(provider => provider && provider !== "none");
}

function getProviderConfig(provider) {
  if (provider === "openrouter") {
    return {
      provider,
      apiKey: process.env.OPENROUTER_API_KEY,
      model: process.env.OPENROUTER_MODEL || "deepseek/deepseek-chat",
      url: "https://openrouter.ai/api/v1/chat/completions",
      tokenParam: "max_tokens",
      supportsJsonMode: true,
      headers: {
        "HTTP-Referer": process.env.APP_URL || "http://localhost:5050",
        "X-Title": "SkillFind AI Exam Study"
      }
    };
  }

  if (provider === "groq") {
    return {
      provider,
      apiKey: process.env.GROQ_API_KEY,
      model: process.env.GROQ_MODEL || "llama-3.1-8b-instant",
      url: "https://api.groq.com/openai/v1/chat/completions",
      tokenParam: "max_tokens",
      supportsJsonMode: true,
      headers: {}
    };
  }

  if (provider === "huggingface") {
    return {
      provider,
      apiKey: process.env.HF_TOKEN,
      model: process.env.HF_MODEL || "meta-llama/Llama-3.1-8B-Instruct",
      url: "https://router.huggingface.co/v1/chat/completions",
      tokenParam: "max_tokens",
      supportsJsonMode: false,
      headers: {}
    };
  }

  if (provider === "openai") {
    const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
    return {
      provider,
      apiKey: process.env.OPENAI_API_KEY,
      model,
      url: "https://api.openai.com/v1/chat/completions",
      tokenParam: usesMaxCompletionTokens(model) ? "max_completion_tokens" : "max_tokens",
      supportsJsonMode: true,
      headers: {}
    };
  }

  return null;
}

function usesMaxCompletionTokens(model) {
  const normalized = String(model || "").toLowerCase();
  return normalized.startsWith("gpt-5") || normalized.startsWith("o1") || normalized.startsWith("o3") || normalized.startsWith("o4");
}

async function generateExamPaperWithProviders(prompt, patternAnalysis) {
  const providers = getConfiguredProviders();
  const errors = [];

  for (const provider of providers) {
    const config = getProviderConfig(provider);
    if (!config?.apiKey) {
      errors.push(`${provider}: missing API key`);
      continue;
    }

    try {
      const content = await callChatCompletion(config, prompt);
      const examPaper = parseJsonObject(content);
      const quality = inspectExamPaperQuality(examPaper, patternAnalysis);
      if (!quality.acceptable) {
        throw new Error(`Rejected incomplete paper: ${quality.issues.join("; ")}`);
      }
      return {
        provider,
        model: config.model,
        examPaper
      };
    } catch (error) {
      errors.push(`${provider}: ${error.message}`);
      console.error(`AI provider failed (${provider}/${config.model}):`, error.message);
    }
  }

  throw new Error(errors.join(" | ") || "No AI providers configured");
}

async function callChatCompletion(config, prompt, options = {}) {
  const messages = [
    {
      role: "system",
      content: options.system || "You generate complete academic mock exam papers. Return only valid JSON matching the requested schema. Do not copy past questions verbatim."
    },
    { role: "user", content: prompt }
  ];

  const body = {
    model: config.model,
    messages,
    temperature: options.temperature ?? 0.65,
    [config.tokenParam]: options.maxTokens || Number(process.env.AI_MAX_TOKENS) || 12000
  };

  if (config.supportsJsonMode) {
    body.response_format = { type: "json_object" };
  } else {
    messages[0].content += " Do not use Markdown fences or commentary.";
  }

  let response = await fetch(config.url, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${config.apiKey}`,
      "Content-Type": "application/json",
      ...config.headers
    },
    body: JSON.stringify(body)
  });

  let data = await response.json().catch(() => ({}));

  if (!response.ok && body.response_format && isUnsupportedJsonModeError(data)) {
    delete body.response_format;
    messages[0].content += " Do not use Markdown fences or commentary.";
    response = await fetch(config.url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${config.apiKey}`,
        "Content-Type": "application/json",
        ...config.headers
      },
      body: JSON.stringify(body)
    });
    data = await response.json().catch(() => ({}));
  }

  if (!response.ok) {
    throw new Error(data?.error?.message || data?.message || `HTTP ${response.status}`);
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content) {
    throw new Error("Provider returned an empty response");
  }

  return content;
}

function isUnsupportedJsonModeError(data) {
  const message = String(data?.error?.message || data?.message || "").toLowerCase();
  return message.includes("response_format") || message.includes("json mode") || message.includes("unsupported");
}

function parseJsonObject(text) {
  try {
    return JSON.parse(text);
  } catch {
    const cleaned = String(text || "")
      .replace(/^```(?:json)?/i, "")
      .replace(/```$/i, "")
      .trim();
    try {
      return JSON.parse(cleaned);
    } catch {
      const start = cleaned.indexOf("{");
      const end = cleaned.lastIndexOf("}");
      if (start !== -1 && end !== -1 && end > start) {
        return JSON.parse(cleaned.slice(start, end + 1));
      }
      throw new Error("Provider did not return valid JSON");
    }
  }
}

function expectedQuestionCount(patternAnalysis) {
  return (patternAnalysis?.section_structure || [])
    .reduce((sum, section) => sum + (Number(section.question_count) || 0), 0);
}

function countExamPaperQuestions(examPaper) {
  return (examPaper?.sections || [])
    .reduce((sum, section) => sum + (Array.isArray(section.questions) ? section.questions.length : 0), 0);
}

function inspectExamPaperQuality(examPaper, patternAnalysis) {
  const issues = [];
  const expectedTotal = expectedQuestionCount(patternAnalysis);
  const actualTotal = countExamPaperQuestions(examPaper);

  if (!examPaper || typeof examPaper !== "object") {
    return { acceptable: false, expected_total: expectedTotal, actual_total: 0, issues: ["Provider did not return an exam paper object"] };
  }

  if (expectedTotal && actualTotal < expectedTotal) {
    issues.push(`expected ${expectedTotal} questions but got ${actualTotal}`);
  }

  const expectedSections = patternAnalysis?.section_structure || [];
  for (let i = 0; i < expectedSections.length; i += 1) {
    const expectedSection = expectedSections[i];
    const section = (examPaper.sections || []).find(item => String(item.section_id) === String(expectedSection.section_id))
      || (examPaper.sections || [])[i];
    const actualCount = Array.isArray(section?.questions) ? section.questions.length : 0;
    const expectedCount = Number(expectedSection.question_count) || 0;
    if (expectedCount && actualCount < expectedCount) {
      issues.push(`section ${expectedSection.section_id || i + 1} expected ${expectedCount} questions but got ${actualCount}`);
    }
  }

  const seen = new Set();
  let duplicateCount = 0;
  for (const section of examPaper.sections || []) {
    for (const question of section.questions || []) {
      const key = normalizeQuestionTextKey(question.text || question.question_text);
      if (!key) continue;
      if (seen.has(key)) duplicateCount += 1;
      seen.add(key);
    }
  }
  if (duplicateCount) issues.push(`${duplicateCount} duplicate question text entries`);

  const answerKey = examPaper.answer_key && typeof examPaper.answer_key === "object" && !Array.isArray(examPaper.answer_key)
    ? examPaper.answer_key
    : {};
  if (actualTotal && Object.keys(answerKey).length > 0 && Object.keys(answerKey).length < Math.ceil(actualTotal * 0.6)) {
    issues.push(`answer key only covers ${Object.keys(answerKey).length} of ${actualTotal} questions`);
  }

  return {
    acceptable: issues.length === 0,
    expected_total: expectedTotal,
    actual_total: actualTotal,
    issues
  };
}

async function generateChunkedExamPaper({ module, pastExams, pastQuestions, selectedChapters, chapterContent, patternAnalysis, studyModeLabel }) {
  const sections = [];
  const diagnostics = [];
  const usedModels = new Set();
  let aiQuestionCount = 0;
  let repairedQuestionCount = 0;

  for (const [sectionIndex, sectionPattern] of (patternAnalysis.section_structure || defaultPatternAnalysis().section_structure).entries()) {
    const blueprints = buildSectionBlueprint(sectionPattern, selectedChapters, patternAnalysis);
    const sectionQuestions = [];
    const usedTexts = new Set();
    const batchSize = getBatchSize(sectionPattern.question_type);

    for (let start = 0; start < blueprints.length; start += batchSize) {
      const batchBlueprint = blueprints.slice(start, start + batchSize);
      const batchResult = await generateQuestionBatch({
        module,
        sectionPattern,
        batchBlueprint,
        pastQuestions,
        chapterContent,
        usedTexts,
        studyModeLabel
      });

      diagnostics.push(...batchResult.diagnostics);
      for (const model of batchResult.models) usedModels.add(model);
      aiQuestionCount += batchResult.questions.length;
      sectionQuestions.push(...batchResult.questions);

      while (sectionQuestions.length < start + batchBlueprint.length) {
        const blueprint = blueprints[sectionQuestions.length];
        const fallbackQuestion = createFallbackQuestion(
          {
            question_type: blueprint.type,
            marks_per_question: blueprint.marks
          },
          sectionQuestions.length + 1,
          {
            id: blueprint.chapter_id,
            chapter_title: blueprint.topic
          }
        );
        fallbackQuestion.text = ensureUniqueQuestionText(
          fallbackQuestion.text,
          fallbackQuestion.type,
          sectionQuestions.length + 1,
          { id: blueprint.chapter_id, chapter_title: blueprint.topic },
          usedTexts
        );
        sectionQuestions.push(fallbackQuestion);
        repairedQuestionCount += 1;
      }
    }

    sections.push({
      section_id: sectionPattern.section_id || "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[sectionIndex],
      title: sectionPattern.title || `Section ${sectionIndex + 1}`,
      instructions: sectionPattern.instructions || sectionInstructions(sectionPattern.question_type, sectionQuestions.length, sectionPattern.marks_per_question),
      total_marks: sectionQuestions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0),
      questions: sectionQuestions
    });
  }

  const totalMarks = sections.reduce((sum, section) => sum + section.total_marks, 0);
  const examPaper = {
    exam_title: `${module?.name || "Selected Module"} - AI Predicted Mock ${studyModeLabel === "test" ? "Test" : "Exam"} Paper`,
    course_code: module?.courses?.code || "",
    module_code: module?.code || "",
    duration_minutes: patternAnalysis.average_duration || 180,
    total_marks: totalMarks || patternAnalysis.average_total_marks || 100,
    instructions: [
      patternAnalysis.common_instructions || "Answer ALL questions. Marks are indicated in brackets.",
      "This paper was generated in batches from topic analysis, past-paper structure, and selected chapter content."
    ],
    student_fields: ["Student name", "Student number", "Date"],
    cover_page_note: "Use this AI predicted paper for timed preparation.",
    sections,
    answer_key: buildAnswerKey(sections),
    pattern_summary: patternAnalysis,
    end_marker: "END OF PAPER"
  };

  const quality = inspectExamPaperQuality(examPaper, patternAnalysis);
  if (!quality.acceptable) {
    diagnostics.push({ stage: "final_validation", issues: quality.issues });
  }

  return {
    examPaper,
    source: aiQuestionCount > 0 ? (repairedQuestionCount > 0 ? "chunked-ai+repair" : "chunked-ai") : "fallback",
    models: [...usedModels],
    diagnostics: [
      ...diagnostics,
      {
        stage: "summary",
        ai_questions: aiQuestionCount,
        repaired_questions: repairedQuestionCount,
        expected_questions: expectedQuestionCount(patternAnalysis),
        actual_questions: countExamPaperQuestions(examPaper)
      }
    ]
  };
}

function buildSectionBlueprint(sectionPattern, selectedChapters, patternAnalysis) {
  const chapters = selectedChapters?.length
    ? selectedChapters
    : (patternAnalysis.selected_chapters || []).map(chapter => ({
      id: chapter.id,
      chapter_title: chapter.title || chapter.chapter_title || `Chapter ${chapter.number || ""}`
    }));
  const topicNames = getTopicNames(chapters, patternAnalysis);
  const count = Math.max(Number(sectionPattern.question_count) || 1, 1);
  const marks = Number(sectionPattern.marks_per_question) || 1;
  const type = normalizeQuestionType(sectionPattern.question_type);
  const bloomLevels = ["remember", "understand", "apply", "analyze", "evaluate", "create"];
  const difficulties = ["easy", "medium", "medium", "hard"];

  return Array.from({ length: count }, (_, index) => {
    const chapter = chapters[index % Math.max(chapters.length, 1)] || {};
    const topic = chapter.chapter_title || chapter.title || topicNames[index % Math.max(topicNames.length, 1)] || "selected course content";
    return {
      number: String(index + 1),
      type,
      marks,
      topic,
      chapter_id: chapter.id || null,
      difficulty: difficulties[index % difficulties.length],
      bloom_level: bloomLevels[index % bloomLevels.length]
    };
  });
}

function getTopicNames(chapters, patternAnalysis) {
  const names = [];
  for (const chapter of chapters || []) {
    const title = chapter.chapter_title || chapter.title;
    if (title) names.push(title);
  }
  const frequentTopics = Object.entries(patternAnalysis.topic_frequency || {})
    .sort((a, b) => b[1] - a[1])
    .map(([topic]) => topic)
    .filter(Boolean);
  return [...new Set([...names, ...frequentTopics])];
}

function getBatchSize(questionType) {
  const type = normalizeQuestionType(questionType);
  if (type === "multiple_choice" || type === "true_false") return 8;
  if (type === "essay" || type === "case_study") return 2;
  return 4;
}

async function generateQuestionBatch({ module, sectionPattern, batchBlueprint, pastQuestions, chapterContent, usedTexts, studyModeLabel }) {
  const providers = getConfiguredProviders();
  const diagnostics = [];
  const models = [];
  const type = normalizeQuestionType(sectionPattern.question_type);
  const examples = compactQuestionExamples(pastQuestions, type);
  const prompt = buildQuestionBatchPrompt({
    module,
    sectionPattern,
    batchBlueprint,
    examples,
    chapterContent,
    usedTexts,
    studyModeLabel
  });

  for (const provider of providers) {
    const config = getProviderConfig(provider);
    if (!config?.apiKey) {
      diagnostics.push({ stage: "batch", provider, status: "skipped", reason: "missing API key" });
      continue;
    }

    try {
      const content = await callChatCompletion(config, prompt, {
        maxTokens: getBatchMaxTokens(type, batchBlueprint.length),
        temperature: 0.55,
        system: "You generate one batch of exam questions. Return only valid JSON. Do not include markdown. Do not duplicate provided or already-used questions."
      });
      const parsed = parseJsonObject(content);
      const rawQuestions = Array.isArray(parsed.questions)
        ? parsed.questions
        : Array.isArray(parsed.generated_questions)
          ? parsed.generated_questions
          : [];
      const questions = [];

      for (let i = 0; i < batchBlueprint.length && i < rawQuestions.length; i += 1) {
        const normalized = normalizeGeneratedQuestion(rawQuestions[i], batchBlueprint[i], usedTexts);
        if (normalized) questions.push(normalized);
      }

      if (questions.length) {
        models.push(`${provider}/${config.model}`);
        diagnostics.push({
          stage: "batch",
          provider,
          model: config.model,
          requested: batchBlueprint.length,
          accepted: questions.length
        });
        return { questions, diagnostics, models };
      }

      diagnostics.push({ stage: "batch", provider, model: config.model, requested: batchBlueprint.length, accepted: 0, reason: "no valid questions returned" });
    } catch (error) {
      diagnostics.push({ stage: "batch", provider, model: config?.model, error: error.message });
    }
  }

  return { questions: [], diagnostics, models };
}

function getBatchMaxTokens(type, count) {
  const normalized = normalizeQuestionType(type);
  if (normalized === "multiple_choice") return Math.min(4200, 900 + count * 350);
  if (normalized === "essay" || normalized === "case_study") return Math.min(3600, 900 + count * 700);
  return Math.min(3600, 900 + count * 450);
}

function compactQuestionExamples(pastQuestions, type) {
  const normalizedType = normalizeQuestionType(type);
  return (pastQuestions || [])
    .filter(q => normalizeQuestionType(q.question_type) === normalizedType)
    .slice(0, 5)
    .map(q => ({
      question_type: normalizeQuestionType(q.question_type),
      text: String(q.question_text || "").slice(0, 260),
      options: Array.isArray(q.options) ? q.options.slice(0, 4) : undefined,
      marks: q.marks,
      topics: Array.isArray(q.topic_tags) ? q.topic_tags.slice(0, 3) : []
    }));
}

function buildQuestionBatchPrompt({ module, sectionPattern, batchBlueprint, examples, chapterContent, usedTexts, studyModeLabel }) {
  const compactContext = String(chapterContent || "")
    .replace(/\s+/g, " ")
    .slice(0, 1500);
  const alreadyUsed = [...usedTexts].slice(-16);

  return `
Generate exactly ${batchBlueprint.length} ${normalizeQuestionType(sectionPattern.question_type)} questions for a mock ${studyModeLabel} paper section.

Module: ${module?.code || ""} ${module?.name || ""}
Section: ${sectionPattern.section_id || ""} - ${sectionPattern.title || ""}
Marks per question: ${sectionPattern.marks_per_question || batchBlueprint[0]?.marks || 1}

Blueprint:
${JSON.stringify(batchBlueprint, null, 2)}

Past question style examples, for style only:
${JSON.stringify(examples, null, 2)}

Chapter context summary:
${compactContext || "Use the blueprint topics and past question style examples."}

Already used question text keys to avoid:
${JSON.stringify(alreadyUsed)}

Rules:
- Return exactly ${batchBlueprint.length} questions.
- Do not copy examples or repeat already-used questions.
- Keep each question specific to its blueprint topic.
- MCQ questions must include exactly 4 plausible options and one correct answer letter.
- Short answer and essay questions must include a marking guide in correct_answer.
- Keep output compact.

Return only JSON:
{
  "questions": [
    {
      "number": "1",
      "type": "${normalizeQuestionType(sectionPattern.question_type)}",
      "text": "question text",
      "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
      "marks": ${Number(sectionPattern.marks_per_question) || 1},
      "answer_space": "answer cue",
      "correct_answer": "answer or marking guide",
      "bloom_level": "understand",
      "difficulty_level": "medium",
      "topic_tags": ["topic"],
      "chapter_id": null,
      "explanation": "brief rationale"
    }
  ]
}`;
}

function normalizeGeneratedQuestion(rawQuestion, blueprint, usedTexts) {
  if (!rawQuestion || typeof rawQuestion !== "object") return null;
  const type = normalizeQuestionType(rawQuestion.type || rawQuestion.question_type || blueprint.type);
  const text = formatQuestionText(rawQuestion.text || rawQuestion.question_text || "", type);
  if (!text) return null;

  const key = normalizeQuestionTextKey(text);
  if (!key || usedTexts.has(key)) return null;

  const marks = Number(rawQuestion.marks) || blueprint.marks || 1;
  const question = {
    number: String(blueprint.number),
    type,
    text,
    options: normalizeQuestionOptions(Array.isArray(rawQuestion.options) ? rawQuestion.options.slice(0, 4) : [], type),
    matching_pairs: rawQuestion.matching_pairs || null,
    word_bank: Array.isArray(rawQuestion.word_bank) ? rawQuestion.word_bank : [],
    marks,
    answer_space: rawQuestion.answer_space || defaultAnswerSpace(type, marks),
    correct_answer: rawQuestion.correct_answer || rawQuestion.marking_guidelines || null,
    bloom_level: rawQuestion.bloom_level || rawQuestion.bloom_taxonomy_level || blueprint.bloom_level || "understand",
    difficulty_level: rawQuestion.difficulty_level || rawQuestion.difficulty || blueprint.difficulty || "medium",
    topic_tags: Array.isArray(rawQuestion.topic_tags) && rawQuestion.topic_tags.length ? rawQuestion.topic_tags : [blueprint.topic].filter(Boolean),
    chapter_id: rawQuestion.chapter_id || blueprint.chapter_id || null,
    explanation: rawQuestion.explanation || ""
  };

  if (type === "multiple_choice") {
    if (question.options.length !== 4 || !question.correct_answer) return null;
    question.correct_answer = String(question.correct_answer).trim().charAt(0).toUpperCase();
    if (!["A", "B", "C", "D"].includes(question.correct_answer)) return null;
  }

  if (!question.correct_answer) {
    question.correct_answer = question.explanation || fallbackShortAnswerGuide(Number(blueprint.number) || 1, blueprint.topic);
  }

  usedTexts.add(key);
  return question;
}

function analyzeCompleteExamPattern(pastExams, pastQuestions, chapters) {
  const fallback = defaultPatternAnalysis();
  const questions = pastQuestions || [];
  const exams = pastExams || [];
  const typeCounts = {};
  const typeMarks = {};
  const difficultyCounts = {};
  const bloomCounts = {};
  const topicFrequency = {};

  for (const q of questions) {
    const type = normalizeQuestionType(q.question_type);
    typeCounts[type] = (typeCounts[type] || 0) + 1;
    if (q.marks) {
      if (!typeMarks[type]) typeMarks[type] = [];
      typeMarks[type].push(Number(q.marks));
    }
    if (q.difficulty_level) difficultyCounts[q.difficulty_level] = (difficultyCounts[q.difficulty_level] || 0) + 1;
    if (q.bloom_taxonomy_level) bloomCounts[q.bloom_taxonomy_level] = (bloomCounts[q.bloom_taxonomy_level] || 0) + 1;
    for (const topic of q.topic_tags || []) topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
  }

  const totalQuestions = Math.max(questions.length, 1);
  const questionTypeDistribution = Object.keys(typeCounts).length
    ? Object.fromEntries(Object.entries(typeCounts).map(([type, count]) => [type, Number((count / totalQuestions).toFixed(3))]))
    : fallback.question_type_distribution;

  const markingPatterns = Object.keys(typeMarks).length
    ? Object.fromEntries(Object.entries(typeMarks).map(([type, marks]) => [type, [...new Set(marks)].sort((a, b) => a - b)]))
    : fallback.marking_patterns;

  const averageTotalMarks = averageNumber(exams.map(e => e.total_marks).filter(Boolean)) || estimateTotalMarks(questions) || fallback.average_total_marks;
  const averageDuration = averageNumber(exams.map(e => e.duration_minutes).filter(Boolean)) || fallback.average_duration;
  const sectionStructure = inferSectionStructure(questionTypeDistribution, markingPatterns, averageTotalMarks);

  return {
    total_papers_analyzed: exams.length,
    total_questions_analyzed: questions.length,
    question_type_distribution: questionTypeDistribution,
    section_structure: sectionStructure,
    average_total_marks: averageTotalMarks,
    average_duration: averageDuration,
    difficulty_distribution: normalizeCounts(difficultyCounts, fallback.difficulty_distribution),
    bloom_distribution: normalizeCounts(bloomCounts, fallback.bloom_distribution),
    topic_frequency: topicFrequency,
    marking_patterns: markingPatterns,
    common_instructions: inferCommonInstructions(exams, sectionStructure),
    recurring_elements: inferRecurringElements(questions, exams),
    selected_chapters: (chapters || []).map(c => ({ id: c.id, number: c.chapter_number, title: c.chapter_title }))
  };
}

function normalizeQuestionType(type) {
  const value = String(type || "short_answer").toLowerCase();
  if (["mcq", "multiple-choice", "multiple choice"].includes(value)) return "multiple_choice";
  if (["fill_blank", "fill_blanks", "fill-in-the-blank"].includes(value)) return "fill_in_blanks";
  if (["truefalse", "true/false"].includes(value)) return "true_false";
  if (["practical", "case_study", "case study"].includes(value)) return "case_study";
  return value;
}

function normalizeQuestionTextKey(text) {
  return String(text || "").toLowerCase().replace(/\s+/g, " ").trim();
}

function formatQuestionText(text, type = "short_answer") {
  let value = String(text || "")
    .replace(/\s+/g, " ")
    .replace(/^\s*(?:question\s*)?[A-Z]?\d+[.)\-\s]+/i, "")
    .trim();

  if (!value) return "";

  const normalizedType = normalizeQuestionType(type);
  const needsQuestionMark = [
    "multiple_choice",
    "true_false",
    "short_answer",
    "short_question",
    "calculation"
  ].includes(normalizedType);

  if (needsQuestionMark) {
    if (/[.]$/.test(value)) value = value.replace(/[.]+$/, "?");
    else if (!/[?!]$/.test(value)) value += "?";
  }
  return value;
}

function normalizeQuestionOptions(options, type = "multiple_choice") {
  const normalizedType = normalizeQuestionType(type);

  if (normalizedType === "true_false") return ["A. True", "B. False"];
  if (normalizedType !== "multiple_choice") {
    return Array.isArray(options) ? options.map(option => String(option || "").trim()).filter(Boolean) : [];
  }

  return (Array.isArray(options) ? options : [])
    .slice(0, 4)
    .map((option, index) => {
      const label = "ABCD"[index];
      const textValue = String(option || "")
        .replace(/^\s*(?:[A-D][.)]|[A-D]\s*[-:])\s*/i, "")
        .trim();
      return `${label}. ${textValue || `Option ${label}`}`;
    });
}

function fallbackQuestionText(type, index, topic) {
  const variants = {
    multiple_choice: [
      `Which statement best defines a core concept in ${topic}?`,
      `Which option is the most accurate application of ${topic}?`,
      `Which example best illustrates ${topic} in practice?`,
      `Which statement identifies an important limitation of ${topic}?`,
      `Which option correctly links ${topic} to its expected outcome?`,
      `Which factor is most important when evaluating ${topic}?`,
      `Which action would be the safest first step when working with ${topic}?`,
      `Which statement best explains why ${topic} is important?`,
      `Which situation would require knowledge of ${topic}?`,
      `Which choice shows a common mistake related to ${topic}?`,
      `Which option best connects ${topic} with everyday digital tasks?`,
      `Which result would you expect after applying ${topic} correctly?`,
      `Which description best separates ${topic} from a related concept?`,
      `Which option is the strongest evidence of understanding ${topic}?`,
      `Which step should be taken after identifying the problem in ${topic}?`
    ],
    true_false: [
      `${topic} can be used to solve practical course-related problems.`,
      `A limitation of ${topic} should be considered before applying it.`,
      `${topic} is only useful when no supporting evidence is available.`,
      `An example can be used to justify an answer about ${topic}.`
    ],
    matching: [
      `Match the key concepts from ${topic} with the correct descriptions.`,
      `Match the applications of ${topic} with their most appropriate outcomes.`,
      `Match each term related to ${topic} with its correct meaning.`
    ],
    fill_in_blanks: [
      `The main purpose of ______ is to support effective understanding of ${topic}.`,
      `A strong answer about ${topic} should include a clear ______ and example.`,
      `When applying ${topic}, students should first identify the relevant ______.`
    ],
    fill_blanks: [
      `The main purpose of ______ is to support effective understanding of ${topic}.`,
      `A strong answer about ${topic} should include a clear ______ and example.`,
      `When applying ${topic}, students should first identify the relevant ______.`
    ],
    essay: [
      `Discuss ${topic} in detail, including definitions, applications, and limitations.`,
      `Evaluate the importance of ${topic} and support your answer with examples.`,
      `Analyze how ${topic} can be applied in a realistic scenario.`,
      `Compare two approaches related to ${topic} and explain which is more effective.`
    ],
    calculation: [
      `Solve a practical problem related to ${topic}. State assumptions and show all working.`,
      `Use the correct method to calculate a result linked to ${topic}, then interpret your answer.`,
      `Apply a relevant formula or procedure from ${topic} and explain each step.`
    ],
    short_answer: [
      `Explain ${topic} and provide one relevant example.`,
      `Describe two key features of ${topic}.`,
      `State the purpose of ${topic} and explain why it matters.`,
      `Identify one advantage and one limitation of ${topic}.`,
      `Apply ${topic} to a brief practical situation.`,
      `Compare ${topic} with a related concept from the course.`,
      `Explain one risk linked to ${topic} and how it can be reduced.`,
      `Give two examples of how ${topic} is used in everyday digital work.`
    ]
  };

  const options = variants[type] || variants.short_answer;
  return options[(Math.max(Number(index) || 1, 1) - 1) % options.length];
}

function ensureUniqueQuestionText(text, type, index, chapter, usedQuestionTexts) {
  const topic = chapter?.chapter_title || chapter?.title || "the selected course content";
  let candidate = String(text || "").trim() || fallbackQuestionText(type, index, topic);
  let key = normalizeQuestionTextKey(candidate);

  if (!usedQuestionTexts.has(key)) {
    usedQuestionTexts.add(key);
    return candidate;
  }

  const focusAreas = [
    "definition",
    "application",
    "example",
    "limitation",
    "comparison",
    "evaluation",
    "scenario",
    "justification"
  ];

  for (let attempt = 0; attempt < focusAreas.length; attempt += 1) {
    const focus = focusAreas[(index + attempt - 1) % focusAreas.length];
    candidate = `${fallbackQuestionText(type, index + attempt, topic)} Focus specifically on ${focus}.`;
    key = normalizeQuestionTextKey(candidate);
    if (!usedQuestionTexts.has(key)) {
      usedQuestionTexts.add(key);
      return candidate;
    }
  }

  candidate = `${fallbackQuestionText(type, index, topic)} Include distinct point ${index}.`;
  usedQuestionTexts.add(normalizeQuestionTextKey(candidate));
  return candidate;
}

function rotateOptions(options, targetIndex, correctIndex = 0) {
  const labels = ["A", "B", "C", "D"];
  const ordered = [...options];
  const safeCorrectIndex = Math.max(0, Math.min(correctIndex, ordered.length - 1));
  const correct = ordered.splice(safeCorrectIndex, 1)[0];
  const safeTargetIndex = Math.max(0, Math.min(targetIndex, labels.length - 1));
  ordered.splice(safeTargetIndex, 0, correct);
  return {
    options: ordered.map((option, index) => `${labels[index]}. ${option}`),
    correct_answer: labels[safeTargetIndex]
  };
}

function fallbackMcqOptions(index, topic) {
  const sets = [
    [
      `It describes the main idea and correct use of ${topic}`,
      "It is unrelated to the question context",
      "It only describes a minor exception",
      "It means the same thing as guessing"
    ],
    [
      `Use ${topic} to choose an appropriate digital tool or method`,
      "Ignore the task requirements",
      "Use any tool without checking the result",
      "Avoid comparing possible solutions"
    ],
    [
      `A learner uses ${topic} to complete a realistic digital task`,
      "A learner copies information without checking it",
      "A learner avoids using evidence",
      "A learner deletes all saved work"
    ],
    [
      `It may be misunderstood if the context and purpose are ignored`,
      "It always gives the same answer in every situation",
      "It removes the need for critical thinking",
      "It is only useful for entertainment"
    ]
  ];

  return rotateOptions(sets[(Math.max(Number(index) || 1, 1) - 1) % sets.length], (Math.max(Number(index) || 1, 1) - 1) % 4, 0);
}

function fallbackShortAnswerGuide(index, topic) {
  const guides = [
    `Award marks for a clear definition of ${topic}, one accurate example, and correct terminology.`,
    `Award marks for two relevant features of ${topic} with brief explanations.`,
    `Award marks for explaining the purpose of ${topic} and linking it to a practical use.`,
    `Award marks for one valid advantage, one valid limitation, and a short explanation.`,
    `Award marks for applying ${topic} to a realistic situation with a logical outcome.`,
    `Award marks for a clear comparison, at least one similarity, and at least one difference.`,
    `Award marks for identifying a realistic risk and explaining a suitable prevention method.`,
    `Award marks for two everyday examples and a short explanation of why each example fits.`
  ];
  return guides[(Math.max(Number(index) || 1, 1) - 1) % guides.length];
}

function averageNumber(values) {
  if (!values.length) return null;
  return Math.round(values.reduce((sum, value) => sum + Number(value), 0) / values.length);
}

function estimateTotalMarks(questions) {
  const total = (questions || []).reduce((sum, q) => sum + (Number(q.marks) || 0), 0);
  return total || null;
}

function normalizeCounts(counts, fallback) {
  const total = Object.values(counts).reduce((sum, count) => sum + count, 0);
  if (!total) return fallback;
  return Object.fromEntries(Object.entries(counts).map(([key, count]) => [key, Number((count / total).toFixed(3))]));
}

function modeNumber(values, fallback) {
  const counts = {};
  for (const value of values || []) counts[value] = (counts[value] || 0) + 1;
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best ? Number(best[0]) : fallback;
}

function inferSectionStructure(distribution, markingPatterns, totalMarks) {
  const typeTitles = {
    multiple_choice: "Multiple Choice Questions",
    true_false: "True or False",
    matching: "Matching Questions",
    fill_in_blanks: "Fill in the Blanks",
    fill_blanks: "Fill in the Blanks",
    short_answer: "Short Answer Questions",
    calculation: "Calculations and Problem Solving",
    practical: "Practical Application Questions",
    case_study: "Case Study Questions",
    essay: "Essay Questions"
  };
  const entries = Object.entries(distribution || {}).filter(([, ratio]) => ratio > 0);
  if (!entries.length) return defaultPatternAnalysis().section_structure;

  const letters = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
  let allocated = 0;
  return entries.map(([type, ratio], index) => {
    const marksPerQuestion = modeNumber(markingPatterns[type], type === "essay" ? 15 : type === "short_answer" ? 5 : 2);
    const rawMarks = index === entries.length - 1 ? Math.max(totalMarks - allocated, marksPerQuestion) : Math.max(Math.round(totalMarks * ratio), marksPerQuestion);
    const questionCount = Math.max(1, Math.round(rawMarks / marksPerQuestion));
    const sectionMarks = questionCount * marksPerQuestion;
    allocated += sectionMarks;
    return {
      section_id: letters[index],
      title: typeTitles[type] || `${type.replace(/_/g, " ")} Questions`,
      question_type: type,
      question_count: questionCount,
      marks_per_question: marksPerQuestion,
      total_marks: sectionMarks,
      instructions: sectionInstructions(type, questionCount, marksPerQuestion)
    };
  });
}

function sectionInstructions(type, questionCount, marksPerQuestion) {
  if (type === "multiple_choice") return `Answer all ${questionCount} questions. Choose the best answer.`;
  if (type === "matching") return "Match each item in Column A with the most appropriate item in Column B.";
  if (type === "fill_in_blanks" || type === "fill_blanks") return "Complete each statement using the most appropriate word or phrase.";
  if (type === "essay") return `Answer all questions. Each question is worth ${marksPerQuestion} marks.`;
  if (type === "calculation") return "Show all working. Marks are awarded for method and final answer.";
  return `Answer all ${questionCount} questions. Each question is worth ${marksPerQuestion} marks.`;
}

function inferCommonInstructions(exams, sections) {
  const totals = sections.reduce((sum, section) => sum + (section.total_marks || 0), 0);
  const duration = averageNumber((exams || []).map(e => e.duration_minutes).filter(Boolean)) || 180;
  return `Duration: ${duration} minutes. Total: ${totals || 100} marks. Answer ALL questions. Write clearly and show all working where applicable.`;
}

function inferRecurringElements(questions, exams) {
  const elements = [];
  const text = `${(questions || []).map(q => q.question_text).join(" ")} ${(exams || []).map(e => `${e.title} ${e.description || ""}`).join(" ")}`.toLowerCase();
  if (text.includes("case study") || text.includes("scenario")) elements.push("case studies");
  if (text.includes("table")) elements.push("data tables");
  if (text.includes("diagram")) elements.push("diagram labelling");
  if (text.includes("formula")) elements.push("formula sheet or formula use");
  if (text.includes("match")) elements.push("matching columns");
  return elements;
}

async function loadChapterContext(chapters) {
  let chapterContent = "";
  const chapterIds = (chapters || []).map(chapter => chapter.id).filter(Boolean);
  const guideMap = new Map();

  if (chapterIds.length) {
    const { data: guides, error: guideError } = await sbAdmin
      .from("chapter_study_guides")
      .select("chapter_id, title, guide_text, summary, key_concepts, updated_at")
      .in("chapter_id", chapterIds);

    if (guideError) {
      console.warn("Chapter study guide context lookup skipped:", guideError.message);
    } else {
      for (const guide of guides || []) {
        guideMap.set(guide.chapter_id, guide);
      }
    }
  }

  for (const chapter of chapters || []) {
    const cachedGuide = guideMap.get(chapter.id);
    if (cachedGuide?.guide_text) {
      chapterContent += `\n\n## Chapter ${chapter.chapter_number || ""}: ${chapter.chapter_title}\n`;
      chapterContent += `Cached study guide:\n${cachedGuide.guide_text.slice(0, 2200)}\n`;
      continue;
    }

    const { data: chunks } = await sbAdmin
      .from("chapter_chunks")
      .select("text")
      .eq("chapter_id", chapter.id)
      .order("chunk_index", { ascending: true })
      .limit(4);

    if (chunks?.length) {
      chapterContent += `\n\n## Chapter ${chapter.chapter_number || ""}: ${chapter.chapter_title}\n`;
      chapterContent += `Raw excerpt because no cached study guide exists yet:\n`;
      chapterContent += chunks.map(c => c.text).join("\n").slice(0, 1400);
    }
  }
  return chapterContent.slice(0, 12000);
}

function buildCompleteExamPaperPrompt({ module, pastExams, pastQuestions, selectedChapters, chapterContent, patternAnalysis, studyModeLabel = "exam" }) {
  const examples = (pastQuestions || []).slice(0, 80).map((q, index) => ({
    number: index + 1,
    question_type: normalizeQuestionType(q.question_type),
    text: q.question_text,
    options: q.options,
    marks: q.marks,
    difficulty: q.difficulty_level,
    topics: q.topic_tags,
    bloom_level: q.bloom_taxonomy_level
  }));

  return `
Generate ONE COMPLETE predicted mock ${studyModeLabel} paper for this module.

MODULE:
${JSON.stringify({
  module_name: module?.name,
  module_code: module?.code,
  course_code: module?.courses?.code,
  course_name: module?.courses?.name
}, null, 2)}

PAST ${studyModeLabel.toUpperCase()} METADATA:
${JSON.stringify((pastExams || []).map(e => ({
  title: e.title,
  year: e.year,
  term: e.term,
  duration_minutes: e.duration_minutes,
  total_marks: e.total_marks,
  description: e.description
})), null, 2)}

PATTERN ANALYSIS TO FOLLOW:
${JSON.stringify(patternAnalysis, null, 2)}

PAST ${studyModeLabel.toUpperCase()} QUESTION EXAMPLES FOR STYLE ONLY - DO NOT COPY VERBATIM:
${JSON.stringify(examples, null, 2)}

SELECTED CHAPTERS TO COVER PROPORTIONALLY:
${JSON.stringify((selectedChapters || []).map(c => ({
  id: c.id,
  chapter_number: c.chapter_number,
  chapter_title: c.chapter_title
})), null, 2)}

CHAPTER CONTENT CONTEXT:
${chapterContent || "No chapter text available. Use chapter titles and past exam pattern metadata."}

REQUIREMENTS:
- Generate a single complete exam paper, not isolated practice questions.
- Match the section structure, question type proportions, mark allocations, instructions, and numbering style from the pattern analysis.
- For every item in pattern_analysis.section_structure, generate exactly question_count questions in that section.
- The total number of generated questions must equal the sum of all section_structure.question_count values.
- Never return only 5 sample questions. Never use placeholders such as "continue similarly" or duplicate the same question with small wording changes.
- Do not summarize sections with sample questions. The paper must include every question that a student would answer.
- Include MCQ, true/false, matching, fill-in-blanks, short answer, essay, calculation, case study, practical, or diagram-label questions only when the pattern supports them.
- Use different cognitive levels: remember, understand, apply, analyze, evaluate, create.
- Cover all selected chapters proportionally.
- Create new questions. Do not repeat exact past question wording.
- Include answer spaces or answer booklet cues for printed use.
- Include an answer_key object.

Return ONLY this JSON shape:
{
  "exam_title": "string",
  "course_code": "string",
  "module_code": "string",
  "duration_minutes": 180,
  "total_marks": 100,
  "instructions": ["instruction 1", "instruction 2"],
  "student_fields": ["Student name", "Student number", "Date"],
  "cover_page_note": "string",
  "sections": [
    {
      "section_id": "A",
      "title": "Multiple Choice Questions",
      "instructions": "Answer all questions.",
      "total_marks": 20,
      "questions": [
        {
          "number": "1",
          "type": "multiple_choice",
          "text": "Question text",
          "options": ["A) ...", "B) ...", "C) ...", "D) ..."],
          "marks": 2,
          "answer_space": "Select one option.",
          "correct_answer": "A",
          "bloom_level": "remember",
          "difficulty_level": "easy",
          "topic_tags": ["topic"],
          "chapter_id": "uuid or null",
          "explanation": "brief rationale"
        }
      ]
    }
  ],
  "answer_key": {
    "A1": "answer or marking guideline"
  },
  "end_marker": "END OF PAPER"
}`;
}

function normalizeCompleteExamPaper(examPaper, module, patternAnalysis) {
  const fallback = generateFallbackExamPaper(module, patternAnalysis.selected_chapters || [], patternAnalysis);
  const paper = examPaper && typeof examPaper === "object" ? examPaper : fallback;
  const sections = Array.isArray(paper.sections) && paper.sections.length ? paper.sections : fallback.sections;
  const expectedSections = Array.isArray(patternAnalysis.section_structure) ? patternAnalysis.section_structure : [];
  const chapterList = Array.isArray(patternAnalysis.selected_chapters) ? patternAnalysis.selected_chapters : [];
  const normalizedSections = sections.map((section, sectionIndex) => {
    const sectionId = section.section_id || "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[sectionIndex] || String(sectionIndex + 1);
    const questions = Array.isArray(section.questions) ? section.questions : [];
    const expectedSection = expectedSections.find(expected => String(expected.section_id) === String(sectionId))
      || expectedSections[sectionIndex]
      || null;
    const usedQuestionTexts = new Set();
    const normalizedQuestions = questions.map((q, questionIndex) => {
      const normalizedType = normalizeQuestionType(q.type || q.question_type || expectedSection?.question_type);
      const chapter = chapterList[questionIndex % Math.max(chapterList.length, 1)] || {};
      const normalized = {
        number: `${questionIndex + 1}`,
        type: normalizedType,
        text: formatQuestionText(q.text || q.question_text || "", normalizedType),
        options: normalizeQuestionOptions(Array.isArray(q.options) ? q.options : [], normalizedType),
        matching_pairs: q.matching_pairs || null,
        word_bank: Array.isArray(q.word_bank) ? q.word_bank : [],
        marks: Number(q.marks) || Number(expectedSection?.marks_per_question) || 1,
        answer_space: q.answer_space || defaultAnswerSpace(normalizedType, Number(q.marks) || Number(expectedSection?.marks_per_question) || 1),
        correct_answer: q.correct_answer || null,
        bloom_level: q.bloom_level || q.bloom_taxonomy_level || "understand",
        difficulty_level: q.difficulty_level || q.difficulty || "medium",
        topic_tags: Array.isArray(q.topic_tags) ? q.topic_tags : [],
        chapter_id: q.chapter_id || null,
        explanation: q.explanation || ""
      };

      normalized.text = formatQuestionText(
        ensureUniqueQuestionText(normalized.text, normalizedType, questionIndex + 1, chapter, usedQuestionTexts),
        normalizedType
      );
      return normalized;
    });
    const expectedCount = Math.max(Number(expectedSection?.question_count) || normalizedQuestions.length || 1, normalizedQuestions.length);
    while (normalizedQuestions.length < expectedCount) {
      const chapter = chapterList[normalizedQuestions.length % Math.max(chapterList.length, 1)] || {};
      const fallbackQuestion = createFallbackQuestion(
        expectedSection || {
          question_type: normalizedQuestions[0]?.type || "short_answer",
          marks_per_question: normalizedQuestions[0]?.marks || 5
        },
        normalizedQuestions.length + 1,
        chapter
      );
      fallbackQuestion.text = ensureUniqueQuestionText(
        fallbackQuestion.text,
        fallbackQuestion.type,
        normalizedQuestions.length + 1,
        chapter,
        usedQuestionTexts
      );
      normalizedQuestions.push(fallbackQuestion);
    }

    return {
      section_id: sectionId,
      title: section.title || `Section ${sectionId}`,
      instructions: section.instructions || sectionInstructions(expectedSection?.question_type || normalizedQuestions[0]?.type || "short_answer", normalizedQuestions.length || 1, expectedSection?.marks_per_question || normalizedQuestions[0]?.marks || 5),
      total_marks: normalizedQuestions.reduce((sum, q) => sum + (Number(q.marks) || 0), 0),
      questions: normalizedQuestions
    };
  });

  const totalMarks = normalizedSections.reduce((sum, section) => sum + section.questions.reduce((s, q) => s + q.marks, 0), 0);
  const generatedAnswerKey = paper.answer_key && typeof paper.answer_key === "object" && !Array.isArray(paper.answer_key)
    ? paper.answer_key
    : {};
  const completeAnswerKey = {
    ...buildAnswerKey(normalizedSections),
    ...generatedAnswerKey
  };

  return {
    exam_title: paper.exam_title || `${module?.name || "Module"} - Predicted Exam`,
    course_code: paper.course_code || module?.courses?.code || "",
    module_code: paper.module_code || module?.code || "",
    duration_minutes: Number(paper.duration_minutes) || patternAnalysis.average_duration || 180,
    total_marks: Number(paper.total_marks) || totalMarks || patternAnalysis.average_total_marks || 100,
    instructions: Array.isArray(paper.instructions) ? paper.instructions : [paper.instructions || patternAnalysis.common_instructions],
    student_fields: Array.isArray(paper.student_fields) && paper.student_fields.length ? paper.student_fields : ["Student name", "Student number", "Date"],
    cover_page_note: paper.cover_page_note || "Read all instructions carefully before you begin.",
    sections: normalizedSections,
    answer_key: completeAnswerKey,
    pattern_summary: patternAnalysis,
    end_marker: paper.end_marker || "END OF PAPER"
  };
}

function defaultAnswerSpace(type, marks) {
  const normalized = normalizeQuestionType(type);
  if (normalized === "multiple_choice" || normalized === "true_false" || normalized === "matching") return "Answer in the answer booklet.";
  if (marks >= 10) return "\n\n\n\n\n\n";
  if (marks >= 5) return "\n\n\n\n";
  return "\n\n";
}

function buildAnswerKey(sections) {
  const answerKey = {};
  for (const section of sections) {
    for (const question of section.questions) {
      answerKey[`${section.section_id}${question.number}`] = question.correct_answer || question.explanation || "Mark using the supplied rubric.";
    }
  }
  return answerKey;
}

function flattenExamPaperQuestions(examPaper) {
  const questions = [];
  for (const section of examPaper.sections || []) {
    for (const q of section.questions || []) {
      questions.push({
        section_id: section.section_id,
        section_title: section.title,
        question_number: q.number,
        question_text: q.text,
        question_type: q.type,
        options: q.options,
        matching_pairs: q.matching_pairs,
        word_bank: q.word_bank,
        correct_answer: q.correct_answer,
        marks: q.marks,
        difficulty: q.difficulty_level,
        difficulty_level: q.difficulty_level,
        bloom_level: q.bloom_level,
        topic_tags: q.topic_tags,
        chapter_id: q.chapter_id || null,
        explanation: q.explanation,
        prediction_reason: "Part of a complete mock exam generated from past paper structure."
      });
    }
  }
  return questions;
}

function generateFallbackExamPaper(module, chapters, patternAnalysis) {
  const analysis = patternAnalysis || defaultPatternAnalysis();
  const chapterList = Array.isArray(chapters) && chapters.length ? chapters : (analysis.selected_chapters || []);
  const sections = (analysis.section_structure || defaultPatternAnalysis().section_structure).map((section, sectionIndex) => {
    const questions = [];
    for (let i = 0; i < Math.max(Number(section.question_count) || 3, 1); i++) {
      const chapter = chapterList[i % Math.max(chapterList.length, 1)] || {};
      questions.push(createFallbackQuestion(section, i + 1, chapter));
    }
    return {
      section_id: section.section_id || "ABCDEFGHIJKLMNOPQRSTUVWXYZ"[sectionIndex],
      title: section.title,
      instructions: section.instructions || sectionInstructions(section.question_type, section.question_count, section.marks_per_question),
      total_marks: questions.reduce((sum, q) => sum + q.marks, 0),
      questions
    };
  });

  const totalMarks = sections.reduce((sum, section) => sum + section.total_marks, 0);
  return {
    exam_title: `${module?.name || "Selected Module"} - Predicted Exam`,
    course_code: module?.courses?.code || "",
    module_code: module?.code || "",
    duration_minutes: analysis.average_duration || 180,
    total_marks: totalMarks || analysis.average_total_marks || 100,
    instructions: [
      "Answer ALL questions.",
      "Marks are indicated in brackets.",
      "Show all working where calculations are required.",
      "This predicted paper follows the structure detected from uploaded past papers."
    ],
    student_fields: ["Student name", "Student number", "Date"],
    cover_page_note: "Use this mock paper for exam preparation and timing practice.",
    sections,
    answer_key: buildAnswerKey(sections),
    pattern_summary: analysis,
    end_marker: "END OF PAPER"
  };
}

function createFallbackQuestion(section, index, chapter) {
  const type = normalizeQuestionType(section.question_type);
  const topic = chapter.chapter_title || chapter.title || "the selected course content";
  const marks = Number(section.marks_per_question) || (type === "essay" ? 15 : type === "short_answer" ? 5 : 2);
  const base = {
    number: `${index}`,
    type,
    marks,
    bloom_level: index % 3 === 0 ? "analyze" : index % 2 === 0 ? "apply" : "understand",
    difficulty_level: marks >= 10 ? "hard" : marks >= 5 ? "medium" : "easy",
    topic_tags: [topic],
    chapter_id: chapter.id || null,
    answer_space: defaultAnswerSpace(type, marks),
    explanation: `Expected answer should address key concepts from ${topic}.`
  };

  if (type === "multiple_choice") {
    const mcq = fallbackMcqOptions(index, topic);
    return {
      ...base,
      text: formatQuestionText(fallbackQuestionText(type, index, topic), type),
      options: mcq.options,
      correct_answer: mcq.correct_answer,
      explanation: `The correct option best matches the role of ${topic} in the question context.`
    };
  }
  if (type === "true_false") {
    return { ...base, text: formatQuestionText(fallbackQuestionText(type, index, topic), type), correct_answer: index % 3 === 0 ? "False" : "True" };
  }
  if (type === "matching") {
    return {
      ...base,
      text: formatQuestionText(fallbackQuestionText(type, index, topic), type),
      matching_pairs: { "Core concept": "Correct description", "Application": "Practical use" },
      correct_answer: "Core concept -> Correct description; Application -> Practical use"
    };
  }
  if (type === "fill_in_blanks" || type === "fill_blanks") {
    return {
      ...base,
      text: formatQuestionText(fallbackQuestionText(type, index, topic), type),
      word_bank: ["analysis", "memorisation", "guessing", "avoidance"],
      correct_answer: "analysis"
    };
  }
  if (type === "essay") {
    return { ...base, text: formatQuestionText(fallbackQuestionText(type, index, topic), type), correct_answer: "Rubric: definitions, examples, applications, limitations, conclusion." };
  }
  if (type === "calculation") {
    return { ...base, text: formatQuestionText(fallbackQuestionText(type, index, topic), type), correct_answer: "Award marks for method, substitution, calculation, and interpretation." };
  }
  return { ...base, text: formatQuestionText(fallbackQuestionText(type, index, topic), type), correct_answer: fallbackShortAnswerGuide(index, topic) };
}

async function savePredictedExam({ userId, moduleId, examDate, intensity, chapterIds, examPaper, patternAnalysis, predictions }) {
  try {
    const { data, error } = await sbAdmin
      .from("predicted_exams")
      .insert({
        module_id: moduleId,
        student_id: userId,
        exam_title: examPaper.exam_title,
        exam_type: "mock_exam",
        total_marks: examPaper.total_marks,
        duration_minutes: examPaper.duration_minutes,
        instructions: Array.isArray(examPaper.instructions) ? examPaper.instructions.join("\n") : examPaper.instructions,
        exam_structure: examPaper,
        ...(examDate ? { exam_date: examDate } : {}),
        ...(intensity ? { intensity } : {}),
        selected_chapters: chapterIds
      })
      .select("id")
      .single();

    if (error) throw error;

    const questionRows = predictions.map(q => ({
      predicted_exam_id: data.id,
      section_id: q.section_id,
      question_number: Number.parseInt(q.question_number, 10) || 0,
      question_type: q.question_type,
      question_text: q.question_text,
      options: q.options || null,
      correct_answer: q.correct_answer || null,
      marks: q.marks || 1,
      difficulty_level: q.difficulty_level || q.difficulty || "medium",
      bloom_level: q.bloom_level || "understand",
      topic_tags: q.topic_tags || [],
      matching_pairs: q.matching_pairs || null,
      word_bank: q.word_bank || [],
      explanation: q.explanation || null
    }));

    if (questionRows.length) {
      const { error: questionError } = await sbAdmin.from("predicted_exam_questions").insert(questionRows);
      if (questionError) console.error("Failed to save predicted exam questions:", questionError.message);
    }

    await sbAdmin
      .from("exam_pattern_analysis")
      .upsert({
        module_id: moduleId,
        analyzed_at: new Date().toISOString(),
        total_papers_analyzed: patternAnalysis.total_papers_analyzed,
        question_type_distribution: patternAnalysis.question_type_distribution,
        section_structure: patternAnalysis.section_structure,
        average_total_marks: patternAnalysis.average_total_marks,
        average_duration: patternAnalysis.average_duration,
        difficulty_distribution: patternAnalysis.difficulty_distribution,
        bloom_distribution: patternAnalysis.bloom_distribution,
        topic_frequency: patternAnalysis.topic_frequency,
        marking_patterns: patternAnalysis.marking_patterns,
        common_instructions: patternAnalysis.common_instructions,
        last_used_for_generation: new Date().toISOString()
      }, { onConflict: "module_id" });

    return data.id;
  } catch (error) {
    console.error("Predicted exam persistence skipped:", error.message);
    return null;
  }
}

function buildFewShotPrompt(pastQuestions, chapterContent, chapters, count) {
    // Format past questions as examples
    let examplesText = "";
    const questionTypeGroups = {
        multiple_choice: [],
        matching: [],
        fill_blanks: [],
        essay: []
    };
    
    // Group past questions by type
    for (const q of pastQuestions || []) {
        if (q.question_type === "multiple_choice" && questionTypeGroups.multiple_choice.length < 2) {
            questionTypeGroups.multiple_choice.push(q);
        } else if (q.question_type === "matching" && questionTypeGroups.matching.length < 2) {
            questionTypeGroups.matching.push(q);
        } else if (q.question_type === "fill_blanks" && questionTypeGroups.fill_blanks.length < 2) {
            questionTypeGroups.fill_blanks.push(q);
        } else if (q.question_type === "essay" && questionTypeGroups.essay.length < 2) {
            questionTypeGroups.essay.push(q);
        }
    }
    
    // Build examples text
    for (const [type, questions] of Object.entries(questionTypeGroups)) {
        if (questions.length > 0) {
            examplesText += `\n\n### ${type.toUpperCase()} EXAMPLE:\n`;
            questions.forEach((q, i) => {
                examplesText += `\nExample ${i + 1}:\n`;
                examplesText += `Question: ${q.question_text}\n`;
                if (q.options) examplesText += `Options: ${JSON.stringify(q.options)}\n`;
                if (q.correct_answer) examplesText += `Answer: ${q.correct_answer}\n`;
                examplesText += `Marks: ${q.marks || 5}\n`;
            });
        }
    }
    
    const topicsList = chapters.map(c => c.chapter_title).join(", ");
    
    return `
You are an expert exam question generator. Your task is to create NEW exam questions that EXACTLY match the format, style, and structure of the provided examples.

## PAST EXAM QUESTIONS (Use these as format examples):
${examplesText}

## CHAPTER CONTENT TO BASE QUESTIONS ON:
${chapterContent.substring(0, 4000)}

## TOPICS TO COVER:
${topicsList}

## INSTRUCTIONS:
Generate ${count} new exam questions that follow these rules:

1. **Question Types Distribution** (match the pattern from examples):
   - Multiple Choice Questions (4 options, A-D)
   - Matching columns (if present in examples)
   - Fill in the blanks (with word bank if shown)
   - Essay questions

2. **Format Requirements**:
   - For MCQs: Provide 4 plausible options, exactly 1 correct answer
   - For Matching: Create as "Column A" and "Column B" pairs
   - For Fill Blanks: Use "______" for missing words, provide word bank
   - For Essays: Include action verbs (analyze, evaluate, compare, discuss)

3. **Difficulty Distribution**:
   - 30% Easy (basic recall)
   - 50% Medium (application/understanding)
   - 20% Hard (analysis/evaluation)

4. **Mark Allocation**:
   - MCQs: 2-3 marks each
   - Matching: 1 mark per correct match
   - Fill blanks: 1-2 marks per blank
   - Essays: 5-15 marks based on complexity

## OUTPUT FORMAT:
Return ONLY valid JSON in this exact structure:

{
  "generated_questions": [
    {
      "question_type": "multiple_choice",
      "question_text": "Complete question text here?",
      "options": ["A) Option 1", "B) Option 2", "C) Option 3", "D) Option 4"],
      "correct_answer": "A",
      "marks": 2,
      "difficulty": "easy",
      "topic_tags": ["tag1", "tag2"],
      "explanation": "Brief explanation why this is correct"
    },
    {
      "question_type": "matching",
      "question_text": "Match Column A with Column B:",
      "matching_pairs": {
        "Column A Item 1": "Column B Item 1",
        "Column A Item 2": "Column B Item 2"
      },
      "marks": 6,
      "difficulty": "medium",
      "topic_tags": ["tag1"]
    },
    {
      "question_type": "fill_blanks",
      "question_text": "The ______ is the powerhouse of the ______.",
      "word_bank": ["mitochondria", "cell", "nucleus", "ribosome"],
      "correct_answer": "mitochondria, cell",
      "marks": 4,
      "difficulty": "easy",
      "topic_tags": ["biology"]
    },
    {
      "question_type": "essay",
      "question_text": "Discuss the importance of [topic] in [context].",
      "marks": 10,
      "difficulty": "hard",
      "topic_tags": ["analysis", "evaluation"],
      "marking_guidelines": ["Key point 1", "Key point 2", "Key point 3"]
    }
  ],
  "total_marks": 100,
  "section_structure": "Description of how questions are organized"
}

Generate ${count} questions now based on the chapter content and examples provided. Make sure questions are academically rigorous and test understanding, not just memorization.
`;
}

function validateAndFormatQuestions(questions) {
    const validQuestions = [];
    
    for (const q of questions) {
        // Skip if missing essential fields
        if (!q.question_text || !q.question_type) continue;
        
        // Validate based on type
        if (q.question_type === "multiple_choice") {
            if (!q.options || q.options.length < 2) continue;
            if (!q.correct_answer) continue;
        }
        
        if (q.question_type === "matching") {
            if (!q.matching_pairs || Object.keys(q.matching_pairs).length === 0) continue;
        }
        
        if (q.question_type === "fill_blanks") {
            if (!q.word_bank || q.word_bank.length === 0) continue;
        }
        
        // Set defaults
        q.marks = q.marks || (q.question_type === "essay" ? 10 : 2);
        q.difficulty = q.difficulty || "medium";
        q.topic_tags = q.topic_tags || ["general"];
        
        validQuestions.push(q);
    }
    
    return validQuestions;
}

function generateFallbackQuestions(chapters, count) {
    const fallbackQuestions = [];
    const questionTemplates = [
        { type: "multiple_choice", template: "What is the main purpose of {topic}?", difficulty: "easy", marks: 2 },
        { type: "short_answer", template: "Explain the concept of {topic} and provide an example.", difficulty: "medium", marks: 5 },
        { type: "essay", template: "Analyze and evaluate the importance of {topic} in real-world applications.", difficulty: "hard", marks: 15 },
        { type: "multiple_choice", template: "Which of the following best describes {topic}?", difficulty: "medium", marks: 2 }
    ];
    
    for (let i = 0; i < count; i++) {
        const chapter = chapters[i % chapters.length];
        const template = questionTemplates[i % questionTemplates.length];
        const topic = chapter?.chapter_title || "this concept";
        
        fallbackQuestions.push({
            question_text: template.template.replace("{topic}", topic),
            question_type: template.type,
            difficulty: template.difficulty,
            marks: template.marks,
            topic_tags: [topic],
            prediction_reason: "Based on analysis of past exam patterns (fallback generation)",
            is_fallback: true
        });
    }
    
    return fallbackQuestions;
}
// ============================================
// GET STUDENT MODULES
// ============================================

router.get("/modules", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    
    // Get user's profile to find their course
    const { data: profile, error: profileError } = await sbAdmin
      .from("profiles")
      .select("course_id, role")
      .eq("id", userId)
      .single();
    
    if (profileError && profileError.code !== 'PGRST116') {
      console.error("Profile error:", profileError);
    }
    
    let modules = [];
    
    if (profile?.role === "admin") {
      // Admin sees all modules
      const { data: allModules, error } = await sbAdmin
        .from("modules")
        .select(`
          id,
          name,
          code,
          course_id,
          courses (name)
        `)
        .order("name");
      
      if (!error && allModules) {
        modules = allModules.map(m => ({
          module_id: m.id,
          name: m.name,
          code: m.code,
          course_id: m.course_id,
          course_name: m.courses?.name
        }));
      }
    } else if (profile?.course_id) {
      // Student sees modules from their enrolled course
      const { data: enrolledModules, error } = await sbAdmin
        .from("modules")
        .select(`
          id,
          name,
          code,
          course_id,
          courses (name)
        `)
        .eq("course_id", profile.course_id)
        .order("name");
      
      if (!error && enrolledModules) {
        modules = enrolledModules.map(m => ({
          module_id: m.id,
          name: m.name,
          code: m.code,
          course_id: m.course_id,
          course_name: m.courses?.name
        }));
      }
    }
    
    // Get exam counts for each module
    for (const module of modules) {
      const { count: examCount } = await sbAdmin
        .from("exams")
        .select("*", { count: "exact", head: true })
        .eq("module_id", module.module_id);
      
      const { count: questionCount } = await sbAdmin
        .from("exam_question_bank")
        .select("*", { count: "exact", head: true })
        .eq("module_id", module.module_id);
      
      module.exam_count = examCount || 0;
      module.question_count = questionCount || 0;
    }
    
    res.json({ ok: true, modules });
    
  } catch (error) {
    console.error("Error fetching modules:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET SKILLS FROM A PUBLISHED MODULE GUIDE
// ============================================

router.get("/module-skills", requireAuth, async (req, res) => {
  try {
    const userId = req.user.id;
    const moduleId = String(req.query.moduleId || "").trim();

    if (!isValidUuid(moduleId)) {
      return res.status(400).json({ ok: false, error: "A valid moduleId is required" });
    }

    const { data: profile, error: profileError } = await sbAdmin
      .from("profiles")
      .select("course_id, role")
      .eq("id", userId)
      .single();

    if (profileError && profileError.code !== "PGRST116") throw profileError;

    const { data: module, error: moduleError } = await sbAdmin
      .from("modules")
      .select("id, name, code, course_id, courses (name, code)")
      .eq("id", moduleId)
      .single();

    if (moduleError) throw moduleError;

    const isAdmin = String(profile?.role || "").toLowerCase() === "admin";
    const canAccess = isAdmin || (profile?.course_id && profile.course_id === module.course_id);

    if (!canAccess) {
      return res.status(403).json({ ok: false, error: "You do not have access to this module" });
    }

    const { data: guide, error: guideError } = await sbAdmin
      .from("module_guides")
      .select("id, module_id, title, description, file_name, file_url, is_published, version, updated_at")
      .eq("module_id", moduleId)
      .eq("is_published", true)
      .order("updated_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (guideError) throw guideError;

    if (!guide) {
      return res.json({
        ok: true,
        module: formatModuleForSkills(module),
        guide: null,
        skills: [],
        skill_groups: [],
        summary: "No published module guide is available for this module yet.",
        source: "none"
      });
    }

    const [{ data: chapters }, { data: questions }] = await Promise.all([
      sbAdmin
        .from("chapters")
        .select("chapter_number, chapter_title")
        .eq("module_id", moduleId)
        .order("chapter_number", { ascending: true })
        .limit(30),
      sbAdmin
        .from("exam_question_bank")
        .select("topic_tags, bloom_taxonomy_level")
        .eq("module_id", moduleId)
        .limit(250)
    ]);

    const extracted = extractModuleGuideSkills({ module, guide, chapters: chapters || [], questions: questions || [] });

    res.json({
      ok: true,
      module: formatModuleForSkills(module),
      guide,
      skills: extracted.skills,
      skill_groups: extracted.skill_groups,
      summary: extracted.summary,
      source: extracted.source
    });
  } catch (error) {
    console.error("Error fetching module skills:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET CHAPTERS FOR A MODULE
// ============================================

router.get("/chapters", requireAuth, async (req, res) => {
  try {
    const { moduleId } = req.query;
    
    if (!moduleId) {
      return res.status(400).json({ ok: false, error: "moduleId is required" });
    }
    
    const { data: chapters, error } = await sbAdmin
      .from("chapters")
      .select("id, chapter_number, chapter_title, created_at")
      .eq("module_id", moduleId)
      .order("chapter_number", { ascending: true });
    
    if (error) throw error;
    
    // Get chunk counts for each chapter
    for (const chapter of chapters || []) {
      const { count: chunkCount } = await sbAdmin
        .from("chapter_chunks")
        .select("*", { count: "exact", head: true })
        .eq("chapter_id", chapter.id);
      
      chapter.chunk_count = chunkCount || 0;
    }
    
    res.json({ ok: true, chapters: chapters || [] });
    
  } catch (error) {
    console.error("Error fetching chapters:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET CHAPTER CONTENT (for study)
// ============================================

router.get("/chapter-content", requireAuth, async (req, res) => {
  try {
    const { chapterId } = req.query;
    
    if (!chapterId) {
      return res.status(400).json({ ok: false, error: "chapterId is required" });
    }
    
    // Get chapter details
    const { data: chapter, error: chapterError } = await sbAdmin
      .from("chapters")
      .select("id, chapter_number, chapter_title, module_id")
      .eq("id", chapterId)
      .single();
    
    if (chapterError) throw chapterError;
    
    // Get chapter chunks
    const { data: chunks, error: chunksError } = await sbAdmin
      .from("chapter_chunks")
      .select("chunk_index, text")
      .eq("chapter_id", chapterId)
      .order("chunk_index", { ascending: true });
    
    if (chunksError) throw chunksError;
    
    // Combine chunks into full text
    const fullText = chunks?.map(c => c.text).join("\n\n") || "";
    
    // Extract key concepts
    const keyConcepts = extractKeyConcepts(fullText);
    
    res.json({
      ok: true,
      chapter: {
        id: chapter.id,
        number: chapter.chapter_number,
        title: chapter.chapter_title,
        content: fullText,
        chunks: chunks || [],
        key_concepts: keyConcepts
      }
    });
    
  } catch (error) {
    console.error("Error fetching chapter content:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET PAST EXAMS FOR MODULE
// ============================================

router.get("/past-exams", requireAuth, async (req, res) => {
  try {
    const { moduleId, courseId } = req.query;
    const sourceExamTypes = getSourceExamTypes(req.query);
    
    if (!moduleId && !courseId) {
      return res.status(400).json({ ok: false, error: "moduleId or courseId is required" });
    }
    
    let query = sbAdmin
      .from("exams")
      .select(`
        id,
        title,
        description,
        exam_type,
        year,
        term,
        duration_minutes,
        total_marks,
        file_url,
        created_at
      `);
    
    if (moduleId) {
      query = query.eq("module_id", moduleId);
    } else if (courseId) {
      query = query.eq("course_id", courseId);
    }
    query = query.in("exam_type", sourceExamTypes);
    
    const { data: exams, error } = await query
      .order("year", { ascending: false })
      .order("term", { ascending: false });
    
    if (error) throw error;
    
    // Get question counts for each exam
    for (const exam of exams || []) {
      const { count: questionCount } = await sbAdmin
        .from("exam_question_bank")
        .select("*", { count: "exact", head: true })
        .eq("exam_id", exam.id);
      
      exam.question_count = questionCount || 0;
    }
    
    res.json({ ok: true, exams: exams || [] });
    
  } catch (error) {
    console.error("Error fetching past exams:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET EXAM QUESTIONS FROM QUESTION BANK
// ============================================

router.get("/exam-questions", requireAuth, async (req, res) => {
  try {
    const { moduleId, chapterId, examId, limit = 50 } = req.query;
    const sourceExamTypes = getSourceExamTypes(req.query);
    
    let query = sbAdmin
      .from("exam_question_bank")
      .select(`
        id,
        question_text,
        question_type,
        options,
        correct_answer,
        difficulty_level,
        topic_tags,
        bloom_taxonomy_level,
        marks,
        explanation,
        exam_id,
        chapter_id
      `);
    
    if (moduleId) query = query.eq("module_id", moduleId);
    if (chapterId) query = query.eq("chapter_id", chapterId);
    if (examId) query = query.eq("exam_id", examId);
    if (!examId && sourceExamTypes.length) {
      let examsQuery = sbAdmin
        .from("exams")
        .select("id")
        .in("exam_type", sourceExamTypes);

      if (moduleId) examsQuery = examsQuery.eq("module_id", moduleId);

      const { data: sourceExams, error: sourceExamsError } = await examsQuery;
      if (sourceExamsError) throw sourceExamsError;

      const sourceExamIds = (sourceExams || []).map(exam => exam.id);
      if (sourceExamIds.length === 0) {
        return res.json({ ok: true, questions: [] });
      }
      query = query.in("exam_id", sourceExamIds);
    }
    
    const { data: questions, error } = await query.limit(parseInt(limit));
    
    if (error) throw error;
    
    res.json({ ok: true, questions: questions || [] });
    
  } catch (error) {
    console.error("Error fetching exam questions:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GENERATE AI PREDICTIONS (uses existing endpoint)
// This endpoint exists in question-extractor.js
// But we'll add a direct one here as well
// ============================================

router.post("/generate-predictions", requireAuth, async (req, res) => {
  try {
    const { moduleId, chapterIds, count = 10 } = req.body;
    
    if (!moduleId || !chapterIds || chapterIds.length === 0) {
      return res.status(400).json({ ok: false, error: "moduleId and chapterIds are required" });
    }
    
    const allPredictions = [];
    
    // Get chapter concepts and exam patterns for each chapter
    for (const chapterId of chapterIds.slice(0, 3)) {
      // Get chapter content
      const { data: chunks, error: chunksError } = await sbAdmin
        .from("chapter_chunks")
        .select("text")
        .eq("chapter_id", chapterId)
        .limit(20);
      
      if (chunksError) continue;
      
      const chapterText = chunks?.map(c => c.text).join(" ") || "";
      const chapterConcepts = extractKeyConcepts(chapterText);
      
      // Get past exam questions for this chapter
      const { data: pastQuestions, error: questionsError } = await sbAdmin
        .from("exam_question_bank")
        .select("question_text, topic_tags, difficulty_level, question_type")
        .eq("chapter_id", chapterId)
        .limit(30);
      
      // Generate predictions based on chapter content and past questions
      const predictions = await generatePredictionsFromData(
        chapterConcepts,
        pastQuestions || [],
        Math.floor(count / chapterIds.length) || 3
      );
      
      allPredictions.push(...predictions);
    }
    
    res.json({
      ok: true,
      predictions: allPredictions.slice(0, count),
      total_generated: allPredictions.length
    });
    
  } catch (error) {
    console.error("Error generating predictions:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET TOPIC ANALYSIS
// ============================================

router.get("/topic-analysis", requireAuth, async (req, res) => {
  try {
    const { moduleId, chapterId } = req.query;
    
    if (!moduleId && !chapterId) {
      return res.status(400).json({ ok: false, error: "moduleId or chapterId is required" });
    }
    
    let query = sbAdmin.from("exam_question_bank").select("topic_tags, question_type, difficulty_level");
    
    if (chapterId) {
      query = query.eq("chapter_id", chapterId);
    } else if (moduleId) {
      query = query.eq("module_id", moduleId);
    }
    
    const { data: questions, error } = await query.limit(500);
    
    if (error) throw error;
    
    // Analyze topic frequency
    const topicFrequency = {};
    const typeDistribution = {};
    const difficultyDistribution = { easy: 0, medium: 0, hard: 0, expert: 0 };
    
    for (const q of questions || []) {
      // Topics
      for (const topic of q.topic_tags || []) {
        topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
      }
      
      // Types
      if (q.question_type) {
        typeDistribution[q.question_type] = (typeDistribution[q.question_type] || 0) + 1;
      }
      
      // Difficulty
      if (q.difficulty_level) {
        difficultyDistribution[q.difficulty_level]++;
      }
    }
    
    const topTopics = Object.entries(topicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15)
      .map(([topic, count]) => ({ topic, count, percentage: ((count / questions.length) * 100).toFixed(1) }));
    
    res.json({
      ok: true,
      analysis: {
        total_questions: questions.length,
        top_topics: topTopics,
        type_distribution: typeDistribution,
        difficulty_distribution: difficultyDistribution
      }
    });
    
  } catch (error) {
    console.error("Error getting topic analysis:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

function extractKeyConcepts(text) {
  if (!text) return [];
  
  const importantKeywords = ["important", "key", "critical", "essential", "main", "primary", "purpose", "goal", "definition", "concept", "principle", "framework", "methodology", "approach"];
  
  const sentences = text.split(/[.!?]+/).filter(s => s.trim().length > 30 && s.trim().length < 300);
  
  const importantSentences = sentences.filter(s => 
    importantKeywords.some(kw => s.toLowerCase().includes(kw))
  );
  
  const words = text.toLowerCase().split(/\s+/);
  const stopWords = new Set(['the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'being']);
  
  const wordFreq = {};
  for (const word of words) {
    const cleanWord = word.replace(/[^a-z]/g, '');
    if (cleanWord.length > 4 && !stopWords.has(cleanWord)) {
      wordFreq[cleanWord] = (wordFreq[cleanWord] || 0) + 1;
    }
  }
  
  const topWords = Object.entries(wordFreq)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 15)
    .map(([word]) => word);
  
  return {
    key_sentences: importantSentences.slice(0, 8),
    key_topics: topWords,
    total_sentences: sentences.length
  };
}

function formatModuleForSkills(module) {
  return {
    id: module?.id || "",
    name: module?.name || "",
    code: module?.code || "",
    course_id: module?.course_id || "",
    course_name: module?.courses?.name || "",
    course_code: module?.courses?.code || ""
  };
}

function titleCaseSkill(text) {
  return String(text || "")
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, letter => letter.toUpperCase());
}

function addSkill(skills, seen, title, category, evidence, confidence = "medium") {
  const cleanTitle = titleCaseSkill(title);
  if (!cleanTitle || cleanTitle.length < 4) return;
  const key = cleanTitle.toLowerCase();
  if (seen.has(key)) return;
  seen.add(key);
  skills.push({
    title: cleanTitle,
    category,
    evidence: String(evidence || "").trim(),
    confidence
  });
}

function extractOutcomeLines(text) {
  const source = String(text || "");
  if (!source.trim()) return [];

  const lines = source
    .split(/\r?\n|[.;]/)
    .map(line => line.replace(/^[\s\-*0-9.)]+/, "").trim())
    .filter(line => line.length >= 10 && line.length <= 180);

  const outcomeMarkers = [
    "outcome",
    "objective",
    "skill",
    "competenc",
    "able to",
    "understand",
    "apply",
    "analyse",
    "analyze",
    "evaluate",
    "design",
    "develop",
    "implement",
    "demonstrate",
    "explain",
    "identify",
    "use "
  ];

  return lines.filter(line => {
    const lower = line.toLowerCase();
    return outcomeMarkers.some(marker => lower.includes(marker));
  });
}

function groupSkills(skills) {
  const groups = new Map();
  for (const skill of skills) {
    const category = skill.category || "Module Skills";
    if (!groups.has(category)) groups.set(category, []);
    groups.get(category).push(skill);
  }
  return [...groups.entries()].map(([title, items]) => ({ title, skills: items }));
}

function extractModuleGuideSkills({ module, guide, chapters = [], questions = [] }) {
  const skills = [];
  const seen = new Set();
  const sourceParts = [
    guide?.title,
    guide?.description,
    module?.name,
    module?.code,
    ...(chapters || []).map(chapter => chapter.chapter_title)
  ];
  const guideText = sourceParts.filter(Boolean).join("\n");

  for (const line of extractOutcomeLines(guideText)) {
    addSkill(skills, seen, line, "Learning Outcomes", "Extracted from the module guide title, description, and module outline.", "high");
  }

  for (const chapter of chapters.slice(0, 8)) {
    addSkill(
      skills,
      seen,
      `Understand and apply ${chapter.chapter_title}`,
      "Module Topics",
      `Listed in the module chapters as ${chapter.chapter_number ? `Chapter ${chapter.chapter_number}: ` : ""}${chapter.chapter_title}.`,
      "medium"
    );
  }

  const topicCounts = {};
  for (const question of questions || []) {
    for (const topic of question.topic_tags || []) {
      const clean = String(topic || "").trim();
      if (clean.length >= 3) topicCounts[clean] = (topicCounts[clean] || 0) + 1;
    }
  }

  Object.entries(topicCounts)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .forEach(([topic, count]) => {
      addSkill(
        skills,
        seen,
        `Apply ${topic} in assessments and practical tasks`,
        "Assessment Skills",
        `This topic appears in ${count} question-bank item${count === 1 ? "" : "s"} for the module.`,
        "medium"
      );
    });

  if (!skills.length) {
    addSkill(skills, seen, `Build practical knowledge in ${module?.name || "this module"}`, "Module Skills", "Generated from the module name because no guide outcomes were available.", "low");
    addSkill(skills, seen, "Prepare for module assessments using the published guide", "Assessment Skills", "Generated from the published module guide record.", "low");
  }

  const moduleName = module?.name || guide?.title || "this module";
  return {
    skills,
    skill_groups: groupSkills(skills),
    summary: `Completing ${moduleName} should help you build ${skills.length} tracked skill${skills.length === 1 ? "" : "s"} from the published module guide and related module content.`,
    source: guide?.description ? "module-guide-description" : "module-guide-metadata"
  };
}

async function generatePredictionsFromData(chapterConcepts, pastQuestions, count) {
  const predictions = [];
  
  if (!chapterConcepts || !chapterConcepts.key_topics) {
    return generateGenericPredictions(count);
  }
  
  const topics = chapterConcepts.key_topics.slice(0, 8);
  
  // Analyze past questions for patterns
  const pastTopics = {};
  for (const q of pastQuestions) {
    for (const topic of q.topic_tags || []) {
      pastTopics[topic] = (pastTopics[topic] || 0) + 1;
    }
  }
  
  const highPriorityTopics = topics.filter(t => pastTopics[t]);
  
  const templates = [
    { type: "short_answer", difficulty: "medium", template: "Explain the concept of {topic} and its importance." },
    { type: "short_answer", difficulty: "easy", template: "What is {topic}? Provide a clear definition." },
    { type: "essay", difficulty: "hard", template: "Discuss the key aspects of {topic} with relevant examples." },
    { type: "multiple_choice", difficulty: "easy", template: "Which of the following best describes {topic}?" },
    { type: "calculation", difficulty: "hard", template: "Solve a practical problem related to {topic}." },
    { type: "compare", difficulty: "medium", template: "Compare and contrast different approaches to {topic}." }
  ];
  
  const usedTopics = highPriorityTopics.length > 0 ? highPriorityTopics : topics;
  
  for (let i = 0; i < Math.min(count, usedTopics.length + 3); i++) {
    const topic = usedTopics[i % usedTopics.length];
    const template = templates[i % templates.length];
    
    let questionText = template.template.replace("{topic}", topic.charAt(0).toUpperCase() + topic.slice(1));
    
    if (template.type === "compare") {
      questionText = `Compare and contrast different approaches to ${topic}, highlighting their strengths and weaknesses.`;
    }
    
    let predictionReason = "";
    if (highPriorityTopics.includes(topic)) {
      predictionReason = `This topic appears frequently in past exams (${pastTopics[topic] || 0} times) and is emphasized in the chapter.`;
    } else if (pastTopics[topic]) {
      predictionReason = `Based on past exam patterns, this topic has been tested before.`;
    } else {
      predictionReason = `This is a key concept from the chapter that is likely to be assessed.`;
    }
    
    predictions.push({
      question_text: questionText,
      question_type: template.type === "compare" ? "essay" : template.type,
      difficulty: template.difficulty,
      topic_tags: [topic],
      prediction_reason: predictionReason,
      suggested_answer: `Review the chapter section on ${topic} for the complete answer. Focus on key definitions, examples, and applications.`
    });
  }
  
  return predictions;
}

function generateGenericPredictions(count) {
  const genericQuestions = [
    { text: "Explain the main objectives of this chapter and how they relate to real-world applications.", type: "essay", difficulty: "medium", topics: ["objectives", "applications"] },
    { text: "What are the key concepts covered in this chapter? Provide brief explanations for each.", type: "short_answer", difficulty: "easy", topics: ["key concepts"] },
    { text: "Describe a practical scenario where you would apply the knowledge from this chapter.", type: "essay", difficulty: "medium", topics: ["practical application"] },
    { text: "Identify and explain the most important terms introduced in this chapter.", type: "short_answer", difficulty: "easy", topics: ["terminology"] },
    { text: "Compare and contrast the different approaches discussed in this chapter.", type: "essay", difficulty: "hard", topics: ["comparison"] },
    { text: "What are the potential challenges or limitations of the methods described?", type: "short_answer", difficulty: "medium", topics: ["limitations"] }
  ];
  
  return genericQuestions.slice(0, count).map(q => ({
    question_text: q.text,
    question_type: q.type,
    difficulty: q.difficulty,
    topic_tags: q.topics,
    prediction_reason: "Based on standard exam patterns for this subject area.",
    suggested_answer: "Review the chapter material thoroughly for comprehensive answers."
  }));
}

// ============================================
// GET MODULE STATS (for dashboard)
// ============================================

router.get("/module-stats", requireAuth, async (req, res) => {
  try {
    const { moduleId } = req.query;
    
    if (!moduleId) {
      return res.status(400).json({ ok: false, error: "moduleId is required" });
    }
    
    // Get chapter count
    const { count: chapterCount, error: chapterError } = await sbAdmin
      .from("chapters")
      .select("*", { count: "exact", head: true })
      .eq("module_id", moduleId);
    
    // Get exam count
    const { count: examCount, error: examError } = await sbAdmin
      .from("exams")
      .select("*", { count: "exact", head: true })
      .eq("module_id", moduleId);
    
    // Get question count
    const { count: questionCount, error: questionError } = await sbAdmin
      .from("exam_question_bank")
      .select("*", { count: "exact", head: true })
      .eq("module_id", moduleId);
    
    // Get topic distribution
    const { data: questions, error: topicsError } = await sbAdmin
      .from("exam_question_bank")
      .select("topic_tags")
      .eq("module_id", moduleId)
      .limit(200);
    
    const topicFrequency = {};
    for (const q of questions || []) {
      for (const topic of q.topic_tags || []) {
        topicFrequency[topic] = (topicFrequency[topic] || 0) + 1;
      }
    }
    
    const topTopics = Object.entries(topicFrequency)
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([topic, count]) => ({ topic, count }));
    
    res.json({
      ok: true,
      stats: {
        chapters: chapterCount || 0,
        exams: examCount || 0,
        questions: questionCount || 0,
        top_topics: topTopics
      }
    });
    
  } catch (error) {
    console.error("Error getting module stats:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// SAVE STUDY PROGRESS
// ============================================

router.post("/save-progress", requireAuth, async (req, res) => {
  try {
    const { chapterId, completed, notes, timeSpent } = req.body;
    const userId = req.user.id;
    
    const { data, error } = await sbAdmin
      .from("study_progress")
      .upsert({
        user_id: userId,
        chapter_id: chapterId,
        completed: completed || false,
        notes: notes || null,
        time_spent: timeSpent || 0,
        last_studied: new Date(),
        updated_at: new Date()
      }, {
        onConflict: 'user_id,chapter_id'
      });
    
    if (error) throw error;
    
    res.json({ ok: true, message: "Progress saved" });
    
  } catch (error) {
    console.error("Error saving progress:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// GET STUDY PROGRESS
// ============================================

router.get("/study-progress", requireAuth, async (req, res) => {
  try {
    const { moduleId } = req.query;
    const userId = req.user.id;
    
    let query = sbAdmin
      .from("study_progress")
      .select(`
        chapter_id,
        completed,
        notes,
        time_spent,
        last_studied,
        chapters (chapter_number, chapter_title, module_id)
      `)
      .eq("user_id", userId);
    
    if (moduleId) {
      query = query.eq("chapters.module_id", moduleId);
    }
    
    const { data: progress, error } = await query;
    
    if (error) throw error;
    
    res.json({ ok: true, progress: progress || [] });
    
  } catch (error) {
    console.error("Error getting progress:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

export default router;
