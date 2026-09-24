/* node test/test_detect.mjs [path/to/capture.txt]
 *
 * The pure library is tested directly. Where a real capture is supplied, the
 * parsers are run against the actual playlist and DeliveryInfo bodies the
 * browser received, and the results checked against figures measured
 * independently from that same file.
 */

import * as d from "../lib/detect.js";
import fs from "node:fs";

const DEFAULT_CAPTURE = "/mnt/user-data/uploads/pitt_hosted_panopto_com-2026-09-23T15-55-33.txt";

let passed = 0;
let failed = 0;

function check(name, fn) {
  try {
    fn();
    passed += 1;
  } catch (err) {
    failed += 1;
    const line = (err.stack || "").split("\n").find((l) => l.includes("test_detect")) || "";
    console.error(`FAIL ${name}\n  ${err.message}\n  ${line.trim()}`);
  }
}

function eq(a, b, msg = "") {
  if (a !== b) throw new Error(`${msg} expected ${JSON.stringify(b)}, got ${JSON.stringify(a)}`);
}

function near(a, b, tol = 1e-6) {
  if (Math.abs(a - b) > tol) throw new Error(`expected ~${b}, got ${a}`);
}

function ok(v, msg = "assertion failed") {
  if (!v) throw new Error(msg);
}

/* ------------------------------------------------------------- classify */

check("classifies session media", () => {
  eq(d.classify("https://cdn.test/a/index.m3u8"), "hls");
  eq(d.classify("https://cdn.test/a/manifest.mpd"), "dash");
  eq(d.classify("https://cdn.test/a/fragmented.mp4"), "video");
  eq(d.classify("https://cdn.test/a/audio.m4a"), "audio");
  eq(d.classify("https://cdn.test/a/subs.vtt"), "caption");
});

check("recognises DeliveryInfo regardless of host", () => {
  eq(d.classify("https://x.panopto.com/Panopto/Pages/Viewer/DeliveryInfo.aspx"), "deliveryinfo");
});

check("ignores the noise a viewer page generates", () => {
  // Hundreds of slide stills would otherwise drown the real media.
  eq(d.classify("https://cdn.test/sessions/s/obj_et/thumbs/slide65537.jpg"), null);
  eq(d.classify("https://cdn.test/sessions/s/obj_et/images/slide65537.jpg"), null);
  eq(d.classify("https://x.panopto.com/Panopto/Pages/Viewer/Thumb.aspx?x=1"), null);
  eq(d.classify("https://x.panopto.com/Panopto/Pages/Viewer/Image.aspx?id=1"), null);
  eq(d.classify("https://static-assets-cdn.i.hosted.panopto.com/x/vendors.js"), null);
  eq(d.classify("https://cdn.test/a/logo.png"), null);
  eq(d.classify("not a url"), null);
});

check("does not treat an mp4 on the asset CDN as media", () => {
  eq(d.classify("https://static-assets-cdn.i.hosted.panopto.com/x/promo.mp4"), null);
});

/* ------------------------------------------------------------ byteranges */

check("parses byte ranges with and without an offset", () => {
  eq(d.parseByteRange("111662@762").length, 111662);
  eq(d.parseByteRange("111662@762").offset, 762);
  // An omitted offset continues from wherever the previous range ended.
  eq(d.parseByteRange("500", 1000).offset, 1000);
  eq(d.parseByteRange("bad"), null);
  eq(d.parseByteRange(""), null);
});

/* -------------------------------------------------------------- playlists */

const MASTER = [
  "#EXTM3U",
  '#EXT-X-STREAM-INF:PROGRAM-ID=1,BANDWIDTH=105954,CODECS="mp4a.40.2",AVERAGE-BANDWIDTH=98888',
  "96003/index.m3u8",
].join("\n");

check("detects a master playlist", () => {
  ok(d.isMaster(MASTER));
  ok(!d.isMaster("#EXTM3U\n#EXTINF:9,\nfragmented.mp4"));
});

