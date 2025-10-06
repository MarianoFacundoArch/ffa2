# Queue Waiting Room Internals

This document describes how the FIFA ticket waiting-room bundle works: lifecycle, network requests, cookies, UI updates, and supporting scripts. It reflects the behavior captured in `fifa ticket.html` and the assets under `fifa ticket_files/`.

## Entry Point Lifecycle
- **`init()`** runs from the `<body onload>` attribute.
- It prepares the UI (`prepareInterface()`), pulls the queue name from `?queue=`, wires language switches, loads brand resources, and starts the info-zone refresh loop.
- Any `?error=` parameter is latched into `wr_error`; if present the flow stops after `showError`.
- The source URL is sanitized via `getSourceUrl()`, stored in `WR_source-<queue>`, and reused between reloads.
- `restoreWR(false)` hydrates previously cached queue state from the `WR_queueinfo-<queue>` cookie/localStorage to avoid re-starting the wait after refreshes.
- The state machine (`process()`) begins with `queueinfo.state === 'START'`.

## Network Touch Points
All HTTP calls are `XMLHttpRequest` GETs against the `/pkpcontroller` backend under the same origin:
- **Queue selection handshake**: `GET /pkpcontroller/selectqueue.do?init=1&queueName={wr_queue}&source={encoded source}`. Response may return `{ "location": "…" }` to redirect straight into the application when tokens are already valid.
- **Primary polling**: `GET /pkpcontroller/servlet.do` with one of:
  - `?WRT={token}` while waiting (server-issued Waiting Room Token kept in `admissionInfo.token`).
  - `?FFRT={token}` when the server sets an auto-refresh token cookie (`WR-FFRT`).
  - No query string for the very first polling call when no token exists yet.
- **Captcha submission**: `GET /pkpcontroller/servlet.do?CAPTCHA={answer}`; `newCaptcha()` refreshes the image with `GET /pkpcontroller/servlet.do?newcaptcha=true` and `captcha.png?rand={random}`.
- **Admission token (AT) generation**: `GET /pkpcontroller/servlet.do?GEN_AT=true[&WRT={token}]` triggered by the ENTER button.
- **Info banner refresh**: `GET /pkpcontroller/message/{queue}/{lang}_{suffix}` every 60s (`INFO_REFRESH_MS`).
- **Final redirect**: Browser navigates to `admissionInfo.admissionURL`, appending `AT={admissionToken}` if the server did not embed it.

External resources:
- `fifa ticket_files/gtm.js` injects Google Tag Manager (`GTM-568KJZZX` + GA tags).
- `fifa ticket_files/tags.js` + inline snippet load DataDome bot-detection scripts.
- `fifa ticket_files/M5SStHFCAB` is the vendor’s obfuscated support library (polyfills, instrumentation, feature flags).

## Persistent State & Cookies
| Name | Scope | Purpose |
| --- | --- | --- |
| `WR_queueinfo-{queue}` | cookie/localStorage | JSON snapshot of `{state, response, enterts, accessts, refreshtime, lastResponseTime}` so refreshes resume the same wait.
| `WR_source-{queue}` | cookie/localStorage | Stores sanitized `source` query parameter used to return to the originating storefront.
| `WR-CT` | cookie only | Control token from server; when present `initConnection(true)` skips the selectqueue handshake and jumps to polling.
| `WR-FFRT` | cookie only | Auto-refresh token read on the next poll (`?FFRT=`). Set by server responses.
| `AcpAT-v3-{queue}` | cookie | Admission token previously granted; if present the handshake short-circuits into the target site.
| `ddv{…}` / others | cookie | Added by DataDome; not touched by project code but relevant for bot mitigation.

The cookie helpers fall back to localStorage when payloads exceed 4 KB. `deleteCookie` clears both storage mechanisms.

