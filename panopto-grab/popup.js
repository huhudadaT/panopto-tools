import * as detect from "./lib/detect.js";

const el = {
  site: document.getElementById("site"),
  clear: document.getElementById("clear"),
  options: document.getElementById("options"),
  sessionState: document.getElementById("session-state"),
  sessionBody: document.getElementById("session-body"),
  mediaState: document.getElementById("media-state"),
  mediaBody: document.getElementById("media-body"),
  status: document.getElementById("status"),
};

let tabId = null;
let tabUrl = "";

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

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function button(label, className, onClick) {
  const b = node("button", className, label);
  b.addEventListener("click", onClick);
  return b;
}

function row(nameText, metaNodes, actionNodes) {
  const r = node("div", "row");
  const grow = node("div", "grow");
  grow.append(node("div", "name", nameText));
  for (const meta of metaNodes) grow.append(meta);
  r.append(grow);
  if (actionNodes.length) {
    const actions = node("div", "actions");
    actions.append(...actionNodes);
    r.append(actions);
  }
  return r;
}

async function download(url, filename, label) {
  setStatus(`Saving ${label}…`);
  const result = await send({ type: "download", url, filename });
  setStatus(result.ok ? `Saved ${filename}` : `Failed: ${result.error}`, !result.ok);
}

async function copy(text, label) {
  try {
    await navigator.clipboard.writeText(text);
    setStatus(`${label} copied`);
  } catch {
    setStatus("Clipboard blocked", true);
  }
}

/* ------------------------------------------------------------- session */

function renderSession(state, settings) {
  el.sessionBody.replaceChildren();

  if (!settings.session) {
    el.sessionState.textContent = "off";
    el.sessionState.className = "tag off";
    el.sessionBody.append(node("p", "empty", "Switched off in Options."));
    return;
  }
  el.sessionState.textContent = "on";
  el.sessionState.className = "tag on";

  if (!state.delivery) {
    el.sessionBody.append(node("p", "empty",
      "Nothing yet. Reload the viewer page with this extension enabled."));
    return;
  }

  const plan = state.delivery.plan;
  const list = node("dl");
  const add = (term, value) => {
    list.append(node("dt", "", term), node("dd", "", value));
  };
  add("title", plan.title || "—");
  if (plan.course) add("course", plan.course);
  add("length", detect.formatDuration(plan.duration));
  add("slides", String(plan.slideCount));
  add("captions", plan.hasCaptions ? `${plan.captionCount} track(s)` : "none");
  el.sessionBody.append(list);

  const actions = node("div", "row");
  const grow = node("div", "grow");

  if (plan.audioOnly && !plan.videoStreams.length) {
    grow.append(node("div", "meta good", "audio only — no video encode exists"));
    grow.append(node("p", "note",
      "Save the JSON and run panopto_slidecast.py on it to rebuild slides plus audio as an MP4."));
  } else if (plan.videoStreams.length) {
    grow.append(node("div", "meta warn",
      `${plan.videoStreams.length} video stream(s): ${plan.videoStreams.map((s) => s.tag).join(", ")}`));
  }
  actions.append(grow);

  const buttons = node("div", "actions");
  buttons.append(button("Save JSON", "primary", async () => {
    const result = await send({ type: "downloadDelivery", tabId });
    setStatus(result.ok ? "delivery.json saved" : `Failed: ${result.error}`, !result.ok);
  }));

  if (plan.podcastUrl && plan.podcastReady) {
    const url = detect.tidyUrl(plan.podcastUrl);
    buttons.append(button("Save audio", "ghost", () => download(
      url,
      detect.suggestFilename({ title: plan.title, url, kind: "video" }),
      "podcast encode",
    )));
  }
  actions.append(buttons);
  el.sessionBody.append(actions);

  if (plan.podcastUrl && !plan.podcastReady) {
    el.sessionBody.append(node("p", "note", "Podcast encode not finished server-side yet."));
  }
}

/* --------------------------------------------------------------- media */

