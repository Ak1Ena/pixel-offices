#!/bin/bash
# Install or update the Pixel Office desktop app on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/Ak1Ena/pixel-offices/main/scripts/install-macos.sh | bash
#   curl -fsSL .../install-macos.sh | bash -s -- v2.4.0   # a specific version
#
# Two environment variables exist for the desktop app's own Install button
# (adapters/electron/updater.ts), and change nothing for a terminal run:
#   PIXEL_OFFICE_PROGRESS=1      the DMG download prints curl's percentage
#                                (stderr) so a progress bar can follow it.
#   PIXEL_OFFICE_KEEP_RUNNING=1  do not quit or relaunch a running app: it
#                                stays usable while the bundle is replaced and
#                                the app asks the user to reopen instead.
#
# This replaces an app on the user's disk, so every failure aborts BEFORE
# anything under /Applications is touched: the download is verified against
# its published SHA256SUMS before the DMG is even mounted, and a failed copy
# restores whatever was there before. No `com.apple.quarantine` attribute is
# ever set or removed here -- the file arrives via curl, not a browser, so
# there is none to begin with, and this script does not touch other files'
# attributes either.
set -euo pipefail

OWNER="Ak1Ena"
REPO="pixel-offices"
APP_NAME="Pixel Office"
APP_PROCESS_PATH="${APP_NAME}.app/Contents/MacOS/${APP_NAME}"
# Real installs always use /Applications; the override exists solely so this
# script's failure/no-op paths can be tested without touching the real one.
INSTALL_DIR="${PIXEL_OFFICE_INSTALL_DIR:-/Applications}"
QUIT_WAIT_SECONDS=15
PROGRESS="${PIXEL_OFFICE_PROGRESS:-0}"
KEEP_RUNNING="${PIXEL_OFFICE_KEEP_RUNNING:-0}"

log() { printf '==> %s\n' "$1"; }
die() {
  printf 'error: %s\n' "$1" >&2
  exit 1
}

# ── Preconditions ────────────────────────────────────────────────

[ "$(uname -s)" = "Darwin" ] || die "this installer only supports macOS."
[ "$(id -u)" != "0" ] || die "do not run this as root (it installs into your own ~/Applications-equivalent /Applications, not a system location that needs it)."

case "$(uname -m)" in
  arm64) ARCH="arm64" ;;
  x86_64) ARCH="x64" ;;
  *) die "unsupported architecture: $(uname -m)" ;;
esac

# ── Resolve the version to install ──────────────────────────────

RAW_VERSION="${1:-}"
if [ -n "$RAW_VERSION" ]; then
  TAG="v${RAW_VERSION#v}"
  RELEASE_API="https://api.github.com/repos/${OWNER}/${REPO}/releases/tags/${TAG}"
  log "Looking up release ${TAG}..."
else
  RELEASE_API="https://api.github.com/repos/${OWNER}/${REPO}/releases/latest"
  log "Looking up the latest release..."
fi

RELEASE_JSON="$(curl -fsSL --proto '=https' "$RELEASE_API")" \
  || die "could not reach the GitHub API. Check your network connection, or that ${TAG:-the latest release} exists."

TAG="$(printf '%s' "$RELEASE_JSON" \
  | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
  | head -1 | sed -E 's/.*"([^"]+)"$/\1/')"
[ -n "$TAG" ] || die "could not determine the release tag from the GitHub API response."
VERSION="${TAG#v}"

# Take the download URLs from the release's OWN asset list rather than
# rebuilding the file name from the version. electron-builder's naming is not
# something to guess at -- it substitutes characters (a space becomes a dot:
# "Pixel.Office-2.4.0-arm64.dmg"), and a release's assets do not necessarily
# carry the tag's version. Asking the release what it actually has avoids
# both traps, and a missing asset becomes a clear error instead of a 404.
asset_url() {
  printf '%s' "$RELEASE_JSON" \
    | grep -o '"browser_download_url"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | sed -E 's/.*"(https:[^"]+)"$/\1/' \
    | grep -E -- "$1" \
    | head -1
}

