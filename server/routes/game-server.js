// ============================================
// SKILLFIND AI - INVADER CHALLENGE GAME API
// Stores arcade results, leaderboard rows, XP, and badges.
// Question generation remains owned by existing quiz/predictor routes.
// ============================================

import express from "express";
import { createClient } from "@supabase/supabase-js";

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

async function requireStudent(req, res, next) {
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

    if (profileError || profile?.role !== "student") {
      return res.status(403).json({ ok: false, error: "Forbidden: Students only." });
    }

    req.user = data.user;
    req.profile = profile;
    next();
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Auth error" });
  }
}

function clampNumber(value, min, max, fallback = 0) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function normalizeSkillName(value) {
  const text = String(value || "").trim();
  return text || "Problem Solving";
}

function getBadges({ score, accuracy, levelReached, gameMode }) {
  const badges = [];
  if (score > 0) badges.push({ code: "first_victory", name: "First Victory" });
  if (accuracy >= 80) badges.push({ code: "quiz_master", name: "Quiz Master" });
  if (levelReached >= 5) badges.push({ code: "chapter_conqueror", name: "Chapter Conqueror" });
  if (gameMode === "boss" && score > 0) badges.push({ code: "exam_slayer", name: "Exam Slayer" });
  if (accuracy >= 90 && score >= 300) badges.push({ code: "skill_expert", name: "Skillname Expert" });
  return badges;
}

const BADGE_STARS = {
  first_victory: 1,
  quiz_master: 2,
  chapter_conqueror: 3,
  exam_slayer: 4,
  skill_expert: 5
};

function badgeStars(code) {
  return BADGE_STARS[String(code || "").trim()] || 1;
}

