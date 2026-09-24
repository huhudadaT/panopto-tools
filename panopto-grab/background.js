/* Service worker.
 *
 * Two independent capture modules, either of which can be switched off in
 * Options:
 *
 *   media   — watches network requests for session media and offers downloads
 *   session — captures the DeliveryInfo response body via content scripts
 *
 * MV3 workers are torn down after roughly 30 seconds idle, so all captured
 * state lives in chrome.storage.session rather than in module variables.
 */

import * as detect from "./lib/detect.js";

const DEFAULTS = { media: true, session: true };
const PROBE_LIMIT = 6; // playlists fetched per tab, guards against manifest loops

let settings = { ...DEFAULTS };

async function loadSettings() {
  const stored = await chrome.storage.local.get("settings");
  settings = { ...DEFAULTS, ...(stored.settings || {}) };
  return settings;
}

async function saveSettings(next) {
  settings = { ...settings, ...next };
  await chrome.storage.local.set({ settings });
  await syncContentScripts();
  return settings;
}

/* ------------------------------------------------------------------ state */

const key = (tabId) => `tab:${tabId}`;

async function getState(tabId) {
  const stored = await chrome.storage.session.get(key(tabId));
  return stored[key(tabId)] || { media: [], probes: {}, delivery: null, probeCount: 0 };
}

async function setState(tabId, state) {
  await chrome.storage.session.set({ [key(tabId)]: state });
  await updateBadge(tabId, state);
}

async function updateBadge(tabId, state) {
  const count = (state.media || []).length + (state.delivery ? 1 : 0);
  try {
    await chrome.action.setBadgeText({ tabId, text: count ? String(count) : "" });
    await chrome.action.setBadgeBackgroundColor({ tabId, color: "#0a63c9" });
  } catch {
    // Tab closed mid-update; nothing to show.
  }
}

/* --------------------------------------------------------- media watching */

chrome.webRequest.onCompleted.addListener(
  (details) => { void onRequest(details); },
  { urls: ["<all_urls>"] },
);

async function onRequest(details) {
  if (!settings.media) return;
  if (details.tabId < 0 || details.statusCode >= 400) return;

  const kind = detect.classify(details.url);
  if (!kind || kind === "deliveryinfo") return;

  const state = await getState(details.tabId);
  const clean = detect.tidyUrl(details.url);
  if (state.media.some((m) => m.url === clean)) {
    // Byte-range playback re-requests one file hundreds of times. Count the
    // hits so the popup can show it, but keep a single row.
    state.media = state.media.map((m) => (m.url === clean ? { ...m, hits: (m.hits || 1) + 1 } : m));
    await setState(details.tabId, state);
    return;
  }

  state.media.push({
    url: clean,
    kind,
    name: detect.lastPathPart(clean),
    hits: 1,
    seen: Date.now(),
  });
  await setState(details.tabId, state);

  if (kind === "hls" || kind === "dash") await probe(details.tabId, clean);
}

/* Fetch and parse a playlist so the popup can say whether this is one
 * whole file or a pile of segments. Panopto's CDN URLs are unsigned, so an
 * anonymous re-request works. */
async function probe(tabId, url) {
  const state = await getState(tabId);
  if (state.probes[url] || state.probeCount >= PROBE_LIMIT) return;
  state.probeCount += 1;
  state.probes[url] = { status: "loading" };
  await setState(tabId, state);

  let result;
  try {
    const response = await fetch(url, { credentials: "include" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const text = await response.text();

    if (detect.isMaster(text)) {
      const { variants } = detect.parseMaster(text, url);
      result = { status: "master", variants };
      for (const variant of variants.slice(0, 3)) {
        if (variant.url) await probe(tabId, variant.url);
      }
    } else {
      const parsed = detect.parseVariant(text, url);
      result = parsed
        ? { status: "media", ...parsed }
        : { status: "error", message: "playlist had no entries" };
    }
  } catch (err) {
    result = { status: "error", message: String(err.message || err) };
  }

  const latest = await getState(tabId);
  latest.probes[url] = result;
  await setState(tabId, latest);
}

/* ------------------------------------------------- DeliveryInfo capture */

const PANOPTO_MATCHES = ["*://*.panopto.com/*", "*://*.panopto.eu/*"];

async function syncContentScripts() {
  const wanted = settings.session;
  const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ["hook", "relay"] })
    .catch(() => []);

  if (!wanted) {
    if (existing.length) {
      await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) });
    }
    return;
  }
  if (existing.length === 2) return;

  await chrome.scripting.unregisterContentScripts({ ids: existing.map((s) => s.id) }).catch(() => {});
  await chrome.scripting.registerContentScripts([
    {
      id: "hook",
      matches: PANOPTO_MATCHES,
      js: ["hook.js"],
      runAt: "document_start",
      world: "MAIN",
      allFrames: true,
    },
    {
      id: "relay",
      matches: PANOPTO_MATCHES,
      js: ["relay.js"],
      runAt: "document_start",
      world: "ISOLATED",
      allFrames: true,
    },
  ]);
}

chrome.runtime.onInstalled.addListener(() => { void loadSettings().then(syncContentScripts); });
chrome.runtime.onStartup.addListener(() => { void loadSettings().then(syncContentScripts); });

/* ---------------------------------------------------------------- messages */

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  handle(message, sender).then(respond).catch((err) => respond({ ok: false, error: String(err.message || err) }));
  return true; // async
});

async function handle(message, sender) {
  await loadSettings();

  switch (message.type) {
    case "deliveryinfo": {
      if (!settings.session) return { ok: false, error: "session module is off" };
      const tabId = sender.tab && sender.tab.id;
      if (tabId === undefined || tabId < 0) return { ok: false, error: "no tab" };
      let parsed;
      try {
        parsed = JSON.parse(message.body);
      } catch {
        return { ok: false, error: "DeliveryInfo body was not JSON" };
      }
      const plan = detect.planFromDeliveryInfo(parsed);
      if (!plan) return { ok: false, error: "unrecognised DeliveryInfo shape" };
      const state = await getState(tabId);
      state.delivery = { plan, body: message.body, at: Date.now() };
      await setState(tabId, state);
      return { ok: true };
    }

    case "state": {
      const state = await getState(message.tabId);
      return { ok: true, state, settings };
    }

    case "settings": {
      if (message.set) await saveSettings(message.set);
      return { ok: true, settings };
    }

    case "clear": {
      await chrome.storage.session.remove(key(message.tabId));
      await chrome.action.setBadgeText({ tabId: message.tabId, text: "" }).catch(() => {});
      return { ok: true };
    }

    case "download":
      return download(message.url, message.filename);

    case "downloadDelivery": {
      const state = await getState(message.tabId);
      if (!state.delivery) return { ok: false, error: "no DeliveryInfo captured" };
      const stem = detect.safeStem(state.delivery.plan.title || state.delivery.plan.deliveryId, "delivery");
      // A data: URL avoids needing createObjectURL, which service workers lack.
      const url = `data:application/json;charset=utf-8,${encodeURIComponent(state.delivery.body)}`;
      return download(url, `panopto-grab/${stem}.delivery.json`);
    }

    default:
      return { ok: false, error: `unknown message ${message.type}` };
  }
}

function download(url, filename) {
  return new Promise((resolve) => {
    chrome.downloads.download({ url, filename, saveAs: false }, (id) => {
      const err = chrome.runtime.lastError;
      resolve(err ? { ok: false, error: err.message } : { ok: true, id });
    });
  });
}

chrome.tabs.onRemoved.addListener((tabId) => {
  void chrome.storage.session.remove(key(tabId));
});

void loadSettings().then(syncContentScripts);
