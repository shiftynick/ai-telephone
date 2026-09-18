# AI Telephone

A local web app for a live "telephone game" between AI models. A phone photo becomes a description, the
description becomes an image, that image is described again … and the last image becomes a short video.
The audience watches meaning drift (or not). See `PLAN.md` for the full specification.

Runs on your laptop. **It is not offline and photos do not stay on the laptop**: every step is sent to
OpenRouter (text, vision, image generation) or fal.ai (video). Use object/tabletop scenes or get consent.

## Requirements (tested)

| | Tested with |
|---|---|
| OS | Arch Linux (Omarchy), kernel 7.2 |
| Node.js | 26.8 (needs ≥ 24: uses built-in `node:sqlite` and native TypeScript execution) |
| npm | 11 |
| FFmpeg / ffprobe | 9.0 on `PATH` (validates generated video; HEIC fallback decoder) |
| Browser | Chromium (host + projector). Phone page: see checklist below |

## Setup

```bash
npm install
cp .env.example .env      # then put real keys in .env (gitignored)
npm run build             # builds the frontend into dist/web
npm start                 # http://localhost:8787 — prints a one-time host link
```

Open the **one-time host link printed in the terminal** (`/host?code=…`). It sets a 12-hour host cookie; a
restart prints a fresh link. Host powers are never available through the LAN listener, even with a cookie.

Other scripts: `npm run dev` (Vite + watch server, open the printed `localhost:5173` link),
`npm run start:mock` (no API calls; fake providers), `npm test` (Vitest, never touches the network),
`npm run e2e` (Playwright against the mock server), `npm run typecheck`,
`npm run smoke -- --yes-bill-me` (**billable** provider smoke test),
`npm run export-run -- <runId> [dir]` (portable replay bundle).

## Running the demo

1. **Source panel → LAN sharing**: pick the address the phone can reach (the app does not guess between
   Wi-Fi/VPN/hotspot interfaces) and start sharing. The server listens on loopback only until you do this.
   A QR code for `http://<ip>:8787/join/<token>` appears.
2. Phone scans the QR, takes/chooses a photo, uploads. **Uploading never starts a billable call.**
3. Host clicks **Accept as source**, picks a preset (or edits the pipeline), **Create run**, **Start**.
4. Open the **projector link** in a second window on the projector display. With auto-reveal on (default) each
   result appears as it completes; switch to **Final-result-first** to hide everything, reveal the final
   video, then rewind. **Compare** shows start vs final side by side. Video needs a click on Play
   (browsers block autoplay with sound).
5. Any completed run can be **replayed on the projector** with zero provider calls (works with networking
   disabled). A real saved rehearsal run ships in `fixtures/rehearsal` and is imported on first start.

If phone → laptop does not connect: venue Wi-Fi often isolates clients. Use a personal hotspot, or transfer
the photo manually and use desktop upload. If `ufw` is active: `sudo ufw allow 8787/tcp`
(undo with `sudo ufw delete allow 8787/tcp`). No public tunnel is ever created.

### Real-phone checklist (not verifiable by the build agent — do this before the meetup)

- [ ] Phone on the same network/hotspot opens the QR link.
- [ ] "Take photo" opens the camera; "Choose from library" opens the picker (iPhone Safari).
- [ ] A portrait photo arrives upright in the host console.
- [ ] A HEIC original (AirDrop/Files, not camera capture) uploads or shows the "export as JPEG" message.
      iOS Safari normally converts camera/library picks to JPEG before upload. On this machine sharp cannot
      decode HEIC; the server falls back to FFmpeg, which handles most but not necessarily all HEIC files.
- [ ] Projector window on the external display at its real resolution; video Play works with sound.

## The telephone invariant

Every step receives **only its immediate predecessor's primary artifact plus its own static instruction**, in a
brand-new provider request: no history, no original photo, no earlier text, no filenames/EXIF, no run title,
no reference images (`input_references` is never sent). One primary artifact per step; model commentary that
accompanies an image is discarded. Adjacency (image/text/video) is validated before any paid request and is
never auto-repaired. `tests/` proves this by inspecting the actual provider payloads.

## Tested model/provider combinations

Live smoke tests on **2026-09-18** with the author's keys (`npm run smoke`), 16:9, single image, 5 s 768P video.
Timings are single samples, end-to-end from this laptop — not a benchmark.

