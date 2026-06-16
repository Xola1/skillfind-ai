import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

const ACTIVITY_TYPES = new Set(["quiz", "flashcard", "word_builder", "invader"]);

function clampNumber(value, min, max, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function cleanText(value, fallback = "") {
  return String(value ?? fallback).trim();
}

function maybeUuid(value) {
  const text = cleanText(value);
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(text)
    ? text
    : null;
}

async function requireRole(req, res, next, role) {
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { data, error } = await sbAdmin.auth.getUser(token);
    if (error || !data?.user) return res.status(401).json({ ok: false, error: "Invalid token" });

    const { data: profile, error: profileError } = await sbAdmin
      .from("profiles")
      .select("role, full_name")
      .eq("id", data.user.id)
      .single();

    if (profileError || profile?.role !== role) {
      return res.status(403).json({ ok: false, error: `Forbidden: ${role} only.` });
    }

    req.user = data.user;
    req.profile = profile;
    next();
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Auth error" });
  }
}

const requireStudent = (req, res, next) => requireRole(req, res, next, "student");
const requireAdmin = (req, res, next) => requireRole(req, res, next, "admin");

async function verifyChapterAccess(studentId, chapterId) {
  if (!chapterId) return null;

  const { data: chapter, error } = await sbAdmin
    .from("chapters")
    .select("id, module_id")
    .eq("id", chapterId)
    .single();

  if (error || !chapter) throw Object.assign(new Error("Chapter not found."), { status: 404 });

  const { data: enrollment, error: enrollmentError } = await sbAdmin
    .from("enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("module_id", chapter.module_id)
    .maybeSingle();

  if (enrollmentError) throw enrollmentError;
  if (!enrollment) throw Object.assign(new Error("Not enrolled in this chapter's module."), { status: 403 });

  return chapter;
}

async function bumpQuestionStats(events) {
  const questionIds = [...new Set(events.map(event => event.question_id).filter(Boolean))];
  for (const questionId of questionIds) {
    const related = events.filter(event => event.question_id === questionId);
    const correctDelta = related.filter(event => event.is_correct).length;

    const { data: row, error } = await sbAdmin
      .from("study_question_bank")
      .select("times_answered, times_correct")
      .eq("id", questionId)
      .maybeSingle();

    if (error || !row) continue;

    await sbAdmin
      .from("study_question_bank")
      .update({
        times_answered: (row.times_answered || 0) + related.length,
        times_correct: (row.times_correct || 0) + correctDelta
      })
      .eq("id", questionId);
  }
}

router.post("/attempts", requireStudent, async (req, res) => {
  try {
    const activityType = cleanText(req.body?.activityType || req.body?.activity_type).toLowerCase();
    if (!ACTIVITY_TYPES.has(activityType)) {
      return res.status(400).json({ ok: false, error: "Invalid activityType" });
    }

    const studentId = req.user.id;
    const moduleId = maybeUuid(req.body?.moduleId || req.body?.module_id);
    const chapterId = maybeUuid(req.body?.chapterId || req.body?.chapter_id);

    if (chapterId) await verifyChapterAccess(studentId, chapterId);

    const score = clampNumber(req.body?.score, 0, 100000, 0);
    const maxScore = clampNumber(req.body?.maxScore || req.body?.max_score, 0, 100000, 0);
    const correctCount = clampNumber(req.body?.correctCount || req.body?.correct_count, 0, 100000, 0);
    const incorrectCount = clampNumber(req.body?.incorrectCount || req.body?.incorrect_count, 0, 100000, 0);
    const total = correctCount + incorrectCount;
    const accuracy = clampNumber(
      req.body?.accuracy,
      0,
      100,
      total ? Math.round((correctCount / total) * 100) : 0
    );
    const timeTaken = clampNumber(req.body?.timeTaken || req.body?.time_taken, 0, 86400, 0);
    const participationCount = clampNumber(req.body?.participationCount || req.body?.participation_count, 0, 100000, 1);
    const metadata = req.body?.metadata && typeof req.body.metadata === "object" ? req.body.metadata : {};

    const { data: attempt, error: attemptError } = await sbAdmin
      .from("activity_attempts")
      .insert([{
        activity_type: activityType,
        student_id: studentId,
        module_id: moduleId,
        chapter_id: chapterId,
        score,
        max_score: maxScore,
        accuracy,
        correct_count: correctCount,
        incorrect_count: incorrectCount,
        participation_count: participationCount,
        time_taken: timeTaken,
        metadata
      }])
      .select("*")
      .single();

    if (attemptError) throw attemptError;

    const answerEvents = Array.isArray(req.body?.answers) ? req.body.answers.slice(0, 100) : [];
    const eventRows = answerEvents.map(answer => {
      const topicTags = Array.isArray(answer?.topicTags || answer?.topic_tags)
        ? (answer.topicTags || answer.topic_tags).map(tag => cleanText(tag)).filter(Boolean).slice(0, 8)
        : [];

      return {
        attempt_id: attempt.id,
        activity_type: activityType,
        student_id: studentId,
        module_id: moduleId,
        chapter_id: chapterId,
        question_id: maybeUuid(answer?.questionId || answer?.question_id),
        question_text: cleanText(answer?.questionText || answer?.question_text).slice(0, 1000) || null,
        topic_tags: topicTags,
        selected_answer: cleanText(answer?.selectedAnswer || answer?.selected_answer).slice(0, 500) || null,
        correct_answer: cleanText(answer?.correctAnswer || answer?.correct_answer).slice(0, 500) || null,
        is_correct: Boolean(answer?.isCorrect ?? answer?.is_correct)
      };
    });

    if (eventRows.length) {
      const { error: eventError } = await sbAdmin.from("activity_answer_events").insert(eventRows);
      if (eventError) throw eventError;
      await bumpQuestionStats(eventRows);
    }

    res.json({ ok: true, attempt });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Could not save attempt" });
  }
});

router.get("/leaderboard", requireStudent, async (req, res) => {
  try {
    const activityType = cleanText(req.query?.activityType || req.query?.activity_type || "quiz").toLowerCase();
    if (!ACTIVITY_TYPES.has(activityType)) {
      return res.status(400).json({ ok: false, error: "Invalid activityType" });
    }

    const chapterId = maybeUuid(req.query?.chapterId || req.query?.chapter_id);
    const limit = Math.min(clampNumber(req.query?.limit, 1, 50, 10), 50);

    let query = sbAdmin
      .from("activity_attempts")
      .select("id, activity_type, student_id, chapter_id, score, accuracy, correct_count, incorrect_count, participation_count, time_taken, created_at, profiles(full_name)")
      .eq("activity_type", activityType)
      .order("score", { ascending: false })
      .limit(500);

    if (chapterId) query = query.eq("chapter_id", chapterId);

    const { data, error } = await query;
    if (error) throw error;

    const byStudent = new Map();
    for (const row of data || []) {
      const current = byStudent.get(row.student_id);
      const better = !current
        || (row.score || 0) > (current.score || 0)
        || ((row.score || 0) === (current.score || 0) && (row.accuracy || 0) > (current.accuracy || 0))
        || ((row.score || 0) === (current.score || 0) && (row.accuracy || 0) === (current.accuracy || 0) && (row.time_taken || 0) < (current.time_taken || 0));
      if (better) byStudent.set(row.student_id, row);
    }

    const leaderboard = [...byStudent.values()]
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.accuracy || 0) - (a.accuracy || 0) || (a.time_taken || 0) - (b.time_taken || 0))
      .slice(0, limit)
      .map((row, index) => ({
        rank: index + 1,
        student_id: row.student_id,
        student_name: row.profiles?.full_name || "Student",
        score: row.score,
        accuracy: row.accuracy,
        correct_count: row.correct_count,
        incorrect_count: row.incorrect_count,
        participation_count: row.participation_count,
        time_taken: row.time_taken,
        created_at: row.created_at
      }));

    res.json({ ok: true, activityType, leaderboard });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not load leaderboard" });
  }
});

