/* Pure helpers shared by the service worker, the popup, and the Node tests.
 * No chrome.* access in here, so it stays testable outside the browser. */

export const PANOPTO_HOST_RE = /(^|\.)panopto\.(com|eu)$/i;

const EXT_KIND = {
  m3u8: "hls", mpd: "dash",
  mp4: "video", m4v: "video", webm: "video", mov: "video",
  m4a: "audio", mp3: "audio", aac: "audio", wav: "audio",
  vtt: "caption", srt: "caption",
};

/* Kinds we surface, in the order the popup should list them. */
export const KIND_ORDER = ["hls", "dash", "video", "audio", "caption"];

export function parseUrl(url) {
  try { return new URL(url); } catch { return null; }
}

export function resolveUrl(ref, base) {
  try { return new URL(ref, base).href; } catch { return null; }
}

export function extensionOf(url) {
  const u = parseUrl(url);
  if (!u) return "";
  const name = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function lastPathPart(url) {
  const u = parseUrl(url);
  if (!u) return url;
  const name = u.pathname.slice(u.pathname.lastIndexOf("/") + 1);
  return decodeURIComponent(name) || u.hostname;
}

/* Is this request one we care about? Returns a kind, or null to ignore.
 * Deliberately narrow: a Panopto viewer page fires 300+ requests and all but a
 * handful are fonts, sprites, and slide thumbnails. */
export function classify(url) {
  const u = parseUrl(url);
  if (!u) return null;
  if (/\/DeliveryInfo\.aspx/i.test(u.pathname)) return "deliveryinfo";

  // Slide stills are images, not media, and there are hundreds of them.
  if (/_et\/(thumbs|images)\//i.test(u.pathname)) return null;
  if (/\/(Thumb|Image)\.aspx/i.test(u.pathname)) return null;

  const kind = EXT_KIND[extensionOf(url)];
  if (!kind) return null;

  // Static site assets live on the asset CDN and are never session media.
  if (/^static-assets-cdn\./i.test(u.hostname)) return null;
  return kind;
}

/* ---------------------------------------------------------------- playlists */

export function isMaster(text) {
  return /^#EXT-X-STREAM-INF/m.test(text);
}

export function parseMaster(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const variants = [];
  let pending = null;

  for (const line of lines) {
    if (!line) continue;
    if (line.startsWith("#EXT-X-STREAM-INF")) {
      const res = /RESOLUTION=([0-9]+x[0-9]+)/i.exec(line);
      const bw = /BANDWIDTH=(\d+)/i.exec(line);
      const codecs = /CODECS="([^"]*)"/i.exec(line);
      pending = {
        resolution: res ? res[1] : "",
        bandwidth: bw ? Number(bw[1]) : 0,
        codecs: codecs ? codecs[1] : "",
      };
      continue;
    }
    if (line.startsWith("#EXT-X-MEDIA")) {
      const uri = /URI="([^"]+)"/i.exec(line);
      const name = /NAME="([^"]+)"/i.exec(line);
      const type = /TYPE=([A-Z]+)/i.exec(line);
      if (uri) {
        variants.push({
          url: resolveUrl(uri[1], baseUrl),
          label: `${type ? type[1].toLowerCase() : "track"} ${name ? name[1] : ""}`.trim(),
          resolution: "", bandwidth: 0, codecs: "", audioOnly: (type && type[1] === "AUDIO") || false,
        });
      }
      continue;
    }
    if (line.startsWith("#")) continue;

    if (pending) {
      const hasVideo = /avc1|hvc1|hev1|vp0?9|av01/i.test(pending.codecs);
      const audioOnly = pending.codecs ? !hasVideo : false;
      variants.push({
        url: resolveUrl(line, baseUrl),
        label: variantLabel(pending, audioOnly),
        resolution: pending.resolution,
        bandwidth: pending.bandwidth,
        codecs: pending.codecs,
        audioOnly,
      });
      pending = null;
    }
  }
  return { variants };
}

function variantLabel(v, audioOnly) {
  const bits = [];
  if (v.resolution) bits.push(v.resolution);
  else if (audioOnly) bits.push("audio only");
  if (v.bandwidth) bits.push(`${Math.round(v.bandwidth / 1000)} kbps`);
  return bits.join(", ") || "variant";
}

/* A media playlist comes in one of two shapes.
 *
 * byterange: every entry points at the same file and carries EXT-X-BYTERANGE.
 *   Panopto does this. One plain GET of that file is the entire recording, so
 *   there is nothing to stitch.
 *
 * segments: entries are separate files, which need joining locally.
 */