check("reads the audio-only master from the real session", () => {
  const { variants } = d.parseMaster(MASTER, "https://cdn.test/s/x.hls/master.m3u8");
  eq(variants.length, 1);
  eq(variants[0].url, "https://cdn.test/s/x.hls/96003/index.m3u8");
  // No avc1 in CODECS, so this recording has no video track at all.
  eq(variants[0].audioOnly, true);
  ok(variants[0].label.includes("audio only"));
  ok(variants[0].label.includes("106 kbps"), variants[0].label);
});

check("marks a variant with a video codec as not audio-only", () => {
  const text = [
    "#EXTM3U",
    '#EXT-X-STREAM-INF:BANDWIDTH=2400000,RESOLUTION=1280x720,CODECS="avc1.640028,mp4a.40.2"',
    "hi/index.m3u8",
  ].join("\n");
  const { variants } = d.parseMaster(text, "https://cdn.test/m.m3u8");
  eq(variants[0].audioOnly, false);
  ok(variants[0].label.includes("1280x720"));
});

check("picks up alternate renditions", () => {
  const text = [
    "#EXTM3U",
    '#EXT-X-MEDIA:TYPE=AUDIO,NAME="English",URI="audio/en.m3u8"',
    "#EXT-X-STREAM-INF:BANDWIDTH=800000",
    "v/index.m3u8",
  ].join("\n");
  const { variants } = d.parseMaster(text, "https://cdn.test/m.m3u8");
  eq(variants.length, 2);
  ok(variants.some((v) => v.url === "https://cdn.test/audio/en.m3u8"));
});

check("recognises the byte-range layout", () => {
  const text = [
    "#EXTM3U",
    "#EXT-X-VERSION:7",
    '#EXT-X-MAP:URI="fragmented.mp4",BYTERANGE="762@0"',
    "#EXTINF:9.022358,",
    "#EXT-X-BYTERANGE:111662@762",
    "fragmented.mp4",
    "#EXTINF:8.987098,",
    "#EXT-X-BYTERANGE:111088@112424",
    "fragmented.mp4",
    "#EXT-X-ENDLIST",
  ].join("\n");
  const r = d.parseVariant(text, "https://cdn.test/s/x.hls/96003/index.m3u8");
  eq(r.layout, "byterange");
  eq(r.wholeUrl, "https://cdn.test/s/x.hls/96003/fragmented.mp4");
  eq(r.count, 2);
  eq(r.bytes, 112424 + 111088);
  eq(r.contiguous, true);
  near(r.duration, 18.009456, 1e-6);
  eq(r.segments.length, 0);
});

check("recognises the separate-segment layout", () => {
  const text = [
    "#EXTM3U",
    "#EXTINF:9,", "seg0.ts",
    "#EXTINF:9,", "seg1.ts",
  ].join("\n");
  const r = d.parseVariant(text, "https://cdn.test/v/index.m3u8");
  eq(r.layout, "segments");
  eq(r.wholeUrl, null);
  eq(r.segments.length, 2);
  eq(r.segments[0], "https://cdn.test/v/seg0.ts");
});

check("flags a non-contiguous byte-range playlist", () => {
  // A trimmed session can leave gaps; a single whole-file GET would then
  // include material the playlist excludes.
  const text = [
    "#EXTM3U",
    '#EXT-X-MAP:URI="f.mp4",BYTERANGE="100@0"',
    "#EXTINF:9,", "#EXT-X-BYTERANGE:100@100", "f.mp4",
    "#EXTINF:9,", "#EXT-X-BYTERANGE:100@9000", "f.mp4",
  ].join("\n");
  const r = d.parseVariant(text, "https://cdn.test/v/index.m3u8");
  eq(r.layout, "byterange");
  eq(r.contiguous, false);
});

check("returns null for a playlist with no entries", () => {
  eq(d.parseVariant("#EXTM3U\n#EXT-X-ENDLIST", "https://cdn.test/v/index.m3u8"), null);
});

/* ----------------------------------------------------------- DeliveryInfo */