| Step | Model | Routed provider | Result | Elapsed | Reported cost |
|---|---|---|---|---|---|
| image → text | `google/gemini-2.5-flash` **(default)** | Google | OK | 2.1 s | $0.0009 |
| image → text | `google/gemini-3.8-flash` | Google | OK | 9.1 s | $0.0041 |
| image → text | `openai/gpt-4.1-mini` | OpenAI | OK | 5.5 s | < $0.0001 |
| image → text | `anthropic/claude-sonnet-4.6` | Claude Platform on AWS | OK | 4.8 s | $0.0064 |
| text → image | `google/gemini-3.1-flash-lite-image` **(default)** | not reported | OK | 3.3 s | $0.034 |
| text → image | `google/gemini-3.1-flash-image` | not reported | OK | 12.7 s | $0.067 |
| text → image | `openai/gpt-image-2.5-flare` | not reported | OK | 11.6 s | reported as $0 (treat as unknown) |
| text → image | `bytedance-seed/seedream-4.5` | not reported | OK (returns 3642×2048) | 10.5 s | $0.040 |
| text → text | gemini-3.8-flash / gpt-4.1-mini / claude-sonnet-4.6 | Google / OpenAI / AWS | OK | 8.3 / 3.2 / 3.8 s | ≤ $0.004 |
| image → video | fal `minimax/h3-max-turbo/image-to-video` | fal | OK, 1344×768, 5.2 s clip, expanded prompt recorded | 8.2 s | not reported by fal → shown as *unknown* |
| text → video | fal `minimax/h3-max-turbo/text-to-video` | fal | OK, 1344×768, 5.2 s clip | 6.9 s | not reported → *unknown* |

Full **Quick demo** chain through the running server (the committed rehearsal run): 5 steps, ≈ 18 s of provider
time, $0.069 known spend + one video of unknown cost.

Deviation from the plan: the plan suggested `google/gemini-3.8-flash` as the default describer; the measured
2.5-flash was 4× faster, and speed was the stated priority. The fal schema now lists 1080P; the app still only
offers 480P/768P as the plan directs.

## Security model (local, minimal)

- Loopback by default. LAN listener is explicit, bound to the chosen interface, and can only reach the phone
  upload, projector, and media routes. **LAN HTTP is unencrypted** — trusted network, non-sensitive photos.
- Host = one-time terminal code → HttpOnly SameSite=Strict cookie. Host header allowlist; every mutation
  requires a same-origin `Origin`. No CORS headers at all.
- Upload token: random, session-scoped (12 h), revocable (rotate), upload-only, bounded count (50) and size
  (20 MB). Projector token: read-only; state and `/media` expose only revealed stages.
- Keys live in `.env`, are used server-side only, and are scrubbed from error text before it is stored or shown.
- Uploaded images: decoded-bytes validation (not extension), EXIF orientation applied, all metadata stripped,
  long edge capped at 2048 px, client filename discarded. Generated media is stored byte-for-byte as returned
  (no silent recompression); any transformation is recorded.

## Execution semantics

One process, one active run, sequential worker independent of browser connections. Runs use an immutable
snapshot of the pipeline. **Pause** finishes the in-flight step; **Stop** aborts locally and asks fal to cancel,
but in-flight work may still be billed; a stopped run never restarts. Only clearly-unbilled transient errors
(429/500/502/503) auto-retry (max 2, honours Retry-After), each as a new attempt. Timeouts and dropped
connections are marked **unknown** and need an explicit "may be billed twice" confirmation to retry. fal jobs
persist their request ID immediately; after a crash/restart the run comes back *paused* and Resume reconciles
the existing job instead of resubmitting. Refusals and empty output fail the step rather than flowing
downstream. No memoization: identical prompts make new calls. Budget is a local soft limit checked before each
step ($2 default); unknown costs are shown as unknown, never as $0; it is not an account-level cap.

## Known issues / not done

- Milestone D (native video → text, sampled frames) is **out of scope** for this build; video is always a final step.
- Phone capture, HEIC from a real iPhone, and venue networking are untested by the build agent (checklist above).
- fal does not return cost; video spend is "unknown" in the summary. Check the fal dashboard.
- Upload/projector tokens are stored in the local SQLite file (alongside their hashes) so the QR code survives a restart.
- Built-in presets are read-only and refreshed on each start; use "Save as new" to customise.
- No run-export zip in the UI (CLI `export-run` only).
