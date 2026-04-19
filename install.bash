#!/usr/bin/env bash
#
# Mandu CLI installer — bash variant.
#
# This is the explicit-bash entry point for users on Git Bash (Windows),
# Cygwin, WSL, or any environment where `sh` doesn't resolve to a POSIX
# shell. For native Linux/macOS `curl | sh`, prefer install.sh.
#
# The two scripts share a single source of truth: install.bash is a thin
# wrapper that re-executes install.sh with bash rather than duplicating
# logic. If you're reading this to learn what the installer does, open
# install.sh.
#
# Usage:
#   bash install.bash [--version <tag>] [--dry-run] [...]
#   curl -fsSL https://raw.githubusercontent.com/konamgil/mandu/main/install.bash | bash
#
# All flags and environment variables documented in install.sh are honored
# verbatim (MANDU_VERSION, MANDU_INSTALL_DIR, MANDU_REPO, MANDU_FORCE,
# MANDU_NO_MODIFY_PATH).

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
POSIX_SCRIPT="${SCRIPT_DIR}/install.sh"

# ---------------------------------------------------------------------------
# Git Bash / MSYS / Cygwin translation
#
# install.sh refuses MSYS/Cygwin on purpose (those environments should use
# install.ps1 for native Windows installs). But some users deliberately
# invoke this from Git Bash to install into a WSL/GNU toolchain — honor
# that by forcing a Linux identity when MANDU_FORCE_UNIX=1.
# ---------------------------------------------------------------------------
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    if [[ "${MANDU_FORCE_UNIX:-0}" != "1" ]]; then
      cat <<'EOF' >&2
error: Git Bash / MSYS / Cygwin detected.

For native Windows installs run install.ps1 from PowerShell:

  iwr https://raw.githubusercontent.com/konamgil/mandu/main/install.ps1 -useb | iex

If you're intentionally installing a unix-target binary into a WSL or
Cygwin toolchain, re-run with MANDU_FORCE_UNIX=1:

  MANDU_FORCE_UNIX=1 bash install.bash --version latest

EOF
      exit 2
    fi
    ;;
esac

# ---------------------------------------------------------------------------
# Locate the POSIX script. Two deployment shapes:
#
#   1. Local checkout — install.sh sits beside install.bash.
#   2. Piped from curl — install.sh doesn't exist on disk. Fetch it from
#      the raw GitHub URL using the same repo/version conventions as
#      install.sh itself.
# ---------------------------------------------------------------------------
if [[ ! -f "${POSIX_SCRIPT}" ]]; then
  MANDU_REPO="${MANDU_REPO:-konamgil/mandu}"
  RAW_URL="https://raw.githubusercontent.com/${MANDU_REPO}/main/install.sh"
  TMP_POSIX="$(mktemp 2>/dev/null || mktemp -t mandu-install.sh)"
  trap 'rm -f "${TMP_POSIX}"' EXIT INT TERM
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 -o "${TMP_POSIX}" "${RAW_URL}"
  elif command -v wget >/dev/null 2>&1; then
    wget -q -O "${TMP_POSIX}" "${RAW_URL}"
  else
    echo "error: neither curl nor wget available; cannot fetch install.sh" >&2
    exit 3
  fi
  POSIX_SCRIPT="${TMP_POSIX}"
fi

# ---------------------------------------------------------------------------
# Delegate
# ---------------------------------------------------------------------------
# We invoke with `bash` explicitly rather than relying on the install.sh
# shebang — some Git Bash setups shadow /bin/sh with a broken wrapper.
exec bash "${POSIX_SCRIPT}" "$@"
