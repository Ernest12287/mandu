#!/usr/bin/env sh
# shellcheck shell=sh
#
# Mandu CLI installer for Linux and macOS.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/konamgil/mandu/main/install.sh | sh
#   curl -fsSL https://raw.githubusercontent.com/konamgil/mandu/main/install.sh | sh -s -- --version v0.23.0
#   curl -fsSL https://raw.githubusercontent.com/konamgil/mandu/main/install.sh | sh -s -- --dry-run
#
# Environment overrides:
#   MANDU_VERSION       Release tag to install (default: "latest").
#   MANDU_INSTALL_DIR   Where to place the binary (default: $HOME/.mandu/bin).
#   MANDU_REPO          GitHub owner/repo (default: "konamgil/mandu").
#   MANDU_FORCE         If "1", overwrite an existing binary without prompting.
#   MANDU_NO_MODIFY_PATH  If "1", skip shell-profile PATH edits.
#
# Exit codes:
#   0  success
#   1  generic failure
#   2  unsupported OS/arch
#   3  download / network failure
#   4  checksum mismatch
#
# This script is intentionally POSIX `sh`-compatible (no bashisms) so it can be
# consumed by Alpine (busybox ash) and FreeBSD users in addition to GNU bash /
# zsh. For Git Bash / WSL users who prefer explicit bash, see install.bash.

set -eu

# ---------------------------------------------------------------------------
# Defaults / constants
# ---------------------------------------------------------------------------
MANDU_REPO="${MANDU_REPO:-konamgil/mandu}"
MANDU_VERSION="${MANDU_VERSION:-latest}"
MANDU_INSTALL_DIR="${MANDU_INSTALL_DIR:-${HOME}/.mandu/bin}"
DRY_RUN=0
VERBOSE=0

# ---------------------------------------------------------------------------
# Output helpers
# ---------------------------------------------------------------------------
log() { printf '%s\n' "$*" >&2; }
err() { printf 'error: %s\n' "$*" >&2; }
note() { printf '  %s\n' "$*" >&2; }

if [ -t 2 ]; then
  BOLD="$(printf '\033[1m')"
  DIM="$(printf '\033[2m')"
  RED="$(printf '\033[31m')"
  GRN="$(printf '\033[32m')"
  YEL="$(printf '\033[33m')"
  RST="$(printf '\033[0m')"
else
  BOLD=""; DIM=""; RED=""; GRN=""; YEL=""; RST=""
fi

# ---------------------------------------------------------------------------
# Arg parsing
# ---------------------------------------------------------------------------
usage() {
  cat <<'EOF' >&2
Mandu CLI installer

Usage:
  install.sh [--version <tag>] [--install-dir <path>] [--dry-run] [--force]
             [--no-modify-path] [--verbose] [--help]

Options:
  --version <tag>       Release tag to install (default: latest).
  --install-dir <path>  Install directory (default: $HOME/.mandu/bin).
  --dry-run             Print planned actions without downloading or writing.
  --force               Overwrite an existing binary without prompting.
  --no-modify-path      Skip shell-profile PATH edits.
  --verbose             Print extra debug output.
  --help                Show this help.

Environment: MANDU_VERSION, MANDU_INSTALL_DIR, MANDU_REPO, MANDU_FORCE,
             MANDU_NO_MODIFY_PATH.
EOF
}

while [ $# -gt 0 ]; do
  case "$1" in
    --version) MANDU_VERSION="${2:?--version requires a tag}"; shift 2 ;;
    --install-dir) MANDU_INSTALL_DIR="${2:?--install-dir requires a path}"; shift 2 ;;
    --dry-run) DRY_RUN=1; shift ;;
    --force) MANDU_FORCE=1; shift ;;
    --no-modify-path) MANDU_NO_MODIFY_PATH=1; shift ;;
    --verbose) VERBOSE=1; shift ;;
    -h|--help) usage; exit 0 ;;
    *) err "unknown argument: $1"; usage; exit 1 ;;
  esac
done

# ---------------------------------------------------------------------------
# Platform detection
# ---------------------------------------------------------------------------
OS_RAW="$(uname -s)"
ARCH_RAW="$(uname -m)"

