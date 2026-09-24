#!/usr/bin/env python3
"""
panopto_slidecast — rebuild an audio-only Panopto session as a watchable MP4.

Some Panopto recordings have no video encode at all: the delivery carries one
AAC audio stream, and what looks like "the screen" is a set of slide stills the
viewer swaps in on a timer. There is no MP4 to download because none was ever
made. This script makes one, using the slide timings Panopto already published
in DeliveryInfo.

Input is the DeliveryInfo response body. Either hand it the .txt that Inspect
Extractor saved (the JSON gets located inside it) or a plain .json file.

    python3 panopto_slidecast.py capture.txt -o lecture.mp4

Outputs alongside the MP4:
    <name>.outline.md    slide titles, times, and slide text
    work/concat.txt      the ffmpeg edit list, kept for inspection

Requires ffmpeg on PATH. No third-party Python packages.
"""

from __future__ import annotations

import argparse
import concurrent.futures
import json
import os
import re
import shutil
import subprocess
import sys
import urllib.error
import urllib.request
from dataclasses import dataclass, field, asdict
from urllib.parse import urlparse, urlunparse

# ===== pure: start =====

DEFAULT_SIZE = (1920, 1080)
UA = "Mozilla/5.0 (compatible; panopto-slidecast/1.0)"


@dataclass
class Slide:
    n: int                 # 1-based position
    seq: str               # ObjectSequenceNumber, used in the image filename
    start: float           # seconds from session start
    duration: float        # seconds this slide is on screen
    caption: str = ""      # slide title
    text: str = ""         # slide body text Panopto extracted
    image_url: str = ""
    thumb_url: str = ""

    @property
    def end(self) -> float:
        return self.start + self.duration

    @property
    def filename(self) -> str:
        return f"{self.n:04d}.jpg"


@dataclass
class Plan:
    title: str
    course: str
    owner: str
    duration: float
    audio_url: str
    audio_kind: str                       # "podcast" or "hls"
    audio_only: bool
    slides: list[Slide] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)


def find_delivery_info(text: str) -> dict:
    """Pull the DeliveryInfo JSON out of a capture dump, or parse it directly.

    The dump format puts a `---` rule between the request header block and the
    body, so the body is located by finding the DeliveryInfo detail block and
    taking everything after that rule. Falls back to brace matching for dumps
    in other shapes.
    """
    stripped = text.lstrip()
    if stripped.startswith("{"):
        return json.loads(stripped)

    blocks = re.split(r"^={10,}\s*$", text, flags=re.M)
    for block in blocks:
        if "DeliveryInfo" not in block:
            continue
        parts = re.split(r"^-{10,}\s*$", block, maxsplit=1, flags=re.M)
        if len(parts) == 2:
            body = parts[1].strip()
            if body.startswith("{"):
                try:
                    return json.loads(body)
                except json.JSONDecodeError:
                    pass

    # Last resort: first balanced object that mentions the fields we need.
    for match in re.finditer(r"\{", text):
        candidate = _balanced(text, match.start())
        if not candidate or "Timestamps" not in candidate:
            continue
        try:
            data = json.loads(candidate)
        except json.JSONDecodeError:
            continue
        if isinstance(data, dict) and ("Delivery" in data or "Timestamps" in data):
            return data

    raise ValueError(
        "No DeliveryInfo JSON found. Capture the viewer page with the Extract "
        "panel open and make sure the DeliveryInfo row shows a body."
    )


def _balanced(text: str, start: int) -> str | None:
    depth = 0
    in_str = False
    escape = False
    for i in range(start, len(text)):
        ch = text[i]
        if in_str:
            if escape:
                escape = False
            elif ch == "\\":
                escape = True
            elif ch == '"':
                in_str = False
            continue
        if ch == '"':
            in_str = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return text[start:i + 1]
    return None


def media_origin(*urls: str) -> str:
    """Scheme + host of the first usable URL, dropping a redundant :443/:80.

    Panopto writes the CDN host with an explicit port. Keeping it works but
    makes every derived URL ugly, and some proxies object.
    """
    for url in urls:
        if not url:
            continue
        parsed = urlparse(url)
        if not parsed.scheme or not parsed.hostname:
            continue
        host = parsed.hostname
        port = parsed.port
        default = {"https": 443, "http": 80}.get(parsed.scheme)
        netloc = host if (port is None or port == default) else f"{host}:{port}"
        return urlunparse((parsed.scheme, netloc, "", "", "", ""))
    raise ValueError("No usable media URL in the delivery")


