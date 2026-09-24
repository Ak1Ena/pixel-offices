#!/bin/bash
# Install or update the Pixel Office desktop app on macOS.
#
#   curl -fsSL https://raw.githubusercontent.com/pixel-agents-hq/pixel-agents/main/scripts/install-macos.sh | bash
#   curl -fsSL .../install-macos.sh | bash -s -- v2.4.0   # a specific version
#
# This replaces an app on the user's disk, so every failure aborts BEFORE
# anything under /Applications is touched: the download is verified against
# its published SHA256SUMS before the DMG is even mounted, and a failed copy
# restores whatever was there before. No `com.apple.quarantine` attribute is
# ever set or removed here -- the file arrives via curl, not a browser, so
# there is none to begin with, and this script does not touch other files'
# attributes either.
set -euo pipefail

OWNER="pixel-agents-hq"
REPO="pixel-agents"
APP_NAME="Pixel Office"
APP_PROCESS_PATH="${APP_NAME}.app/Contents/MacOS/${APP_NAME}"
# Real installs always use /Applications; the override exists solely so this
# script's failure/no-op paths can be tested without touching the real one.
INSTALL_DIR="${PIXEL_OFFICE_INSTALL_DIR:-/Applications}"
QUIT_WAIT_SECONDS=15

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
else
  log "Looking up the latest release..."
  LATEST_JSON="$(curl -fsSL --proto '=https' "https://api.github.com/repos/${OWNER}/${REPO}/releases/latest")" \
    || die "could not reach the GitHub API to find the latest release. Check your network connection."
  TAG="$(printf '%s' "$LATEST_JSON" \
    | grep -o '"tag_name"[[:space:]]*:[[:space:]]*"[^"]*"' \
    | head -1 \
    | sed -E 's/.*"([^"]+)"$/\1/')"
  [ -n "$TAG" ] || die "could not determine the latest release tag from the GitHub API response."
fi
VERSION="${TAG#v}"
log "Target version: ${VERSION} (${ARCH})"

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

DMG_NAME="${APP_NAME}-${VERSION}-${ARCH}.dmg"
DMG_NAME_ENCODED="${DMG_NAME// /%20}"
SUMS_NAME="SHA256SUMS-macos-${ARCH}"
DOWNLOAD_BASE="https://github.com/${OWNER}/${REPO}/releases/download/${TAG}"
DMG_URL="${DOWNLOAD_BASE}/${DMG_NAME_ENCODED}"
SUMS_URL="${DOWNLOAD_BASE}/${SUMS_NAME}"

for url in "$DMG_URL" "$SUMS_URL"; do
  case "$url" in
    https://*) ;;
    *) die "refusing a non-HTTPS download URL: ${url}" ;;
  esac
done

log "Downloading ${DMG_NAME}..."
curl -fsSL --proto '=https' -o "${WORKDIR}/${DMG_NAME}" "$DMG_URL" \
  || die "download failed. Is version ${VERSION} published for macOS ${ARCH}?"

log "Downloading ${SUMS_NAME}..."
curl -fsSL --proto '=https' -o "${WORKDIR}/${SUMS_NAME}" "$SUMS_URL" \
  || die "could not download the checksum file. Aborting without installing anything."

log "Verifying checksum..."
if ! (cd "$WORKDIR" && shasum -a 256 -c "$SUMS_NAME"); then
  rm -f "${WORKDIR}/${DMG_NAME}"
  die "checksum verification FAILED for ${DMG_NAME}. The download has been deleted; nothing was installed or modified."
fi

# ── Mount, locate the .app ───────────────────────────────────────

log "Mounting disk image..."
mkdir -p "$MOUNT_POINT"
hdiutil attach "${WORKDIR}/${DMG_NAME}" -nobrowse -readonly -mountpoint "$MOUNT_POINT" -quiet \
  || die "could not mount the downloaded disk image."
MOUNTED=1

SOURCE_APP="$(find "$MOUNT_POINT" -maxdepth 1 -name "*.app" -print -quit)"
[ -n "$SOURCE_APP" ] || die "no .app bundle found inside the disk image."

# ── Quit a running instance ─────────────────────────────────────

if pgrep -f "$APP_PROCESS_PATH" >/dev/null 2>&1; then
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

log "Launching ${APP_NAME}..."
open -a "$CURRENT_APP"

log "Done: ${APP_NAME} ${VERSION} installed."
