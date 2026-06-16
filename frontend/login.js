(function () {
  const cfg = window.APP_CONFIG || {};
  if (!cfg.SUPABASE_URL || !cfg.SUPABASE_ANON_KEY) {
    alert("Missing APP_CONFIG in config.js (SUPABASE_URL / SUPABASE_ANON_KEY).");
    return;
  }

  const sb = window.supabase.createClient(cfg.SUPABASE_URL, cfg.SUPABASE_ANON_KEY);

  const el = (id) => document.getElementById(id);
  const ui = {
    email: el("email"),
    password: el("password"),
    btnLogin: el("btnLogin"),
    btnGoAdmin: el("btnGoAdmin"),
    status: el("status"),
  };

  function setStatus(msg) { ui.status.textContent = msg || ""; }

  ui.btnGoAdmin.addEventListener("click", () => {
    window.location.href = "/admin.html";
  });

  async function ensureStudent(userId) {
    // Optional: enforce role === student (recommended)
    const { data, error } = await sb.from("profiles").select("role").eq("id", userId).single();
    if (error) return { ok: false, message: "Profile not found for this user." };
    if ((data.role || "").toLowerCase() !== "student") {
      return { ok: false, message: "This account is not a student." };
    }
    return { ok: true };
  }

  ui.btnLogin.addEventListener("click", async () => {
    try {
      setStatus("");
      const email = ui.email.value.trim();
      const password = ui.password.value;
      if (!email || !password) return setStatus("Enter email and password.");

      setStatus("Signing in...");
      const { data, error } = await sb.auth.signInWithPassword({ email, password });
      if (error) throw error;

      const userId = data?.user?.id;
      if (!userId) return setStatus("Login failed: user not returned.");

      const check = await ensureStudent(userId);
      if (!check.ok) {
        await sb.auth.signOut();
        return setStatus(check.message);
      }

      setStatus("Signed in. Redirecting...");
      window.location.href = "index.html";
    } catch (e) {
      setStatus(e?.message || String(e));
    }
  });

  // auto-redirect if already logged in
  (async () => {
    const { data } = await sb.auth.getSession();
    if (data?.session?.user) window.location.href = "index.html";
  })();
})();
