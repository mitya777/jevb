# jevb

Plain-English browser and phone tests for agents and CI. You write
`act go to create a new account` and `check is a sign-up form shown?`, and
[Jev](https://docs.typesafe.ai) (TypeSafe System One) picks the element and
judges the page in ~150–300ms. It drives headless Chromium on demand, and
real iPhones and Android phones through AWS Device Farm or a local Appium
server. It runs at human pace by default, or as fast as possible.

> Status: experimental. Plain Playwright with selectors is faster per step;
> jevb trades speed for selector-free steps and plain-English checks.

## What you need

| | Required for | Where it goes |
|---|---|---|
| TypeSafe API key | everything | `TYPESAFEAI_API_KEY` |
| AWS credentials with Device Farm access | real phones (optional, metered) | `AWS_ACCESS_KEY_ID` + `AWS_SECRET_ACCESS_KEY`, or an AWS profile |

```bash
git clone https://github.com/mitya777/jevb && cd jevb && npm install
npx playwright-core install chromium-headless-shell
cp .env.example .env     # fill in the key(s)
node bin/jevb.mjs run examples/treechat-signup-nav.jevb   # or `npm link` for `jevb`
```

The `examples/` run read-only against the public site treechat.com (the
project this was built to test). They never post, sign in or pay.

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

## CLI (one JSON object per command; exit 1 on error or failed check)

```bash
jevb open https://app.treechat.com/
jevb act go to create a new account
jevb type the email field -- someone@example.com
jevb check is a sign-up form shown?
jevb refute is an error page shown?
jevb checks --check 'is this a login page?' --refute 'is an error shown?'   # 1 Jev request
jevb act open the composer --check 'is the feed loaded?'   # checks run in parallel with the pick
jevb scroll end          # or top / 800 / -800; follows in-app scroll panels
jevb snap                 # what Jev chooses from
jevb shot out.png --full
jevb stop
```

Use `--session NAME` for parallel contexts and `JEVB_HEADED=1` to watch.

To test signed-in flows, attach to real Chrome instead of launching Chromium:
`bin/jevb-chrome.sh` starts Google Chrome with a dedicated profile
(`~/.jevb/chrome-profile`) and a local DevTools port, then prints
`JEVB_CDP_URL`. Sign in there once (`JEVB_CHROME_PROFILE_DIR` pins which
Chrome profile it starts in, if you add more than one); its cookies and Password Manager persist.
With `JEVB_CDP_URL` set, sessions are tabs in that profile (no per-session
isolation or `JEVB_VIDEO`), and idle/stop closes jevb's tabs but leaves
Chrome running.
`JEVB_DEMO=1` draws a visible cursor plus a HUD (step, and what Jev picked
with its confidence). `JEVB_VIDEO=<dir>` records a .webm per session.

## Real phones (AWS Device Farm)

The same commands drive a real iPhone or Android phone. Jev picks from the
device's accessibility tree (UiAutomator2 / XCUITest), `check` judges the text
on screen, and taps, swipes and typing are touch gestures at human or agent
pace. Mobile web runs in Safari/Chrome on the device, and snapshots use the
native tree there too, so system alerts, keyboards and permission sheets are
visible and tappable.

```bash
jevb devices --platform android                       # what you can open
jevb open https://app.treechat.com --device "pixel 8"  # Chrome on a real Pixel
jevb open --device "iphone 15" --app build/Treechat.ipa  # uploads, installs, launches
jevb act open the new thread composer                  # same session, now a phone
jevb press Back                                        # Android key; iOS edge swipe
jevb close                                             # stops the metered session
```

Devices come from a **metered** (pay-per-minute) remote access session. The phone is
billed from allocation until the session stops. jevb stops it on `close`,
`stop`, daemon exit, errors during startup, and after `JEVB_DEVICE_IDLE_MS`
(default 3 min) with no commands. Getting a device usually takes a minute or
more.

Setup: any AWS credentials with Device Farm access (in `.env`, or the
standard AWS chain). The narrowest option is a Device-Farm-only IAM key in an
AWS profile named `jevb`, which jevb picks up automatically:

```bash
aws iam create-user --user-name jevb
aws iam attach-user-policy --user-name jevb --policy-arn arn:aws:iam::aws:policy/AWSDeviceFarmFullAccess
aws iam create-access-key --user-name jevb --query 'AccessKey.[AccessKeyId,SecretAccessKey]' --output text | read id secret && aws configure set aws_access_key_id "$id" --profile jevb && aws configure set aws_secret_access_key "$secret" --profile jevb && aws configure set region us-west-2 --profile jevb
```

(`JEVB_AWS_PROFILE` picks a different profile. Without one, the standard chain applies:
`AWS_PROFILE`, env keys, or `aws login`.) The
project is `JEVB_DF_PROJECT_ARN`, or a project named `jevb` that is created on first use.
Device Farm is us-west-2 only. `--app` takes a local `.apk`/`.ipa` (uploaded),
an https/s3 URL, an upload ARN, or an installed bundle id / package name. An
iOS app must be a device build (`.ipa`), not a simulator build.

Controls the tree can't identify, whether unnamed or missing because they're
a clickable div with no role, are a last resort. When Jev finds no confident
match on an app screen, jevb asks Claude Sonnet 5 with the computer-use toolset
where on the screenshot to tap. If the point falls inside a tree element, jevb
taps that element's center; otherwise it taps the point (target `visual`). It
runs only when `ANTHROPIC_API_KEY` is set (env or `./.env`) and costs about 6k
tokens (~1-2 cents) and 1.5-4s per use. Measured: toolset clicks hit 4 of 5
test targets, including Treechat's unlabeled menu button. Plain "give me x,y"
prompting was off by 100px or more. Having Haiku label the unnamed controls
first was tried and dropped: it got 3-4 of 8 right, and one confident wrong
label led to a wrong tap. Set `JEVB_LOCATE_MODEL` to use another model.

App screens are also read from their screenshots. An app's accessibility
tree can lag the screen: after an in-app navigation, Treechat's Android tree
still held the previous page while its feed was plainly visible. With
`ANTHROPIC_API_KEY` set, checks on app screens judge the screen's text as Claude
Haiku reads it from the screenshot (1-6s, cached per image; the tree's form
fields are kept, so passwords stay masked). If the tree's text barely matches
the screen (under 30% word overlap), its elements are treated as stale and taps
go to the screenshot fallback. `JEVB_SCREEN_TEXT=off` keeps the tree's text.

In scenarios:

```
device pixel 8
app build/treechat.apk
open                     # launch the app; or `open https://...` for mobile web
act open the new thread composer
```

Or keep the scenario device-free and choose the phone per run:
`jevb run examples/demo-treechat-app.jevb --device "iphone 14" --app treechat.ipa`.

Things specific to phones:
- iOS system alerts, such as permission prompts, aren't in the app's tree on Device Farm.
  jevb reads them through the alert API. While one is up, it is the only thing on screen,
  and its buttons can be tapped (`act? dismiss the notifications prompt`).
  `act?` skips instead of failing when nothing matches.
- `press HideKeyboard` closes the keyboard (on iOS web views, it taps the ✓ Done
  toolbar button). `press Back` on Android closes the keyboard first when one is
  up, like the real button. iOS Back is an edge swipe, which many apps ignore.
- Unlabeled web inputs, such as a WebView sign-up form, take the text just above them
  as their label. Values are exact: Android sets the field value rather than sending
  keys through the IME, which would autocapitalize.
- A failed check lists the form `fields` Jev judged.
- Device Farm records every session. The MP4 is under the session's artifacts once it
  finishes stopping (`aws devicefarm list-artifacts --arn <session> --type FILE`).

`JEVB_APPIUM_URL=http://127.0.0.1:4723` (plus `JEVB_APPIUM_UDID`) uses a local
Appium server instead: a simulator, an emulator or a USB phone, at no cost.

## Testing jevb itself

```bash
npm test            # offline, ~25s: real headless Chromium + a fake Jev, no key, no cost
npm run test:live   # the same fixture pages judged by the real Jev (needs TYPESAFEAI_API_KEY)
```

`test/harness` starts two local servers. One serves the fixture pages in
`test/fixtures`, whose cases include modals, pointer-div rows, icon-only
buttons, covered and offscreen controls, and delayed renders and navigations.
The other is a fake Jev that answers deterministically and records every
request, so tests can assert what jevb sent: the pick request carries no page
text, checks see no offscreen text, and passwords are masked.

With the fake, a `"quoted label"` in an intent pins the pick. For example,
`act click the last "Reply" button` picks a button labelled Reply. For checks,
every quoted phrase in the question must be on screen. `jev.answer(fn)`
overrides any single answer.

`test:live` prints each case's confidence (noul) next to its threshold, so a
drift in `jev-latest` shows up before a case flips. Known weak spots run as
TODO and don't fail the suite.

`test/fixtures/layouts.html` covers the common ways a page repeats one control
per item: table rows, title and actions in sibling rows (Hacker News), an
action in a header followed by the body, card grids, nested comment threads and
lists. `test:live` also runs a Hacker News case, so the suite isn't measured
only on the app jevb was first built for.

### How repeated controls are picked

When several controls share a label ("Reply", "Edit", "hide"), each option
names the item it belongs to: `button "Edit" in "Grace Hopper grace@…"`.
The same rule runs on native app screens, over the accessibility tree.
Intents that say first/last ("edit the last row") send the copies to Jev as
**one** option, `button "Edit" ×3, one per item, from "Ada…" to "Grace…"`. Jev
judges which *kind* of control the intent means, and jevb picks the
topmost/bottommost copy on screen.

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

### Waiting

Like Playwright's auto-wait and `expect`, jevb re-judges the screen every 0.6s
until it's ready, for up to `JEVB_WAIT_MS` (default 4000; 0 disables).
- A failing `check`/`refute` passes once the screen gets there, such as a list
  behind a spinner. A real failure costs the wait.
- An `act`/`type` waits until its target is on screen and the checks riding
  along with it pass. Only then does it tap or fall back to the screenshot. Right
  after logging in, an app may show just a spinner.

### Secrets

`${NAME}` in a `type` step is filled from the environment, or from `./.env`,
when the step runs. Credentials therefore live in secrets (`.env`, CI secrets)
and never in scenario files. Output and videos show the step as written, and
password fields are masked in what Jev judges. A non-password field's value,
such as an email, is part of the state that checks send to Jev.

```
type the email field => ${TREECHAT_EMAIL}
type the password field => ${TREECHAT_PASSWORD}
```

An explicit `--pace` overrides `pace` lines in the scenario.

### Batching

Consecutive `check`/`refute` steps go to Jev as **one request**, since they
share the same page state. If the next step is `act`/`type`, the batch is sent
**at the same time** as that step's element-choice request, so it costs one
round trip, not two. Checks always see the page *before* the action.

The element choice never shares a request with the page text. Measured on
Treechat signup, the page text in the state dropped the pick's confidence
from 0.94 to about 0.5 for the same intent. `--no-batch` runs every step on its own
for comparison. Batched and standalone nouls matched within 0.01 on the demo.

Checks judge **what the user sees now**:
- `viewport_text`: the text on screen. When a popup is open (`modal_open`),
  it's only the popup's text.
- `fields`: form values, which `innerText` leaves out. Passwords show only as
  `(filled)`/`(empty)`.

There's no whole-page text. Offscreen or covered text made judgments worse
(footer-visible dropped from 0.75 to 0.58), and it let "is a thread shown?"
pass at 0.92 behind a sign-up popup. Jev reads text, not layout, so name
what's on screen: "is a feed shown?" scores ~0.6, "does the page show a Public
stream with Now, Hot and Top tabs?" ~0.8.

Element picks skip anything covered at its center (for example by a popup).
They also include plain `<div>`s with a pointer cursor, which is how React
apps usually build clickable rows and pills.

`act` waits for navigations that start shortly after the click (e.g. after
an analytics call). It then waits for the new page to commit, load, and for
its text to stop changing, so checks never judge a blank page.

Library use: `import { JevBrowser, JevDevice, runScenario } from 'jevb'`.

## Cost / speed (measured 2026-09-26, against treechat.com)

- `examples/tour-treechat.jevb`: landing → scroll end/top → Explore →
  Hot/Now → Reply (sign-up popup) → close → Channels → Home. 16 checks and
  7 actions, 0 failures; 17–18s at agent pace, ~48s at human pace.
- `examples/demo-treechat.jevb` (10 checks, 3 actions, agent pace):
  batched 2.2–3.1s with 7 Jev requests; `--no-batch` 4.0–4.2s with 13.

- Fixture flow (type, click, 2 checks): ~2.5s at agent pace, ~6s at human pace.
- Jev calls: 140–310ms each.
- Chromium cold start: 220–400ms.

## License

MIT. See [LICENSE](LICENSE).