router.get("/admin/analytics", requireAdmin, async (req, res) => {
  try {
    const { data: attempts, error: attemptsError } = await sbAdmin
      .from("activity_attempts")
      .select("id, activity_type, student_id, module_id, chapter_id, score, max_score, accuracy, correct_count, incorrect_count, participation_count, time_taken, created_at, profiles(full_name), chapters(chapter_title)")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (attemptsError) throw attemptsError;

    const { data: gameScores, error: gameScoresError } = await sbAdmin
      .from("game_scores")
      .select("id, student_id, chapter_id, score, accuracy, time_taken, xp_earned, level_reached, game_mode, created_at, profiles(full_name), chapters(chapter_title)")
      .order("created_at", { ascending: false })
      .limit(1000);

    if (gameScoresError) throw gameScoresError;

    const { data: events, error: eventsError } = await sbAdmin
      .from("activity_answer_events")
      .select("activity_type, student_id, question_text, topic_tags, is_correct, created_at")
      .order("created_at", { ascending: false })
      .limit(3000);

    if (eventsError) throw eventsError;

    const invaderAttempts = (gameScores || []).map(row => ({
      id: row.id,
      activity_type: "invader",
      student_id: row.student_id,
      module_id: null,
      chapter_id: row.chapter_id,
      score: row.score || 0,
      max_score: row.score || 0,
      accuracy: row.accuracy || 0,
      correct_count: 0,
      incorrect_count: 0,
      participation_count: 1,
      time_taken: row.time_taken || 0,
      created_at: row.created_at,
      profiles: row.profiles,
      chapters: row.chapters
    }));

    const safeAttempts = [...(attempts || []), ...invaderAttempts];
    const safeEvents = events || [];
    const activeStudents = new Set(safeAttempts.map(row => row.student_id).filter(Boolean));
    const totalQuestions = safeAttempts.reduce((sum, row) => sum + (row.correct_count || 0) + (row.incorrect_count || 0), 0);
    const avgAccuracy = safeAttempts.length
      ? Math.round(safeAttempts.reduce((sum, row) => sum + (Number(row.accuracy) || 0), 0) / safeAttempts.length)
      : 0;

    const leaderboardMap = new Map();
    for (const row of safeAttempts) {
      const key = `${row.activity_type}:${row.student_id}`;
      const current = leaderboardMap.get(key);
      if (!current) {
        leaderboardMap.set(key, { ...row, attempts: 1, total_score: row.score || 0 });
      } else {
        current.attempts += 1;
        current.total_score += row.score || 0;
        if ((row.score || 0) > (current.score || 0)) Object.assign(current, { ...row, attempts: current.attempts, total_score: current.total_score });
      }
    }

    const leaderboards = [...leaderboardMap.values()]
      .sort((a, b) => (b.score || 0) - (a.score || 0) || (b.accuracy || 0) - (a.accuracy || 0))
      .slice(0, 25)
      .map(row => ({
        activity_type: row.activity_type,
        student_name: row.profiles?.full_name || "Student",
        score: row.score,
        accuracy: row.accuracy,
        attempts: row.attempts,
        total_score: row.total_score,
        chapter_title: row.chapters?.chapter_title || ""
      }));

    const participantMap = new Map();
    for (const row of safeAttempts) {
      const entry = participantMap.get(row.student_id) || {
        student_name: row.profiles?.full_name || "Student",
        attempts: 0,
        total_score: 0,
        avg_accuracy_total: 0
      };
      entry.attempts += 1;
      entry.total_score += row.score || 0;
      entry.avg_accuracy_total += Number(row.accuracy) || 0;
      participantMap.set(row.student_id, entry);
    }

    const participants = [...participantMap.values()]
      .map(row => ({ ...row, avg_accuracy: row.attempts ? Math.round(row.avg_accuracy_total / row.attempts) : 0 }))
      .sort((a, b) => b.attempts - a.attempts || b.total_score - a.total_score)
      .slice(0, 15);

    const topicMap = new Map();
    const correctnessMap = new Map();
    for (const event of safeEvents) {
      const tags = Array.isArray(event.topic_tags) && event.topic_tags.length ? event.topic_tags : ["General"];
      for (const tag of tags) {
        const label = cleanText(tag, "General");
        const topic = topicMap.get(label) || { topic: label, count: 0, correct: 0, incorrect: 0 };
        topic.count += 1;
        if (event.is_correct) topic.correct += 1;
        else topic.incorrect += 1;
        topicMap.set(label, topic);
      }

      const question = cleanText(event.question_text, "Untitled question").slice(0, 180);
      const stat = correctnessMap.get(question) || { question, attempts: 0, correct: 0, incorrect: 0 };
      stat.attempts += 1;
      if (event.is_correct) stat.correct += 1;
      else stat.incorrect += 1;
      correctnessMap.set(question, stat);
    }

    const topics = [...topicMap.values()].sort((a, b) => b.count - a.count).slice(0, 15);
    const mostCorrect = [...correctnessMap.values()].sort((a, b) => b.correct - a.correct || b.attempts - a.attempts).slice(0, 10);
    const mostIncorrect = [...correctnessMap.values()].sort((a, b) => b.incorrect - a.incorrect || b.attempts - a.attempts).slice(0, 10);

    res.json({
      ok: true,
      summary: {
        total_attempts: safeAttempts.length,
        active_students: activeStudents.size,
        total_questions: totalQuestions,
        average_accuracy: avgAccuracy
      },
      leaderboards,
      participants,
      topics,
      most_correct: mostCorrect,
      most_incorrect: mostIncorrect
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not load analytics" });
  }
});

export default router;