check("summarises a delivery", () => {
  const plan = d.planFromDeliveryInfo({
    Delivery: {
      SessionName: "Lecture 4",
      SessionGroupLongName: "BIOENG_1310",
      OwnerDisplayName: "Someone",
      PublicID: "abc",
      Duration: 3375.065,
      IsPrimaryAudioOnly: true,
      IsPodcastEncodeComplete: true,
      HasCaptions: false,
      AvailableCaptions: [],
      PodcastStreams: [{ StreamUrl: "https://cdn.test:443/a.mp4" }],
      Streams: [{ Tag: "AUDIO", StreamHttpUrl: "https://cdn.test:443/m.m3u8" }],
      Timestamps: [{}, {}, {}],
    },
  });
  eq(plan.title, "Lecture 4");
  eq(plan.audioOnly, true);
  eq(plan.podcastReady, true);
  eq(plan.hasCaptions, false);
  eq(plan.slideCount, 3);
  eq(plan.videoStreams.length, 0);
  eq(plan.podcastUrl, "https://cdn.test:443/a.mp4");
});

check("separates video-tagged streams from audio", () => {
  const plan = d.planFromDeliveryInfo({
    Delivery: {
      Duration: 10,
      Streams: [
        { Tag: "AUDIO", StreamHttpUrl: "https://cdn.test/a.m3u8" },
        { Tag: "SCREEN", StreamHttpUrl: "https://cdn.test/s.m3u8" },
      ],
      PodcastStreams: [],
      Timestamps: [],
    },
  });
  eq(plan.videoStreams.length, 1);
  eq(plan.videoStreams[0].tag, "SCREEN");
});

check("tolerates a bare delivery object and rubbish input", () => {
  eq(d.planFromDeliveryInfo({ Duration: 5, Streams: [], PodcastStreams: [], Timestamps: [] }).duration, 5);
  eq(d.planFromDeliveryInfo(null), null);
  eq(d.planFromDeliveryInfo("nope"), null);
});

/* ----------------------------------------------------------------- naming */

check("tidies the redundant port", () => {
  eq(d.tidyUrl("https://cdn.test:443/a/b.mp4?x=1"), "https://cdn.test/a/b.mp4?x=1");
  eq(d.tidyUrl("https://cdn.test:8443/a"), "https://cdn.test:8443/a");
});

check("builds safe filenames", () => {
  eq(d.safeStem("Thursday, August 27, 2026 at 5:07:11 PM"),
     "Thursday,-August-27,-2026-at-5-07-11-PM");
  eq(d.safeStem("../../etc/passwd"), "etc-passwd");
  eq(d.safeStem(""), "panopto");
  ok(d.safeStem("x".repeat(200)).length <= 80);
});

check("chooses an extension by layout, not by manifest suffix", () => {
  eq(d.suggestFilename({ title: "L4", url: "https://c/x/index.m3u8", kind: "hls", audioOnly: true }),
     "panopto-grab/L4.m4a");
  eq(d.suggestFilename({ title: "L4", url: "https://c/x/index.m3u8", kind: "hls", audioOnly: false }),
     "panopto-grab/L4.mp4");
  eq(d.suggestFilename({ title: "", url: "https://c/x/fragmented.mp4", kind: "video" }),
     "panopto-grab/fragmented.mp4");
});

check("formats sizes and durations", () => {
  eq(d.formatBytes(0), "—");
  eq(d.formatBytes(41720035), "40 MB");
  eq(d.formatDuration(3375.065), "56:15");
  eq(d.formatDuration(0), "—");
  eq(d.formatDuration(61), "1:01");
});

check("identifies a viewer page", () => {
  const v = d.viewerInfo("https://pitt.hosted.panopto.com/Panopto/Pages/Viewer.aspx?id=c2a88244");
  eq(v.tenant, "pitt.hosted.panopto.com");
  eq(v.deliveryId, "c2a88244");
  eq(d.viewerInfo("https://pitt.hosted.panopto.com/Panopto/Pages/Sessions/List.aspx"), null);
  eq(d.viewerInfo("https://evil.test/Panopto/Pages/Viewer.aspx?id=x"), null);
});

