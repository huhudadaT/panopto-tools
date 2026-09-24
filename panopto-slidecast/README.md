# panopto-slidecast

Rebuilds an audio-only Panopto session as a watchable MP4.

Some recordings have no video encode at all. The delivery carries one AAC audio stream, and what looks like "the screen" in the viewer is a set of slide stills swapped in on a timer. There is no MP4 to download because none was ever made. This builds one from the slide timings Panopto already publishes.

## Requirements

`ffmpeg` on PATH, Python 3.9+. No third-party packages.

## Use

Capture the viewer page with the **Extract** panel open (reload with it open so the `DeliveryInfo` body is retained), save the `.txt`, then:

```sh
python3 panopto_slidecast.py capture.txt -o lecture.mp4
```

It reads the `DeliveryInfo` JSON out of the capture, downloads the podcast audio and every slide image, normalizes the images to one frame size, and muxes a chaptered MP4.

Check the plan before committing to an encode:

```sh
python3 panopto_slidecast.py capture.txt --plan-only
```

That prints duration, slide count, and audio source, and writes the outline without downloading anything.

## Outputs

| File | Contents |
| --- | --- |
| `lecture.mp4` | H.264 + AAC, one chapter marker per slide |
| `lecture.outline.md` | Slide titles, timestamps, and the slide text Panopto extracted |
| `lecture.work/` | Audio, slide images, `concat.txt`, `chapters.txt` (deleted unless `--keep-work`) |

The outline is worth keeping. These sessions usually have no caption track, and the slide text is the only searchable record of the content.

## Options

| Flag | Default | Notes |
| --- | --- | --- |
| `--size` | `1920x1080` | Both dimensions must be even for H.264 |
| `--fps` | `5` | Still images, so low is fine. Raise it if a player seeks badly |
| `--crf` | `24` | Lower is better quality and bigger |
| `--preset` | `veryfast` | x264 speed/size tradeoff |
| `--pad-color` | `white` | Letterbox colour; suits slides better than black |
| `--thumbs` | off | Use thumbnail images instead of full-size. Much faster, much blurrier |
| `--cookie` | — | Pass a `Cookie` header if the CDN refuses anonymous requests |
| `--jobs` | `8` | Parallel downloads |
| `--skip-download` | off | Reuse an existing working directory |
| `--keep-work` | off | Keep the working directory |

Re-encoding without re-downloading:

```sh
python3 panopto_slidecast.py capture.txt -o lecture.mp4 --keep-work
python3 panopto_slidecast.py capture.txt -o lecture.mp4 --skip-download --crf 20
```

## Behaviour worth knowing

**Slide durations are derived from start times, not the published `Duration` field.** They normally agree to the millisecond. They can drift apart on sessions that were trimmed in the editor, and start times are what keep audio in sync, so those win. A warning prints if they disagreed by more than 0.05s.

**Every chapter carries its index**, including untitled slides. Lecture decks are frequently mostly untitled — one real session had 97 of 137 with no caption — and unnumbered entries in a long chapter list read as if slides are missing.

**Images are normalized before muxing, not during.** The concat demuxer feeds a single decoder, so a mid-stream resolution change either errors or silently reconfigures the filter graph. Slide exports are usually uniform, but one pasted screenshot at a different size would otherwise surface 40 minutes into an encode.

**Missing slide images become labelled placeholders** rather than aborting the run. The thumbnail URL is tried as a fallback first.

**Very short slides exist.** Real sessions contain sub-second slide changes from clicking through animations. At 5 fps those get one or two frames, which is correct but looks like a flicker.

**If the delivery has a real video stream**, the script warns and you should download that directly instead. This tool is only worth running when there is genuinely no video encode.

## Tests

```sh
python3 test/test_slidecast.py [path/to/capture.txt]
```

21 checks. The pure functions are tested directly; where a real capture is supplied, derived image URLs are asserted to appear verbatim in that same capture, which is the only way to confirm the URL template. The end-to-end test builds a synthetic three-slide session with deliberately mismatched image sizes, runs the real encode path, and verifies duration, frame size, stream count, and chapter boundaries with `ffprobe`.
