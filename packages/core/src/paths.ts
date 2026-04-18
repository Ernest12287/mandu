import path from "path";

/**
 * 프레임워크가 생성하는 파일들의 경로 구조
 * apps/ 하드코딩 대신 .mandu/ 기반 중앙 관리
 */
export interface GeneratedPaths {
  /** 서버 라우트 핸들러 디렉토리 */
  serverRoutesDir: string;
  /** 웹 라우트 컴포넌트 디렉토리 */
  webRoutesDir: string;
  /** 타입 글루 디렉토리 */
  typesDir: string;
  /** 생성 맵 디렉토리 */
  mapDir: string;
  /** 생성된 매니페스트 경로 */
  manifestPath: string;
  /** Resource 관련 경로 */
  resourceContractsDir: string;
  resourceTypesDir: string;
  resourceSlotsDir: string;
  resourceClientDir: string;
  /** User-authored resource schema files (spec/resources). */
  resourceSchemasDir: string;
  /**
   * Phase 4c — Generated per-resource repo modules
   * (`.mandu/generated/server/repos/{name}.repo.ts`). DERIVED; regenerated
   * on every build when the resource declares `options.persistence`.
   */
  resourceReposDir: string;
  /**
   * Phase 4c — Per-resource CREATE TABLE DDL snapshots for humans
   * (`.mandu/generated/server/schema/{table}.sql`). DERIVED; not applied
   * by the migration runner — applied migrations live in `migrationsDir`.
   */
  resourceSchemaOutDir: string;
  /**
   * Phase 4c — Schema state directory (`.mandu/schema`). Holds
   * `applied.json` (owned by the migration runner after successful apply).
   * The Phase 4c generator only READS from here — never writes.
   */
  schemaStateDir: string;
  /**
   * Phase 4c — User-visible migration files directory
   * (`spec/db/migrations`). `mandu db plan` writes `NNNN_auto_*.sql`
   * here, the runner reads it on `mandu db apply`.
   */
  migrationsDir: string;
}

/**
 * 프로젝트 루트에서 생성 경로를 결정
 */
export function resolveGeneratedPaths(rootDir: string): GeneratedPaths {
  return {
    serverRoutesDir: path.join(rootDir, ".mandu/generated/server/routes"),
    webRoutesDir: path.join(rootDir, ".mandu/generated/web/routes"),
    typesDir: path.join(rootDir, ".mandu/generated/server/types"),
    mapDir: path.join(rootDir, ".mandu/generated"),
    manifestPath: path.join(rootDir, ".mandu/routes.manifest.json"),
    resourceContractsDir: path.join(rootDir, ".mandu/generated/server/contracts"),
    resourceTypesDir: path.join(rootDir, ".mandu/generated/server/types"),
    resourceSlotsDir: path.join(rootDir, "spec/slots"),
    resourceClientDir: path.join(rootDir, ".mandu/generated/client"),
    resourceSchemasDir: path.join(rootDir, "spec/resources"),
    resourceReposDir: path.join(rootDir, ".mandu/generated/server/repos"),
    resourceSchemaOutDir: path.join(rootDir, ".mandu/generated/server/schema"),
    schemaStateDir: path.join(rootDir, ".mandu/schema"),
    migrationsDir: path.join(rootDir, "spec/db/migrations"),
  };
}

/**
 * 생성된 파일의 상대 경로 (generatedMap.files 키 등에 사용)
 */
export const GENERATED_RELATIVE_PATHS = {
  serverRoutes: ".mandu/generated/server/routes",
  webRoutes: ".mandu/generated/web/routes",
  types: ".mandu/generated/server/types",
  map: ".mandu/generated",
  manifest: ".mandu/routes.manifest.json",
  history: ".mandu/history",
  contracts: ".mandu/generated/server/contracts",
  resourceTypes: ".mandu/generated/server/types",
  slots: "spec/slots",
  client: ".mandu/generated/client",
  resourceSchemas: "spec/resources",
  /** Phase 4c — repo emission target. */
  resourceRepos: ".mandu/generated/server/repos",
  /** Phase 4c — per-resource CREATE TABLE snapshots (documentation). */
  resourceSchemaOut: ".mandu/generated/server/schema",
  /** Phase 4c — applied.json lives here (runner-owned). */
  schemaState: ".mandu/schema",
  /** Phase 4c — user-visible migrations directory. */
  migrations: "spec/db/migrations",
} as const;
