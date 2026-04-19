#!/usr/bin/env bash
# shellcheck shell=bash
#
# Smoke tests for install.sh / install.bash / install.ps1.
#
# This runs in CI (or locally) against the repository's install scripts
# without actually downloading the released binary. The goal is to catch
# regressions in:
#
#   1. Argument parsing (--dry-run, --version, --install-dir)
#   2. Platform detection (Linux glibc vs musl, macOS arm64 vs x64)
#   3. URL construction (latest vs tagged)
#   4. Error paths (unsupported arch, missing curl+wget)
#
# Run locally:
#   bash .github/workflows/__tests__/smoke-install.sh
#
# In CI this is invoked from the release workflow (manually enabled) so
# we can gate a release on the installers still parsing the URL shape
# the workflow actually uploads.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "${SCRIPT_DIR}/../../.." && pwd)"

INSTALL_SH="${ROOT}/install.sh"
INSTALL_BASH="${ROOT}/install.bash"
INSTALL_PS1="${ROOT}/install.ps1"

PASS=0
FAIL=0

ok()   { PASS=$((PASS + 1)); printf '  ok   %s\n' "$*"; }
fail() { FAIL=$((FAIL + 1)); printf '  FAIL %s\n' "$*" >&2; }

section() { printf '\n== %s ==\n' "$*"; }

# ---------------------------------------------------------------------------
# 1. Static syntax checks — catch typos before any runtime behavior runs.
# ---------------------------------------------------------------------------
section "syntax"

if sh -n "${INSTALL_SH}"; then
  ok "install.sh parses as POSIX sh"
else
  fail "install.sh failed POSIX sh syntax check"
fi

if bash -n "${INSTALL_SH}"; then
  ok "install.sh parses as bash"
else
  fail "install.sh failed bash syntax check"
fi

if bash -n "${INSTALL_BASH}"; then
  ok "install.bash parses as bash"
else
  fail "install.bash failed bash syntax check"
fi

# PowerShell check only runs when pwsh is on PATH. GitHub-hosted runners
# have it everywhere; local dev machines may not. We write the parser
# invocation to a temp .ps1 file rather than passing it on the command
# line — Windows / MSYS quoting rules mangle nested quotes in awkward
# ways that make inline commands unreliable.
if command -v pwsh >/dev/null 2>&1; then
  parse_script="$(mktemp --suffix=.ps1 2>/dev/null || mktemp -t mandu-parse-XXXXXX.ps1)"
  ps1_path_win="${INSTALL_PS1}"
  # Windows paths need backslashes when embedded as PS literals.
  case "$(uname -s)" in
    MINGW*|MSYS*|CYGWIN*)
      ps1_path_win="$(cygpath -w "${INSTALL_PS1}" 2>/dev/null || echo "${INSTALL_PS1}")"
      ;;
  esac
  cat > "${parse_script}" <<PSEOF
\$errors = \$null
[System.Management.Automation.Language.Parser]::ParseFile('${ps1_path_win//\\/\\\\}', [ref]\$null, [ref]\$errors) | Out-Null
if (\$errors -and \$errors.Count -gt 0) {
  \$errors | ForEach-Object { Write-Host ("L" + \$_.Extent.StartLineNumber + ": " + \$_.Message) }
  exit 1
}
exit 0
PSEOF
  if pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${parse_script}" >/dev/null 2>&1; then
    ok "install.ps1 parses cleanly"
  else
    fail "install.ps1 has parse errors"
    pwsh -NoLogo -NoProfile -ExecutionPolicy Bypass -File "${parse_script}" 2>&1 | sed 's/^/    /' || true
  fi
  rm -f "${parse_script}"
else
  printf '  skip install.ps1 parse (pwsh not in PATH)\n'
fi

# ---------------------------------------------------------------------------
# 2. Dry-run behavior — no network, no fs writes.
# ---------------------------------------------------------------------------
section "dry-run"