## Admission Info Payload
`admissionInfo` is the JSON payload returned from `/pkpcontroller/servlet.do`. Observed fields:
- `token`: waiting room token (WRT) identifying the session.
- `genWRT`: `'true'` when the server requires a new WRT before continuing.
- `needCaptcha`: `'true'` when a CAPTCHA challenge is mandatory.
- `genAT`: `'true'` when the server is willing to mint an admission token; `'false'` (and sometimes `'null'`) means sales are paused or not open yet, so the UI loops through the PAUSE/IDLE path until the controller flips the flag.
- `admissionToken`: access token (`'null'` until generated) and `admissionURL`: target route.
- `waitingTime`: seconds until eligible; `showWaitingTime` toggles countdown visibility.
- `canEnter`: `'true'` triggers READY state; `'false'` keeps waiting even when AT generation is permitted.
- `showQueuePosition` + `queuePosition`: opt-in UI for position messaging.
- `openingTime`: timestamp text for pre-open pauses.
- `showOnsalesWaitingRoomWidget`, `fairQueuePeriod`: flags for the onsale widget / fairness transition copy.
- `userPollingInterval`: overrides `MAX_POLL_FREQ` for throttled polling.
- `error`: non-`'null'` values push state `ERROR`.

## Determining Queue Availability
- **Queue not open yet**: responses where `genAT !== 'true'` (commonly `'false'`, but sometimes `'null'`) and `genWRT === 'false'` leave the state machine in `IDLE`/`PAUSE`. The UI calls `showPause()` and, when `openingTime` is provided, surfaces the scheduled start. Polling continues via `retryPeriod()` until the controller eventually returns `genAT === 'true'` plus real wait times.
- **Fair queue preamble**: when `admissionInfo.fairQueuePeriod` is set, `delayLoadingDiv()` shows `showFairQueue()` followed by `showFairQueueTransition()` or `showOnsalesTransition()`, keeping users informed while access is still closed.
- **Direct store URL**: hitting `https://fwc26-shop-usd.tickets.fifa.com/account/…` without a valid admission token simply serves the waiting-room markup again (captured via a real browser cURL). The appended controller payload includes a leading `{ "location": "…queue…" }` followed by `admissionInfo` values such as `genWRT: 'false'`, `genAT: 'null'`, `waitingTime: 'null'`, `admissionURL: 'false'`, so `process()` keeps polling but never exposes the ENTER button. Only when a later poll returns `admissionURL` + `admissionToken` does `redirectToACP()` navigate into the store.
- **Edge protection**: the store sits behind Akamai/DataDome. Command-line calls must replay browser cookies/headers (see `ak_bmsc`, `_abck`, `bm_sv`, etc.), otherwise the service responds with a bot 403. Use DevTools “Copy as cURL” or a headful browser automation stack (Puppeteer/Playwright) when you need the live storefront response.

## UI & Accessibility Logic
- Text content lives in the `language` map keyed by locale IDs (e.g. `message_wait`, `titre_pause`).
- `resources[]` is reserved for brand-specific HTML fragments; the current build does not populate it but the plumbing exists via `setBrandingResources()`.
- `show()/hide()` drive visibility. They are overridden later in the file to support flex layouts and the SVG ring visual.
- Progress UI:
  - `WAIT` state shows a circular SVG progress ring whose dash offset is derived from `waitingTime` vs total wait.
  - `WAITLONG` swaps in an 8-dot spinner.
  - `WAITMIN` hides the timer and displays a high-load message.
  - `showWaitingTime()` formats countdowns in `HH:MM:SS` when `showInClockFormat`.
- Fair-queue transitions: `delayLoadingDiv(fairQueuePeriod)` schedules the swap between `showFairQueue` and either `showOnsalesTransition()` or `showFairQueueTransition()`, ensuring copy changes once the onsale window opens.
- Language selector is rebuilt into a custom dropdown (`languagesButtonClick`, `window.onclick` handler) with keyboard access.
- `showCaptcha()` populates the CAPTCHA modal, resets the input, and focuses the field.
- `showAdmissionLink()` reveals the ENTER button for 5 minutes (UI text warns about expiry).

## Watchdogs & Timers
- `timerControllerRequest`: next poll scheduled via `triggerControllerRequest(delaySeconds, afterException)`.
- `timerWatchdog`: `triggerWatchdog()` complains (`showError('connection')`) if nothing heard back for `(MAX_POLL_FREQ + RETRY_PERIOD)` seconds while a token exists.
- `timerProgress`: governs the countdown refresh; cancelled by `stopProgress()` when leaving WAIT states.
- `timerInfoRefresh`: pulls the info snippet every minute.

