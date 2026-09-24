#!/usr/bin/env python3
"""Tests for panopto_slidecast.

    node -v          not needed
    python3 test/test_slidecast.py [path/to/capture.txt]

Two layers. The first exercises the pure functions, and where a real capture is
supplied it checks derived URLs against URLs the browser actually requested in
that same capture, which is the only way to be sure the URL template is right.
The second builds a small synthetic session and runs the real encode path, so
concat timing, chapters, and scaling are verified against ffprobe rather than
assumed.
"""

import json
import os
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
sys.path.insert(0, ROOT)

import panopto_slidecast as ps  # noqa: E402

DEFAULT_CAPTURE = "/mnt/user-data/uploads/pitt_hosted_panopto_com-2026-09-23T15-55-33.txt"

passed = 0
failed = 0


def check(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
    except Exception:  # noqa: BLE001
        failed += 1
        import traceback
        frame = traceback.format_exc().strip().splitlines()
        print(f"FAIL {name}")
        for line in frame[-3:]:
            print(f"  {line.strip()}")


def near(a, b, tol=1e-6):
    assert abs(a - b) <= tol, f"{a} != {b} (tol {tol})"


# ------------------------------------------------------------------ pure

def test_parse_size():
    assert ps.parse_size("1920x1080") == (1920, 1080)
    assert ps.parse_size(" 1280 X 720 ") == (1280, 720)
    for bad in ("1920", "abc", "1921x1080", "1920x1081", ""):
        try:
            ps.parse_size(bad)
            raise AssertionError(f"{bad!r} should have been rejected")
        except ValueError:
            pass


def test_media_origin():
    assert ps.media_origin("https://cdn.test:443/a/b.mp4?x=1") == "https://cdn.test"
    assert ps.media_origin("http://cdn.test:80/a") == "http://cdn.test"
    assert ps.media_origin("https://cdn.test:8443/a") == "https://cdn.test:8443"
    assert ps.media_origin("", None or "", "https://second.test/x") == "https://second.test"
    try:
        ps.media_origin("", "not a url")
        raise AssertionError("should reject")
    except ValueError:
        pass


def test_clean_text():
    assert ps.clean_text("  a\n\n b \t c ") == "a b c"
    assert ps.clean_text(None) == ""
    assert ps.clean_text("") == ""


def test_escaping():
    assert ps.escape_concat("/a/b's file.jpg") == "/a/b'\\''s file.jpg"
    assert ps.escape_concat("/a\\b.jpg") == "/a\\\\b.jpg"
    assert ps.escape_meta("a=b;c#d") == "a\\=b\\;c\\#d"
    assert "\\\n" in ps.escape_meta("a\nb")


def test_hhmmss():
    assert ps.hhmmss(0) == "0:00"
    assert ps.hhmmss(59.9) == "0:59"
    assert ps.hhmmss(61) == "1:01"
    assert ps.hhmmss(3375.065) == "56:15"  # hours omitted under 1h


def test_safe_stem():
    assert ps.safe_stem("Thursday, August 27, 2026 at 5:07:11 PM").startswith("Thursday-August-27")
    assert "/" not in ps.safe_stem("a/b")
    assert ps.safe_stem("***") == "session"
    assert len(ps.safe_stem("x" * 200)) <= 80


def test_repair_timing_tiles_exactly():
    slides = [
        ps.Slide(n=1, seq="1", start=0.0, duration=10.0),
        ps.Slide(n=2, seq="2", start=10.0, duration=999.0),   # published value wrong
        ps.Slide(n=3, seq="3", start=25.0, duration=5.0),
    ]
    warnings = []
    out = ps.repair_timing(slides, 40.0, warnings)
    near(out[0].duration, 10.0)
    near(out[1].duration, 15.0)
    near(out[2].duration, 15.0)
    near(sum(s.duration for s in out), 40.0)
    assert any("disagreed" in w for w in warnings)


def test_repair_timing_pads_leading_gap():
    slides = [ps.Slide(n=1, seq="1", start=4.0, duration=6.0)]
    warnings = []
    out = ps.repair_timing(slides, 10.0, warnings)
    near(out[0].start, 0.0)
    near(out[0].duration, 10.0)
    assert any("First slide" in w for w in warnings)


def test_repair_timing_reorders():
    slides = [
        ps.Slide(n=1, seq="b", start=5.0, duration=1.0),
        ps.Slide(n=2, seq="a", start=0.0, duration=1.0),
    ]
    out = ps.repair_timing(slides, 10.0, [])
    assert [s.seq for s in out] == ["a", "b"]
    assert [s.n for s in out] == [1, 2]


def test_concat_lines_repeat_last():
    slides = [
        ps.Slide(n=1, seq="1", start=0, duration=2.5),
        ps.Slide(n=2, seq="2", start=2.5, duration=1.0),
    ]
    lines = ps.concat_lines(slides, "/w")
    assert lines[0] == "ffconcat version 1.0"
    assert lines[1] == "file '/w/0001.jpg'"
    assert lines[2] == "duration 2.500000"
    # last slide repeated with no duration, else the demuxer drops it
    assert lines[-1] == "file '/w/0002.jpg'"
    assert not lines[-1].startswith("duration")
    assert len(lines) == 1 + 2 * len(slides) + 1


def test_ffmetadata_chapters():
    plan = ps.Plan(title="T", course="C", owner="O", duration=12.0,
                   audio_url="u", audio_kind="podcast", audio_only=True,
                   slides=[ps.Slide(n=1, seq="1", start=0, duration=7.0, caption="First"),
                           ps.Slide(n=2, seq="2", start=7.0, duration=5.0, caption="")])
    lines = ps.ffmetadata_lines(plan)
    assert lines[0] == ";FFMETADATA1"
    assert "title=T" in lines and "album=C" in lines and "artist=O" in lines
    assert lines.count("[CHAPTER]") == 2
    assert "START=0" in lines and "END=7000" in lines and "END=12000" in lines
    assert any(l == "title=001 First" for l in lines)
    assert any(l == "title=002 Slide 2" for l in lines)


def test_chapter_title_truncates():
    long = ps.Slide(n=9, seq="9", start=0, duration=1, caption="w " * 100)
    title = ps.chapter_title(long, limit=20)
    assert title.startswith("009 ")
    assert len(title) <= 4 + 20
    assert title.endswith("\u2026")
    # falls back to body text, then to a number
    assert ps.chapter_title(ps.Slide(n=3, seq="3", start=0, duration=1, text="body")) == "003 body"
    assert ps.chapter_title(ps.Slide(n=4, seq="4", start=0, duration=1)) == "004 Slide 4"


def test_find_delivery_info_raw_json():
    assert ps.find_delivery_info('  {"Timestamps": [], "a": 1}')["a"] == 1


def test_find_delivery_info_in_dump():
    body = json.dumps({"Delivery": {"Duration": 1, "Timestamps": []}})
    dump = (
        "Inspect Extractor\n\n"
        + "=" * 78 + "\n[001] GET 200  https://x/other\n"
        + "-" * 78 + "\nnot json\n\n"
        + "=" * 78 + "\n[002] POST 200  https://x/Panopto/Pages/Viewer/DeliveryInfo.aspx\n"
        + "      application/json\n"
        + "-" * 78 + "\n" + body + "\n"
    )
    assert ps.find_delivery_info(dump)["Delivery"]["Duration"] == 1


def test_find_delivery_info_missing():
    try:
        ps.find_delivery_info("nothing useful here")
        raise AssertionError("should raise")
    except ValueError as err:
        assert "DeliveryInfo" in str(err)


def test_build_plan_rejects_empty():
    for info, needle in [
        ({"Delivery": {"Duration": 0}}, "duration"),
        ({"Delivery": {"Duration": 10, "PodcastStreams": [], "Streams": []}}, "media URL"),
    ]:
        try:
            ps.build_plan(info)
            raise AssertionError(f"should raise for {needle}")
        except ValueError as err:
            assert needle in str(err), f"{needle} not in {err}"


def test_build_plan_falls_back_to_hls():
    info = {"Delivery": {
        "Duration": 10.0,
        "PodcastStreams": [],
        "Streams": [{"Tag": "AUDIO", "StreamHttpUrl": "https://cdn.test:443/s/x.hls/master.m3u8"}],
        "Timestamps": [{"ObjectSequenceNumber": "7", "ObjectPublicIdentifier": "obj",
                        "SessionID": "sess", "Time": 0, "Duration": 10.0}],
    }}
    plan = ps.build_plan(info)
    assert plan.audio_kind == "hls"
    assert any("podcast encode" in w for w in plan.warnings)
    assert plan.slides[0].image_url == "https://cdn.test/sessions/sess/obj_et/images/slide7.jpg"


def test_build_plan_warns_on_video_stream():
    info = {"Delivery": {
        "Duration": 5.0,
        "PodcastStreams": [{"StreamUrl": "https://cdn.test/a.mp4"}],
        "Streams": [{"Tag": "SCREEN", "StreamHttpUrl": "https://cdn.test/m.m3u8"}],
        "Timestamps": [{"ObjectSequenceNumber": "1", "ObjectPublicIdentifier": "o",
                        "SessionID": "s", "Time": 0, "Duration": 5.0}],
    }}
    plan = ps.build_plan(info)
    assert any("SCREEN" in w for w in plan.warnings)


def test_outline_has_every_slide():
    plan = ps.Plan(title="T", course="", owner="", duration=3.0, audio_url="u",
                   audio_kind="podcast", audio_only=True,
                   slides=[ps.Slide(n=1, seq="1", start=0, duration=2, caption="A", text="body A"),
                           ps.Slide(n=2, seq="2", start=2, duration=1, caption="B")])
    text = "\n".join(ps.outline_lines(plan))
    assert "# T" in text and "2 slides." in text
    assert "001  0:00  A" in text and "002  0:02  B" in text
    assert "body A" in text


# --------------------------------------------------- against the real capture

def test_real_capture(path):
    with open(path, encoding="utf-8", errors="replace") as handle:
        text = handle.read()
    info = ps.find_delivery_info(text)
    plan = ps.build_plan(info)

    assert len(plan.slides) == 137, len(plan.slides)
    near(plan.duration, 3375.065)
    assert plan.audio_kind == "podcast"
    assert plan.audio_only is True
    assert plan.course == "2271_BIOENG_1310_SEC1025"

    # durations must tile the whole session, or audio drifts out of sync
    near(sum(s.duration for s in plan.slides), plan.duration, 1e-3)
    near(plan.slides[0].start, 0.0)
    near(plan.slides[-1].end, plan.duration, 1e-3)
    for a, b in zip(plan.slides, plan.slides[1:]):
        near(a.end, b.start, 1e-6)
        assert a.duration > 0

    # the derived image URL must match one the browser actually fetched
    assert plan.slides[0].image_url in text, plan.slides[0].image_url
    assert plan.slides[0].thumb_url in text, plan.slides[0].thumb_url
    assert ":443" not in plan.slides[0].image_url
    assert plan.audio_url.startswith("https://")
    assert plan.audio_url.endswith(".mp4") or "?" in plan.audio_url

    assert plan.slides[0].caption == "Resistor configurations"
    assert plan.slides[0].seq == "65537"

    meta = ps.ffmetadata_lines(plan)
    assert meta.count("[CHAPTER]") == 137
    starts = [int(l.split("=")[1]) for l in meta if l.startswith("START=")]
    assert starts == sorted(starts)
    assert int([l for l in meta if l.startswith("END=")][-1].split("=")[1]) == 3375065

    concat = ps.concat_lines(plan.slides, "/w")
    assert len(concat) == 1 + 2 * 137 + 1

    outline = "\n".join(ps.outline_lines(plan))
    assert outline.count("\n## ") == 137
    assert "56:15" in outline


# --------------------------------------------------------------- end to end

def test_end_to_end():
    """Build a real MP4 from synthetic slides and verify it with ffprobe."""
    if shutil.which("ffmpeg") is None or shutil.which("ffprobe") is None:
        print("SKIP end-to-end (ffmpeg/ffprobe not on PATH)")
        return

    tmp = tempfile.mkdtemp(prefix="slidecast-test-")
    try:
        duration = 12.0
        slides = [("1", 0.0, 5.0, "Intro"), ("2", 5.0, 4.0, "Middle"), ("3", 9.0, 3.0, "End")]
        info = {"Delivery": {
            "Duration": duration,
            "SessionName": "Synthetic Session",
            "SessionGroupLongName": "TEST_101",
            "OwnerDisplayName": "Tester",
            "IsPrimaryAudioOnly": True,
            "PodcastStreams": [{"StreamUrl": "https://cdn.test:443/sessions/s/a.mp4"}],
            "Streams": [{"Tag": "AUDIO", "StreamHttpUrl": "https://cdn.test:443/x.m3u8"}],
            "Timestamps": [
                {"ObjectSequenceNumber": seq, "ObjectPublicIdentifier": "obj",
                 "SessionID": "sess", "Time": start, "Duration": dur, "Caption": cap}
                for seq, start, dur, cap in slides
            ],
        }}
        info_path = os.path.join(tmp, "info.json")
        with open(info_path, "w", encoding="utf-8") as handle:
            json.dump(info, handle)

        out = os.path.join(tmp, "out.mp4")
        work = os.path.join(tmp, "work")
        raw = os.path.join(work, "raw")
        os.makedirs(raw)

        # deliberately mismatched input sizes, which is what breaks naive concat
        for i, (w, h) in enumerate([(800, 600), (1024, 768), (640, 640)], start=1):
            subprocess.run(
                ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi",
                 "-i", f"color=c=gray:s={w}x{h}:d=1", "-frames:v", "1",
                 os.path.join(raw, f"{i:04d}.jpg")], check=True)

        subprocess.run(
            ["ffmpeg", "-nostdin", "-v", "error", "-y", "-f", "lavfi",
             "-i", f"anullsrc=r=44100:cl=mono", "-t", str(duration),
             "-c:a", "aac", "-b:a", "64k", os.path.join(work, "audio.mp4")], check=True)

        rc = ps.main([info_path, "-o", out, "--work", work, "--skip-download",
                      "--keep-work", "--size", "1280x720", "--fps", "5",
                      "--preset", "ultrafast"])
        assert rc == 0
        assert os.path.exists(out), "no output file"

        probe = json.loads(subprocess.run(
            ["ffprobe", "-v", "error", "-print_format", "json",
             "-show_format", "-show_streams", "-show_chapters", out],
            capture_output=True, text=True, check=True).stdout)

        near(float(probe["format"]["duration"]), duration, 0.35)

        video = [s for s in probe["streams"] if s["codec_type"] == "video"]
        audio = [s for s in probe["streams"] if s["codec_type"] == "audio"]
        assert len(video) == 1 and len(audio) == 1, "expected one video and one audio stream"
        assert (video[0]["width"], video[0]["height"]) == (1280, 720), \
            (video[0]["width"], video[0]["height"])
        assert video[0]["codec_name"] == "h264"

        chapters = probe["chapters"]
        assert len(chapters) == 3, len(chapters)
        assert chapters[0]["tags"]["title"] == "001 Intro"
        near(float(chapters[1]["start_time"]), 5.0, 0.01)
        near(float(chapters[2]["end_time"]), 12.0, 0.01)

        assert probe["format"]["tags"]["title"] == "Synthetic Session"
        assert probe["format"]["tags"]["album"] == "TEST_101"

        outline = os.path.join(tmp, "out.outline.md")
        assert os.path.exists(outline)
        assert "Synthetic Session" in open(outline, encoding="utf-8").read()

        # the working directory survives --keep-work, for a retry without re-download
        assert os.path.exists(os.path.join(work, "concat.txt"))
        assert os.path.exists(os.path.join(work, "chapters.txt"))
        assert len(os.listdir(os.path.join(work, "norm"))) == 3
    finally:
        shutil.rmtree(tmp, ignore_errors=True)


def main():
    for name, fn in sorted(globals().items()):
        if name.startswith("test_") and name not in ("test_real_capture", "test_end_to_end"):
            check(name, fn)

    capture = sys.argv[1] if len(sys.argv) > 1 else DEFAULT_CAPTURE
    if os.path.exists(capture):
        check("test_real_capture", lambda: test_real_capture(capture))
    else:
        print(f"SKIP test_real_capture (no capture at {capture})")

    check("test_end_to_end", test_end_to_end)

    print(f"{passed} passed, {failed} failed")
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
