// ---------- CONFIG ----------
const API_BASE = "http://localhost:5050/admin";

// Expect config injected in frontend (config.js)
const CFG = window.APP_CONFIG || {};
const SUPABASE_URL = CFG.SUPABASE_URL;
const SUPABASE_ANON_KEY = CFG.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error("Missing SUPABASE_URL / SUPABASE_ANON_KEY. Create config.js and load it before admin.js.");
}

// Create Supabase client
const sb = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ---------- ELEMENTS ----------
const el = (id) => document.getElementById(id);

const ui = {
  btnSignOut: el("btnSignOut"),
  whoami: el("whoami"),
  userName: el("userName"),
  panels: {
    courses: el("panel-courses"),
    modules: el("panel-modules"),
    moduleGuides: el("panel-moduleGuides"),
    exams: el("panel-exams"),
    requests: el("panel-requests"),
    chapters: el("panel-chapters"),
    students: el("panel-students"),
    leaderboard: el("panel-leaderboard"),
  },
  debug: el("debug"),
  btnClearDebug: el("btnClearDebug"),
  pendingBadge: el("pendingBadge"),
  pageTitle: document.querySelector('.page-title'),

  // Courses
  courseCode: el("courseCode"),
  courseName: el("courseName"),
  btnCreateCourse: el("btnCreateCourse"),
  btnReloadCourses: el("btnReloadCourses"),
  coursesStatus: el("coursesStatus"),
  coursesTable: el("coursesTable")?.querySelector("tbody"),

  // Exams
  examCourseSelect: el("examCourseSelect"),
  examModuleSelect: el("examModuleSelect"),
  examTypeSelect: el("examTypeSelect"),
  examTitle: el("examTitle"),
  examDescription: el("examDescription"),
  examYear: el("examYear"),
  examTerm: el("examTerm"),
  examDuration: el("examDuration"),
  examTotalMarks: el("examTotalMarks"),
  examFile: el("examFile"),
  answerFile: el("answerFile"),
  btnUploadExam: el("btnUploadExam"),
  btnReloadExams: el("btnReloadExams"),
  examsStatus: el("examsStatus"),
  examsTable: el("examsTable")?.querySelector("tbody"),

  // Leaderboard / Analytics
  btnReloadLeaderboard: el("btnReloadLeaderboard"),
  leaderboardSummary: el("leaderboardSummary"),
  leaderboardRows: el("leaderboardRows"),
  participantRows: el("participantRows"),
  topicRows: el("topicRows"),
  correctRows: el("correctRows"),
  incorrectRows: el("incorrectRows"),

};

// ---------- HELPERS ----------
function setText(node, text) { if (node) node.textContent = text || ""; }

function logDebug(obj) {
  if (ui.debug) ui.debug.textContent = (typeof obj === "string") ? obj : JSON.stringify(obj, null, 2);
}
ui.btnClearDebug?.addEventListener("click", () => logDebug(""));

function formatErr(e) {
  if (!e) return "Unknown error";
  if (typeof e === "string") return e;
  const msg = e.message || e.error_description || e.error || JSON.stringify(e);
  return msg;
}

function pill(status) {
  const s = (status || "").toLowerCase();
  const span = document.createElement("span");
  span.className = "badge " + (s === "approved" ? "badge-success" : s === "rejected" ? "badge-danger" : "badge-warning");
  span.textContent = status || "";
  return span;
}

function fmtDate(iso) {
  if (!iso) return "";
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function escapeHtml(str) {
  if (!str) return '';
  return str.replace(/[&<>]/g, function(m) {
    if (m === '&') return '&amp;';
    if (m === '<') return '&lt;';
    if (m === '>') return '&gt;';
    return m;
  });
}

function escapeAttr(str) {
  return String(str || '').replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

const safe = (fn) => async (...args) => {
  try { return await fn(...args); }
  catch (e) {
    logDebug({ error: formatErr(e), stack: e?.stack });
    throw e;
  }
};

async function getAccessToken() {
  const adminSession = localStorage.getItem('adminSession');
  if (adminSession) {
    try {
      const session = JSON.parse(adminSession);
      if (session?.access_token) return session.access_token;
    } catch (e) {}
  }
  const { data, error } = await sb.auth.getSession();
  if (error) throw error;
  return data?.session?.access_token || "";
}

async function apiFetch(path, opts = {}) {
  const token = await getAccessToken();
  const headers = opts.headers ? { ...opts.headers } : {};
  if (token) headers.Authorization = `Bearer ${token}`;

  const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); } catch { json = { raw: text }; }

  if (!res.ok) {
    const msg = json?.message || json?.error || `HTTP ${res.status}`;
    const err = new Error(msg);
    err.httpStatus = res.status;
    err.payload = json;
    throw err;
  }
  return json;
}

