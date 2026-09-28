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
  xcrun simctl boot "$1"
  limit 600 xcrun simctl bootstatus "$1" -b >/dev/null
  xcrun simctl status_bar "$1" override --time 9:41 --batteryState charged --batteryLevel 100 --wifiBars 3 --cellularBars 4
}

start_mock() {
  SCENE=$1 bun "$here/mock-sirus.ts" >/dev/null 2>&1 &
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
  limit 30 xcrun simctl terminate "$udid" "$bundle" >/dev/null 2>&1 || true
  limit 60 xcrun simctl uninstall "$udid" "$bundle" >/dev/null 2>&1 || true
  limit 120 xcrun simctl install "$udid" "$app" || echo "install timed out" >&2
  limit 60 xcrun simctl launch "$udid" "$bundle" -notificationsAsked YES "$@" >/dev/null || echo "launch timed out" >&2
}

shot() {
  limit 60 xcrun simctl io "$1" screenshot "$out/$2.png" >/dev/null || echo "screenshot $2 timed out" >&2
  echo "$(date +%T) shot $2"
}

# One scene against the stand-in Sirus: udid, device label, name, SCENE,
# seconds to wait, then launch arguments.
scene() {
  local udid=$1 label=$2 name=$3 mock_scene=$4 wait=$5
  shift 5
  start_mock "$mock_scene"
  launch "$udid" -host 127.0.0.1 "$@"
  sleep "$wait"
  shot "$udid" "$label-$name"
  stop_mock
}

run() {
  local udid=$1 label=$2

  # Setup: a fresh install knows no Mac.
  launch "$udid"
  sleep 4
  shot "$udid" "$label-setup"

  # Setup after a failed connect, from a link to a Mac that isn't there.
  launch "$udid"
  sleep 3
  limit 30 xcrun simctl openurl "$udid" "sirus://connect?host=nope.invalid" || echo "openurl failed" >&2
  sleep 8
  shot "$udid" "$label-setup-failed"

  # The lobby for a known Mac that can't be reached.
  launch "$udid" -host nope.invalid
  sleep 9
  shot "$udid" "$label-lobby-offline"

  scene "$udid" "$label" lobby-empty nosessions 6
  scene "$udid" "$label" loading loading 6
  scene "$udid" "$label" conversation conversation 6
  scene "$udid" "$label" menu-command conversation 8 -composerDraft /mo -composerFocused YES
  scene "$udid" "$label" menu-mention conversation 8 -composerDraft "Review @ios/Sir" -composerFocused YES
  scene "$udid" "$label" picker-model conversation 8 -openPicker /model
  scene "$udid" "$label" picker-permissions conversation 8 -openPicker /permissions
  scene "$udid" "$label" note conversation 7 -sendOnLaunch "/model claude-sonnet-4-5"
  scene "$udid" "$label" note-failed conversation 7 -sendOnLaunch "/model claude-opus-9"
  scene "$udid" "$label" approval approval 6
  scene "$udid" "$label" question question 6
  scene "$udid" "$label" crowded crowded 6
  scene "$udid" "$label" empty empty 6
  scene "$udid" "$label" long long 6
  scene "$udid" "$label" sidebar conversation 6 -sidebarExpanded YES
  scene "$udid" "$label" gone gone 8
  scene "$udid" "$label" stress stress 7
  scene "$udid" "$label" question-keyboard question 8 -composerFocused YES
  scene "$udid" "$label" note-long conversation 7 -sendOnLaunch /long-note

  # Offline: the Mac goes away while the conversation is on screen.
  start_mock offline
  launch "$udid" -host 127.0.0.1
  sleep 6
  stop_mock
  sleep 6
  shot "$udid" "$label-offline"
}

# The software keyboard, as on a phone, rather than the Mac's.
defaults write com.apple.iphonesimulator ConnectHardwareKeyboard -bool false

small=$(create_device "Screens small" "iPhone SE (3rd generation)" "iPhone 13 mini" "iPhone 16e")
large=$(create_device "Screens large" "iPhone 17 Pro Max" "iPhone 16 Pro Max" "iPhone 16 Plus")
trap 'stop_mock; xcrun simctl shutdown all >/dev/null 2>&1 || true' EXIT

boot "$small"
run "$small" small
# The largest standard text size, on the smallest screen.
xcrun simctl ui "$small" content_size extra-extra-extra-large
scene "$small" small conversation-largest-text conversation 6
scene "$small" small question-largest-text question 6
xcrun simctl ui "$small" content_size large
xcrun simctl shutdown "$small"

boot "$large"
run "$large" large
