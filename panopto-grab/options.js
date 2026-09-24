const el = {
  media: document.getElementById("media"),
  session: document.getElementById("session"),
  host: document.getElementById("host"),
  add: document.getElementById("add"),
  granted: document.getElementById("granted"),
  status: document.getElementById("status"),
};

function setStatus(text, bad) {
  el.status.textContent = text || "";
  el.status.classList.toggle("bad", !!bad);
}

function send(message) {
  return new Promise((resolve) => {
    chrome.runtime.sendMessage(message, (response) => {
      resolve(response || { ok: false, error: chrome.runtime.lastError?.message || "no response" });
    });
  });
}

async function load() {
  const response = await send({ type: "settings" });
  if (!response.ok) {
    setStatus(response.error, true);
    return;
  }
  el.media.checked = !!response.settings.media;
  el.session.checked = !!response.settings.session;
  await showGranted();
}

async function save(patch) {
  const response = await send({ type: "settings", set: patch });
  setStatus(response.ok ? "Saved" : `Failed: ${response.error}`, !response.ok);
}

async function showGranted() {
  const all = await chrome.permissions.getAll();
  const extra = (all.origins || []).filter((o) => !/panopto\.(com|eu)|cloudfront\.net/.test(o));
  el.granted.textContent = extra.length ? `Also granted: ${extra.join(", ")}` : "";
}

el.media.addEventListener("change", () => save({ media: el.media.checked }));
el.session.addEventListener("change", () => save({ session: el.session.checked }));

el.add.addEventListener("click", async () => {
  const raw = el.host.value.trim().replace(/^https?:\/\//, "").replace(/\/.*$/, "");
  // A bare hostname only. Wildcards or paths here would request far more than
  // the person intends.
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(raw)) {
    setStatus("Enter a hostname like panopto.example.edu", true);
    return;
  }
  const origins = [`*://${raw}/*`];
  try {
    const granted = await chrome.permissions.request({ origins });
    setStatus(granted ? `Access granted for ${raw}` : "Request declined", !granted);
    if (granted) {
      el.host.value = "";
      await showGranted();
    }
  } catch (err) {
    setStatus(String(err.message || err), true);
  }
});

void load();