// ---------- SIDEBAR NAVIGATION ----------
function setActiveTab(tabName) {
  // Update sidebar nav items
  document.querySelectorAll('.nav-item').forEach(item => {
    if (item.dataset.tab === tabName) {
      item.classList.add('active');
    } else {
      item.classList.remove('active');
    }
  });
  
  // Update panels
  Object.entries(ui.panels).forEach(([name, panel]) => {
    if (panel) panel.classList.toggle('hidden', name !== tabName);
  });
  
  // Update page title
  const pageTitles = {
    courses: 'Courses',
    modules: 'Modules',
    moduleGuides: 'Module Guides',
    exams: 'Exams & Tests',
    requests: 'Enrollment Requests',
    chapters: 'Chapters',
    students: 'Students',
    leaderboard: 'Leaderboard'
  };
  if (ui.pageTitle) ui.pageTitle.textContent = pageTitles[tabName] || 'Dashboard';
  
  // Load data based on tab
  if (tabName === "exams") {
    loadExamCourses();
    loadExams();
  }
  if (tabName === "requests") {
    loadPendingRequestBadge();
  }
  if (tabName === "courses") {
    loadCourses();
  }
  if (tabName === "leaderboard") {
    loadLeaderboardAnalytics();
  }
}

function setupNavigation() {
  document.querySelectorAll('.nav-item').forEach(btn => {
    btn.addEventListener('click', () => {
      const target = btn.dataset.tab;
      if (target) setActiveTab(target);
    });
  });
}

// ---------- AUTH ----------
ui.btnSignOut?.addEventListener("click", safe(async () => {
  await sb.auth.signOut();
  localStorage.removeItem('adminSession');
  window.location.href = 'adminlogin.html';
}));

// ---------- DATA CACHE ----------
let cache = { courses: [], modules: [] };

// ---------- LOADERS ----------
async function loadCourses() {
  const data = await apiFetch("/courses");
  cache.courses = data.courses || [];
  renderCourses();
  fillCourseSelects();
  return cache.courses;
}

async function loadModules(courseId = "") {
  const q = courseId ? `?courseId=${encodeURIComponent(courseId)}` : "";
  const data = await apiFetch(`/modules${q}`);
  cache.modules = data.modules || [];
  fillModuleSelects();
  return cache.modules;
}

async function loadPendingRequestBadge() {
  const data = await apiFetch("/enrollment-requests?status=pending");
  if (ui.pendingBadge) {
    ui.pendingBadge.textContent = String((data.requests || []).length);
  }
}

// ---------- RENDER: COURSES ----------
function renderCourses() {
  if (!ui.coursesTable) return;
  ui.coursesTable.innerHTML = "";
  for (const c of cache.courses) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td>${c.code || ""}</td>
      <td>${c.name || ""}</td>
      <td>${fmtDate(c.created_at)}</td>
      <td class="actions-cell">
        <button class="btn-danger-sm delete-course" data-id="${c.id}" data-name="${escapeHtml(c.name)}">Delete</button>
      </td>
    `;
    ui.coursesTable.appendChild(tr);
  }
  
  document.querySelectorAll('.delete-course').forEach(btn => {
    btn.addEventListener('click', safe(async () => {
      const id = btn.dataset.id;
      const name = btn.dataset.name;
      if (!confirm(`Delete course "${name}"? This will delete ALL modules, chapters, exams, and enrollments. Students will be preserved.`)) return;
      await apiFetch(`/courses/${id}`, { method: "DELETE" });
      await loadCourses();
      await loadModules();
    }));
  });
}

ui.btnCreateCourse?.addEventListener("click", safe(async () => {
  setText(ui.coursesStatus, "");
  const code = ui.courseCode?.value.trim();
  const name = ui.courseName?.value.trim();
  if (!name) { setText(ui.coursesStatus, "Course name is required."); return; }
  await apiFetch("/courses", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ code: code || null, name })
  });
  ui.courseCode.value = "";
  ui.courseName.value = "";
  setText(ui.coursesStatus, "✅ Course created.");
  await loadCourses();
}));

ui.btnReloadCourses?.addEventListener("click", safe(() => loadCourses()));

// ---------- MODULES ----------
function fillCourseSelects() {
  const selects = [ui.examCourseSelect];
  for (const s of selects) {
    if (!s) continue;
    const current = s.value;
    s.innerHTML = '<option value="">Select course...</option>';
    for (const c of cache.courses) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name}${c.code ? ` (${c.code})` : ""}`;
      s.appendChild(opt);
    }
    if (current && Array.from(s.options).some(opt => opt.value === current)) s.value = current;
  }
}

