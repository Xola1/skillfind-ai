import express from "express";
import { createClient } from "@supabase/supabase-js";
import * as pdfjsLib from "pdfjs-dist/legacy/build/pdf.mjs";

const router = express.Router();

const SUPABASE_URL = process.env.SUPABASE_URL || "";
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

const sbAdmin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false }
});

function normalizeText(t) {
  return (t || "").replace(/\s+/g, " ").trim();
}

async function requireSupabaseUser(req) {
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token) throw Object.assign(new Error("Missing Authorization Bearer token."), { status: 401 });

  const { data, error } = await sbAdmin.auth.getUser(token);
  if (error || !data?.user) throw Object.assign(new Error("Invalid/expired session."), { status: 401 });
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

    if (error || prof.role !== "student") {
      throw Object.assign(new Error("Forbidden: Students only."), { status: 403 });
    }

    req.user = user;
    next();
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Auth error" });
  }
}

async function verifyEnrollment({ studentId, moduleId }) {
  const { data, error } = await sbAdmin
    .from("enrollments")
    .select("id")
    .eq("student_id", studentId)
    .eq("module_id", moduleId)
    .maybeSingle();

  if (error) throw new Error(error.message);
  if (!data) throw Object.assign(new Error("Forbidden: not enrolled in this module"), { status: 403 });
}

async function extractPdfText(buffer, password = "") {
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
    if (pageText) fullText += `\n\n${pageText}`;
  }
  return { text: fullText.trim(), pages: doc.numPages };
}

async function callGroqChat(messages, temperature = 0.5) {
  const apiKeysStr = process.env.GROQ_API_KEY || "";
  const apiKeys = apiKeysStr.split(",").map(k => k.trim()).filter(Boolean);
  if (!apiKeys.length) throw new Error("Missing GROQ_API_KEY in .env");

  const model = process.env.GROQ_MODEL || "llama-3.1-8b-instant";
  const url = "https://api.groq.com/openai/v1/chat/completions";
  let lastError = null;

  for (const apiKey of apiKeys) {
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
          max_tokens: 1600
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
        const msg = json?.error?.message || json?.message || raw;
        lastError = new Error(`[Groq Error ${resp.status}]: ${msg}`);
        if (resp.status === 401) continue;
        throw lastError;
      }

      return json?.choices?.[0]?.message?.content || "";
    } catch (error) {
      lastError = error;
      continue;
    }
  }

  throw lastError || new Error("All Groq API keys failed");
}

