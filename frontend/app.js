const API_UPLOAD = "http://localhost:5050/chapter/upload";
const API_LIST = "http://localhost:5050/chapters";
const API_ASK = "http://localhost:5050/ask";

const els = {
  subject: document.getElementById("subject"),
  chapter: document.getElementById("chapter"),
  file: document.getElementById("file"),
  btnUpload: document.getElementById("btnUpload"),
  uploadStatus: document.getElementById("uploadStatus"),

  btnRefresh: document.getElementById("btnRefresh"),
  chapterSelect: document.getElementById("chapterSelect"),
  keyword: document.getElementById("keyword"),
  btnAsk: document.getElementById("btnAsk"),
  askStatus: document.getElementById("askStatus"),

  matched: document.getElementById("matched"),
  answer: document.getElementById("answer"),
  sources: document.getElementById("sources"),
  debug: document.getElementById("debug"),
};

function setText(el, text) { if (el) el.textContent = text || ""; }

async function refreshChapters() {
  setText(els.askStatus, "Loading chapters...");
  const res = await fetch(API_LIST);
  const data = await res.json();
  setText(els.debug, JSON.stringify(data, null, 2));

  if (!data.ok) {
    setText(els.askStatus, "Failed to load chapters.");
    return;
  }

  els.chapterSelect.innerHTML = "";
  const optAll = document.createElement("option");
  optAll.value = "";
  optAll.textContent = "All uploaded chapters (recommended)";
  els.chapterSelect.appendChild(optAll);

  for (const ch of data.chapters) {
    const opt = document.createElement("option");
    opt.value = ch.id;
    opt.textContent = `${ch.subject} — ${ch.chapter} (${ch.chunkCount} chunks)`;
    els.chapterSelect.appendChild(opt);
  }

  setText(els.askStatus, "Chapters loaded.");
}

function renderSources(sources) {
  els.sources.innerHTML = "";

  const makeCard = (title, items) => {
    const card = document.createElement("div");
    card.className = "sourceCard";
    const h = document.createElement("h3");
    h.textContent = title;
    card.appendChild(h);

    (items || []).forEach((it) => {
      const a = document.createElement("a");
      a.href = it.url;
      a.target = "_blank";
      a.rel = "noopener noreferrer";
      a.textContent = it.title || it.url;
      card.appendChild(a);
    });

    els.sources.appendChild(card);
  };

  makeCard("Wikipedia", sources?.wikipedia || []);
  makeCard("Web Results", sources?.web || []);
}

function renderMatchedChunks(chunks) {
  if (!els.matched) return;
  els.matched.innerHTML = "";

  const wrap = document.createElement("div");
  wrap.className = "matchedWrap";

  const h = document.createElement("h3");
  h.textContent = "Matched from your notes";
  wrap.appendChild(h);

  if (!chunks || chunks.length === 0) {
    const p = document.createElement("p");
    p.textContent = "No matching snippet was found in your uploaded notes for that keyword.";
    wrap.appendChild(p);
    els.matched.appendChild(wrap);
    return;
  }

  chunks.forEach((c, idx) => {
    const card = document.createElement("div");
    card.className = "matchCard";

    const title = document.createElement("div");
    title.className = "matchTitle";
    title.textContent = `#${idx + 1} — ${c.subject} | ${c.chapter} (score: ${c.score})`;
    card.appendChild(title);

    const pre = document.createElement("pre");
    pre.className = "matchPreview";
    pre.textContent = c.preview || "";
    card.appendChild(pre);

    wrap.appendChild(card);
  });

  els.matched.appendChild(wrap);
}

els.btnRefresh.addEventListener("click", refreshChapters);

els.btnUpload.addEventListener("click", async () => {
  setText(els.uploadStatus, "");
  setText(els.debug, "");
  setText(els.answer, "");
  if (els.matched) els.matched.innerHTML = "";
  els.sources.innerHTML = "";

  const subject = els.subject.value.trim();
  const chapter = els.chapter.value.trim();
  const file = els.file.files?.[0];

  if (!subject || !chapter) {
    setText(els.uploadStatus, "Please fill Subject and Chapter.");
    return;
  }
  if (!file) {
    setText(els.uploadStatus, "Please choose a file.");
    return;
  }

  setText(els.uploadStatus, "Uploading and indexing...");
  const fd = new FormData();
  fd.append("subject", subject);
  fd.append("chapter", chapter);
  fd.append("file", file);

  const res = await fetch(API_UPLOAD, { method: "POST", body: fd });
  const data = await res.json().catch(() => ({}));
  setText(els.debug, JSON.stringify(data, null, 2));

  if (!res.ok || !data.ok) {
    setText(els.uploadStatus, data.message || data.error || "Upload failed.");
    return;
  }

  setText(els.uploadStatus, `Uploaded. Stored ${data.chunks} chunks. (Method: ${data.method})`);
  await refreshChapters();
});

els.btnAsk.addEventListener("click", async () => {
  setText(els.askStatus, "");
  setText(els.answer, "");
  if (els.matched) els.matched.innerHTML = "";
  els.sources.innerHTML = "";
  setText(els.debug, "");

  const keyword = els.keyword.value.trim();
  if (!keyword) {
    setText(els.askStatus, "Enter a keyword/question.");
    return;
  }

  const selectedId = els.chapterSelect.value;

  setText(els.askStatus, "Thinking (notes first)...");
  const payload = {
    keyword,
    chapterId: selectedId || ""
  };

  const res = await fetch(API_ASK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload)
  });

  const data = await res.json().catch(() => ({}));
  setText(els.debug, JSON.stringify(data, null, 2));

  if (!res.ok || !data.ok) {
    setText(els.askStatus, data.message || data.error || "Ask failed.");
    return;
  }

  setText(els.askStatus, "Done.");
  renderMatchedChunks(data.matchedChunks || []);
  setText(els.answer, data.answer || "");
  renderSources(data.sources || {});
});

// auto-load chapters on page open
refreshChapters();
