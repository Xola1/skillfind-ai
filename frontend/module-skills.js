(function () {
  const API_BASE = "http://localhost:5050";
  const cfg = window.APP_CONFIG || {};

  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    alert("Missing APP_CONFIG in config.js (SUPABASE_URL / SUPABASE_ANON_KEY).");
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);
  const el = (id) => document.getElementById(id);

  const ui = {
    userName: el("userName"),
    btnSignOut: el("btnSignOut"),
    btnAnalyzeSkills: el("btnAnalyzeSkills"),
    btnSelectAll: el("btnSelectAll"),
    moduleChecklist: el("moduleChecklist"),
    statusPanel: el("statusPanel"),
    moduleSummary: el("moduleSummary"),
    courseName: el("courseName"),
    moduleName: el("moduleName"),
    summaryText: el("summaryText"),
    guideLink: el("guideLink"),
    skillsGrid: el("skillsGrid")
  };

  let modules = [];

  function setStatus(message, type = "") {
    ui.statusPanel.textContent = message || "";
    ui.statusPanel.className = `skills-status${type ? ` ${type}` : ""}`;
  }

  function escapeHtml(value) {
    return String(value || "").replace(/[&<>"]/g, (char) => {
      if (char === "&") return "&amp;";
      if (char === "<") return "&lt;";
      if (char === ">") return "&gt;";
      return "&quot;";
    });
  }

  async function getAccessToken() {
    const { data, error } = await sb.auth.getSession();
    if (error) throw error;
    return data?.session?.access_token || "";
  }

  async function apiFetch(path, opts = {}) {
    const token = await getAccessToken();
    const headers = { ...(opts.headers || {}) };
    if (opts.body && !headers["Content-Type"]) headers["Content-Type"] = "application/json";
    if (token) headers.Authorization = `Bearer ${token}`;

    const res = await fetch(`${API_BASE}${path}`, { ...opts, headers });
    const json = await res.json().catch(() => ({}));
    if (!res.ok || !json.ok) throw new Error(json.error || json.message || `HTTP ${res.status}`);
    return json;
  }

  async function checkAuth() {
    const { data } = await sb.auth.getSession();
    if (!data?.session) {
      window.location.href = "login.html";
      return false;
    }

    const email = data.session.user?.email || "";
    ui.userName.textContent = email ? email.split("@")[0] : "Student";
    return true;
  }

  function selectedModuleIds() {
    return [...ui.moduleChecklist.querySelectorAll("input[type='checkbox']:checked")]
      .map(input => input.value)
      .filter(Boolean);
  }

  function renderModules() {
    if (!modules.length) {
      ui.moduleChecklist.innerHTML = `<div class="module-check-empty">No modules are linked to your student profile yet.</div>`;
      return;
    }

    ui.moduleChecklist.innerHTML = modules.map(module => `
      <label class="module-check-card">
        <input type="checkbox" value="${escapeHtml(module.module_id)}" />
        <span>
          <strong>${escapeHtml(module.code ? `${module.code} - ${module.name}` : module.name)}</strong>
          <small>${escapeHtml(module.course_name || "Your course")}</small>
        </span>
      </label>
    `).join("");
  }

  function renderEmpty(message) {
    ui.moduleSummary.classList.add("hidden");
    ui.guideLink.classList.add("hidden");
    ui.skillsGrid.innerHTML = "";
    setStatus(message, "warning");
  }

  function renderResults(results) {
    ui.guideLink.classList.add("hidden");

    if (!results.length) {
      renderEmpty("No skills could be generated for the selected modules.");
      return;
    }

    const successful = results.filter(result => result.ok && Array.isArray(result.skills) && result.skills.length);
    ui.moduleSummary.classList.remove("hidden");
    ui.courseName.textContent = `${results.length} selected module${results.length === 1 ? "" : "s"}`;
    ui.moduleName.textContent = "Skills students will gain";
    ui.summaryText.textContent = successful.length
      ? "AI analyzed the published module guide text for each selected module and identified likely student capabilities."
      : "The selected modules do not have enough published module guide text for AI analysis yet.";

    setStatus(
      successful.length
        ? `Generated skills for ${successful.length} of ${results.length} selected module${results.length === 1 ? "" : "s"}.`
        : "No selected module had enough published guide text to analyze.",
      successful.length ? "success" : "warning"
    );

    ui.skillsGrid.innerHTML = results.map(result => {
      const module = result.module || {};
      const guide = result.guide || null;
      const skills = result.skills || [];
      const heading = `${module.code ? `${module.code} - ` : ""}${module.name || "Module"}`;

      return `
        <article class="skill-group">
          <div class="skill-group-head">
            <div>
              <p class="course-name">${escapeHtml(module.course_name || "")}</p>
              <h4>${escapeHtml(heading)}</h4>
            </div>
            ${guide?.file_url ? `<a class="btn ghost" href="${escapeHtml(guide.file_url)}" target="_blank" rel="noreferrer">Open guide</a>` : ""}
          </div>
          <p class="module-skill-summary">${escapeHtml(result.summary || "")}</p>
          ${skills.length ? `
            <div class="skill-list">
              ${skills.map(skill => `
                <div class="skill-card">
                  <div class="skill-card-top">
                    <span class="skill-dot"></span>
                    <strong>${escapeHtml(skill.title)}</strong>
                  </div>
                  <p>${escapeHtml(skill.description)}</p>
                  ${skill.evidence ? `<p class="skill-evidence">${escapeHtml(skill.evidence)}</p>` : ""}
                  ${Array.isArray(skill.job_links) && skill.job_links.length ? `
                    <div class="skill-job-links">
                      ${skill.job_links.map(link => `
                        <a href="${escapeHtml(link.url)}" target="_blank" rel="noreferrer">
                          ${escapeHtml(link.label)}
                        </a>
                      `).join("")}
                    </div>
                  ` : ""}
                  <span class="skill-confidence">${escapeHtml(skill.confidence || "medium")} confidence</span>
                </div>
              `).join("")}
            </div>
          ` : ""}
        </article>
      `;
    }).join("");
  }

  async function loadModules() {
    setStatus("Loading your modules...");
    const data = await apiFetch("/student/modules");
    modules = data.modules || [];
    renderModules();

    if (!modules.length) {
      renderEmpty("No modules are linked to your student profile yet.");
      return;
    }

    setStatus("Check one or more modules, then generate skills from their published module guides.");
  }

  async function analyzeCheckedModules() {
    const moduleIds = selectedModuleIds();
    if (!moduleIds.length) {
      renderEmpty("Check at least one module first.");
      return;
    }

    setStatus("AI is reading the selected module guide text and identifying student skills...");
    ui.skillsGrid.innerHTML = "";
    ui.moduleSummary.classList.add("hidden");
    ui.btnAnalyzeSkills.disabled = true;

    try {
      const data = await apiFetch("/student/module-skills", {
        method: "POST",
        body: JSON.stringify({ moduleIds })
      });
      renderResults(data.results || []);
    } finally {
      ui.btnAnalyzeSkills.disabled = false;
    }
  }

  ui.btnAnalyzeSkills.addEventListener("click", () => {
    analyzeCheckedModules().catch(error => {
      renderEmpty(error.message || "Failed to generate module skills.");
    });
  });

  ui.btnSelectAll.addEventListener("click", () => {
    const boxes = [...ui.moduleChecklist.querySelectorAll("input[type='checkbox']")];
    const shouldSelect = boxes.some(box => !box.checked);
    boxes.forEach(box => { box.checked = shouldSelect; });
    ui.btnSelectAll.textContent = shouldSelect ? "Clear all" : "Select all";
  });

  ui.btnSignOut.addEventListener("click", async () => {
    await sb.auth.signOut();
    window.location.href = "login.html";
  });

  (async function init() {
    try {
      if (!(await checkAuth())) return;
      await loadModules();
    } catch (error) {
      renderEmpty(error.message || "Failed to load module skills.");
    }
  })();
})();
