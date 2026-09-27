# jev-browser (`jevb`)

On-demand headless Chromium for agents and tests, steered by
[Jev](https://docs.typesafe.ai) (TypeSafe System One).

- **On demand.** Nothing runs until the first action. The CLI starts a
  localhost daemon if needed. The daemon launches Chromium on first use and
  closes it after `JEVB_IDLE_MS` (default 2 min) with no actions, then exits
  itself after `JEVB_DAEMON_IDLE_MS` (15 min). After an idle shutdown, acting on
  the old session fails with `SESSION_EXPIRED`, so a check can't pass
  against a blank page.
- **Jev decides; code drives.** Every visible interactive element gets a
  `data-jevb` id and a one-line description. `act`/`type` ask Jev a single
  `choice` question (~150–300ms) to pick the element for a plain-English
  intent. If the answer is `none` or confidence is below 0.5, you get
  `NO_MATCH` plus the top candidates, not a guessed click. `check`/`refute`
  are Jev `noul` questions over the visible page text, usable as test
  assertions.
- **Human speed by default, agent speed on request.**
  - `human`: curved mouse travel, hover dwell, per-key typing with jitter,
    and a reading pause after navigation. This exercises the hover, focus,
    and debounce paths that real users hit, and makes recordings watchable.
  - `agent` (`--pace agent`, `JEVB_PACE=agent`, or `pace agent` in a
    scenario): as fast as possible. It uses direct clicks and `fill()`, and
    waits only on the page (load + network idle, capped at 3s).

## Setup

```bash
npm install          # playwright-core 1.57; reuses ~/Library/Caches/ms-playwright
npx playwright-core install chromium-headless-shell   # only if not already installed
export TYPESAFEAI_API_KEY=...   # or put it in ./.env
```

## CLI (one JSON object per command; exit 1 on error or failed check)

```bash
jevb open https://app.treechat.com/
jevb act go to create a new account
jevb type the email field -- someone@example.com
jevb check is a sign-up form shown?
jevb refute is an error page shown?
jevb snap                 # what Jev chooses from
jevb shot out.png --full
jevb stop
```

Use `--session NAME` for parallel contexts and `JEVB_HEADED=1` to watch.
`JEVB_DEMO=1` draws a visible cursor plus a HUD (step, and what Jev picked
with its confidence). `JEVB_VIDEO=<dir>` records a .webm per session.

## Scenarios (for tests)

```
pace agent
open /login
act go to create a new account
check is a sign-up form shown?
check@0.9 is the Join button highlighted?    # custom threshold
refute is an error or "not found" page shown?
shot out/signup.png
```

```bash
jevb run examples/treechat-signup-nav.jevb
jevb run my.jevb --base http://localhost:5174 --pace human
```

The runner stops at the first step that throws. It exits non-zero if any
check fails.

Library use: `import { JevBrowser, runScenario } from 'jev-browser'`.

## Cost / speed (measured 2026-09-26)

- Fixture flow (type, click, 2 checks): ~2.5s at agent pace, ~6s at human pace.
- Jev calls: 140–310ms each.
- Chromium cold start: 220–400ms.