function fillModuleSelects() {
  const modSelects = [ui.examModuleSelect];
  for (const s of modSelects) {
    if (!s) continue;
    const current = s.value;
    s.innerHTML = '<option value="">Select module...</option>';
    for (const m of cache.modules) {
      const opt = document.createElement("option");
      opt.value = m.id;
      opt.textContent = m.name;
      s.appendChild(opt);
    }
    if (current && Array.from(s.options).some(opt => opt.value === current)) s.value = current;
  }
}

// ---------- EXAMS ----------
async function loadExamCourses() {
  const data = await apiFetch("/courses");
  const courses = data.courses || [];
  if (ui.examCourseSelect) {
    const current = ui.examCourseSelect.value;
    ui.examCourseSelect.innerHTML = '<option value="">Select Course...</option>';
    for (const c of courses) {
      const opt = document.createElement("option");
      opt.value = c.id;
      opt.textContent = `${c.name}${c.code ? ` (${c.code})` : ""}`;
      ui.examCourseSelect.appendChild(opt);
    }
    if (current) ui.examCourseSelect.value = current;
  }
}

async function loadExams() {
  if (!ui.examsTable) return;
  try {
    const token = await getAccessToken();
    const courseId = ui.examCourseSelect?.value || "";
    const url = courseId ? `${API_BASE}/exams?courseId=${courseId}` : `${API_BASE}/exams`;
    
    const response = await fetch(url, {
      headers: { "Authorization": `Bearer ${token}` }
    });
    
    const data = await response.json();
    if (data.ok) {
      renderExams(data.exams || []);
    } else {
      console.error("Failed to load exams:", data.error);
    }
  } catch (e) {
    console.error("Failed to load exams:", e);
  }
}

function renderExams(exams) {
  if (!ui.examsTable) return;
  if (!exams.length) {
    ui.examsTable.innerHTML = `<tr><td colspan="8" style="text-align: center;">No exams uploaded yet.</td></tr>`;
    return;
  }
  ui.examsTable.innerHTML = "";
  for (const exam of exams) {
    const tr = document.createElement("tr");
    tr.innerHTML = `
      <td><strong>${escapeHtml(exam.title)}</strong><br><small>${escapeHtml(exam.description || '')}</small></td>
      <td>${escapeHtml(exam.course_name || "-")}</td>
      <td>${escapeHtml(exam.module_name || "All Modules")}</td>
      <td><span class="exam-badge ${exam.exam_type}">${exam.exam_type.replace('_', ' ')}</span></td>
      <td>${exam.year || "-"} ${exam.term || ""}</td>
      <td>${exam.duration_minutes ? exam.duration_minutes + ' min' : '-'}</td>
      <td>${fmtDate(exam.created_at)}</td>
      <td class="actions-cell">
        ${exam.file_url ? `<button class="btn-sm view-exam" data-url="${escapeAttr(exam.file_url)}">View</button>` : ''}
        <button class="btn-sm process-exam" data-id="${exam.id}" data-title="${escapeHtml(exam.title)}">Extract</button>
        <button class="btn-danger-sm delete-exam" data-id="${exam.id}" data-title="${escapeHtml(exam.title)}">Delete</button>
      </td>
    `;
    ui.examsTable.appendChild(tr);
  }
  
  document.querySelectorAll('.view-exam').forEach(btn => {
    btn.addEventListener('click', () => window.open(btn.dataset.url, '_blank'));
  });
  document.querySelectorAll('.process-exam').forEach(btn => {
    btn.addEventListener('click', safe(async () => {
      if (!confirm(`Process exam "${btn.dataset.title}"? This will extract questions, answers, and reusable mock-prediction data into the database.`)) return;
      setText(ui.examsStatus, "Processing exam and storing reusable questions...");
      const token = await getAccessToken();
      const response = await fetch(`http://localhost:5050/api/questions/exams/${btn.dataset.id}/process`, {
        method: "POST",
        headers: { "Authorization": `Bearer ${token}`, "Content-Type": "application/json" }
      });
      const result = await response.json();
      if (result.ok) {
        setText(ui.examsStatus, `✅ Extracted ${result.questions_extracted} questions`);
        setText(ui.examsStatus, `Extracted ${result.questions_extracted || 0} exam questions. Stored ${result.study_bank_added || 0} reusable questions and answers.`);
        await loadExams();
      } else {
        setText(ui.examsStatus, `❌ Processing failed: ${result.error}`);
      }
    }));
  });
  document.querySelectorAll('.delete-exam').forEach(btn => {
    btn.addEventListener('click', safe(async () => {
      if (!confirm(`Delete exam "${btn.dataset.title}"?`)) return;
      await apiFetch(`/exams/${btn.dataset.id}`, { method: "DELETE" });
      await loadExams();
    }));
  });
}