function extractJsonObject(text) {
  const raw = (text || "").trim();
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {}
  const match = raw.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

function generateFallbackModuleSkills({ module, guideText }) {
  const text = normalizeText(guideText || "");
  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter(w => w.length > 4);
  const frequent = new Map();
  for (const word of words) frequent.set(word, (frequent.get(word) || 0) + 1);
  const keywords = [...frequent.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([word]) => word);
  const topic = module?.name || module?.code || "this module";
  const evidence = keywords.length
    ? `Key guide terms include: ${keywords.join(", ")}.`
    : "The uploaded module guide describes the expected module learning outcomes.";

  return {
    summary: `This module builds practical and conceptual capability in ${topic}.`,
    skills: [
      {
        title: "Explain core module concepts",
        description: `Describe the major ideas, terminology, and principles covered in ${topic}.`,
        evidence,
        confidence: "medium"
      },
      {
        title: "Apply module knowledge to tasks",
        description: "Use the module content to solve course-related questions, scenarios, or practical activities.",
        evidence: "This is inferred from the guide content and module structure.",
        confidence: "medium"
      },
      {
        title: "Prepare for assessments",
        description: "Identify what to study, organize learning priorities, and connect outcomes to assessment expectations.",
        evidence: "Module guides usually define outcomes, topics, and assessment direction.",
        confidence: "medium"
      }
    ]
  };
}

function skillConfidence(value) {
  const confidence = String(value || "").toLowerCase();
  return ["high", "medium", "low"].includes(confidence) ? confidence : "medium";
}

function buildJobLinks({ module, skill }) {
  const moduleName = module?.name || module?.code || "";
  const baseQuery = [skill?.title, moduleName]
    .map(part => String(part || "").trim())
    .filter(Boolean)
    .join(" ");
  const query = encodeURIComponent(baseQuery || "student skills");

  return [
    {
      label: "Upwork",
      type: "freelance",
      url: `https://www.upwork.com/nx/search/jobs/?q=${query}`
    },
    {
      label: "Freelancer",
      type: "freelance",
      url: `https://www.freelancer.com/jobs/?keyword=${query}`
    },
    {
      label: "LinkedIn Jobs",
      type: "jobs",
      url: `https://www.linkedin.com/jobs/search/?keywords=${query}`
    }
  ];
}

function prepareSkillsForResponse({ module, skills }) {
  return (skills || [])
    .map(skill => ({
      title: String(skill.title || "").trim(),
      description: String(skill.description || "").trim(),
      evidence: String(skill.evidence || "").trim(),
      confidence: skillConfidence(skill.confidence)
    }))
    .filter(skill => skill.title && skill.description && skill.confidence !== "low")
    .map(skill => ({
      ...skill,
      job_links: buildJobLinks({ module, skill })
    }));
}

async function analyzeModuleGuideSkills({ module, guide }) {
  const guideText = normalizeText(guide?.guide_text || "");
  if (guideText.length < 120) {
    return {
      ok: false,
      reason: "The published module guide does not have enough extracted text for AI skill analysis."
    };
  }

  const systemPrompt = `You identify concrete student skills from university module guides.
Return only valid JSON with this shape:
{
  "summary": "1-2 sentence overview",
  "skills": [
    {
      "title": "short skill name",
      "description": "what the student will be able to do",
      "evidence": "short phrase from or grounded in the guide",
      "confidence": "high|medium|low"
    }
  ]
}
Rules:
- Base the skills only on the module guide.
- Focus on capabilities students gain, not generic study advice.
- Use "low" confidence only when the guide evidence is weak. Low-confidence skills will not be shown to students.
- Return 4 to 8 skills.
- Keep each field concise.`;

  const userPrompt = `Module: ${module.code ? `${module.code} - ` : ""}${module.name}
Course: ${module.course_name || ""}
Guide title: ${guide.title || ""}
Guide description: ${guide.description || ""}

Module guide text:
${guideText.slice(0, 10000)}`;

  try {
    const response = await callGroqChat([
      { role: "system", content: systemPrompt },
      { role: "user", content: userPrompt }
    ], 0.2);
    const parsed = extractJsonObject(response);
    if (parsed?.summary && Array.isArray(parsed.skills) && parsed.skills.length > 0) {
      return {
        ok: true,
        summary: parsed.summary,
        skills: prepareSkillsForResponse({ module, skills: parsed.skills.slice(0, 8) })
      };
    }
  } catch (error) {
    console.error("Module skills AI failed:", error.message);
  }

  const fallback = generateFallbackModuleSkills({ module, guideText });
  return {
    ok: true,
    source: "fallback",
    ...fallback,
    skills: prepareSkillsForResponse({
      module,
      skills: fallback.skills
    })
  };
}

async function ensureModuleGuideText(guide) {
  if (guide?.guide_text && normalizeText(guide.guide_text).length > 120) return guide;
  if (!guide?.file_path) return guide;

  const { data, error } = await sbAdmin.storage
    .from("module-guides")
    .download(guide.file_path);
  if (error || !data) return guide;

  const buffer = Buffer.from(await data.arrayBuffer());
  const { text } = await extractPdfText(buffer);
  const extracted = normalizeText(text || "");
  if (extracted.length > 120) {
    await sbAdmin
      .from("module_guides")
      .update({ guide_text: extracted })
      .eq("id", guide.id);
    return { ...guide, guide_text: extracted };
  }
  return guide;
}

async function handleModuleSkillsRequest(req, res) {
  try {
    const studentId = req.user.id;
    const moduleIds = Array.isArray(req.body?.moduleIds)
      ? req.body.moduleIds.map(id => String(id || "").trim()).filter(Boolean)
      : [];
    const uniqueModuleIds = [...new Set(moduleIds)].slice(0, 8);
    if (uniqueModuleIds.length === 0) {
      return res.status(400).json({ ok: false, error: "Select at least one module" });
    }

    const results = [];
    for (const moduleId of uniqueModuleIds) {
      try {
        await verifyEnrollment({ studentId, moduleId });
        const { data: moduleRow, error: moduleErr } = await sbAdmin
          .from("modules")
          .select("id, code, name, courses(name)")
          .eq("id", moduleId)
          .single();
        if (moduleErr) throw moduleErr;

        const module = {
          module_id: moduleRow.id,
          code: moduleRow.code || "",
          name: moduleRow.name || "",
          course_name: moduleRow.courses?.name || ""
        };

        const { data: guideRow, error: guideErr } = await sbAdmin
          .from("module_guides")
          .select("id, module_id, title, description, guide_text, file_url, file_path, version, is_published, updated_at")
          .eq("module_id", moduleId)
          .eq("is_published", true)
          .order("updated_at", { ascending: false })
          .limit(1)
          .maybeSingle();
        if (guideErr) throw guideErr;
        if (!guideRow) {
          results.push({
            module,
            guide: null,
            ok: false,
            summary: "No published module guide is available for this module yet.",
            skills: []
          });
          continue;
        }

        const guide = await ensureModuleGuideText(guideRow);
        const analysis = await analyzeModuleGuideSkills({ module, guide });
        results.push({
          module,
          guide: {
            id: guide.id,
            title: guide.title,
            description: guide.description || "",
            file_url: guide.file_url || "",
            version: guide.version,
            updated_at: guide.updated_at
          },
          ok: analysis.ok,
          summary: analysis.summary || analysis.reason || "",
          skills: analysis.skills || [],
          source: analysis.source || "ai"
        });
      } catch (error) {
        results.push({
          module: { module_id: moduleId },
          guide: null,
          ok: false,
          summary: error.message || "Failed to analyze this module.",
          skills: []
        });
      }
    }

    res.json({ ok: true, results });
  } catch (e) {
    res.status(e.status || 500).json({ ok: false, error: e.message || "Server error" });
  }
}

router.use(requireStudent);

router.get("/", async (req, res) => {
  const moduleId = (req.query?.moduleId || "").toString().trim();
  if (!moduleId) return res.status(400).json({ ok: false, error: "moduleId is required" });
  req.body = { moduleIds: [moduleId] };
  return handleModuleSkillsRequest(req, res);
});

router.post("/", async (req, res) => {
  return handleModuleSkillsRequest(req, res);
});

export default router;