def clean_text(value: str | None) -> str:
    if not value:
        return ""
    return re.sub(r"\s+", " ", value).strip()


def build_plan(info: dict) -> Plan:
    delivery = info.get("Delivery") or info
    duration = float(delivery.get("Duration") or 0)
    if duration <= 0:
        raise ValueError("Delivery reports no duration")

    streams = delivery.get("Streams") or []
    podcasts = delivery.get("PodcastStreams") or []

    origin = media_origin(
        *[s.get("StreamUrl") or s.get("StreamHttpUrl") or "" for s in podcasts],
        *[s.get("StreamHttpUrl") or s.get("StreamUrl") or "" for s in streams],
    )

    warnings: list[str] = []

    audio_url, audio_kind = "", ""
    for s in podcasts:
        url = s.get("StreamUrl") or s.get("StreamHttpUrl")
        if url:
            audio_url, audio_kind = url, "podcast"
            break
    if not audio_url:
        for s in streams:
            url = s.get("StreamHttpUrl") or s.get("StreamUrl")
            if url:
                audio_url, audio_kind = url, "hls"
                warnings.append(
                    "No podcast encode published; reading audio from the HLS "
                    "manifest instead. Slower, and ffmpeg has to do the demux."
                )
                break
    if not audio_url:
        raise ValueError("Delivery has no podcast or stream URL to take audio from")

    audio_only = bool(delivery.get("IsPrimaryAudioOnly"))
    video_tags = [s.get("Tag") for s in streams if (s.get("Tag") or "").upper() not in ("", "AUDIO")]
    if video_tags:
        warnings.append(
            f"Delivery also carries non-audio stream(s) {video_tags}. If one of "
            "those is real video, downloading it directly beats rebuilding "
            "slides."
        )
    elif not audio_only:
        warnings.append(
            "IsPrimaryAudioOnly is not set, but no video-tagged stream was "
            "found. Proceeding on the assumption this is audio plus slides."
        )

    timestamps = delivery.get("Timestamps") or []
    slides: list[Slide] = []
    for entry in timestamps:
        seq = entry.get("ObjectSequenceNumber")
        obj = entry.get("ObjectPublicIdentifier")
        session = entry.get("SessionID") or delivery.get("SessionPublicID")
        if not (seq and obj and session):
            continue
        start = float(entry.get("Time") or 0)
        dur = entry.get("Duration")
        n = len(slides) + 1
        base = f"{origin}/sessions/{session}/{obj}_et"
        slides.append(Slide(
            n=n,
            seq=str(seq),
            start=start,
            duration=float(dur) if dur is not None else 0.0,
            caption=clean_text(entry.get("Caption")),
            text=clean_text(entry.get("Data")),
            image_url=f"{base}/images/slide{seq}.jpg",
            thumb_url=f"{base}/thumbs/slide{seq}.jpg",
        ))

    if not slides:
        raise ValueError(
            "No slide timestamps in this delivery. With no slides and no video "
            "there is nothing to build; just download the audio."
        )

    slides = repair_timing(slides, duration, warnings)

    return Plan(
        title=clean_text(delivery.get("SessionName")) or "Panopto session",
        course=clean_text(delivery.get("SessionGroupLongName")),
        owner=clean_text(delivery.get("OwnerDisplayName")),
        duration=duration,
        audio_url=audio_url,
        audio_kind=audio_kind,
        audio_only=audio_only,
        slides=slides,
        warnings=warnings,
    )


def repair_timing(slides: list[Slide], duration: float, warnings: list[str]) -> list[Slide]:
    """Make the slide durations tile [0, duration] exactly.

    Panopto's own Duration fields normally already do this. They can drift when
    a session has been trimmed in the editor, so derive each duration from the
    next slide's start and only fall back to the published value.
    """
    slides = sorted(slides, key=lambda s: s.start)
    drift = 0.0
    for i, slide in enumerate(slides):
        nxt = slides[i + 1].start if i + 1 < len(slides) else duration
        derived = nxt - slide.start
        if derived <= 0:
            derived = 0.001
        if slide.duration and abs(derived - slide.duration) > 0.05:
            drift = max(drift, abs(derived - slide.duration))
        slide.duration = derived
        slide.n = i + 1

    if slides[0].start > 0.05:
        warnings.append(
            f"First slide starts at {slides[0].start:.1f}s; padding the gap with it."
        )
        slides[0].duration += slides[0].start
        slides[0].start = 0.0

    if drift > 0:
        warnings.append(
            f"Published slide durations disagreed with slide start times by up "
            f"to {drift:.2f}s. Used the start times, which keeps audio in sync."
        )
    return slides


