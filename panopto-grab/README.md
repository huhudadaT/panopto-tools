# Panopto Grab

One extension, two capture modules. Either works on its own; either can be switched off.

**Media capture** watches network requests on Panopto pages, reads any playlist it sees to work out whether the recording is a single file or a pile of segments, and offers a download.

**Session capture** injects a small script that reads the `DeliveryInfo` response body, which network monitoring cannot see. That body holds the session title, duration, slide timings, whether captions exist, and the direct podcast URL.

No DevTools needed. Open a session, click the toolbar icon.

## Install

`chrome://extensions` → Developer mode → **Load unpacked** → pick this folder.

Both modules are on by default. Turn either off in **Options**.

## Why the media part works on Panopto

Three things in a real session capture make this simpler than media sniffing usually is:

**The recording is one file.** The variant playlist is `#EXT-X-MAP` plus `#EXT-X-BYTERANGE` entries that all point at the same `fragmented.mp4`. In one 56-minute lecture that was 376 ranges covering 41,720,035 contiguous bytes. Playback issues hundreds of range requests, but a single GET with no `Range` header returns the whole recording. Nothing to stitch, no ffmpeg in the browser.

**URLs are unsigned.** No `Signature`, `Policy`, or `Key-Pair-Id` on the playlist or media requests, so re-requesting works. That is what defeats most sniffers.

**No DRM.** The viewer uses hls.js with plain AAC. No EME, no Widevine, nothing encrypted.

The extension checks all three rather than assuming them. If a playlist turns out to use separate segments, it says so and hands you an ffmpeg command instead of producing a broken file. If the byte ranges are not contiguous — possible on a session trimmed in the editor — it warns that a whole-file download may include material the playlist excludes.

## Using one module without the other

**Media only.** Switch off Session capture and no scripts are injected into any page; `chrome.scripting.unregisterContentScripts` removes them rather than leaving them idle. You still get downloads, but filenames fall back to the CDN's own (`fragmented.mp4`) because the session title lives in `DeliveryInfo`.

**Session only.** Switch off Media capture and the request listener stops recording. You still get the session summary, the **Save JSON** button, and a direct **Save audio** button when a podcast encode exists — which is usually the cleanest download anyway, since it is a normal MP4 rather than a fragmented one.

**Both.** The session title names the downloads, and the summary tells you which of the media rows is worth taking.

## Feeding panopto-slidecast

Some sessions have no video encode at all: one AAC stream, and the "screen" is slide stills the viewer swaps on a timer. The Session panel says **audio only — no video encode exists** when it detects this.

**Save JSON** writes `panopto-grab/<title>.delivery.json`, which `panopto_slidecast.py` takes directly:

```sh
python3 panopto_slidecast.py ~/Downloads/panopto-grab/*.delivery.json -o lecture.mp4
```

That rebuilds slides plus audio into a chaptered MP4. Downloading the audio here and the script rebuilding the video are the same workflow split across the two tools.

## Permissions

| Permission | Why |
| --- | --- |
| `webRequest` | Observe media requests. Non-blocking; nothing is modified |
| `downloads` | Hand URLs to the browser, which attaches your session cookies |
| `storage` | Settings, plus captured state in `chrome.storage.session` |
| `scripting` | Register and unregister the DeliveryInfo hook on demand |
| `activeTab` | Read the current tab's URL when the popup opens |
| `*://*.panopto.com/*`, `*://*.panopto.eu/*` | Panopto tenants |
| `*://*.cloudfront.net/*` | Where hosted tenants keep media |

Self-hosted tenants on their own domain are outside that list. Options has a field to grant a single hostname via `chrome.permissions.request`, so you are not asked for blanket access.

Credentials are never written anywhere. The captured `DeliveryInfo` body is session data, not headers, so no cookies pass through it.

## Design notes

**Captured state lives in `chrome.storage.session`.** MV3 service workers are killed after roughly 30 seconds idle. Anything held in a module variable is gone by the time you open the popup.

**One row per URL, with a hit count.** Byte-range playback requests the same file hundreds of times. Without collapsing them the list is unusable.

**Slide stills and asset-CDN files are filtered out.** A viewer page fires 300+ requests; in one capture 374 requests contained exactly one master playlist, one variant, and one media file. Everything else was fonts, sprites, and 137 slide images.

**The DeliveryInfo hook lives in the page's world.** `chrome.webRequest` cannot read response bodies, and the viewer sends DeliveryInfo over `XMLHttpRequest`, so the transport has to be wrapped where the page can see it. That world has no `chrome.*`, so findings cross to the extension via `postMessage`, and the relay accepts only messages the page posted to itself.

**Playlist probes are capped** at six per tab, since a master can reference variants which reference more.

## Known limits

Two video streams (screen plus camera) give two files that need a local mux; the extension flags them but will not combine them.

Response bodies already transferred cannot be salvaged — `webRequest` never exposes them. The extension observes, then re-requests. Same file, second download.

Sessions with real video may not use the single-file byte-range layout. The detector handles both and tells you which it found rather than guessing.

The Chrome Web Store prohibits this category of extension, so it stays loaded unpacked.

## Tests

```sh
node test/test_detect.mjs [path/to/capture.txt]
```

23 checks over URL classification, byte-range arithmetic, master and variant playlist parsing, contiguity detection, DeliveryInfo summarising, and filename safety.

Given a real capture, the parsers run against the actual playlist and `DeliveryInfo` bodies the browser received, and results are checked against figures measured independently from the same file: 376 ranges, 41,720,035 bytes, 3375.09s of playlist against 3375.065s of delivery, 137 slides, no captions. Derived URLs are asserted to appear verbatim in the capture, which is the only way to confirm a URL template is right rather than plausible.

One wrinkle that test surfaced: Panopto serialises JSON with escaped forward slashes, so a URL parsed out of `DeliveryInfo` will never `grep` against the raw response text.