async function verifyChapterAccess(studentId, chapterId) {
  const { data, error } = await sbAdmin
    .from("chapters")
    .select("id, module_id, modules(id)")
    .eq("id", chapterId)
    .single();

  if (error || !data) throw Object.assign(new Error("Chapter not found."), { status: 404 });

  const { data: enrollment, error: enrollmentError } = await sbAdmin
    .from("enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("module_id", data.module_id)
    .maybeSingle();

  if (enrollmentError) throw enrollmentError;
  if (!enrollment) throw Object.assign(new Error("Not enrolled in this chapter's module."), { status: 403 });

  return data;
}

router.use(requireStudent);

router.post("/scores", async (req, res) => {
  try {
    const studentId = req.user.id;
    const chapterId = String(req.body?.chapterId || "").trim();
    if (!chapterId) return res.status(400).json({ ok: false, error: "chapterId is required" });

    const chapter = await verifyChapterAccess(studentId, chapterId);

    const score = clampNumber(req.body?.score, 0, 100000, 0);
    const accuracy = clampNumber(req.body?.accuracy, 0, 100, 0);
    const timeTaken = clampNumber(req.body?.timeTaken, 0, 86400, 0);
    const levelReached = clampNumber(req.body?.levelReached, 1, 100, 1);
    const xpEarned = clampNumber(req.body?.xpEarned, 0, 100000, 0);
    const gameMode = String(req.body?.gameMode || "standard").trim() === "boss" ? "boss" : "standard";
    const skillRewards = Array.isArray(req.body?.skillRewards) ? req.body.skillRewards : [];

    const { data: scoreRow, error: scoreError } = await sbAdmin
      .from("game_scores")
      .insert([{
        student_id: studentId,
        chapter_id: chapterId,
        score,
        accuracy,
        time_taken: timeTaken,
        xp_earned: xpEarned,
        level_reached: levelReached,
        game_mode: gameMode
      }])
      .select("*")
      .single();

    if (scoreError) throw scoreError;

    const totalAttempts = clampNumber(req.body?.attempts, 0, 100000, 0);
    const correctCount = clampNumber(req.body?.correctCount || req.body?.correct_count, 0, 100000, 0);
    const incorrectCount = totalAttempts && correctCount <= totalAttempts
      ? totalAttempts - correctCount
      : 0;

    const { error: activityError } = await sbAdmin
      .from("activity_attempts")
      .insert([{
        activity_type: "invader",
        student_id: studentId,
        module_id: chapter.module_id || null,
        chapter_id: chapterId,
        score,
        max_score: 0,
        accuracy,
        correct_count: correctCount,
        incorrect_count: incorrectCount,
        participation_count: levelReached,
        time_taken: timeTaken,
        metadata: {
          gameScoreId: scoreRow.id,
          xpEarned,
          levelReached,
          gameMode
        }
      }]);

    if (activityError) {
      console.warn("Could not mirror invader score to activity_attempts:", activityError.message);
    }

    for (const reward of skillRewards.slice(0, 8)) {
      const skillName = normalizeSkillName(reward?.skill);
      const xp = clampNumber(reward?.xp, 0, 10000, 0);
      if (!xp) continue;

      const { data: existing } = await sbAdmin
        .from("student_skill_xp")
        .select("id, xp")
        .eq("student_id", studentId)
        .eq("chapter_id", chapterId)
        .eq("skill_name", skillName)
        .maybeSingle();

      if (existing) {
        await sbAdmin
          .from("student_skill_xp")
          .update({ xp: (existing.xp || 0) + xp, updated_at: new Date().toISOString() })
          .eq("id", existing.id);
      } else {
        await sbAdmin
          .from("student_skill_xp")
          .insert([{ student_id: studentId, chapter_id: chapterId, skill_name: skillName, xp }]);
      }
    }

    const awardedBadges = getBadges({ score, accuracy, levelReached, gameMode });
    for (const badge of awardedBadges) {
      await sbAdmin
        .from("student_badges")
        .upsert([{
          student_id: studentId,
          chapter_id: chapterId,
          badge_code: badge.code,
          badge_name: badge.name
        }], { onConflict: "student_id,chapter_id,badge_code" });
    }

    res.json({ ok: true, score: scoreRow, badges: awardedBadges });
  } catch (error) {
    res.status(error.status || 500).json({ ok: false, error: error.message || "Could not save score" });
  }
});

router.get("/leaderboard", async (req, res) => {
  try {
    const chapterId = String(req.query?.chapterId || "").trim();
    const metric = String(req.query?.metric || "score").trim();
    const limit = Math.min(clampNumber(req.query?.limit, 1, 50, 10), 50);

    let orderColumn = "score";
    let ascending = false;
    if (metric === "xp") orderColumn = "xp_earned";
    if (metric === "accuracy") orderColumn = "accuracy";
    if (metric === "fastest") {
      orderColumn = "time_taken";
      ascending = true;
    }

    let query = sbAdmin
      .from("game_scores")
      .select("id, student_id, chapter_id, score, accuracy, time_taken, xp_earned, level_reached, game_mode, created_at, profiles(full_name)")
      .order(orderColumn, { ascending })
      .limit(500);

    if (chapterId) query = query.eq("chapter_id", chapterId);

    const { data, error } = await query;
    if (error) throw error;

    const betterForMetric = (next, current) => {
      if (!current) return true;
      if (metric === "fastest") {
        if ((next.time_taken || 0) !== (current.time_taken || 0)) return (next.time_taken || 0) < (current.time_taken || 0);
        return (next.score || 0) > (current.score || 0);
      }
      if (metric === "xp") {
        if ((next.xp_earned || 0) !== (current.xp_earned || 0)) return (next.xp_earned || 0) > (current.xp_earned || 0);
        return (next.score || 0) > (current.score || 0);
      }
      if (metric === "accuracy") {
        if ((next.accuracy || 0) !== (current.accuracy || 0)) return (next.accuracy || 0) > (current.accuracy || 0);
        return (next.score || 0) > (current.score || 0);
      }
      if ((next.score || 0) !== (current.score || 0)) return (next.score || 0) > (current.score || 0);
      return (next.xp_earned || 0) > (current.xp_earned || 0);
    };

    const byStudent = new Map();
    for (const row of data || []) {
      const current = byStudent.get(row.student_id);
      if (betterForMetric(row, current)) byStudent.set(row.student_id, row);
    }

    const ranked = [...byStudent.values()].sort((a, b) => {
      if (metric === "fastest") return (a.time_taken || 0) - (b.time_taken || 0) || (b.score || 0) - (a.score || 0);
      if (metric === "xp") return (b.xp_earned || 0) - (a.xp_earned || 0) || (b.score || 0) - (a.score || 0);
      if (metric === "accuracy") return (b.accuracy || 0) - (a.accuracy || 0) || (b.score || 0) - (a.score || 0);
      return (b.score || 0) - (a.score || 0) || (b.xp_earned || 0) - (a.xp_earned || 0);
    }).slice(0, limit);

    const rows = ranked.map((row, index) => ({
      rank: index + 1,
      student_id: row.student_id,
      student_name: row.profiles?.full_name || "Student",
      score: row.score,
      accuracy: row.accuracy,
      time_taken: row.time_taken,
      xp_earned: row.xp_earned,
      level_reached: row.level_reached,
      game_mode: row.game_mode,
      created_at: row.created_at
    }));

    res.json({ ok: true, metric, leaderboard: rows });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not load leaderboard" });
  }
});

router.get("/profile", async (req, res) => {
  try {
    const studentId = req.user.id;
    const chapterId = String(req.query?.chapterId || "").trim();

    let skillQuery = sbAdmin
      .from("student_skill_xp")
      .select("skill_name, xp, updated_at, chapter_id")
      .eq("student_id", studentId)
      .order("xp", { ascending: false });

    let badgeQuery = sbAdmin
      .from("student_badges")
      .select("badge_code, badge_name, earned_at, chapter_id")
      .eq("student_id", studentId)
      .order("earned_at", { ascending: false });

    let bestQuery = sbAdmin
      .from("game_scores")
      .select("score, accuracy, time_taken, xp_earned, level_reached, game_mode, created_at, chapter_id")
      .eq("student_id", studentId)
      .order("score", { ascending: false })
      .limit(5);

    if (chapterId) {
      await verifyChapterAccess(studentId, chapterId);
      skillQuery = skillQuery.eq("chapter_id", chapterId);
      badgeQuery = badgeQuery.eq("chapter_id", chapterId);
      bestQuery = bestQuery.eq("chapter_id", chapterId);
    }

    const [xpResult, badgesResult, bestResult] = await Promise.all([
      skillQuery,
      badgeQuery,
      bestQuery
    ]);

    if (xpResult.error) throw xpResult.error;
    if (badgesResult.error) throw badgesResult.error;
    if (bestResult.error) throw bestResult.error;

    res.json({
      ok: true,
      skills: xpResult.data || [],
      badges: (badgesResult.data || []).map(badge => ({
        ...badge,
        badge_stars: badgeStars(badge.badge_code)
      })),
      best_scores: bestResult.data || []
    });
  } catch (error) {
    res.status(500).json({ ok: false, error: error.message || "Could not load game profile" });
  }
});

export default router;