def concat_lines(slides: list[Slide], directory: str) -> list[str]:
    """ffmpeg concat demuxer edit list.

    The final entry is repeated with no duration on purpose: without it the
    demuxer drops the last slide, which is a well-known wart.
    """
    lines = ["ffconcat version 1.0"]
    for slide in slides:
        path = os.path.join(directory, slide.filename)
        lines.append(f"file '{escape_concat(path)}'")
        lines.append(f"duration {slide.duration:.6f}")
    last = os.path.join(directory, slides[-1].filename)
    lines.append(f"file '{escape_concat(last)}'")
    return lines


def escape_concat(path: str) -> str:
    return path.replace("\\", "\\\\").replace("'", "'\\''")


def escape_meta(value: str) -> str:
    return re.sub(r"([=;#\\\n])", r"\\\1", value)


def chapter_title(slide: Slide, limit: int = 70) -> str:
    # Every chapter keeps its index prefix, including untitled ones. Dropping it
    # for the blank ones makes a long chapter list read as if slides are missing.
    title = clean_text(slide.caption) or clean_text(slide.text)
    if not title:
        title = f"Slide {slide.n}"
    if len(title) > limit:
        title = title[:limit - 1].rstrip() + "\u2026"
    return f"{slide.n:03d} {title}"


def ffmetadata_lines(plan: Plan) -> list[str]:
    lines = [";FFMETADATA1"]
    if plan.title:
        lines.append(f"title={escape_meta(plan.title)}")
    if plan.course:
        lines.append(f"album={escape_meta(plan.course)}")
    if plan.owner:
        lines.append(f"artist={escape_meta(plan.owner)}")
    for slide in plan.slides:
        lines += [
            "[CHAPTER]",
            "TIMEBASE=1/1000",
            f"START={int(round(slide.start * 1000))}",
            f"END={int(round(slide.end * 1000))}",
            f"title={escape_meta(chapter_title(slide))}",
        ]
    return lines


def hhmmss(seconds: float) -> str:
    total = int(seconds)
    h, rem = divmod(total, 3600)
    m, s = divmod(rem, 60)
    return f"{h}:{m:02d}:{s:02d}" if h else f"{m}:{s:02d}"


def outline_lines(plan: Plan) -> list[str]:
    """A searchable text outline, since these sessions rarely have captions."""
    out = [f"# {plan.title}", ""]
    meta = [m for m in (plan.course, plan.owner, hhmmss(plan.duration) + " long") if m]
    if meta:
        out += ["  ".join(meta), ""]
    out += [f"{len(plan.slides)} slides.", ""]
    for slide in plan.slides:
        out.append(f"## {slide.n:03d}  {hhmmss(slide.start)}  {slide.caption or 'Untitled slide'}")
        out.append("")
        if slide.text and slide.text != slide.caption:
            out += [slide.text, ""]
    return out


def safe_stem(value: str) -> str:
    value = re.sub(r"[^\w\s.-]", "", value).strip()
    value = re.sub(r"\s+", "-", value)
    return value[:80].strip("-.") or "session"


def parse_size(value: str) -> tuple[int, int]:
    match = re.fullmatch(r"\s*(\d{2,5})\s*[xX:*]\s*(\d{2,5})\s*", value)
    if not match:
        raise ValueError(f"Bad size {value!r}; expected something like 1920x1080")
    w, h = int(match.group(1)), int(match.group(2))
    if w % 2 or h % 2:
        raise ValueError("Width and height must both be even for H.264")
    return w, h


# ===== pure: end =====


def log(message: str) -> None:
    print(message, file=sys.stderr, flush=True)


def require_ffmpeg() -> None:
    for tool in ("ffmpeg",):
        if shutil.which(tool) is None:
            raise SystemExit(f"{tool} not found on PATH. Install ffmpeg and retry.")


def fetch(url: str, dest: str, cookie: str | None, tries: int = 3) -> int:
    headers = {"User-Agent": UA, "Accept": "*/*"}
    if cookie:
        headers["Cookie"] = cookie
    last: Exception | None = None
    for attempt in range(1, tries + 1):
        try:
            request = urllib.request.Request(url, headers=headers)
            with urllib.request.urlopen(request, timeout=60) as response:
                tmp = dest + ".part"
                with open(tmp, "wb") as handle:
                    shutil.copyfileobj(response, handle, 1 << 16)
                os.replace(tmp, dest)
                return os.path.getsize(dest)
        except (urllib.error.URLError, urllib.error.HTTPError, OSError) as err:
            last = err
            if attempt == tries:
                break
    raise RuntimeError(f"{url} failed after {tries} tries: {last}")