DMG_URL="$(asset_url "-${ARCH}\.dmg$")"
[ -n "$DMG_URL" ] || die "release ${TAG} has no macOS ${ARCH} .dmg asset. Published assets:
$(printf '%s' "$RELEASE_JSON" | grep -o '"name"[[:space:]]*:[[:space:]]*"[^"]*\.\(dmg\|exe\|AppImage\|deb\)"' | sed -E 's/.*"([^"]+)"$/  - \1/')"
SUMS_URL="$(asset_url "SHA256SUMS-macos-${ARCH}$")"
[ -n "$SUMS_URL" ] || die "release ${TAG} publishes a ${ARCH} .dmg but no SHA256SUMS-macos-${ARCH} to verify it against. Refusing to install an unverified download."

DMG_NAME="$(basename "${DMG_URL%%\?*}" | sed 's/%20/ /g')"
SUMS_NAME="$(basename "${SUMS_URL%%\?*}")"

# The version that matters for "is this already installed?" is the one INSIDE
# the asset, which is not always the tag's: a release can carry a dmg built
# before it was cut (v2.4.2 shipping Pixel.Office-2.4.1-arm64.dmg). Comparing
# the tag against the installed bundle version would then reinstall forever.
ASSET_VERSION="$(printf '%s' "$DMG_NAME" | sed -E "s/.*[-.]([0-9]+\.[0-9]+\.[0-9]+[^-]*)-${ARCH}\.dmg$/\1/")"
case "$ASSET_VERSION" in
  [0-9]*) VERSION="$ASSET_VERSION" ;;
  *) ;; # unrecognized naming -- keep the tag's version
esac
log "Target version: ${VERSION} (${ARCH}) -- ${DMG_NAME}"

# ── Idempotent no-op: already installed ─────────────────────────

CURRENT_APP="${INSTALL_DIR}/${APP_NAME}.app"
if [ -d "$CURRENT_APP" ]; then
  INSTALLED_VERSION="$(plutil -extract CFBundleShortVersionString raw "${CURRENT_APP}/Contents/Info.plist" 2>/dev/null || true)"
  if [ "$INSTALLED_VERSION" = "$VERSION" ]; then
    log "${APP_NAME} ${VERSION} is already installed -- nothing to do."
    exit 0
  fi
fi

# ── Download + verify (HTTPS only, checksum before anything is mounted) ──

WORKDIR="$(mktemp -d)"
MOUNT_POINT="${WORKDIR}/mount"
MOUNTED=0

cleanup() {
  if [ "$MOUNTED" = "1" ]; then
    hdiutil detach "$MOUNT_POINT" -quiet -force >/dev/null 2>&1 || true
  fi
  rm -rf "$WORKDIR"
}
trap cleanup EXIT

for url in "$DMG_URL" "$SUMS_URL"; do
  case "$url" in
    https://*) ;;
    *) die "refusing a non-HTTPS download URL: ${url}" ;;
  esac
done

log "Downloading ${DMG_NAME}..."
# --progress-bar writes a percentage to stderr; the app parses it. A terminal
# run keeps the silent -s so piping this script stays quiet.
if [ "$PROGRESS" = "1" ]; then
  DMG_CURL_OPTS=(-fL --progress-bar)
else
  DMG_CURL_OPTS=(-fsSL)
fi
curl "${DMG_CURL_OPTS[@]}" --proto '=https' -o "${WORKDIR}/${DMG_NAME}" "$DMG_URL" \
  || die "download failed. Is version ${VERSION} published for macOS ${ARCH}?"

log "Downloading ${SUMS_NAME}..."
curl -fsSL --proto '=https' -o "${WORKDIR}/${SUMS_NAME}" "$SUMS_URL" \
  || die "could not download the checksum file. Aborting without installing anything."

# Compare hashes directly instead of `shasum -c`: the SUMS file lists the
# file name as electron-builder produced it ("Pixel Office-...dmg"), while
# GitHub serves the asset with spaces rewritten ("Pixel.Office-...dmg"), so
# name-based checking would fail on a download that is in fact correct. The
# HASH is the thing being trusted here, not the name.
log "Verifying checksum..."
EXPECTED_SHA="$(grep -E "[0-9a-f]{64}[[:space:]]+\*?.*-${ARCH}\.dmg$" "${WORKDIR}/${SUMS_NAME}" \
  | head -1 | awk '{print $1}')"
