// ============================================
// TEST-SERVER.JS - Test Study Mode API Routes
// ============================================

import express from "express";
import examRoutes from "./exam-server.js";

const router = express.Router();

function forcePracticeTestBody(req) {
  req.body = {
    ...(req.body || {}),
    studyMode: "test",
    examType: "practice_test",
    examTypes: ["practice_test"]
  };
}

function forcePracticeTestQuery(req) {
  req.query.studyMode = "test";
  req.query.examType = "practice_test";
}

router.use((req, res, next) => {
  if (req.path === "/api/test/predict-questions") {
    forcePracticeTestBody(req);
    req.url = req.url.replace("/api/test/predict-questions", "/api/exam/predict-questions");
    return next();
  }

  if (req.path === "/api/test/study-guide") {
    forcePracticeTestBody(req);
    req.url = req.url.replace("/api/test/study-guide", "/api/exam/study-guide");
    return next();
  }

  if (req.path === "/past-tests") {
    forcePracticeTestQuery(req);
    req.url = req.url.replace("/past-tests", "/past-exams");
    return next();
  }

  if (req.path === "/test-questions") {
    forcePracticeTestQuery(req);
    req.url = req.url.replace("/test-questions", "/exam-questions");
    return next();
  }

  return next("router");
});

router.use(examRoutes);

export default router;