ui.btnUploadExam?.addEventListener("click", safe(async () => {
  setText(ui.examsStatus, "Uploading...");
  const courseId = ui.examCourseSelect?.value;
  const examType = ui.examTypeSelect?.value;
  const title = ui.examTitle?.value.trim();
  const examFile = ui.examFile?.files?.[0];
  
  if (!courseId || !examType || !title || !examFile) {
    setText(ui.examsStatus, "Please fill all required fields");
    return;
  }
  
  const fd = new FormData();
  fd.append("courseId", courseId);
  fd.append("examType", examType);
  fd.append("title", title);
  fd.append("examFile", examFile);
  if (ui.examModuleSelect?.value) fd.append("moduleId", ui.examModuleSelect.value);
  if (ui.examDescription?.value) fd.append("description", ui.examDescription.value);
  if (ui.examYear?.value) fd.append("year", ui.examYear.value);
  if (ui.examTerm?.value) fd.append("term", ui.examTerm.value);
  if (ui.examDuration?.value) fd.append("duration", ui.examDuration.value);
  if (ui.examTotalMarks?.value) fd.append("totalMarks", ui.examTotalMarks.value);
  if (ui.answerFile?.files?.[0]) fd.append("answerFile", ui.answerFile.files[0]);
  
  const token = await getAccessToken();
  const res = await fetch(`${API_BASE}/exams/upload`, {
    method: "POST",
    headers: token ? { Authorization: `Bearer ${token}` } : {},
    body: fd
  });
  const json = await res.json();
  if (json.ok) {
    setText(ui.examsStatus, "✅ Exam uploaded!");
    ui.examTitle.value = "";
    ui.examFile.value = "";
    ui.answerFile.value = "";
    await loadExams();
  } else {
    setText(ui.examsStatus, `❌ ${json.error}`);
  }
}));

ui.examCourseSelect?.addEventListener("change", () => loadExams());
ui.btnReloadExams?.addEventListener("click", () => loadExams());

// ---------- LEADERBOARD / ANALYTICS ----------
function renderSummary(summary = {}) {
  if (!ui.leaderboardSummary) return;
  const cards = [
    { label: "Attempts", value: summary.total_attempts || 0 },
    { label: "Active Students", value: summary.active_students || 0 },
    { label: "Questions Answered", value: summary.total_questions || 0 },
    { label: "Average Accuracy", value: `${summary.average_accuracy || 0}%` }
  ];
  ui.leaderboardSummary.innerHTML = cards.map(card => `
    <div class="analytics-card">
      <div class="analytics-value">${escapeHtml(String(card.value))}</div>
      <div class="analytics-label">${escapeHtml(card.label)}</div>
    </div>
  `).join("");
}

function renderAnalyticsRows(container, rows, renderRow, emptyText) {
  if (!container) return;
  container.innerHTML = rows && rows.length
    ? rows.map(renderRow).join("")
    : `<div class="analytics-meta">${escapeHtml(emptyText || "No data yet.")}</div>`;
}

