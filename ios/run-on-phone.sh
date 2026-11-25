#!/usr/bin/env bash
# Pulls the latest code, builds the app, and installs and opens it on your iPhone.
#
#   ios/run-on-phone.sh            the first connected iPhone
#   ios/run-on-phone.sh --no-pull  build what's checked out, without pulling
#
# Needs Xcode (signed in to your Apple ID under Xcode › Settings › Accounts) and the iPhone
# plugged in or paired over Wi-Fi, unlocked, with Developer Mode on.
set -euo pipefail

IOS_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_DIR="$(dirname "$IOS_DIR")"
PBX="$IOS_DIR/CostcoGas.xcodeproj/project.pbxproj"
LOCAL="$IOS_DIR/Local.xcconfig"
BUILD_DIR="$IOS_DIR/build"
PULL=1
[ "${1:-}" = "--no-pull" ] && PULL=0

say() { printf '\n\033[1m▸ %s\033[0m\n' "$*"; }
fail() { printf '\n\033[31m✗ %s\033[0m\n' "$*" >&2; exit 1; }

command -v xcodebuild >/dev/null || fail "Xcode isn't installed (xcodebuild not found)."
cd "$REPO_DIR"

# --- Signing: team and bundle identifier live in Local.xcconfig (git-ignored) -------------
if [ ! -f "$LOCAL" ]; then
    say "Setting up signing (once)"
    # Values set earlier in Xcode's Signing tab are in the project file: keep them.
    team="$(grep -m1 -oE 'DEVELOPMENT_TEAM = [A-Z0-9]{10};' "$PBX" 2>/dev/null | grep -oE '[A-Z0-9]{10}' || true)"
    bundle="$(grep -m1 -oE 'PRODUCT_BUNDLE_IDENTIFIER = [^;]+;' "$PBX" 2>/dev/null | sed -E 's/.*= "?([^";]+)"?;/\1/' || true)"
    [ "$bundle" = "com.example.costcogas" ] && bundle=""
    # Otherwise the team from your Apple Development certificate.
    if [ -z "$team" ]; then
        team="$(security find-certificate -a -c "Apple Development" -p 2>/dev/null \
            | openssl x509 -noout -subject 2>/dev/null \
            | sed -nE 's/.*OU ?= ?([A-Z0-9]{10}).*/\1/p' | head -1 || true)"
    fi
    if [ -z "$team" ]; then
        echo "Couldn't find your team ID. In Xcode, open Settings › Accounts, select your Apple ID,"
        echo "and look under Team (or run the app once from Xcode, which creates the certificate)."
        read -r -p "Team ID (10 characters): " team
    fi
    if [ -z "$bundle" ]; then
        default="com.$(id -un | tr -cd '[:alnum:]' | tr '[:upper:]' '[:lower:]').costcogas"
        read -r -p "Bundle identifier [$default]: " bundle
        bundle="${bundle:-$default}"
    fi
    printf 'DEVELOPMENT_TEAM = %s\nPRODUCT_BUNDLE_IDENTIFIER = %s\n' "$team" "$bundle" > "$LOCAL"
    echo "Saved team $team and bundle identifier $bundle in ios/Local.xcconfig"
fi
BUNDLE_ID="$(sed -nE 's/^PRODUCT_BUNDLE_IDENTIFIER *= *([^ ]+).*/\1/p' "$LOCAL")"

# --- Latest code ---------------------------------------------------------------------------
if [ "$PULL" = 1 ]; then
    say "Pulling the latest code"
    # Signing changes made in Xcode's Signing tab edit the project file; they're in
    # Local.xcconfig now, so drop them rather than let them block the pull.
    if ! git diff --quiet -- "$PBX"; then
        echo "Resetting local edits to the Xcode project file (signing is in ios/Local.xcconfig)."
        git checkout -- "$PBX"
    fi
    git pull --ff-only || fail "git pull failed. Commit or stash your own changes, then try again."
fi

# --- Find the iPhone -----------------------------------------------------------------------
say "Looking for your iPhone"
DEVICES_JSON="$(mktemp)"
trap 'rm -f "$DEVICES_JSON"' EXIT
xcrun devicectl list devices --json-output "$DEVICES_JSON" >/dev/null 2>&1 \
    || fail "Couldn't list devices. Is Xcode 15 or later installed?"
read -r UDID NAME < <(/usr/bin/python3 - "$DEVICES_JSON" <<'PY'
import json, sys
devices = json.load(open(sys.argv[1])).get("result", {}).get("devices", [])
phones = [d for d in devices
          if d.get("hardwareProperties", {}).get("platform") == "iOS"
          and d.get("hardwareProperties", {}).get("reality") == "physical"]
# Connected ones first.
phones.sort(key=lambda d: d.get("connectionProperties", {}).get("tunnelState") != "connected")
if phones:
    d = phones[0]
    print(d["hardwareProperties"]["udid"], d.get("deviceProperties", {}).get("name", "iPhone"))
PY
) || true
[ -n "${UDID:-}" ] || fail "No iPhone found. Plug it in, unlock it, and tap Trust if asked."
echo "Using $NAME ($UDID)"

# --- Build ---------------------------------------------------------------------------------
say "Building (the first build takes a few minutes)"
xcodebuild build -quiet \
    -project "$IOS_DIR/CostcoGas.xcodeproj" \
    -scheme CostcoGas \
    -configuration Debug \
    -destination "id=$UDID" \
    -derivedDataPath "$BUILD_DIR" \
    -allowProvisioningUpdates \
    || fail "The build failed. The errors are above."
APP="$BUILD_DIR/Build/Products/Debug-iphoneos/CostcoGas.app"
[ -d "$APP" ] || fail "Built, but couldn't find CostcoGas.app."

# --- Install and open ----------------------------------------------------------------------
say "Installing on $NAME"
xcrun devicectl device install app --device "$UDID" "$APP" >/dev/null \
    || fail "Install failed. Unlock the phone and check Developer Mode is on (Settings › Privacy & Security)."

say "Opening Costco Gas"
if ! xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID" >/dev/null 2>&1; then
    echo "Installed, but the phone wouldn't open it yet. If this is the first install, open"
    echo "Settings › General › VPN & Device Management on the phone, trust your Apple ID, then"
    echo "open Costco Gas from the home screen."
    exit 0
fi
printf '\n\033[32m✓ Costco Gas is running on %s\033[0m\n' "$NAME"
