---
name: qa-movie
description: Record a QA movie of the user's running web app in one browser tab they are signed in to and hand over, with a pass/fail step log and a proof binding their exact prompt to the movie (hash anchored on Bitcoin SV, dry run by default). Use when the user asks to QA, test, demo or record a flow in their app "in my tab" or "signed in", or to verify a jevb QA proof.
---

# QA movie from a handed-over tab

You drive the `jevb` CLI. jevb picks elements from plain-English intents, runs
`.jevb` scenarios, and does the confinement itself: in a hand-over it can act
only in the tab the user picked, and it refuses sign-out, credentials, account
settings and password fields on its own. Your job is to get the user's
choices right and write a good scenario.

Every jevb command prints JSON. Exit code 1 means an error or a failed check.

## 0. Check the setup (once)

```bash
jevb setup                 # browser + Jev key; fix whatever it reports
ffmpeg -version            # needed to encode the movie
jevb tabs                  # needs JEVB_CDP_URL: the Chrome holding the user's tab
```

If `jevb tabs` says JEVB_CDP_URL is unset, the user's app tab must be in a
Chrome started with remote debugging. Tell them to run `bin/jevb-chrome.sh`
from the jevb repo (it prints the URL), sign in to their app in that window,
and set `JEVB_CDP_URL`. Do not start or drive any other browser yourself.
If your sandbox blocks localhost network access, ask the user to allow it for
`jevb`.

## 1. Keep the prompt exactly

The proof hashes the user's prompt byte for byte. Write the user's request
(their own message about what to test, not your paraphrase) to a file with no
edits, and tell them which file it is:

```bash
cat > qa-prompt.txt <<'PROMPT'
<the user's words, exactly>
PROMPT
```

## 2. Hand-over: the user picks one tab

Run `jevb tabs` (add `--match <word>` to narrow it) and show the user the
list as numbered lines of title and URL. Ask them which tab to hand over.
**Never pick a tab yourself**, even if only one looks right: wait for their
choice, then use that tab's `id`. If their tab isn't listed, ask them to open
the app's URL in the jevb Chrome window and run `jevb tabs` again.

## 3. Tell them about the recording, and wait for a yes

Say this before recording, in your own words but with all of it:

> The movie records everything shown in that tab while the steps run,
> including any personal or account data on those pages. It stays on this
> computer. Only hashes leave it, and only if you anchor them. jevb acts only
> in that tab, never signs out, types passwords or changes account settings,
> and gives the tab back open when it's done. OK to record?

Pass `--recording-ok` only after they say yes.

## 4. Write the scenario

One step per line, in a `.jevb` file. The tab is already on the app, so start
with the first action (an `open /path` on the same site is fine).

```
act open the notes page
type the "New note" box => milk
act click "Add note"
check is a note "milk" shown in the list?
refute is an error message shown?
```

| Step | Does |
|---|---|
| `act <intent>` / `act? <intent>` | click what the intent names (`act?`: skip if absent) |
| `type <field> => <text>` | type into a field |
| `press <key>` | Enter, Escape, Tab, arrows (no Ctrl/Cmd/Alt shortcuts) |
| `scroll [px\|end\|top]` · `wait <ms>` | |
| `check <question>` / `refute <question>` | pass/fail in the step log; name visible text in quotes |
| `read <question>` | the on-screen text that answers, verbatim |
| `open /path` | same site only |

Rules jevb enforces (a scenario that breaks them is refused before it runs):
no signing out, no passwords, codes, keys or other credentials, no account,
security, billing or settings pages, no `${SECRET}` values, no `send`,
`capture` or `eval`, no other sites. If the user's request needs one of
those, say so and leave that part out.

## 5. Run it

```bash
jevb qa run flow.jevb --tab <id> --prompt qa-prompt.txt --out qa-run \
  --recording-ok --client codex --model <your model name>
```

`--client` and `--model` are recorded as you report them, marked unverified.
Default pace is `human` so the cursor and captions are watchable.

The output folder holds `qa.mp4`, `steps.json` (each step with `ok` and
`movieAt`, the second it appears in the movie), `manifest.json`,
`anchor.json` (a **dry-run** transaction), the prompt and the scenario.

## 6. Report and hand back

- The movie path, and pass/fail per check from `steps.json`.
- Say plainly: **the tab is yours again**, still open where it was.
- The manifest hash, and that the anchor is a dry run until they choose to
  broadcast.
- On a failed step, show its `error` and the `movieAt` time to look at.

## Verifying a proof

```bash
jevb qa verify qa-run                  # prompt + movie vs manifest vs transaction
jevb qa verify qa-run --chain          # also fetch the transaction and its block time
jevb qa verify --prompt p.txt --movie m.mp4 --manifest manifest.json --anchor anchor.json
```

What it proves: this exact prompt text and this exact movie file were bound
together in the manifest no later than the transaction's block time, and
none of them changed since. What it does not prove: that the movie is an
honest, unedited capture, that the steps follow the prompt, or which model
wrote them.

## Real anchoring (only when the user asks)

A broadcast is public and permanent and costs a few satoshis. Only when the
user explicitly asks, and has set `JEVB_BSV_WIF` (a funded key they control;
never ask them to paste it to you):

```bash
jevb qa anchor qa-run --broadcast
```

Only hashes go onchain. `--publish-prompt` also puts the prompt text onchain,
in clear, forever: use it only if the user asks for exactly that.