function renderLeaderboardAnalytics(data) {
  renderSummary(data.summary || {});

  renderAnalyticsRows(ui.leaderboardRows, data.leaderboards || [], row => `
    <div class="analytics-row">
      <div>
        <strong>${escapeHtml(row.student_name || "Student")}</strong>
        <div class="analytics-meta">${escapeHtml(row.activity_type || "")} ${row.chapter_title ? `- ${escapeHtml(row.chapter_title)}` : ""}</div>
      </div>
      <span class="analytics-pill">${Number(row.score || 0)} pts</span>
    </div>
  `, "No leaderboard attempts yet.");

  renderAnalyticsRows(ui.participantRows, data.participants || [], row => `
    <div class="analytics-row">
      <div>
        <strong>${escapeHtml(row.student_name || "Student")}</strong>
        <div class="analytics-meta">${Number(row.total_score || 0)} total points, ${Number(row.avg_accuracy || 0)}% average accuracy</div>
      </div>
      <span class="analytics-pill">${Number(row.attempts || 0)} attempts</span>
    </div>
  `, "No participating students yet.");

  renderAnalyticsRows(ui.topicRows, data.topics || [], row => `
    <div class="analytics-row">
      <div>
        <strong>${escapeHtml(row.topic || "General")}</strong>
        <div class="analytics-meta">${Number(row.correct || 0)} correct, ${Number(row.incorrect || 0)} incorrect</div>
      </div>
      <span class="analytics-pill">${Number(row.count || 0)}</span>
    </div>
  `, "No topic data yet.");

  renderAnalyticsRows(ui.correctRows, data.most_correct || [], row => `
    <div class="analytics-row">
      <div>
        <strong>${escapeHtml(row.question || "Question")}</strong>
        <div class="analytics-meta">${Number(row.attempts || 0)} total attempts</div>
      </div>
      <span class="analytics-pill">${Number(row.correct || 0)} correct</span>
    </div>
  `, "No correct-answer data yet.");

  renderAnalyticsRows(ui.incorrectRows, data.most_incorrect || [], row => `
    <div class="analytics-row">
      <div>
        <strong>${escapeHtml(row.question || "Question")}</strong>
        <div class="analytics-meta">${Number(row.attempts || 0)} total attempts</div>
      </div>
      <span class="analytics-pill">${Number(row.incorrect || 0)} incorrect</span>
    </div>
  `, "No incorrect-answer data yet.");
}

async function loadLeaderboardAnalytics() {
  try {
    renderAnalyticsRows(ui.leaderboardRows, [], null, "Loading analytics...");
    const token = await getAccessToken();
    const res = await fetch("http://localhost:5050/activity/admin/analytics", {
      headers: token ? { Authorization: `Bearer ${token}` } : {}
    });
    const data = await res.json();
    if (!res.ok || !data.ok) throw new Error(data.error || `HTTP ${res.status}`);
    renderLeaderboardAnalytics(data);
  } catch (error) {
    logDebug({ leaderboardAnalyticsError: formatErr(error) });
    renderAnalyticsRows(ui.leaderboardRows, [], null, `Could not load analytics: ${formatErr(error)}`);
  }
}

ui.btnReloadLeaderboard?.addEventListener("click", () => loadLeaderboardAnalytics());

// ---------- BOOT ----------
async function boot() {
  const adminSession = localStorage.getItem('adminSession');
  if (adminSession) {
    try {
      const session = JSON.parse(adminSession);
      if (session?.access_token) {
        await sb.auth.setSession({
          access_token: session.access_token,
          refresh_token: session.refresh_token
        });
      }
    } catch (e) {}
  }
  const { data: userData } = await sb.auth.getUser();
  if (userData?.user) {
    if (ui.whoami) ui.whoami.textContent = `Signed in: ${userData.user.email}`;
    if (ui.userName) ui.userName.textContent = userData.user.email?.split('@')[0] || 'Admin';
  }
  
  setupNavigation();
  setActiveTab('courses');
  await loadCourses();
  await loadModules();
  await loadPendingRequestBadge();
  await loadExamCourses();
  await loadExams();
}

// Initialize
(async function init() {
  if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
    document.body.innerHTML = `<div style="padding:40px;text-align:center;color:#721c24;background:#f8d7da;">Configuration Error: Missing Supabase config.</div>`;
    return;
  }
  await boot();
})();
