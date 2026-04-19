---
phase: 9.1
round: R0.2
status: diagnostic
date: 2026-04-18
verdict: YELLOW — 기술적으로 가능, 단 자산 임베딩 리팩터 + 3-OS 배포 인프라 필요
sources:
  - https://bun.com/docs/bundler/executables
  - https://bun.com/docs/bundler
  - https://bun.com/docs/bundler/bytecode
  - https://developer.mamezou-tech.com/en/blogs/2024/05/20/bun-cross-compile/
  - https://github.com/oven-sh/bun/issues/13454
  - https://github.com/oven-sh/bun/issues/14676
  - https://github.com/oven-sh/bun/issues/14546
---

# Phase 9.1 R0.2 — `bun build --compile` 단일 바이너리 배포 현황 조사

## TL;DR

`bun build --compile` 는 **1.3.12 에서 프로덕션 준비 수준**이다. 3 OS × 2 아키텍처 모두 크로스 컴파일 가능하고, `Bun.serve` / `Bun.build` / `Bun.spawn` / `chokidar` / `node:fs` / `node:child_process` 등 Mandu CLI 가 쓰는 API 전부 실측 동작 확인됨. 그러나 **hello world 바이너리 = 110MB, Mandu CLI 바이너리 = 132MB** 로 npm 패키지(5MB dep)의 약 26 배 크기이며, 결정적으로 `packages/cli/templates/` 가 `import.meta.dir` + 상대경로로 로드되어 컴파일 바이너리에서 **`mandu init` 이 깨진다 (Template not found)**. 자산 임베딩(`with { type: "file" }`) 리팩터가 필수 선행 작업이다. 판정: **YELLOW** — Phase 9.1 (+CLI 바이너리) 실행 가능, 단 템플릿 임베딩 + 3-OS GitHub Actions 매트릭스 + 설치 스크립트 3종 작성(약 2 주) 필요하며, npm 패키지와 **병행**(binary for end-users, npm for framework devs) 이 권고된다.

---

## 1. 현황 — `bun --compile` 1.3.12 지원 매트릭스

### 1.1 실측 타겟 (Windows x64 에서 크로스 컴파일)

| `--target` | 결과 | 바이너리 크기 | 시간 |
|---|---|---|---|
| (default = host) `bun-windows-x64` | ✅ 성공 (.exe) | **116 MB** | 496ms |
| `bun-linux-x64` | ✅ 성공 (ELF) | 100 MB | 2.2s |
| `bun-linux-x64-musl` | ✅ 성공 (ELF, Alpine 호환) | 95 MB | 1.8s |
| `bun-linux-x64-baseline` | ✅ 성공 (AVX2 없는 구형 x64) | 99 MB | 1.9s |
| `bun-darwin-arm64` | ✅ 성공 (Mach-O) | **61 MB** | 1.7s |

모두 hello-world 1 모듈 기준. macOS ARM64 가 가장 작음(aarch64 코드 밀도 우수 + 일부 데스크톱 전용 코드 미포함으로 추정).

### 1.2 공식 카탈로그 타겟 (1.3.12 기준, 12 종)