case "${OS_RAW}" in
  Linux*) OS=linux ;;
  Darwin*) OS=darwin ;;
  MINGW*|MSYS*|CYGWIN*)
    # Native Windows installs should use install.ps1. The
    # MANDU_FORCE_UNIX=1 escape hatch (also honored by install.bash) lets
    # power users install a unix-target binary into a WSL/Cygwin toolchain
    # that's accessed from a Git Bash shell.
    if [ "${MANDU_FORCE_UNIX:-0}" = "1" ]; then
      OS=linux
    else
      err "Git Bash / MSYS detected. Please use install.ps1 (PowerShell) on Windows."
      exit 2
    fi
    ;;
  *) err "Unsupported OS: ${OS_RAW}"; exit 2 ;;
esac

case "${ARCH_RAW}" in
  x86_64|amd64) ARCH=x64 ;;
  arm64|aarch64) ARCH=arm64 ;;
  *) err "Unsupported architecture: ${ARCH_RAW}"; exit 2 ;;
esac

# Linux glibc vs musl detection. The GitHub Release ships distinct
# `bun-linux-x64` (glibc) and `bun-linux-x64-musl` (Alpine / musl) binaries;
# installing the wrong one produces cryptic "not found" errors at exec time.
LIBC_SUFFIX=""
if [ "${OS}" = "linux" ]; then
  if ldd --version 2>&1 | grep -qi musl; then
    LIBC_SUFFIX="-musl"
  elif [ -f /etc/alpine-release ]; then
    LIBC_SUFFIX="-musl"
  fi
fi

RUNNER_TARGET="bun-${OS}-${ARCH}${LIBC_SUFFIX}"
EXT=""  # unix targets have no extension
BINARY_NAME="mandu-${RUNNER_TARGET}${EXT}"

# ---------------------------------------------------------------------------
# Tool detection (curl preferred, wget fallback)
# ---------------------------------------------------------------------------
FETCH=""
if command -v curl >/dev/null 2>&1; then
  FETCH="curl"
elif command -v wget >/dev/null 2>&1; then
  FETCH="wget"
else
  err "neither curl nor wget is installed; cannot download release"
  exit 3
fi

HASH=""
if command -v sha256sum >/dev/null 2>&1; then
  HASH="sha256sum"
elif command -v shasum >/dev/null 2>&1; then
  HASH="shasum -a 256"
fi

# ---------------------------------------------------------------------------
# Build download URL
# ---------------------------------------------------------------------------
# GitHub Release layout (set by release-binaries.yml):
#   /releases/download/<tag>/<binary>
#   /releases/download/<tag>/<binary>.sha256
# Special-case `latest` — the /releases/latest path resolves to whichever
# release has been marked latest.
if [ "${MANDU_VERSION}" = "latest" ]; then
  BASE_URL="https://github.com/${MANDU_REPO}/releases/latest/download"
else
  BASE_URL="https://github.com/${MANDU_REPO}/releases/download/${MANDU_VERSION}"
fi

BIN_URL="${BASE_URL}/${BINARY_NAME}"
SHA_URL="${BIN_URL}.sha256"

# ---------------------------------------------------------------------------
# Plan
# ---------------------------------------------------------------------------
log ""
log "${BOLD}Mandu CLI installer${RST}"
log "  ${DIM}repo${RST}        ${MANDU_REPO}"
log "  ${DIM}version${RST}     ${MANDU_VERSION}"
log "  ${DIM}platform${RST}    ${OS}/${ARCH}${LIBC_SUFFIX:+ (libc: musl)}"
log "  ${DIM}target${RST}      ${RUNNER_TARGET}"
log "  ${DIM}install dir${RST} ${MANDU_INSTALL_DIR}"
log "  ${DIM}binary url${RST}  ${BIN_URL}"
log ""

if [ "${DRY_RUN}" = "1" ]; then
  log "${YEL}[dry-run]${RST} stopping before download."
  exit 0
fi