def download_slides(plan: Plan, raw_dir: str, cookie: str | None,
                    jobs: int, use_thumbs: bool) -> list[Slide]:
    os.makedirs(raw_dir, exist_ok=True)
    missing: list[Slide] = []

    def one(slide: Slide) -> tuple[Slide, bool]:
        dest = os.path.join(raw_dir, slide.filename)
        if os.path.exists(dest) and os.path.getsize(dest) > 0:
            return slide, True
        primary = slide.thumb_url if use_thumbs else slide.image_url
        backup = slide.image_url if use_thumbs else slide.thumb_url
        for url in (primary, backup):
            try:
                if fetch(url, dest, cookie) > 0:
                    return slide, True
            except RuntimeError:
                continue
        return slide, False

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        for slide, ok in pool.map(one, plan.slides):
            done += 1
            if not ok:
                missing.append(slide)
            if done % 20 == 0 or done == len(plan.slides):
                log(f"  slides {done}/{len(plan.slides)}")
    return missing


def normalize_slides(plan: Plan, raw_dir: str, norm_dir: str,
                     size: tuple[int, int], pad: str, jobs: int) -> None:
    """Force every slide to identical dimensions.

    The concat demuxer feeds one decoder, so a mid-stream resolution change
    either errors or silently reconfigures the filter graph. Slide exports are
    usually uniform but a pasted screenshot can differ, and finding that out 40
    minutes into an encode is miserable.
    """
    os.makedirs(norm_dir, exist_ok=True)
    w, h = size
    chain = (
        f"scale={w}:{h}:force_original_aspect_ratio=decrease,"
        f"pad={w}:{h}:(ow-iw)/2:(oh-ih)/2:color={pad},setsar=1"
    )

    def one(slide: Slide) -> None:
        src = os.path.join(raw_dir, slide.filename)
        dst = os.path.join(norm_dir, slide.filename)
        if os.path.exists(dst) and os.path.getsize(dst) > 0:
            return
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-i", src,
             "-vf", chain, "-q:v", "3", dst],
            check=True,
        )

    done = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=jobs) as pool:
        for _ in pool.map(one, plan.slides):
            done += 1
            if done % 20 == 0 or done == len(plan.slides):
                log(f"  normalized {done}/{len(plan.slides)}")


def placeholder(path: str, size: tuple[int, int], label: str, pad: str) -> None:
    w, h = size
    text = label.replace("\\", "").replace(":", " ").replace("'", "")
    subprocess.run(
        ["ffmpeg", "-nostdin", "-v", "error", "-y",
         "-f", "lavfi", "-i", f"color=c={pad}:s={w}x{h}:d=1",
         "-vf", f"drawtext=text='{text}':fontcolor=gray:fontsize={max(18, h // 30)}"
                f":x=(w-text_w)/2:y=(h-text_h)/2",
         "-frames:v", "1", "-q:v", "3", path],
        check=False,
    )
    if not os.path.exists(path):
        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y",
             "-f", "lavfi", "-i", f"color=c={pad}:s={w}x{h}:d=1",
             "-frames:v", "1", "-q:v", "3", path],
            check=True,
        )