export function parseVariant(text, baseUrl) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const entries = [];
  let duration = 0;
  let pendingDuration = 0;
  let pendingRange = null;
  let init = null;
  let cursor = 0; // implied offset when EXT-X-BYTERANGE omits @offset

  for (const line of lines) {
    if (!line) continue;

    if (line.startsWith("#EXT-X-MAP")) {
      const uri = /URI="([^"]+)"/i.exec(line);
      const range = /BYTERANGE="([^"]+)"/i.exec(line);
      if (uri) {
        const parsed = range ? parseByteRange(range[1], 0) : null;
        init = { url: resolveUrl(uri[1], baseUrl), range: parsed };
        if (parsed) cursor = parsed.offset + parsed.length;
      }
      continue;
    }
    if (line.startsWith("#EXTINF:")) {
      pendingDuration = parseFloat(line.slice(8)) || 0;
      continue;
    }
    if (line.startsWith("#EXT-X-BYTERANGE:")) {
      pendingRange = parseByteRange(line.slice(17), cursor);
      if (pendingRange) cursor = pendingRange.offset + pendingRange.length;
      continue;
    }
    if (line.startsWith("#")) continue;

    entries.push({
      url: resolveUrl(line, baseUrl),
      duration: pendingDuration,
      range: pendingRange,
    });
    duration += pendingDuration;
    pendingDuration = 0;
    pendingRange = null;
  }

  if (!entries.length) return null;

  const distinct = new Set(entries.map((e) => e.url));
  const ranged = entries.every((e) => e.range);

  if (distinct.size === 1 && ranged) {
    const last = entries[entries.length - 1].range;
    const bytes = last.offset + last.length;
    let contiguous = true;
    let expected = init && init.range ? init.range.offset + init.range.length : entries[0].range.offset;
    for (const e of entries) {
      if (e.range.offset !== expected) { contiguous = false; break; }
      expected = e.range.offset + e.range.length;
    }
    return {
      layout: "byterange",
      wholeUrl: entries[0].url,
      initUrl: init ? init.url : null,
      count: entries.length,
      duration,
      bytes,
      contiguous,
      segments: [],
    };
  }

  return {
    layout: "segments",
    wholeUrl: null,
    initUrl: init ? init.url : null,
    count: entries.length,
    duration,
    bytes: 0,
    contiguous: false,
    segments: entries.map((e) => e.url),
  };
}

export function parseByteRange(value, impliedOffset) {
  const match = /^\s*(\d+)(?:@(\d+))?\s*$/.exec(value || "");
  if (!match) return null;
  const length = Number(match[1]);
  const offset = match[2] !== undefined ? Number(match[2]) : Number(impliedOffset || 0);
  return { length, offset };
}

/* ----------------------------------------------------------- DeliveryInfo */

export function planFromDeliveryInfo(info) {
  const delivery = (info && info.Delivery) || info;
  if (!delivery || typeof delivery !== "object") return null;

  const streams = delivery.Streams || [];
  const podcasts = delivery.PodcastStreams || [];
  const timestamps = delivery.Timestamps || [];

  const podcastUrl = firstUrl(podcasts);
  const videoStreams = streams
    .filter((s) => (s.Tag || "").toUpperCase() !== "AUDIO")
    .map((s) => ({ tag: s.Tag || "untagged", url: s.StreamHttpUrl || s.StreamUrl || "" }))
    .filter((s) => s.url);

  return {
    title: (delivery.SessionName || "").trim(),
    course: (delivery.SessionGroupLongName || "").trim(),
    owner: (delivery.OwnerDisplayName || "").trim(),
    deliveryId: delivery.PublicID || "",
    duration: Number(delivery.Duration) || 0,
    audioOnly: !!delivery.IsPrimaryAudioOnly,
    hasCaptions: !!delivery.HasCaptions,
    captionCount: (delivery.AvailableCaptions || []).length,
    podcastUrl,
    podcastReady: !!delivery.IsPodcastEncodeComplete,
    streamUrl: firstUrl(streams),
    videoStreams,
    slideCount: timestamps.length,
  };
}

function firstUrl(list) {
  for (const s of list || []) {
    const url = s.StreamUrl || s.StreamHttpUrl;
    if (url) return url;
  }
  return "";
}

/* Panopto writes the CDN host with an explicit :443, which is valid but makes
 * every derived URL ugly and upsets some proxies. */
export function tidyUrl(url) {
  const u = parseUrl(url);
  if (!u) return url;
  if ((u.protocol === "https:" && u.port === "443") || (u.protocol === "http:" && u.port === "80")) {
    u.port = "";
  }
  return u.href;
}

/* ------------------------------------------------------------------ naming */

export function safeStem(value, fallback = "panopto") {
  const cleaned = String(value || "")
    .replace(/\.{2,}/g, "")
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  return cleaned.slice(0, 80) || fallback;
}

export function suggestFilename({ title, url, kind, audioOnly }) {
  const stem = safeStem(title || lastPathPart(url).replace(/\.[^.]+$/, ""));
  let ext = extensionOf(url) || "bin";
  if (kind === "hls" || kind === "dash") ext = audioOnly ? "m4a" : "mp4";
  return `panopto-grab/${stem}.${ext}`;
}

export function formatBytes(n) {
  if (!n || n < 0 || Number.isNaN(n)) return "—";
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB"];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i += 1; }
  return `${v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
}

export function formatDuration(seconds) {
  if (!seconds || seconds < 0) return "—";
  const total = Math.round(seconds);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const pad = (n) => String(n).padStart(2, "0");
  return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
}

export function viewerInfo(url) {
  const u = parseUrl(url);
  if (!u || !PANOPTO_HOST_RE.test(u.hostname)) return null;
  if (!/\/Pages\/Viewer\.aspx/i.test(u.pathname)) return null;
  return { tenant: u.hostname, deliveryId: u.searchParams.get("id") || "" };
}

/* ffmpeg command for the cases the extension cannot finish on its own. */
export function ffmpegCommand({ url, out, referer }) {
  const quote = (s) => `'${String(s).replace(/'/g, "'\\''")}'`;
  const parts = ["ffmpeg"];
  if (referer) parts.push("-referer", quote(referer));
  parts.push("-i", quote(url), "-c", "copy", quote(out || "out.mp4"));
  return parts.join(" ");
}
