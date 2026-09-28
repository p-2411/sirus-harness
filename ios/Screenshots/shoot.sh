#!/bin/bash
# Screenshots of the phone app in each state worth checking, on the
# smallest and the largest iPhone it supports. Each scene starts the
# stand-in Sirus (mock-sirus.ts) with its SCENE, launches a fresh install
# with the launch arguments that set the scene up, and captures the
# screen. Needs macOS with Xcode and Bun; .github/workflows/ios-screens.yml
# runs it.
#
#   shoot.sh <path to SirusRemote.app> <output folder>
set -euo pipefail

app=$1
out=$2
here=$(cd "$(dirname "$0")" && pwd)
bundle=com.sirus.remote
mock=""
mkdir -p "$out"

runtime=$(xcrun simctl list runtimes -j | python3 -c '
import json, sys
runtimes = [r for r in json.load(sys.stdin)["runtimes"] if r["platform"] == "iOS" and r["isAvailable"]]
print(sorted(runtimes, key=lambda r: [int(p) for p in r["version"].split(".")])[-1]["identifier"])')
echo "runtime $runtime"

# The first of the device types named that this runtime can run.
create_device() {
  local label=$1 name type udid
  shift
  for name in "$@"; do
    type=$(xcrun simctl list devicetypes -j | python3 -c '
import json, sys
types = {t["name"]: t["identifier"] for t in json.load(sys.stdin)["devicetypes"]}
print(types.get(sys.argv[1], ""))' "$name")
    [ -n "$type" ] || continue
    if udid=$(xcrun simctl create "$label" "$type" "$runtime" 2>/dev/null); then
      echo "$label: $name" >&2
      echo "$udid"
      return 0
    fi
  done
  echo "no device type for $label" >&2
  return 1
}

# Runs a command, giving up after the seconds given, so one simulator
# command that hangs can't hold the whole run.
limit() {
  local seconds=$1
  shift
  perl -e 'alarm shift; exec @ARGV' "$seconds" "$@"
}

boot() {
  echo "$(date +%T) booting $1"
  limit 300 xcrun simctl boot "$1" || echo "boot timed out" >&2
  limit 600 xcrun simctl bootstatus "$1" -b >/dev/null
  xcrun simctl status_bar "$1" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
  # The keyboard's one-time tip on sliding to type would cover it.
  xcrun simctl spawn "$1" defaults write com.apple.keyboard.preferences DidShowContinuousPathIntroduction -bool true || true
  # The first launch after a boot can be sent to the background while the
  # system is still settling, so a throwaway launch takes it.
  limit 120 xcrun simctl install "$1" "$app" || echo "install timed out" >&2
  limit 60 xcrun simctl launch "$1" "$bundle" -notificationsAsked YES >/dev/null 2>&1 || true
  sleep 10
  limit 30 xcrun simctl terminate "$1" "$bundle" >/dev/null 2>&1 || true
}

start_mock() {
  SCENE=$1 bun "$here/mock-sirus.ts" >>"$out/../mock.log" 2>&1 &
  mock=$!
  for _ in $(seq 50); do
    curl -sf http://127.0.0.1:47470/v1/hello >/dev/null && return 0
    sleep 0.1
  done
  echo "the stand-in Sirus did not start" >&2
  return 1
}

stop_mock() {
  [ -n "$mock" ] || return 0
  kill "$mock" 2>/dev/null || true
  wait "$mock" 2>/dev/null || true
  mock=""
}

# A fresh install, so nothing one scene stored reaches the next. The
# notification prompt is marked as asked so it never covers a screen.
launch() {
  local udid=$1
  shift
  touch "$out/../launched"
  limit 30 xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1 || true
  limit 60 xcrun simctl uninstall "$udid" "$bundle" >/dev/null 2>&1 || true
  limit 120 xcrun simctl install "$udid" "$app" || echo "install timed out" >&2
  limit 60 xcrun simctl launch "$udid" "$bundle" -notificationsAsked YES "$@" >/dev/null || echo "launch timed out" >&2
}

shot() {
  limit 60 xcrun simctl io "$1" screenshot "$out/$2.png" >/dev/null || echo "screenshot $2 timed out" >&2
  echo "$(date +%T) shot $2"
  # What the app asked the stand-in Sirus, and what it logged: layout
  # loops, crashes and the debug build's own notes.
  sed 's/^/  mock: /' "$out/../mock.log" 2>/dev/null | tail -n 8 || true
  limit 30 xcrun simctl spawn "$1" log show --last 25s --style compact \
    --predicate 'process == "SirusRemote" AND (subsystem == "com.sirus.remote" OR messageType == error OR eventMessage CONTAINS[c] "per frame" OR eventMessage CONTAINS[c] "cycle")' \
    2>/dev/null | tail -n 12 | sed 's/^/  app: /' || true
  # A crash since the launch, which otherwise only shows as the home screen.
  find "$HOME/Library/Logs/DiagnosticReports" -name 'SirusRemote*' -newer "$out/../launched" 2>/dev/null \
    | xargs python3 "$here/crash.py" 2>&1 | sed 's/^/  crash: /' || true
  : >"$out/../mock.log"
}

# One scene against the stand-in Sirus: udid, device label, name, SCENE,
# seconds to wait, then launch arguments.
scene() {
  local udid=$1 label=$2 name=$3 mock_scene=$4 wait=$5
  shift 5
  wanted "$name" || return 0
  start_mock "$mock_scene"
  launch "$udid" -host 127.0.0.1 "$@"
  sleep "$wait"
  shot "$udid" "$label-$name"
  stop_mock
}

run() {
  local udid=$1 label=$2

  # Setup: a fresh install knows no Mac.
  if wanted setup; then
    launch "$udid"
    sleep 4
    shot "$udid" "$label-setup"
  fi

  # Setup after a failed connect to a Mac that isn't there. (A sirus://
  # link would do the same, but the system asks before opening it and the
  # question stays up over every later scene.)
  if wanted setup-failed; then
    launch "$udid" -connectTo nope.invalid
    sleep 9
    shot "$udid" "$label-setup-failed"
  fi

  # The lobby for a known Mac that can't be reached.
  if wanted lobby-offline; then
    launch "$udid" -host nope.invalid
    sleep 9
    shot "$udid" "$label-lobby-offline"
  fi

  scene "$udid" "$label" lobby-empty nosessions 6
  scene "$udid" "$label" loading loading 6
  scene "$udid" "$label" conversation conversation 6
  scene "$udid" "$label" menu-command conversation 8 -composerDraft /mo -composerFocused YES
  scene "$udid" "$label" menu-mention conversation 8 -composerDraft "Review @ios/Sir" -composerFocused YES
  scene "$udid" "$label" picker-model conversation 8 -openPicker /model
  scene "$udid" "$label" picker-permissions conversation 8 -openPicker /permissions
  scene "$udid" "$label" note conversation 4 -sendOnLaunch "/model claude-sonnet-4-5"
  scene "$udid" "$label" note-failed conversation 4 -sendOnLaunch "/model claude-opus-9"
  scene "$udid" "$label" approval approval 6
  scene "$udid" "$label" question question 6
  scene "$udid" "$label" crowded crowded 6
  scene "$udid" "$label" empty empty 6
  scene "$udid" "$label" long long 6
  scene "$udid" "$label" sidebar conversation 6 -sidebarExpanded YES
  scene "$udid" "$label" gone gone 8
  scene "$udid" "$label" stress stress 7
  scene "$udid" "$label" question-keyboard question 8 -composerFocused YES
  scene "$udid" "$label" note-long conversation 5 -sendOnLaunch /long-note

  # Offline: the Mac goes away while the conversation is on screen.
  if wanted offline; then
    start_mock offline
    launch "$udid" -host 127.0.0.1
    sleep 6
    stop_mock
    sleep 6
    shot "$udid" "$label-offline"
  fi
}

# Scenes to shoot, by name: all of them, unless ONLY or a file named `only`
# beside this script lists some, to look again at a few quickly.
only=${ONLY:-$(cat "$here/only" 2>/dev/null || true)}
wanted() {
  [ -z "$only" ] || [[ " $only " == *" $1 "* ]]
}

# The software keyboard, as on a phone, rather than the Mac's.
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false

small=$(create_device "Screens small" "iPhone SE (3rd generation)" "iPhone 13 mini" "iPhone 16e")
large=$(create_device "Screens large" "iPhone 17 Pro Max" "iPhone 16 Pro Max" "iPhone 16 Plus")
trap 'stop_mock; xcrun simctl shutdown all >/dev/null 2>&1 || true' EXIT

boot "$small"
run "$small" small
# The largest standard text size, on the smallest screen.
if wanted conversation-largest-text || wanted question-largest-text; then
  xcrun simctl ui "$small" content_size extra-extra-extra-large
  sleep 3
  scene "$small" small conversation-largest-text conversation 10
  scene "$small" small question-largest-text question 10
  xcrun simctl ui "$small" content_size large
fi
limit 120 xcrun simctl shutdown "$small" || echo "shutdown timed out" >&2

# A quick look at a few scenes needs one screen only.
[ -z "$only" ] || exit 0
boot "$large"
run "$large" large