def mux(concat_path: str, audio_path: str, meta_path: str, out_path: str,
        fps: int, crf: int, preset: str) -> None:
    base = [
        "ffmpeg", "-nostdin", "-y", "-v", "error", "-stats",
        "-f", "concat", "-safe", "0", "-i", concat_path,
        "-i", audio_path,
        "-i", meta_path,
        "-map_metadata", "2",
        "-map", "0:v:0", "-map", "1:a:0",
        "-c:v", "libx264", "-preset", preset, "-crf", str(crf),
        "-tune", "stillimage", "-pix_fmt", "yuv420p",
        "-r", str(fps), "-g", str(max(fps * 10, 2)),
        "-shortest", "-movflags", "+faststart",
    ]
    for audio_args in (["-c:a", "copy"], ["-c:a", "aac", "-b:a", "128k"]):
        result = subprocess.run(base + audio_args + [out_path])
        if result.returncode == 0:
            if audio_args[1] == "aac":
                log("  (audio stream copy refused, re-encoded to AAC)")
            return
    raise SystemExit("ffmpeg failed to mux. Run with --keep-work and inspect work/.")


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Rebuild an audio-only Panopto session as an MP4 slidecast.")
    parser.add_argument("delivery_info",
                        help="Inspect Extractor .txt capture, or a DeliveryInfo .json")
    parser.add_argument("-o", "--output", help="output MP4 (default: derived from session name)")
    parser.add_argument("--work", help="working directory (default: <output>.work)")
    parser.add_argument("--size", default="1920x1080", help="frame size (default 1920x1080)")
    parser.add_argument("--fps", type=int, default=5, help="output frame rate (default 5)")
    parser.add_argument("--crf", type=int, default=24, help="x264 quality, lower is better (default 24)")
    parser.add_argument("--preset", default="veryfast", help="x264 preset (default veryfast)")
    parser.add_argument("--pad-color", default="white", help="letterbox colour (default white)")
    parser.add_argument("--cookie", help="Cookie header, if the CDN rejects anonymous requests")
    parser.add_argument("--thumbs", action="store_true",
                        help="prefer low-res thumbnails (faster, much smaller)")
    parser.add_argument("--jobs", type=int, default=8, help="parallel downloads (default 8)")
    parser.add_argument("--plan-only", action="store_true",
                        help="print the plan and write the outline, then stop")
    parser.add_argument("--skip-download", action="store_true",
                        help="reuse whatever is already in the working directory")
    parser.add_argument("--keep-work", action="store_true", help="do not delete the working directory")
    args = parser.parse_args(argv)

    size = parse_size(args.size)

    with open(args.delivery_info, encoding="utf-8", errors="replace") as handle:
        info = find_delivery_info(handle.read())
    plan = build_plan(info)

    log(f"{plan.title}")
    if plan.course:
        log(f"  course   {plan.course}")
    log(f"  duration {hhmmss(plan.duration)}  ({plan.duration:.3f}s)")
    log(f"  slides   {len(plan.slides)}")
    log(f"  audio    {plan.audio_kind} stream")
    for warning in plan.warnings:
        log(f"  note     {warning}")

    stem = safe_stem(plan.title if plan.title else "session")
    out_path = args.output or f"{stem}.mp4"
    work = args.work or f"{os.path.splitext(out_path)[0]}.work"
    raw_dir = os.path.join(work, "raw")
    norm_dir = os.path.join(work, "norm")
    os.makedirs(work, exist_ok=True)

    outline_path = f"{os.path.splitext(out_path)[0]}.outline.md"
    with open(outline_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(outline_lines(plan)) + "\n")
    log(f"  wrote    {outline_path}")

    with open(os.path.join(work, "plan.json"), "w", encoding="utf-8") as handle:
        json.dump(asdict(plan), handle, indent=1)

    if args.plan_only:
        return 0

    require_ffmpeg()

    audio_path = os.path.join(work, "audio.mp4")
    if not args.skip_download:
        log("Downloading audio")
        if plan.audio_kind == "hls":
            subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-stats", "-y",
                 "-i", plan.audio_url, "-vn", "-c:a", "copy", audio_path],
                check=True,
            )
        else:
            size_bytes = fetch(plan.audio_url, audio_path, args.cookie)
            log(f"  {size_bytes / 1e6:.1f} MB")

        log("Downloading slides")
        missing = download_slides(plan, raw_dir, args.cookie, args.jobs, args.thumbs)
        if missing:
            log(f"  {len(missing)} slide image(s) unavailable; substituting placeholders")
            for slide in missing:
                placeholder(os.path.join(raw_dir, slide.filename), size,
                            f"slide {slide.n} unavailable", args.pad_color)
    else:
        found = sorted(f for f in os.listdir(norm_dir)) if os.path.isdir(norm_dir) else []
        log(f"Reusing working directory ({len(found)} normalized slides present)")

    if not os.path.exists(audio_path):
        raise SystemExit(f"No audio at {audio_path}. Drop --skip-download.")

    log("Normalizing slides")
    normalize_slides(plan, raw_dir if os.path.isdir(raw_dir) else norm_dir,
                     norm_dir, size, args.pad_color, args.jobs)

    concat_path = os.path.join(work, "concat.txt")
    with open(concat_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(concat_lines(plan.slides, os.path.abspath(norm_dir))) + "\n")

    meta_path = os.path.join(work, "chapters.txt")
    with open(meta_path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(ffmetadata_lines(plan)) + "\n")

    log(f"Encoding {out_path}")
    mux(concat_path, audio_path, meta_path, out_path, args.fps, args.crf, args.preset)

    final = os.path.getsize(out_path) / 1e6
    log(f"Done. {out_path} ({final:.1f} MB, {len(plan.slides)} chapters)")

    if not args.keep_work:
        shutil.rmtree(work, ignore_errors=True)
    else:
        log(f"  work kept at {work}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