function renderMedia(state, settings) {
  el.mediaBody.replaceChildren();

  if (!settings.media) {
    el.mediaState.textContent = "off";
    el.mediaState.className = "tag off";
    el.mediaBody.append(node("p", "empty", "Switched off in Options."));
    return;
  }

  const items = state.media || [];
  el.mediaState.textContent = items.length ? `${items.length} found` : "on";
  el.mediaState.className = "tag on";

  if (!items.length) {
    el.mediaBody.append(node("p", "empty",
      "Nothing yet. Start playback, or reload the page."));
    return;
  }

  const order = detect.KIND_ORDER;
  const sorted = [...items].sort((a, b) => order.indexOf(a.kind) - order.indexOf(b.kind));
  const title = state.delivery ? state.delivery.plan.title : "";

  for (const item of sorted) {
    const probe = state.probes ? state.probes[item.url] : null;
    const metas = [];
    const actions = [];

    if (item.hits > 1) metas.push(node("div", "meta", `${item.kind} · ${item.hits} requests`));
    else metas.push(node("div", "meta", item.kind));

    if (probe && probe.status === "loading") {
      metas.push(node("div", "meta", "reading playlist…"));
    } else if (probe && probe.status === "error") {
      metas.push(node("div", "meta bad", `playlist unreadable: ${probe.message}`));
    } else if (probe && probe.status === "master") {
      const labels = probe.variants.map((v) => v.label).join(" | ") || "none";
      metas.push(node("div", "meta", `master: ${labels}`));
    } else if (probe && probe.status === "media" && probe.layout === "byterange") {
      const audioOnly = /m4a|audio/i.test(item.name) ? true : undefined;
      metas.push(node("div", "meta good",
        `one file · ${detect.formatBytes(probe.bytes)} · ${detect.formatDuration(probe.duration)}`));
      if (!probe.contiguous) {
        metas.push(node("div", "meta warn",
          "ranges are not contiguous — the file may include trimmed material"));
      }
      actions.push(button("Save file", "primary", () => download(
        probe.wholeUrl,
        detect.suggestFilename({ title, url: probe.wholeUrl, kind: "video", audioOnly }),
        "whole file",
      )));
    } else if (probe && probe.status === "media" && probe.layout === "segments") {
      metas.push(node("div", "meta warn",
        `${probe.count} separate segments · ${detect.formatDuration(probe.duration)}`));
      metas.push(node("p", "note", "Joining segments needs ffmpeg locally."));
      actions.push(button("Copy ffmpeg", "ghost", () => copy(
        detect.ffmpegCommand({
          url: item.url,
          out: `${detect.safeStem(title, "panopto")}.mp4`,
          referer: tabUrl,
        }),
        "ffmpeg command",
      )));
    } else if (item.kind === "video" || item.kind === "audio" || item.kind === "caption") {
      actions.push(button("Save", "primary", () => download(
        item.url,
        detect.suggestFilename({ title, url: item.url, kind: item.kind }),
        item.name,
      )));
    }

    actions.push(button("URL", "ghost", () => copy(item.url, "URL")));
    el.mediaBody.append(row(item.name, metas, actions));
  }
}

/* ---------------------------------------------------------------- wiring */

async function refresh() {
  const response = await send({ type: "state", tabId });
  if (!response.ok) {
    setStatus(response.error, true);
    return;
  }
  renderSession(response.state, response.settings);
  renderMedia(response.state, response.settings);
}

el.clear.addEventListener("click", async () => {
  await send({ type: "clear", tabId });
  setStatus("Cleared");
  await refresh();
});

el.options.addEventListener("click", () => chrome.runtime.openOptionsPage());

(async () => {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab", true);
    return;
  }
  tabId = tab.id;
  tabUrl = tab.url || "";
  const viewer = detect.viewerInfo(tabUrl);
  el.site.textContent = viewer ? viewer.tenant : (detect.parseUrl(tabUrl)?.hostname || "Panopto Grab");
  if (!viewer && !/panopto\./i.test(tabUrl)) {
    setStatus("Not a Panopto page");
  }
  await refresh();
  // Playlist probes finish after the popup opens, so poll briefly.
  const timer = setInterval(refresh, 1200);
  window.addEventListener("unload", () => clearInterval(timer));
})();
