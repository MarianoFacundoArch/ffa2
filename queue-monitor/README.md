# FIFA Queue Monitor

Browser-based dashboard that spins up multiple Chromium sessions, parks them in the FIFA waiting room, and surfaces their status (countdown, queue position, captcha prompts, current page). You can bring any session window to the foreground, trigger a reload, or refresh the screenshots from the control panel.

> **Heads up**
> - The tool launches non-headless Chromium windows so you can take manual control when captchas appear or when access becomes available.
> - The waiting room is protected by Akamai/DataDome. Steady operation assumes each session keeps its dedicated persistent profile (`./data/profiles/<session-id>`).
> - Captchas are not solved automatically. When the dashboard flags a session as `Captcha`, click **Bring to front** and solve it manually in the live browser window.

## Getting Started

```bash
cd queue-monitor
npm install
npm start
```

The control panel is available at [http://localhost:4000](http://localhost:4000). From there you can:

- Launch new queue watchers by pasting a waiting-room URL (defaults to the Visa shop queue) and optionally supplying a label, count, and storefront source URL.
- Monitor all active sessions in real time.
- Bring any Chromium window to the foreground, pause/resume its auto reload, reload it, or refresh its screenshot.

Sessions do not auto-start—you decide when to launch them from the UI. Each new watcher gets its own persistent Chromium profile under `data/profiles/<session-id>`, so cookies/tokens survive restarts.

### Fingerprint service (optional)

- Install [`playwright-with-fingerprints`](https://github.com/bablosoft/playwright-with-fingerprints) alongside the existing dependencies.
- Provide your API key via an environment variable before running the dashboard, e.g. `export FINGERPRINT_API_KEY=sk_live_your_key` (current key: `P40o1xL0dcN2sgTw4WktX985h77ieF5SP84cQTb0m4sjvg60ideAjSsDrCqyCpZC`).
- (Optional) Copy `fingerprint.config.example.json` to `fingerprint.config.json` and tweak `fingerprintOptions`, `launchOptions`, and `contextOptions` to match the profiles you want to emulate.
- When the key is present and the library is installed, each session launches with a fresh fingerprint; otherwise the watcher falls back to stock Playwright Chromium.

### Dashboard controls

- **Bring to front** – focuses the associated Chromium window so you can interact with it.
- **Pause/Resume auto reload** – per-session toggle that freezes the automatic retry loop for that browser only.
- **Reload** – forces a `page.reload()` for the selected session (automatic reloads still run when enabled).
- **Refresh snapshot** – captures an on-demand screenshot (dash snapshots update automatically every second).
- **Stop/Resume auto reload (all)** – panic button that flips the automatic refresh loop globally across every active session.

Cards highlight critical states:

- `Waiting open` – queue not ready (`genAT !== 'true'`); the session periodically auto-reloads until the controller exposes wait times or a captcha. If the maintenance banner (“We are currently performing scheduled maintenance…”) appears, the watcher forces a refresh on a short cooldown. Captcha prompts (“enter the characters you see in the image below…”) pause auto reload automatically so you can solve them.
- `Captcha` – manual captcha required.
- `Ready` – admission URL or ENTER button should be available.
- `Error/Warning` – session encountered an issue (check the browser window or console output).

### Capturing queue telemetry

The monitor listens to `/pkpcontroller/servlet.do` responses and extracts `admissionInfo` and redirect hints. That data feeds the dashboard (countdown, queue position, readiness flags). When the controller reports new tokens, you can bring the window to the foreground and proceed manually.

### Troubleshooting

- **Edge protection (403 / DataDome)** – import real browser cookies by launching a standard Chrome session with the same profile directory, or allow the session to warm up inside the waiting room. If a session gets blocked, use the store UI to complete the challenge once; the persistent profile caches the solution.
- **Captcha loops** – the card goes yellow (`Captcha`). Bring the window forward and solve the challenge.
- **Excessive CPU** – each session runs a full Chromium instance. Launch only as many as your hardware can handle.
- **Need to pause everything?** – hit **Stop auto reload (all)** to freeze every watcher, then resume when you are ready.

### Housekeeping

- Screenshots live under `queue-monitor/data/screenshots`.
- Persistent Chromium profiles live under `queue-monitor/data/profiles`.
- Delete those directories to reset a session.

## Roadmap ideas

- Optional headless mode that streams the viewport into the dashboard via WebRTC.
- Hooks to post status updates to Slack/Teams.
- Automated captcha alerts (sound/email).