`retryPeriod(baseDelayMs)` guards against polling faster than `baseDelayMs` from the last successful response.

## State Machine Overview
Main driver is `process()` with these transitions:

```
START -> initConnection(useCT=true)
INITIALIZED ->
  if genWRT == 'false' or genAT == 'false' -> IDLE
  else if needCaptcha -> AUTHREQ
  else if admissionToken == 'null' -> AUTHORIZED
  else -> ADMITTED
AUTHREQ ->
  if token != 'null' -> AUTHORIZED
  else if genWRT == 'false' -> IDLE
  else -> showCaptcha() and wait
AUTHORIZED ->
  selectInterface('info'); deleteCookie(WR-CT)
  if admissionToken == 'null' -> WAIT
  else -> ADMITTED
WAIT ->
  if genAT == 'false' -> PAUSE
  else if canEnter == 'true' -> READY
  else:
    if waitingTime <= MIN_WAIT_TIME -> WAITMIN
    if showWaitingTime == 'false' -> WAITLONG
    compute next refresh (min(waitingTime/2, MAX_POLL_FREQ) but ≥ MIN_POLL_FREQ)
    triggerControllerRequest()
    showProgress()
WAITMIN ->
  if waitingTime > MIN_WAIT_TIME_THRESHOLD -> WAIT
  else showMinWaitMessage()
WAITLONG ->
  if showWaitingTime == 'true' -> WAIT else spinner
READY ->
  stopWatchdog()
  if canEnter == 'false' -> WAITMIN
  else if admissionToken != 'null' -> ADMITTED
  else if genAT == 'false' -> PAUSE
  else -> showAdmissionLink()
PAUSE ->
  if genAT == 'true' -> READY
  else showPause() and poll after RETRY_PERIOD
IDLE ->
  selectInterface('info')
  if genWRT == 'true' -> START
  else showPause(); schedule initConnection(false) after retryPeriod(MAX_POLL_FREQ)
ADMITTED -> redirectToACP()
ERROR -> showError(admissionInfo.error); stopWatchdog()
END -> stopWatchdog(); showReload()
```

`restoreWR(true)` hydrates `admissionInfo` and ensures `queueinfo.enterts` / `queueinfo.accessts` are set so `progress()` can derive countdowns across refreshes.

## End-to-End Pseudocode

