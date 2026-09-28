#!/usr/bin/env bash
# Start real Google Chrome with a dedicated jevb profile and a local
# DevTools port, then print the JEVB_CDP_URL for jevb to attach to.
#
# Sign in to Chrome once in that window (profile icon → turn on sync) and its
# cookies, sign-ins and Password Manager persist in the profile folder.
# Chrome refuses a debugging port on its default profile, so this profile is
# separate from your everyday Chrome.
#
#   bin/jevb-chrome.sh               # start (or reuse) it
#   export JEVB_CDP_URL=http://127.0.0.1:9333
#   jevb stop; jevb open https://example.com   # daemon attaches on next start
set -euo pipefail

# JEVB_* settings from the repo's .env (shell env wins), like the CLI.
ENV_FILE="$(cd "$(dirname "$0")/.." && pwd)/.env"
if [[ -f "$ENV_FILE" ]]; then
    while IFS='=' read -r k v; do
        v="${v%\"}"; v="${v#\"}"
        if [[ "$k" =~ ^JEVB_[A-Z_]+$ && -z "${!k:-}" ]]; then export "$k=$v"; fi
    done < "$ENV_FILE"
fi

PORT="${JEVB_CDP_PORT:-9333}"
PROFILE="${JEVB_CHROME_PROFILE:-$HOME/.jevb/chrome-profile}"
URL="http://127.0.0.1:$PORT"
# Which Chrome profile inside $PROFILE to start in, e.g. "Profile 1" (see
# chrome://version → Profile Path). jevb's tabs open in the profile Chrome
# starts with, so pin it when the folder holds more than one sign-in.
PROFILE_ARGS=()
if [[ -n "${JEVB_CHROME_PROFILE_DIR:-}" ]]; then PROFILE_ARGS=(--profile-directory="$JEVB_CHROME_PROFILE_DIR"); fi

if [[ -z "${CHROME:-}" ]]; then
    for c in "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
             "$(command -v google-chrome || true)" "$(command -v google-chrome-stable || true)"; do
        [[ -n "$c" && -x "$c" ]] && CHROME="$c" && break
    done
fi
[[ -n "${CHROME:-}" ]] || { echo "Google Chrome not found; set CHROME=/path/to/chrome" >&2; exit 1; }

# Whatever listens on the port must be Chrome on the jevb profile, never
# your everyday Chrome (chrome://inspect remote debugging also opens a port).
owner() { lsof -nP -tiTCP:"$PORT" -sTCP:LISTEN 2>/dev/null | head -1 || true; }
pid="$(owner)"
if [[ -n "$pid" ]]; then
    ps -o command= -p "$pid" | grep -qF -- "--user-data-dir=$PROFILE" \
        || { echo "port $PORT is taken by another process (pid $pid); set JEVB_CDP_PORT" >&2; exit 1; }
    echo "already running on $URL" >&2
else
    mkdir -p "$PROFILE"
    "$CHROME" --user-data-dir="$PROFILE" ${PROFILE_ARGS[@]+"${PROFILE_ARGS[@]}"} --remote-debugging-port="$PORT" \
        --remote-debugging-address=127.0.0.1 --no-first-run --no-default-browser-check \
        >"$PROFILE/../chrome.log" 2>&1 &
    for _ in $(seq 1 50); do
        curl -fs "$URL/json/version" >/dev/null 2>&1 && break
        sleep 0.2
    done
    curl -fs "$URL/json/version" >/dev/null || { echo "Chrome didn't open $URL; see $PROFILE/../chrome.log" >&2; exit 1; }
    echo "Chrome up (profile $PROFILE)" >&2
fi
echo "JEVB_CDP_URL=$URL"