check("quotes the ffmpeg command safely", () => {
  const cmd = d.ffmpegCommand({ url: "https://c/x's.m3u8", out: "a b.mp4", referer: "https://p/" });
  ok(cmd.includes("-referer 'https://p/'"));
  ok(cmd.includes("'https://c/x'\\''s.m3u8'"));
  ok(cmd.endsWith("'a b.mp4'"));
});

/* ------------------------------------------------- against the real capture */

function blocks(text) {
  return text.split(/^={10,}\s*$/m);
}

function bodyOf(text, needle) {
  for (const block of blocks(text)) {
    const header = block.match(/^\s*\[(\d+)\]\s+\w+\s+\d+\s+(\S+)/);
    if (!header || !header[2].includes(needle)) continue;
    const parts = block.split(/^-{10,}\s*$/m);
    if (parts.length > 1) return { url: header[2], body: parts[1].trim() };
  }
  return null;
}

function testRealCapture(path) {
  const text = fs.readFileSync(path, "utf8");

  const master = bodyOf(text, "master.m3u8");
  ok(master, "no master.m3u8 body in capture");
  ok(d.isMaster(master.body));
  // Base URL comes from the capture, so derived URLs can be checked against
  // URLs the browser really requested rather than against a guess.
  const { variants } = d.parseMaster(master.body, master.url);
  eq(variants.length, 1, "master variants:");
  eq(variants[0].audioOnly, true, "real session should be audio only:");
  ok(text.includes(variants[0].url.split("?")[0]),
     `variant URL not seen in capture: ${variants[0].url}`);

  const variant = bodyOf(text, "96003/index.m3u8");
  ok(variant, "no variant playlist body in capture");
  const r = d.parseVariant(variant.body, variant.url);

  // Figures measured independently from the same capture.
  eq(r.layout, "byterange");
  eq(r.count, 376, "segment count:");
  eq(r.bytes, 41720035, "whole-file size:");
  eq(r.contiguous, true, "ranges should tile the file:");
  near(r.duration, 3375.09, 0.001);
  ok(r.wholeUrl.endsWith("/96003/fragmented.mp4"), r.wholeUrl);
  // The derived whole-file URL must be one the browser actually requested.
  ok(text.includes(r.wholeUrl), `derived URL not seen in capture: ${r.wholeUrl}`);

  const info = bodyOf(text, "DeliveryInfo.aspx");
  ok(info, "no DeliveryInfo body in capture");
  const plan = d.planFromDeliveryInfo(JSON.parse(info.body));
  eq(plan.slideCount, 137, "slides:");
  near(plan.duration, 3375.065, 1e-9);
  eq(plan.audioOnly, true);
  eq(plan.podcastReady, true);
  eq(plan.hasCaptions, false, "session should have no captions:");
  eq(plan.captionCount, 0);
  eq(plan.videoStreams.length, 0, "no video streams expected:");
  eq(plan.course, "2271_BIOENG_1310_SEC1025");
  // Panopto serialises JSON with escaped forward slashes ("https:\/\/..."),
  // which is legal JSON but means a URL parsed out of the body will never match
  // the raw dump text. Unescape before checking containment.
  const plain = text.replace(/\\\//g, "/");
  ok(plain.includes(plan.podcastUrl.split("?")[0]),
     `podcast URL not in capture: ${plan.podcastUrl}`);
  ok(plain.includes(d.tidyUrl(plan.streamUrl).split("?")[0])
     || plain.includes(plan.streamUrl.split("?")[0]), "stream URL not in capture");

  // Playlist duration and delivery duration should agree closely but need not
  // match exactly; the last fragment overruns slightly.
  ok(Math.abs(r.duration - plan.duration) < 0.5,
     `playlist ${r.duration} vs delivery ${plan.duration}`);

  eq(d.suggestFilename({ title: plan.title, url: r.wholeUrl, kind: "video" }),
     "panopto-grab/Thursday,-August-27,-2026-at-5-07-11-PM.mp4");
}

const capture = process.argv[2] || DEFAULT_CAPTURE;
if (fs.existsSync(capture)) {
  check("real capture end to end", () => testRealCapture(capture));
} else {
  console.log(`SKIP real capture (nothing at ${capture})`);
}

console.log(`${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