```pseudo
on window load:
  queueinfo ← { state: 'START', response: null, enterts: null, accessts: null, refreshtime: null, lastResponseTime: null }
  prepareInterface()
  if queue parameter missing:
    showReload() and abort
  wr_error ← queryParam('error') or 'null'
  if wr_error ≠ 'null': showError(wr_error) and abort
  sourceUrl ← getSourceUrl() // cookie or ?source=, sanitized against javascript: etc
  restoreWR(serverAnswer=false)
  process()

function initConnection(useCT):
  if useCT and cookie WR-CT exists:
    requestWaitingTime()
    return
  source ← getSourceUrl()
  if source null: connectionError(); return
  stopWatchdog(); stopProgress(); clearWaitCookies()
  url ← "/pkpcontroller/selectqueue.do?init=1&queueName=" + wr_queue + "&source=" + encodeURIComponent(source)
  xhrSelect(url, checkQueueSelect)

function checkQueueSelect(response):
  if HTTP 403: connectionError()
  if HTTP error: showPause(); retry initConnection(true)
  if JSON.location present:
    if WR-CT missing or location has welcome?AT or AcpAT, or cookie AcpAT-v3-{queue} present:
      clearWRCookies(); redirect to JSON.location; return
  schedule requestWaitingTime() after DELAY

function requestWaitingTime():
  url ← "/pkpcontroller/servlet.do"
  if cookie WR-FFRT present:
    url += "?FFRT=" + cookie; deleteCookie(WR-FFRT)
  else if admissionInfo.token ≠ 'null':
    url += "?WRT=" + admissionInfo.token
  xhrPoll(url)

function handleResponse(xhr):
  if status 200:
    persistResponse(xhr.responseText, now)
    if queueinfo.state == 'START': queueinfo.state ← 'INITIALIZED'
    if wr_error is 'reset' or 'timeout':
      if source missing: showReload() else initConnection(false) after DELAY; return
  else:
    log technical error
  if admissionInfo exists: process() else triggerControllerRequest(DEFAULT_TIME, false)

function persistResponse(response, timestamp):
  queueinfo.response ← response
  queueinfo.lastResponseTime ← timestamp
  persistQueueInfo()
  if wr_error ≠ 'cookie': restoreWR(serverAnswer=true)
  if response has admissionInfo.userPollingInterval: MAX_POLL_FREQ ← value

function restoreWR(serverAnswer):
  if cookie WR_queueinfo-{queue} exists:
    queueinfo ← parsed cookie
  if queueinfo.response:
    admissionInfo ← JSON.parse(queueinfo.response).admissionInfo
    backfill missing token/waitingTime from previous admissionInfo
  if admissionInfo.error ≠ 'null': wr_error ← admissionInfo.error
  if admissionInfo.waitingTime valid:
    if queueinfo.enterts null: queueinfo.enterts ← now
    wr_waitr ← (serverAnswer ? admissionInfo.waitingTime : max(0, queueinfo.accessts - now))
    if serverAnswer: queueinfo.accessts ← now + admissionInfo.waitingTime * 1000
    schedule progress timer

// process() executes the state machine described earlier and schedules network retries and UI updates accordingly.

User interactions:
  - submitCaptcha() → GET /servlet.do?CAPTCHA=...
  - newCaptcha() → GET /servlet.do?newcaptcha=true
  - requestAccess() (ENTER button) → GET /servlet.do?GEN_AT=true[&WRT=...]
  - goSource() reload → clear cookies and navigate to source URL
```

## Supporting Assets
- **SVG & imagery** under `fifa ticket_files/resources/` (referenced via relative paths) power the background, language icon, and refresh spinner.
- **`refresh.png`** shows the wait spinner inside the static markup.
- **Language dropdown** uses `Language.svg` and dynamically rewrites the anchor list into an accessible control.

## Operational Notes
- Run `python3 -m http.server 8000` at the repo root for local previews (`http://localhost:8000/fifa%20ticket.html`).
- When editing JS run `npx eslint fifa\ ticket_files/*.js`; format HTML/JS with `npx prettier --write "fifa ticket.html" "fifa ticket_files/**/*.js"`.
- Validate markup via `npx htmlhint fifa\ ticket.html` before delivery.
- Browser QA: confirm console clean, network calls succeed, and queue states (waiting, ready, captcha, error) behave as described above.

## Automation Toolkit
- **Dashboard**: `queue-monitor/` hosts a Node.js tool that launches multiple Chromium instances, parks them in the waiting room, and exposes their status via a web UI (`npm install && npm start`). Use the control form (pre-filled with the Visa shop queue URL) to spawn N independent sessions on demand.
- **Features**: live status badges (waiting, captcha, ready), per-second screenshots, capture of `/servlet.do` telemetry, per-session auto-reload toggles (plus a global panic button), and actions to bring a browser forward or reload it. Optional fingerprint spoofing integrates with [`playwright-with-fingerprints`](https://github.com/bablosoft/playwright-with-fingerprints); set `FINGERPRINT_API_KEY` (or `PLAYWRIGHT_FINGERPRINT_API_KEY`) and install the dependency to enable it.
- **Captchas**: sessions stay headful—when the dashboard flags `Captcha`, click **Bring to front** and solve manually. Profiles persist under `queue-monitor/data/profiles/<session-id>` to retain anti-bot challenges.
- **Scaling**: launch as many watchers as you need from the UI (use the **Count** field for bulk starts). Each session consumes a full Chromium process—adjust the total to match hardware limits. Maintenance banners trigger an automatic refresh on a short cooldown, keeping sessions cycling until the queue reopens, while captcha prompts pause auto reload automatically so you can solve them. Provide `fingerprint.config.json` (copied from the example) to control fingerprint profiles when the service is active.