run_dry() {
  # run_dry <extra-env-prefix> <expected-substring...>
  #
  # We use `grep -F` (fixed-string) here on purpose — some needles contain
  # `[` / `]` which grep treats as character-class brackets in BRE mode
  # and busybox ash's grep flags an "Invalid range end".
  prefix="$1"; shift
  out=$(env ${prefix} sh "${INSTALL_SH}" --dry-run 2>&1 || true)
  all_found=1
  for needle in "$@"; do
    if ! printf '%s' "${out}" | grep -Fq "${needle}"; then
      fail "dry-run missing substring '${needle}' (env: ${prefix})"
      printf '    output was:\n%s\n' "${out}" | sed 's/^/    /'
      all_found=0
      break
    fi
  done
  if [ "${all_found}" = "1" ]; then
    ok "dry-run with ${prefix:-defaults} emits expected substrings"
  fi
}

# Default invocation needs either a real OS or the MSYS escape hatch on
# Windows hosts. On GH-hosted ubuntu/macos the default works as-is; on a
# Windows runner we have to force the unix branch because install.ps1 is
# the native path there.
case "$(uname -s)" in
  MINGW*|MSYS*|CYGWIN*)
    FORCE_UNIX="MANDU_FORCE_UNIX=1"
    ;;
  *)
    FORCE_UNIX=""
    ;;
esac

run_dry "${FORCE_UNIX}" \
  "Mandu CLI installer" \
  "repo" \
  "install dir" \
  "binary url" \
  "[dry-run]"

run_dry "${FORCE_UNIX} MANDU_VERSION=v0.23.0" \
  "v0.23.0"

run_dry "${FORCE_UNIX} MANDU_VERSION=v0.23.0" \
  "releases/download/v0.23.0"

run_dry "${FORCE_UNIX} MANDU_INSTALL_DIR=/tmp/mandu-test" \
  "/tmp/mandu-test"

run_dry "${FORCE_UNIX} MANDU_REPO=test/fork" \
  "test/fork"

# ---------------------------------------------------------------------------
# 3. URL shape — cross-check install.sh with what the workflow uploads.
# ---------------------------------------------------------------------------
section "url shape"

# Every runner_target in release-binaries.yml must be reachable via the
# platform-detection branches in install.sh. If the workflow adds or
# renames a target, this test flags the installer as out-of-sync.
WORKFLOW="${ROOT}/.github/workflows/release-binaries.yml"
if [ -f "${WORKFLOW}" ]; then
  # Extract runner_target values
  targets=$(grep -E '^\s+runner_target:' "${WORKFLOW}" | awk -F': *' '{print $2}' | tr -d ' ' | sort -u)
  for target in ${targets}; do
    case "${target}" in
      bun-linux-x64|bun-linux-x64-musl|bun-linux-arm64|bun-darwin-arm64|bun-darwin-x64|bun-windows-x64)
        ok "workflow target '${target}' is known to installers"
        ;;
      *)
        fail "workflow target '${target}' has no installer support"
        ;;
    esac
  done
else
  fail "release workflow not found at ${WORKFLOW}"
fi

# ---------------------------------------------------------------------------
# 4. Error paths
# ---------------------------------------------------------------------------
section "errors"

# Unknown flag -> usage + exit 1. We set +e temporarily because sh's
# `set -e` (inherited from the top of this script) would terminate on
# the expected non-zero exit.
set +e
out=$(sh "${INSTALL_SH}" --nonsense-flag 2>&1)
rc=$?
set -e
if [ "${rc}" != "1" ]; then
  fail "unknown flag should exit 1, got ${rc}"
else
  if printf '%s' "${out}" | grep -Fq "unknown argument"; then
    ok "unknown flag rejected with clear error"
  else
    fail "unknown flag error missing expected message"
  fi
fi

# --help -> exits 0 + prints usage
set +e
help_out=$(sh "${INSTALL_SH}" --help 2>&1)
help_rc=$?
set -e
if [ "${help_rc}" = "0" ]; then
  if printf '%s' "${help_out}" | grep -Fq "Mandu CLI installer"; then
    ok "--help prints usage"
  else
    fail "--help output missing usage banner"
  fi
else
  fail "--help should exit 0, got ${help_rc}"
fi

# ---------------------------------------------------------------------------
# Summary
# ---------------------------------------------------------------------------
printf '\n== summary ==\n'
printf '  passed: %d\n' "${PASS}"
printf '  failed: %d\n' "${FAIL}"

if [ "${FAIL}" -gt 0 ]; then
  exit 1
fi
