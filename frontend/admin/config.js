// config.js (frontend - safe to expose)
const APP_LOCAL_API_BASE = "http://localhost:5050";
const APP_PROD_API_BASE = "https://skillfind-ai.onrender.com";
const APP_IS_LOCAL =
  window.location.protocol === "file:" ||
  window.location.hostname === "localhost" ||
  window.location.hostname === "127.0.0.1";

window.APP_CONFIG = {
  API_BASE: APP_IS_LOCAL ? APP_LOCAL_API_BASE : APP_PROD_API_BASE,
  SUPABASE_URL: "https://aaqpcxcogeyluguztsea.supabase.co",
  SUPABASE_ANON_KEY: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImFhcXBjeGNvZ2V5bHVndXp0c2VhIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Njc0NzAxNDAsImV4cCI6MjA4MzA0NjE0MH0.ILQkXvoveyU0FFWjvIT7gG-Q-RjB-I3FuZQ01iVFY-E"
};