ACTUAL_SHA="$(shasum -a 256 "${WORKDIR}/${DMG_NAME}" | awk '{print $1}')"

if [ -z "$EXPECTED_SHA" ]; then
  rm -f "${WORKDIR}/${DMG_NAME}"
  die "${SUMS_NAME} has no entry for a ${ARCH} .dmg. The download has been deleted; nothing was installed or modified."
fi
if [ "$EXPECTED_SHA" != "$ACTUAL_SHA" ]; then
  rm -f "${WORKDIR}/${DMG_NAME}"
  die "checksum verification FAILED for ${DMG_NAME}
  expected: ${EXPECTED_SHA}
  actual:   ${ACTUAL_SHA}
The download has been deleted; nothing was installed or modified."
fi
log "Checksum OK (${ACTUAL_SHA})"

# ── Mount, locate the .app ───────────────────────────────────────

log "Mounting disk image..."
mkdir -p "$MOUNT_POINT"
hdiutil attach "${WORKDIR}/${DMG_NAME}" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet \
  || die "could not mount the downloaded disk image."
MOUNTED=1

SOURCE_APP="$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -print -quit)"
[ -n "$SOURCE_APP" ] || die "no .app bundle found inside the disk image."

# ── Quit a running instance ─────────────────────────────────────

if [ "$KEEP_RUNNING" = "1" ]; then
  # The app installs its own update: quitting it here would kill the update.
  # It keeps running from the bundle about to be replaced (macOS holds the
  # open files) and asks the user to reopen once this finishes.
  log "Leaving the running ${APP_NAME} alone (it asked for this update)."
elif pgrep -f "$APP_PROCESS_PATH" >/dev/null 2>&1; then
  log "Quitting the running ${APP_NAME}..."
  osascript -e "quit app \"${APP_NAME}\"" >/dev/null 2>&1 || true
  waited=0
  while pgrep -f "$APP_PROCESS_PATH" >/dev/null 2>&1; do
    if [ "$waited" -ge "$QUIT_WAIT_SECONDS" ]; then
      log "${APP_NAME} did not quit in time -- forcing it closed."
      pkill -9 -f "$APP_PROCESS_PATH" >/dev/null 2>&1 || true
      break
    fi
    sleep 1
    waited=$((waited + 1))
  done
fi

# ── Replace the installed app, restoring on failure ─────────────

BACKUP_APP="${INSTALL_DIR}/.${APP_NAME}.app.pre-update-backup"
rm -rf "$BACKUP_APP"
HAD_PREVIOUS=0
if [ -d "$CURRENT_APP" ]; then
  log "Backing up the current install..."
  mv "$CURRENT_APP" "$BACKUP_APP"
  HAD_PREVIOUS=1
fi

log "Installing ${APP_NAME} ${VERSION} to ${INSTALL_DIR}..."
if ditto "$SOURCE_APP" "$CURRENT_APP"; then
  rm -rf "$BACKUP_APP"
else
  log "Install failed -- restoring the previous version."
  rm -rf "$CURRENT_APP"
  if [ "$HAD_PREVIOUS" = "1" ]; then
    mv "$BACKUP_APP" "$CURRENT_APP"
  fi
  die "could not copy ${APP_NAME}.app into ${INSTALL_DIR}. Your previous install (if any) has been restored."
fi

# ── Unmount, relaunch ────────────────────────────────────────────

log "Unmounting disk image..."
hdiutil detach "$MOUNT_POINT" -quiet || hdiutil detach "$MOUNT_POINT" -quiet -force || true
MOUNTED=0

if [ "$KEEP_RUNNING" = "1" ]; then
  log "Installed. Reopen ${APP_NAME} to use ${VERSION}."
else
  log "Launching ${APP_NAME}..."
  open -a "$CURRENT_APP"
fi

log "Done: ${APP_NAME} ${VERSION} installed."
