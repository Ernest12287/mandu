/**
 * Builtin adapter registry.
 *
 * Returns a fresh {@link DeployAdapterRegistry} populated with Mandu's
 * bundled adapters. Tests construct isolated registries to inject mocks
 * without mutating shared state; the CLI dispatcher uses the default.
 *
 * @module cli/commands/deploy/adapters
 */
import { DeployAdapterRegistry } from "../types";
import { dockerAdapter } from "./docker";
import { flyAdapter } from "./fly";
import { vercelAdapter } from "./vercel";
import { railwayAdapter } from "./railway";
import { netlifyAdapter } from "./netlify";
import { cfPagesAdapter } from "./cf-pages";
import { dockerComposeAdapter } from "./docker-compose";

export { dockerAdapter, renderDockerfile } from "./docker";
export { flyAdapter, createFlyAdapter, renderFlyToml } from "./fly";
export {
  vercelAdapter,
  createVercelAdapter,
  renderVercelJson,
  renderVercelFunctionEntry,
} from "./vercel";
export {
  railwayAdapter,
  createRailwayAdapter,
  renderRailwayJson,
  renderNixpacksToml,
} from "./railway";
export {
  netlifyAdapter,
  createNetlifyAdapter,
  renderNetlifyToml,
  renderNetlifySsrFunction,
} from "./netlify";
export {
  cfPagesAdapter,
  createCfPagesAdapter,
  renderCfPagesWrangler,
  renderCfPagesMiddleware,
} from "./cf-pages";
export {
  dockerComposeAdapter,
  renderDockerCompose,
  renderEnvExample,
} from "./docker-compose";

/**
 * Build a registry pre-populated with the seven builtin adapters.
 * Callers MUST NOT hold on to the returned instance between invocations
 * of `mandu deploy` — the adapter graph is cheap to recreate and making
 * it per-invocation lets tests mutate freely.
 */
export function createBuiltinRegistry(): DeployAdapterRegistry {
  const registry = new DeployAdapterRegistry();
  registry.register(dockerAdapter);
  registry.register(dockerComposeAdapter);
  registry.register(flyAdapter);
  registry.register(vercelAdapter);
  registry.register(railwayAdapter);
  registry.register(netlifyAdapter);
  registry.register(cfPagesAdapter);
  return registry;
}
