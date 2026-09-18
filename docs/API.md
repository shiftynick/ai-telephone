# HTTP API contract (server → web)

All types referenced live in `shared/types.ts`. Errors are `{ error: string, issues?: ... }` with a 4xx/5xx status.
Every non-GET request must carry a same-origin `Origin` header (browsers do this automatically) — no extra CSRF token.
Host routes need the `tele_host` HttpOnly cookie (obtained via `/api/auth/exchange`). Use `fetch(..., { credentials: 'same-origin' })`.

## Auth / status
- `POST /api/auth/exchange {code}` → `{ok:true}` + cookie. Code is one-time (from terminal link `/host?code=…`). 401 when used/invalid.
- `GET /api/status` → `{host:false}` or `{host:true, mock, port, defaultBudgetUsd:number|null, keys:{openrouter:boolean, fal:boolean}}`

## Host: models & presets
- `GET /api/models`, `POST /api/models/refresh` → `ModelsView`
- `GET /api/presets` → `{presets: Preset[]}`; `POST /api/presets PresetBody` → `Preset`
- `PUT /api/presets/:id {confirmReplace:true, preset:PresetBody}` → `Preset` (428 without confirmReplace); `DELETE /api/presets/:id`
- `POST /api/presets/validate PresetBody` → `{issues: StepIssue[]}` (adjacency + model/param compatibility). The client can also call `validateChain` from shared for instant adjacency feedback.

## Host: session / source / reveal
- `GET /api/session` → SessionView:
  `{id, uploadToken, projectorToken, expiresAt, source: ArtifactView|null, uploads: {id, origin:'phone'|'phone-text'|'desktop'|'text', status:'pending'|'accepted'|'rejected', createdAt, transformations:string[], artifact:ArtifactView}[], selectedRunId:string|null, replay:boolean, autoReveal:boolean, revealed:number[], currentStage:number, compare:boolean}`
- `POST /api/session/rotate {which:'upload'|'projector'|'both'}` → SessionView (revokes old tokens)
- `POST /api/session/uploads` multipart field `file` (desktop upload) → `{uploadId, width, height, transformations, session}`; still needs Accept.
- `POST /api/session/source-text {text}` → SessionView (text source, auto-accepted)
- `POST /api/session/uploads/:id/accept|reject` → SessionView. Accept = becomes the next run's source. Never starts a run.
- `POST /api/session/select-run {runId|null, replay:boolean}` → SessionView. Chooses what the projector shows. `replay:true` = Replay label, no provider calls.
- `POST /api/session/reveal` body one of `{action:'show',stage}`, `{action:'next'}`, `{action:'prev'}`, `{action:'final'}`, `{action:'reset'}`, `{action:'compare',on}`, `{action:'auto',on}` → SessionView.
  Stage 0 = source, stage N = output of step N. Auto-reveal (default on) reveals each output as it completes; turn it off for "final-result-first" (then `final`, then `prev` to rewind).

## Host: LAN
- `GET /api/lan` → `{candidates:{name,address}[], active:{address,port}|null, firewallHint:string|null, warning:string}`
- `POST /api/lan {address: string|null}` → `{active}`. Starts/stops the LAN listener. Phone URL: `http://<address>:<port>/join/<uploadToken>`; projector URL: `/present/<projectorToken>` (works on localhost too).

## Host: runs
- `GET /api/runs` → `{runs:{id,name,status,createdAt,imported,stepCount}[]}`
- `POST /api/runs {preset:PresetBody, sourceArtifactId?, budgetUsd?:number|null, select?:boolean}` → `RunView` (400 + `issues` when the chain is invalid — before any paid call). Omitting sourceArtifactId uses the session's accepted source. Passing the artifact id of any earlier output = "New run from this artifact".
- `GET /api/runs/:id` → `RunView`
- `POST /api/runs/:id/actions {action:'start'|'next'|'pause'|'resume'|'stop'|'retry', acknowledgeBilling?:boolean}` → `RunView`. `retry` returns 428 when the previous attempt's outcome is unknown and `acknowledgeBilling` is not true (show a "may be billed twice" confirm). 409 on conflicting state (e.g. double start).
- `GET /api/events` (SSE, host) — `event: change`, data `{type, runId, ...}`. Treat as an invalidation ping: refetch session/run. `GET /api/runs/:id/events` is the same per run and honours Last-Event-ID.

## Phone (upload token only)
- `GET /api/join/:token` → `{ok, sessionId, maxBytes}` or 404
- `POST /api/sessions/:sessionId/uploads` multipart `file`, header `x-upload-token` → `{ok,width,height}`; 413 too large, 415 not an image / HEIC undecodable (message is user-presentable), 429 upload limit.
- `POST /api/sessions/:sessionId/text {text}` (1–2000 chars, trimmed), header `x-upload-token` → `{ok:true}`. Creates a *pending* text upload with `origin:'phone-text'`; like a photo it becomes the source only when the host accepts it. 400 empty/oversized, 429 upload limit.

## Projector (projector token only, read-only)
- `GET /api/present/:token/state` → `PresentState` (unrevealed stages have no artifact/instruction)
- `GET /api/present/:token/events` SSE, content-free `change` pings → refetch state.

## Media
- `GET /media/:artifactId` (host cookie) or `/media/:artifactId?t=<projectorToken>` (only revealed stages). Supports Range. Text artifacts are inline in views (`artifact.text`), not served here.