# ---------------------------------------------------------------------------
# Download helpers
# ---------------------------------------------------------------------------
download() {
  # download <url> <dest>
  _url="$1"; _dst="$2"
  if [ "${FETCH}" = "curl" ]; then
    if [ "${VERBOSE}" = "1" ]; then
      curl -fL --retry 3 --retry-delay 2 -o "${_dst}" "${_url}"
    else
      curl -fsSL --retry 3 --retry-delay 2 -o "${_dst}" "${_url}"
    fi
  else
    wget -q -O "${_dst}" "${_url}"
  fi
}

# ---------------------------------------------------------------------------
# Temp workspace
# ---------------------------------------------------------------------------
TMPDIR="$(mktemp -d 2>/dev/null || mktemp -d -t 'mandu-install')"
trap 'rm -rf "${TMPDIR}"' EXIT INT TERM

# ---------------------------------------------------------------------------
# Download binary + checksum
# ---------------------------------------------------------------------------
log "Downloading ${BINARY_NAME}..."
if ! download "${BIN_URL}" "${TMPDIR}/${BINARY_NAME}"; then
  err "download failed: ${BIN_URL}"
  note "verify the release tag exists and that ${RUNNER_TARGET} is a published artifact"
  exit 3
fi

# Checksum is best-effort. If the sidecar is missing we warn loudly but
# continue — avoids hard-failing on earlier releases that pre-date the
# checksum-emitting workflow.
if [ -n "${HASH}" ]; then
  log "Downloading checksum..."
  if download "${SHA_URL}" "${TMPDIR}/${BINARY_NAME}.sha256" 2>/dev/null; then
    log "Verifying checksum..."
    # The .sha256 file is `<digest>  <filename>` in POSIX format. We only
    # compare the digest column to avoid path-mismatch false negatives.
    expected="$(awk '{print $1}' < "${TMPDIR}/${BINARY_NAME}.sha256")"
    actual="$(${HASH} "${TMPDIR}/${BINARY_NAME}" | awk '{print $1}')"
    if [ "${expected}" != "${actual}" ]; then
      err "checksum mismatch"
      note "expected: ${expected}"
      note "actual:   ${actual}"
      exit 4
    fi
    log "  ${GRN}OK${RST} ${actual}"
  else
    log "${YEL}warning${RST}: checksum sidecar not found; skipping verification"
  fi
else
  log "${YEL}warning${RST}: sha256 tool not available; skipping verification"
fi

# ---------------------------------------------------------------------------
# Install
# ---------------------------------------------------------------------------
mkdir -p "${MANDU_INSTALL_DIR}"
DEST="${MANDU_INSTALL_DIR}/mandu"

if [ -e "${DEST}" ] && [ -z "${MANDU_FORCE:-}" ]; then
  log "${YEL}warning${RST}: ${DEST} already exists — overwriting."
fi

mv -f "${TMPDIR}/${BINARY_NAME}" "${DEST}"
chmod +x "${DEST}"

log "${GRN}Installed${RST}: ${DEST}"

# ---------------------------------------------------------------------------
# PATH assistance
# ---------------------------------------------------------------------------
case ":${PATH:-}:" in
  *":${MANDU_INSTALL_DIR}:"*)
    log ""
    log "mandu is already on your PATH."
    ;;
  *)
    log ""
    log "Add this line to your shell profile to expose \`mandu\` globally:"
    log "  ${BOLD}export PATH=\"${MANDU_INSTALL_DIR}:\$PATH\"${RST}"

    if [ -z "${MANDU_NO_MODIFY_PATH:-}" ]; then
      for profile in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
        [ -f "${profile}" ] || continue
        if ! grep -q "${MANDU_INSTALL_DIR}" "${profile}" 2>/dev/null; then
          printf '\n# Added by Mandu installer\nexport PATH="%s:$PATH"\n' "${MANDU_INSTALL_DIR}" >> "${profile}"
          log "  -> appended PATH entry to ${profile}"
          break
        fi
      done
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Verify install
# ---------------------------------------------------------------------------
log ""
if "${DEST}" --version >/dev/null 2>&1; then
  v="$("${DEST}" --version 2>/dev/null | head -1)"
  log "${GRN}mandu ${v} is ready.${RST}"
  log "Try: ${BOLD}mandu init my-app${RST}"
else
  err "binary installed but failed to execute"
  note "try running it directly: ${DEST} --help"
  exit 1
fi
