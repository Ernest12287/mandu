/**
 * `@mandujs/core/deploy` — deploy intent primitive (issue #250 Phase 1).
 *
 * The barrel re-exports everything adapters and the CLI need:
 *
 *   - **Schemas**: `DeployIntent`, `DeployIntentCache`, runtime / cache /
 *     visibility / target enums, plus the partial `DeployIntentInput`
 *     used by the `.deploy()` builder call site.
 *   - **Cache I/O**: `loadDeployIntentCache`, `saveDeployIntentCache`,
 *     `emptyDeployIntentCache`, the cache file path constants.
 *   - **Inference**: the offline heuristic and the context builder. The
 *     brain inferer plugs in via `planDeploy({ infer: ... })`.
 *   - **Plan**: `planDeploy` returns the next cache + a diff in one
 *     pure call.
 *   - **Validation helpers**: `isStaticIntentValidFor` so adapters can
 *     surface configuration errors before deploy.
 */

export {
  DeployIntent,
  DeployIntentInput,
  DeployRuntime,
  DeployCache,
  DeployCacheLifetime,
  DeployVisibility,
  DeployTarget,
  isStaticIntentValidFor,
} from "./intent";

export {
  DeployIntentCache,
  DeployIntentCacheEntry,
  DeployIntentSource,
  DEPLOY_INTENT_CACHE_FILE,
  emptyDeployIntentCache,
  loadDeployIntentCache,
  saveDeployIntentCache,
  resolveDeployIntentCachePath,
} from "./cache";

export {
  buildDeployInferenceContext,
  classifyImports,
  extractImports,
  hashSource,
  type DependencyClass,
  type DeployInferenceContext,
} from "./inference/context";

export {
  inferDeployIntentHeuristic,
  type InferenceResult,
} from "./inference/heuristic";

export {
  planDeploy,
  planHasChanges,
  type PlanDeployOptions,
  type PlanDiffEntry,
  type PlanDiffEntryKind,
  type PlanResult,
} from "./plan";

export {
  compileVercelJson,
  renderVercelJsonFromCompile,
  VercelCompileError,
  type CompileVercelOptions,
  type VercelCompileResult,
  type VercelConfig,
  type VercelFunctionConfig,
  type VercelHeader,
} from "./compile/vercel";
