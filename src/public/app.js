const $ = (id) => document.getElementById(id);

async function fetchJson(url, options) {
  const res = await fetch(url, options);
  return res.json();
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

async function loadAdapters() {
  const data = await fetchJson("/api/adapters");
  $("adapters").innerHTML = data.adapters.map((name) => `<div class="pill">${escapeHtml(name)}</div>`).join("");
}

async function loadThreads() {
  const data = await fetchJson("/api/threads");
  $("threads").innerHTML = data.threads
    .map((name) => `<button class="thread-btn" data-thread="${escapeHtml(name)}">${escapeHtml(name)}</button>`)
    .join("");

  document.querySelectorAll(".thread-btn").forEach((button) => {
    button.addEventListener("click", () => {
      $("threadId").value = button.dataset.thread;
      loadThread();
    });
  });
}

async function loadThread() {
  const threadId = $("threadId").value || "default";
  const data = await fetchJson(`/api/thread/${encodeURIComponent(threadId)}`);

  $("messages").innerHTML = (data.recent || [])
    .map(
      (item) => `
        <div class="msg">
          <div class="meta">${escapeHtml(item.from)} → ${escapeHtml(item.to || "-")} · ${escapeHtml(item.role)}</div>
          <div class="body">${escapeHtml(item.text)}</div>
        </div>
      `
    )
    .join("");

  $("summary").textContent = JSON.stringify(data.summary, null, 2);
  $("state").textContent = JSON.stringify(data.state, null, 2);
}

async function sendMessage() {
  await fetchJson("/api/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      threadId: $("threadId").value || "default",
      from: $("from").value || "user",
      to: $("to").value || null,
      role: "user",
      text: $("text").value || "",
      meta: {
        replyTo: $("replyTo").value || null
      }
    })
  });

  await loadThreads();
  await loadThread();
}

function connectEvents() {
  const source = new EventSource("/api/events");
  source.onmessage = async () => {
    await loadThreads();
    await loadThread();
  };
}

$("sendBtn").addEventListener("click", sendMessage);
$("refreshBtn").addEventListener("click", loadThread);

await loadAdapters();
await loadThreads();
await loadThread();
connectEvents();