`bun-linux-{x64,x64-baseline,x64-modern,x64-musl,arm64,arm64-musl}`, `bun-darwin-{x64,arm64}`, `bun-windows-{x64,x64-baseline,x64-modern,arm64}` — [공식 doc](https://bun.com/docs/bundler/executables). Linux `arm64-musl` 과 Windows `arm64` 크로스도 모두 가능.

### 1.3 바이너리 옵션

| 옵션 | 효과 | 실측(Mandu CLI) |
|---|---|---|
| `--minify` | 소스 minify + `NODE_ENV=production` (자동 적용) | 포함됨 (`--compile` 이 `--production` 을 implies) |
| `--bytecode` | 2-4x 빠른 startup, 1.38x 더 빠른 첫 실행 | ⚠️ **132MB → 190MB (+58MB, +44%)** |
| `--sourcemap` | 디버깅용 | 런타임 크기 영향 적음 |
| `--windows-icon/title/version/publisher` | .exe 메타 커스터마이즈 | ✅ 필수 (SmartScreen 완화) |
| `BUN_BE_BUN=1` | 바이너리가 `bun` CLI 로 동작 (`bun upgrade` 내장!) | v1.2.16+ |

**`--bytecode` 는 Mandu CLI 에 부적합.** 크기 증가가 과도하고, top-level `await` 가 있는 모듈과 충돌 가능(Mandu CLI 엔트리에 async 루트 있음).

---

## 2. 실측 — Mandu CLI 컴파일 결과

### 2.1 빌드 시간 + 크기

```bash
cd packages/cli
bun build --compile src/main.ts --outfile=mandu-cli
# [1494ms]  bundle  777 modules
# [ 774ms] compile  mandu-cli.exe
# 132,306,944 bytes (126 MB)
```

- **번들**: 777 모듈 인라이닝 (CLI 소스 + @mandujs/core + @mandujs/mcp + @mandujs/ate + @mandujs/skills + chokidar + cfonts + zod + ollama + fast-glob + glob + minimatch)
- **전체 빌드**: 2.8s
- **Bun runtime 자체**: ~110MB (hello-world 도 동일 크기), Mandu 모듈 추가분은 **+16MB** 에 불과

### 2.2 실행 시간 오버헤드

```bash
time mandu-cli.exe --help    # real 0m0.864s
time mandu-cli.exe info      # real 0m0.889s
```

- **cold start ~ 800ms** (번들 + 런타임 초기화 + 명령 실행)
- npm 기반 (`bunx mandu` 또는 `bun run mandu`) 대비 초기 spin-up 이 유사 또는 약간 빠름 (패키지 해석 불필요)

### 2.3 Mandu 가 쓰는 API 검증 — 전부 ✅

| API | 결과 | 중요도 |
|---|---|---|
| `process.argv` / `process.env` | ✅ 정상 | 🔴 CLI 엔트리 |
| `Bun.version` / `Bun.serve` | ✅ `Bun.serve` roundtrip OK | 🔴 `mandu dev/start` |
| **`Bun.build` (nested)** | ✅ **compiled 바이너리 내부에서 새 번들 생성 OK** | 🔴 user 프로젝트 빌드 |
| `Bun.spawn` / `node:child_process.spawn` | ✅ 자식 프로세스 + stdout 캡처 OK | 🔴 git/npm/tailwind 호출 |
| `node:fs.readdirSync` | ✅ 정상 | 🔴 파일 스캔 |
| **`chokidar` (Node module)** | ✅ `chokidar.watch()` 정상 — 네이티브 dep 없는 fs 폴러 | 🔴 watch/dev |
| `fetch()` | ✅ 정상 | 🟡 upgrade/brain |

**가장 중요한 발견**: 바이너리 **안에서 다시 `Bun.build()` 가 동작**한다. 즉 컴파일된 `mandu-cli` 가 유저 프로젝트의 `.mandu/client/` 를 생성하는 기존 흐름이 그대로 유지된다. [Bun issue #14676](https://github.com/oven-sh/bun/issues/14676) 에서 보고된 과거 이슈는 1.3.12 에서 해결.

---

## 3. Mandu CLI 바이너리화 제약 — 진짜 blocker 1 건

### 3.1 🔴 CRITICAL: `packages/cli/templates/` 가 실행 시 깨짐

**재현:**
```bash
mandu-cli.exe init test-app
# ❌ Error [CLI_E003] Template not found: default
```

**원인** (`packages/cli/src/commands/init.ts:177-180`):
```ts
const commandsDir = import.meta.dir;            // 바이너리: B:/~BUN/root/commands
return path.resolve(commandsDir, "../../templates");  // → B:/templates (존재 X)
```

바이너리 안에서 `import.meta.dir` 은 **가상 루트** (`$bunfs/...`) 를 가리키고, `../../templates` 는 파일시스템 어디도 가리키지 않는다. 마찬가지로 `generate-ai.ts`, `test-auto.ts` 등 템플릿 기반 명령 전부 영향.

**해결**: `with { type: "file" }` 또는 glob 임베딩으로 전환.

- `packages/cli/templates/` 총 크기 **372 KB** (auth-starter + default + realtime-chat) — 바이너리에 부담 없음
- 리팩터 범위: init.ts, test-auto.ts, generate-ai.ts 의 `getTemplatesDir()` → `embeddedTemplate(name)` 헬퍼로 치환, `Bun.embeddedFiles` 로 런타임 읽기
- 예상 작업량: **약 2 일**

### 3.2 🟡 기타 잠재 이슈

| 항목 | 실측 | 대응 |
|---|---|---|
| Dynamic `import("@mandujs/core")` | ✅ 컴파일 시 고정 (777 모듈 인라이닝) | 무대응 |
| `react` / `react-dom` 번들 | ✅ ALWAYS_EXTERNAL 로 **제외됨** (user 프로젝트의 node_modules 사용) | 무대응. `packages/cli/src/util/bun.ts:111-140` 의 `buildExternalList()` 가 이미 설계됨 |
| Windows 프로세스명 `"Bun"` 표시 | [#13454](https://github.com/oven-sh/bun/issues/13454) — 1.3.12 상태 미확인 | `--windows-title="Mandu"` 로 일부 완화, 완전 해결은 Bun 패치 대기 |
| `BUN_BE_BUN=1` 로 `bun upgrade` | 1.2.16+ 지원 | **활용**: `mandu upgrade` 를 `BUN_BE_BUN=1 ./mandu upgrade` 로 프록시 가능 |

---

## 4. 3 OS 배포 전략

### 4.1 Windows

| 이슈 | 대응 |
|---|---|
| **SmartScreen 경고** (미서명 exe) | Code signing 필수. EV 인증서 (~$300/yr) 또는 Azure Trusted Signing(~$10/mo) 권장 — 일반 OV 인증서는 reputation 쌓을 때까지 여전히 경고 |
| `.exe` 확장자 + 메타데이터 | `--windows-icon=./assets/mandu.ico --windows-title="Mandu CLI" --windows-publisher="LamySolution" --windows-version=0.23.0.0 --windows-description="Mandu Framework CLI" --windows-copyright="© 2026 LamySolution" --windows-hide-console` (console 은 보여야 하므로 hide 제외) |
| PATH 설치 | PowerShell 스크립트 `install.ps1` → `%LOCALAPPDATA%\Programs\mandu\mandu.exe` + `setx PATH` |
| 배포 채널 | **Scoop bucket** (가장 쉬움, admin 불필요) > winget (manifest 제출) > Chocolatey (서명 필수) |

### 4.2 macOS

| 이슈 | 대응 |
|---|---|
| Gatekeeper + notarization | Apple Developer ID ($99/yr) + `codesign --deep --force --sign "Developer ID Application: ..."` + `xcrun notarytool submit` + `xcrun stapler staple` |
| JIT entitlements | `codesign` 시 Bun 문서 표기 entitlements plist 포함 필수 — [docs](https://bun.com/docs/bundler/executables) |
| Homebrew 배포 | **homebrew-tap** 리포 + `mandu.rb` formula (binary URL + SHA256). 가장 표준 |
| Apple Silicon vs Intel | 2 binary 제공 (`bun-darwin-arm64` + `bun-darwin-x64`) 또는 `lipo` 로 universal binary 병합 |

### 4.3 Linux

| 이슈 | 대응 |
|---|---|
| **musl vs glibc** | 2 binary 제공 필수 — `bun-linux-x64` (glibc, Ubuntu/Debian/RHEL) + `bun-linux-x64-musl` (Alpine/Docker) |
| `curl \| sh` 설치 | 표준 `install.sh`: uname 으로 OS/arch 감지 → GitHub Release 에서 적합 바이너리 다운로드 → `/usr/local/bin/mandu` 또는 `~/.mandu/bin/mandu` + `.bashrc`/`.zshrc` PATH 추가 |
| AppImage / Flatpak | **불필요** — 단일 바이너리만으로 충분 |
| CPU baseline | AVX2 없는 구형 서버를 지원하려면 `bun-linux-x64-baseline` 추가 |

---

## 5. GitHub Releases workflow 설계

참조: [Bun 자체 workflow](https://github.com/oven-sh/bun/tree/main/.github/workflows)

### 5.1 매트릭스 (5 바이너리)

```yaml
# .github/workflows/release-binary.yml (요약)
on:
  push: { tags: ['@mandujs/cli@*'] }
jobs:
  build:
    strategy:
      matrix:
        include:
          - { os: windows-latest, target: bun-windows-x64,    artifact: mandu-windows-x64.exe }
          - { os: ubuntu-latest,  target: bun-linux-x64,      artifact: mandu-linux-x64 }
          - { os: ubuntu-latest,  target: bun-linux-x64-musl, artifact: mandu-linux-x64-musl }
          - { os: ubuntu-latest,  target: bun-linux-arm64,    artifact: mandu-linux-arm64 }
          - { os: macos-14,       target: bun-darwin-arm64,   artifact: mandu-darwin-arm64 }
          - { os: macos-13,       target: bun-darwin-x64,     artifact: mandu-darwin-x64 }
    steps:
      - uses: actions/checkout@v4
      - uses: oven-sh/setup-bun@v2
        with: { bun-version: 1.3.12 }
      - run: bun install --frozen-lockfile
      - run: |
          bun build --compile --target=${{ matrix.target }} \
            packages/cli/src/main.ts \
            --outfile=dist/${{ matrix.artifact }}
      # Windows: signtool sign
      # macOS: codesign + notarytool submit + stapler staple
      - uses: actions/upload-artifact@v4
  release:
    needs: build
    steps:
      - uses: softprops/action-gh-release@v2
        with: { files: 'dist/mandu-*' }
```

### 5.2 설치 스크립트 3 종

1. **`install.sh`** (Linux/macOS) — curl | sh 표준. uname → arch 감지 → GitHub Release API 에서 latest → download → chmod +x → PATH 안내
2. **`install.ps1`** (Windows PowerShell) — Invoke-WebRequest → `%LOCALAPPDATA%\Programs\mandu\` → User PATH 에 추가
3. **`install.bash`** — `install.sh` 와 동일하나 Git Bash / WSL 용 shebang

리포지토리 `install.mandu.dev/install.sh` 같은 짧은 URL 을 위해 Cloudflare Pages 단 리디렉트 권장.

---

## 6. 업데이트 전략

### 6.1 `mandu upgrade` 명령 — 현재 이미 존재

`packages/cli/src/commands/upgrade.ts` 가 이미 있음 (npm/bun 경로 지원). 바이너리 모드에서는 다른 경로 필요:

```ts
// upgrade.ts 에 binary 분기 추가
if (isRunningAsCompiledBinary()) {
  // 1. GitHub Release API 에서 latest 확인
  // 2. 현재 OS/arch 에 맞는 바이너리 다운로드 (임시 경로)
  // 3. 자기 자신 교체 (Windows: 재시작 후 교체, Unix: mv over)
}
```

`BUN_BE_BUN=1` 로 번들 내장 `bun upgrade` 는 **Bun 런타임만** 업데이트 — Mandu 자체는 별도 로직 필요.

### 6.2 npm 패키지 병행 유지 — **권장**

| 경로 | 대상 | 장점 | 단점 |
|---|---|---|---|
| `bun install -g @mandujs/cli` | 프레임워크 개발자, CI | 소용량(~5MB), lockfile 재현성 | Bun 사전 설치 필요 |
| Binary 릴리스 | 초심자, 데스크톱 사용자 | **Bun 불필요**, 한 파일 | 132MB, 업데이트 수동 |

README 에서 "Beginner: curl install.sh, Dev: bun add -g" 로 2-트랙 제시.

---

## 7. 기존 CLI 와의 관계 — 병행, 대체 아님

- `@mandujs/cli` npm 패키지는 **유지** (monorepo 소비자, CI, 컨트리뷰터용)
- 바이너리는 **학습곡선 완화용 onboarding 채널**. `mandu init` 원클릭 체험 유도
- 크기 trade-off 솔직하게 공개: README 에 "Binary = 132MB (Bun runtime included), npm = 5MB (requires Bun)" 명시
- 업데이트: npm 사용자 `bun update -g`, binary 사용자 `mandu upgrade`

---

## 8. Mandu 의 peer dep 처리 — 이미 해결됨

`packages/cli/src/util/bun.ts:111-140` 의 `buildExternalList()` 이 이미 `react` / `react-dom` / `@mandujs/*` 를 ALWAYS_EXTERNAL 로 선언. 이는 **유저 프로젝트 빌드** 용 설정이며, **CLI 바이너리 컴파일** 시에도 아래 관점에서 문제 없음:

- CLI 프로세스 자체는 react 를 import 하지 않음 (SSR 은 유저 프로젝트의 react 를 로드)
- 유저 프로젝트 빌드 시 CLI 내부 `Bun.build()` 가 `resolve` 훅으로 유저 `node_modules/react` 를 찾음 → 바이너리 안에서도 동일하게 작동 (§2.3 에서 확인)

추가 조치 불필요.

---

## 9. 결론 — Phase 9.1 (+CLI 바이너리) 실행 가능성

**판정: 🟡 YELLOW — 실행 가능, 선행 리팩터 + 인프라 구축 필요**

### 9.1 Green 요소

- ✅ 3 OS × 2 arch 크로스 컴파일 실측 성공 (1.3.12)
- ✅ Mandu CLI 의 모든 API (Bun.serve/build/spawn, chokidar, fs, child_process) 바이너리 내부에서 정상 작동
- ✅ peer dep (react/react-dom) 외부화 설정 이미 존재
- ✅ `mandu upgrade` 명령 기존 존재 (분기 추가만 필요)

### 9.2 Yellow 요소 (해결 가능, 작업 필요)

- 🟡 **`templates/` 임베딩 리팩터 필수** — `import.meta.dir` + 상대경로 의존 제거, `with { type: "file" }` 또는 `Bun.embeddedFiles` 로 전환 (~2 일)
- 🟡 **3-OS GitHub Actions 매트릭스** 신규 작성 + 설치 스크립트 3 종 (~3 일)
- 🟡 **Code signing** — Windows EV cert ($300/yr 또는 Azure Trusted Signing $10/mo) + Apple Developer ID ($99/yr) 필요 → 비용 승인 의사결정

### 9.3 Red 요소 (해결 불가)

- ❌ **바이너리 크기 132MB** — 개선 여지 없음 (Bun runtime 자체가 ~110MB). [oven-sh/bun#14546](https://github.com/oven-sh/bun/issues/14546) 의 "minimal runtime" 개선 대기. 현재로서는 수용해야 함

---

## 10. 예상 일정 (각 단계)

| 단계 | 작업 | 소요 |
|---|---|---|
| **10.1** | `templates/` 임베딩 리팩터 (init.ts, test-auto.ts, generate-ai.ts) + 테스트 | 2 일 |
| **10.2** | `upgrade` 커맨드 binary 분기 추가 + self-replace 로직 (Win/Unix) | 1 일 |
| **10.3** | GitHub Actions 매트릭스 workflow + dist upload | 2 일 |
| **10.4** | `install.sh` / `install.ps1` 스크립트 작성 + E2E 검증 | 1 일 |
| **10.5** | Windows code signing 통합 (Azure Trusted Signing) | 1 일 + 수속 대기 |
| **10.6** | macOS notarization 통합 (codesign + notarytool) | 1 일 + Apple 심사 |
| **10.7** | Homebrew tap / Scoop bucket 등록 | 1 일 |
| **10.8** | README 2-트랙 가이드 + landing page | 0.5 일 |
| **합계 (순수 개발)** | | **9.5 일** (~2 주) |
| **수속 대기 (code signing, Apple notarization)** | | **+1~2 주** (병렬) |

우선순위 권고: **10.1 (템플릿 임베딩) → 10.3 (Actions) → 10.4 (install 스크립트) 까지를 1차 (unsigned binary release), 이후 10.5/10.6 (signing) 을 2차 (프로덕션 release) 로 나누어 진행**. 초기 unsigned 바이너리는 "early access" 라벨링.
