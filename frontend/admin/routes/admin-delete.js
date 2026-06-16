// ============================================
// ADMIN-DELETE.JS - Complete Cascade Delete Operations
// Handles: courses, modules, chapters, exams, and all related data
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
  try {
    const auth = req.headers.authorization || "";
    const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
    if (!token) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { data: user, error } = await sbAdmin.auth.getUser(token);
    if (error || !user?.user) {
      return res.status(401).json({ ok: false, error: "Invalid token" });
    }

    const { data: prof, error: profError } = await sbAdmin
      .from("profiles")
      .select("role")
      .eq("id", user.user.id)
      .single();

    if (profError || prof?.role !== "admin") {
      return res.status(403).json({ ok: false, error: "Forbidden: Admins only" });
    }

    req.user = user.user;
    next();
  } catch (e) {
    console.error("Auth error:", e);
    res.status(500).json({ ok: false, error: e.message || "Auth error" });
  }
}

// ============================================
// DELETE COURSE - Complete cascade
// Deletes: modules, chapters, chunks, exams, questions, chat, predictions, etc.
// Preserves: student profiles (only removes course_id association)
// ============================================

router.delete("/courses/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    
    console.log(`🗑️ Deleting course: ${id}`);
    
    // 1. Get all modules in this course
    const { data: modules, error: modulesError } = await sbAdmin
      .from("modules")
      .select("id")
      .eq("course_id", id);
    
    if (modulesError) throw modulesError;
    
    // 2. Delete all modules and their data (using the module delete logic)
    for (const module of modules || []) {
      await deleteModuleComplete(module.id);
    }
    
    // 3. Delete course-level exams (no module_id)
    const { data: courseExams } = await sbAdmin
      .from("exams")
      .select("id, file_url")
      .eq("course_id", id)
      .is("module_id", null);
    
    for (const exam of courseExams || []) {
      // Delete exam file from storage
      if (exam.file_url) {
        try {
          const fileName = exam.file_url.split('/').pop();
          await sbAdmin.storage.from("exam-files").remove([`exams/${fileName}`]);
        } catch (e) {
          console.error("Error deleting exam file:", e);
        }
      }
      // Delete exam questions
      await sbAdmin.from("study_question_bank").delete().eq("exam_id", exam.id);
      await sbAdmin.from("exam_question_bank").delete().eq("exam_id", exam.id);
      // Delete exam
      await sbAdmin.from("exams").delete().eq("id", exam.id);
    }
    
    // 4. Delete question patterns for this course
    await sbAdmin.from("question_patterns").delete().eq("course_id", id);
    
    // 5. Delete enrollment requests
    await sbAdmin.from("enrollment_requests").delete().eq("course_id", id);
    
    // 6. Update student profiles (preserve students, just remove course association)
    const { error: updateError } = await sbAdmin
      .from("profiles")
      .update({ course_id: null })
      .eq("course_id", id);
    
    if (updateError) console.error("Error updating students:", updateError);
    
    // 7. Delete the course itself
    const { error } = await sbAdmin.from("courses").delete().eq("id", id);
    if (error) throw error;
    
    console.log(`✅ Course ${id} deleted successfully`);
    
    res.json({ 
      ok: true, 
      message: "Course and all related data deleted successfully. Students preserved." 
    });
    
  } catch (error) {
    console.error("Error deleting course:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// DELETE MODULE - Complete cascade
// Deletes: chapters, chunks, exams, questions, chat, predictions, enrollments, etc.
// ============================================

router.delete("/modules/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Deleting module: ${id}`);
    
    await deleteModuleComplete(id);
    
    console.log(`✅ Module ${id} deleted successfully`);
    
    res.json({ 
      ok: true, 
      message: "Module and all related data deleted successfully" 
    });
    
  } catch (error) {
    console.error("Error deleting module:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// DELETE CHAPTER - Complete cascade
// Deletes: chunks, progress, and updates references to NULL
// ============================================

router.delete("/chapters/:chapterId", requireAdmin, async (req, res) => {
  try {
    const { chapterId } = req.params;
    console.log(`🗑️ Deleting chapter: ${chapterId}`);
    
    await deleteChapterComplete(chapterId);
    
    console.log(`✅ Chapter ${chapterId} deleted successfully`);
    
    res.json({ 
      ok: true, 
      message: "Chapter and all related data deleted successfully" 
    });
    
  } catch (error) {
    console.error("Error deleting chapter:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// DELETE EXAM
// Deletes: exam, its questions, and file from storage
// ============================================

router.delete("/exams/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Deleting exam: ${id}`);
    
    // Get exam details
    const { data: exam, error: fetchError } = await sbAdmin
      .from("exams")
      .select("file_url, file_name")
      .eq("id", id)
      .single();
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }
    
    // Delete exam file from storage
    if (exam?.file_url) {
      try {
        const fileName = exam.file_url.split('/').pop();
        await sbAdmin.storage.from("exam-files").remove([`exams/${fileName}`]);
        console.log(`  📁 Deleted file: ${fileName}`);
      } catch (storageError) {
        console.error("Error deleting exam file:", storageError);
      }
    }
    
    // Delete exam questions first (foreign key constraint)
    await sbAdmin
      .from("study_question_bank")
      .delete()
      .eq("exam_id", id);

    const { error: questionsError } = await sbAdmin
      .from("exam_question_bank")
      .delete()
      .eq("exam_id", id);
    
    if (questionsError) throw questionsError;
    
    // Delete the exam
    const { error } = await sbAdmin.from("exams").delete().eq("id", id);
    if (error) throw error;
    
    console.log(`✅ Exam ${id} deleted successfully`);
    
    res.json({ ok: true, message: "Exam deleted successfully" });
    
  } catch (error) {
    console.error("Error deleting exam:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// DELETE MODULE GUIDE
// ============================================

router.delete("/module-guides/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Deleting module guide: ${id}`);
    
    // Get guide to find file path
    const { data: guide, error: fetchError } = await sbAdmin
      .from("module_guides")
      .select("file_path")
      .eq("id", id)
      .single();
    
    if (fetchError && fetchError.code !== 'PGRST116') {
      throw fetchError;
    }
    
    // Delete file from storage
    if (guide?.file_path) {
      try {
        await sbAdmin.storage.from("module-guides").remove([guide.file_path]);
        console.log(`  📁 Deleted file: ${guide.file_path}`);
      } catch (storageError) {
        console.error("Error deleting guide file:", storageError);
      }
    }
    
    // Delete the guide
    const { error } = await sbAdmin.from("module_guides").delete().eq("id", id);
    if (error) throw error;
    
    console.log(`✅ Module guide ${id} deleted successfully`);
    
    res.json({ ok: true, message: "Module guide deleted successfully" });
    
  } catch (error) {
    console.error("Error deleting module guide:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// DELETE STUDENT ENROLLMENT
// ============================================

router.delete("/students/:studentId/enrollments/:moduleId", requireAdmin, async (req, res) => {
  try {
    const { studentId, moduleId } = req.params;
    console.log(`🗑️ Removing enrollment: student ${studentId} from module ${moduleId}`);
    
    const { error } = await sbAdmin
      .from("enrollments")
      .delete()
      .eq("student_id", studentId)
      .eq("module_id", moduleId);
    
    if (error) throw error;
    
    console.log(`✅ Enrollment removed successfully`);
    
    res.json({ ok: true, message: "Enrollment removed successfully" });
    
  } catch (error) {
    console.error("Error deleting enrollment:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// DELETE ENROLLMENT REQUEST
// ============================================

router.delete("/enrollment-requests/:id", requireAdmin, async (req, res) => {
  try {
    const { id } = req.params;
    console.log(`🗑️ Deleting enrollment request: ${id}`);
    
    const { error } = await sbAdmin
      .from("enrollment_requests")
      .delete()
      .eq("id", id);
    
    if (error) throw error;
    
    console.log(`✅ Enrollment request deleted successfully`);
    
    res.json({ ok: true, message: "Enrollment request deleted successfully" });
    
  } catch (error) {
    console.error("Error deleting enrollment request:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// BULK DELETE - Delete all modules in a course
// ============================================

router.delete("/courses/:courseId/modules", requireAdmin, async (req, res) => {
  try {
    const { courseId } = req.params;
    console.log(`🗑️ Bulk deleting modules in course: ${courseId}`);
    
    // Get all module IDs
    const { data: modules, error: fetchError } = await sbAdmin
      .from("modules")
      .select("id")
      .eq("course_id", courseId);
    
    if (fetchError) throw fetchError;
    
    let deletedCount = 0;
    const errors = [];
    
    for (const module of modules || []) {
      try {
        await deleteModuleComplete(module.id);
        deletedCount++;
      } catch (err) {
        errors.push({ moduleId: module.id, error: err.message });
      }
    }
    
    console.log(`✅ Bulk delete complete: ${deletedCount} modules deleted`);
    
    res.json({ 
      ok: true, 
      message: `Deleted ${deletedCount} modules`,
      errors: errors.length > 0 ? errors : undefined
    });
    
  } catch (error) {
    console.error("Error bulk deleting modules:", error);
    res.status(500).json({ ok: false, error: error.message });
  }
});

// ============================================
// HELPER FUNCTIONS
// ============================================

// Complete module deletion - handles ALL related data
async function deleteModuleComplete(moduleId) {
  console.log(`  📦 Processing module: ${moduleId}`);
  
  // 1. Get all chapters in this module
  const { data: chapters, error: chaptersError } = await sbAdmin
    .from("chapters")
    .select("id")
    .eq("module_id", moduleId);
  
  if (chaptersError) throw chaptersError;
  
  // 2. Delete each chapter completely
  for (const chapter of chapters || []) {
    await deleteChapterComplete(chapter.id);
  }
  
  // 3. Delete predicted exams and their questions
  const { data: predictedExams } = await sbAdmin
    .from("predicted_exams")
    .select("id")
    .eq("module_id", moduleId);
  
  for (const exam of predictedExams || []) {
    // Delete predicted exam questions
    await sbAdmin.from("predicted_exam_questions").delete().eq("predicted_exam_id", exam.id);
    // Delete predicted exam
    await sbAdmin.from("predicted_exams").delete().eq("id", exam.id);
  }
  
  // 4. Delete exam pattern analysis
  await sbAdmin.from("exam_pattern_analysis").delete().eq("module_id", moduleId);
  
  // 5. Delete module guides
  const { data: guides } = await sbAdmin
    .from("module_guides")
    .select("file_path")
    .eq("module_id", moduleId);
  
  for (const guide of guides || []) {
    if (guide.file_path) {
      try {
        await sbAdmin.storage.from("module-guides").remove([guide.file_path]);
      } catch (e) {
        console.error(`  ⚠️ Failed to delete guide file: ${guide.file_path}`);
      }
    }
  }
  await sbAdmin.from("module_guides").delete().eq("module_id", moduleId);
  
  // 6. Delete question patterns for this module
  await sbAdmin.from("question_patterns").delete().eq("module_id", moduleId);
  
  // 7. Delete exam questions for this module
  await sbAdmin.from("study_question_bank").delete().eq("module_id", moduleId);
  await sbAdmin.from("exam_question_bank").delete().eq("module_id", moduleId);
  
  // 8. Delete exams for this module
  const { data: moduleExams } = await sbAdmin
    .from("exams")
    .select("id, file_url")
    .eq("module_id", moduleId);
  
  for (const exam of moduleExams || []) {
    if (exam.file_url) {
      try {
        const fileName = exam.file_url.split('/').pop();
        await sbAdmin.storage.from("exam-files").remove([`exams/${fileName}`]);
      } catch (e) {
        console.error(`  ⚠️ Failed to delete exam file: ${exam.file_url}`);
      }
    }
  }
  await sbAdmin.from("exams").delete().eq("module_id", moduleId);
  
  // 9. Delete chat messages for this module
  await sbAdmin.from("chat_messages").delete().eq("module_id", moduleId);
  
  // 10. Delete enrollment requests and enrollments
  await sbAdmin.from("enrollment_requests").delete().eq("module_id", moduleId);
  await sbAdmin.from("enrollments").delete().eq("module_id", moduleId);
  
  // 11. Update student skills (set to NULL, don't delete)
  await sbAdmin.from("student_skills").update({ source_module_id: null }).eq("source_module_id", moduleId);
  
  // 12. Delete module skills
  await sbAdmin.from("module_skills").delete().eq("module_id", moduleId);
  
  // 13. Finally delete the module itself
  const { error } = await sbAdmin.from("modules").delete().eq("id", moduleId);
  if (error) throw error;
  
  console.log(`  ✅ Module ${moduleId} deleted`);
}

// Complete chapter deletion - handles ALL related data
async function deleteChapterComplete(chapterId) {
  console.log(`    📄 Processing chapter: ${chapterId}`);
  
  // 1. Delete chapter chunks
  const { error: chunksError } = await sbAdmin
    .from("chapter_chunks")
    .delete()
    .eq("chapter_id", chapterId);
  
  if (chunksError) throw chunksError;
  
  // 2. Delete flashcard progress
  await sbAdmin.from("flashcard_progress").delete().eq("chapter_id", chapterId);
  
  // 3. Delete study progress
  await sbAdmin.from("study_progress").delete().eq("chapter_id", chapterId);
  
  // 4. Update chat messages (set chapter_id to NULL)
  await sbAdmin.from("chat_messages").update({ chapter_id: null }).eq("chapter_id", chapterId);
  
  // 5. Delete question-bank rows linked to this chapter
  await sbAdmin.from("study_question_bank").delete().eq("chapter_id", chapterId);
  await sbAdmin.from("exam_question_bank").delete().eq("chapter_id", chapterId);
  
  // 6. Update question patterns (set chapter_id to NULL)
  await sbAdmin.from("question_patterns").update({ chapter_id: null }).eq("chapter_id", chapterId);
  
  // 7. Update predicted exam questions (set chapter_id to NULL)
  await sbAdmin.from("predicted_exam_questions").update({ chapter_id: null }).eq("chapter_id", chapterId);
  
  // 8. Delete the chapter itself
  const { error } = await sbAdmin.from("chapters").delete().eq("id", chapterId);
  if (error) throw error;
  
  console.log(`    ✅ Chapter ${chapterId} deleted`);
}

// ============================================
// EXPORT ROUTER
// ============================================

export default router;
