/**
 * Plan 18 P2-6 — Bundle inspector.
 *
 * Reads `.mandu/manifest.json` and adds disk-byte measurements per
 * route bundle / island bundle / shared chunk so the Kitchen UI (and
 * the supervisor context pack downstream) can answer "which island
 * weighs the most" without each consumer re-stat'ing the same files.
 *
 * The manifest itself describes WHAT was emitted; this layer adds HOW
 * MUCH. Stat failures are not fatal — a missing or torn file just
 * shows up as 0 bytes so the rest of the report still renders.
 */

import fs from "fs/promises";
import path from "path";
import type { BundleManifest } from "../../bundler/types";

export interface BundleSizeEntry {
  /** Public path declared by the manifest (e.g. /.mandu/client/home.js). */
  path: string;
  /** On-disk size in bytes; 0 when the file is missing or unreadable. */
  bytes: number;
}

export interface BundleRouteEntry extends BundleSizeEntry {
  routeId: string;
  priority: string;
  dependencies: string[];
  css?: string;
}

export interface BundleIslandEntry extends BundleSizeEntry {
  islandId: string;
  route: string;
  priority: string;
}

export interface BundleReport {
  /** False when `.mandu/manifest.json` is missing or malformed. */
  loaded: boolean;
  /** Reason the report could not be loaded; absent on success. */
  reason?: string;
  manifest?: {
    version: number;
    buildTime: string;
    env: "development" | "production";
  };
  shared?: {
    runtime: BundleSizeEntry;
    vendor: BundleSizeEntry;
    router?: BundleSizeEntry;
  };
  bundles: BundleRouteEntry[];
  islands: BundleIslandEntry[];
  totals: {
    totalBytes: number;
    sharedBytes: number;
    bundleBytes: number;
    islandBytes: number;
    bundleCount: number;
    islandCount: number;
    largestIsland?: { id: string; route: string; bytes: number };
    largestBundle?: { routeId: string; bytes: number };
  };
}

async function fileBytes(rootDir: string, urlPath: string | undefined): Promise<number> {
  if (!urlPath) return 0;
  const rel = urlPath.startsWith("/") ? urlPath.slice(1) : urlPath;
  try {
    const stat = await fs.stat(path.join(rootDir, rel));
    return stat.isFile() ? stat.size : 0;
  } catch {
    return 0;
  }
}

async function readManifest(rootDir: string): Promise<BundleManifest | null> {
  const manifestPath = path.join(rootDir, ".mandu", "manifest.json");
  try {
    const raw = await fs.readFile(manifestPath, "utf-8");
    return JSON.parse(raw) as BundleManifest;
  } catch {
    return null;
  }
}

export async function buildBundleReport(rootDir: string): Promise<BundleReport> {
  const manifest = await readManifest(rootDir);
  if (!manifest) {
    return {
      loaded: false,
      reason: ".mandu/manifest.json is missing or malformed. Run `mandu build`.",
      bundles: [],
      islands: [],
      totals: {
        totalBytes: 0,
        sharedBytes: 0,
        bundleBytes: 0,
        islandBytes: 0,
        bundleCount: 0,
        islandCount: 0,
      },
    };
  }

  const sharedRuntime: BundleSizeEntry = {
    path: manifest.shared?.runtime ?? "",
    bytes: await fileBytes(rootDir, manifest.shared?.runtime),
  };
  const sharedVendor: BundleSizeEntry = {
    path: manifest.shared?.vendor ?? "",
    bytes: await fileBytes(rootDir, manifest.shared?.vendor),
  };
  const sharedRouter: BundleSizeEntry | undefined = manifest.shared?.router
    ? { path: manifest.shared.router, bytes: await fileBytes(rootDir, manifest.shared.router) }
    : undefined;

  const bundleEntries: BundleRouteEntry[] = [];
  for (const [routeId, entry] of Object.entries(manifest.bundles ?? {})) {
    bundleEntries.push({
      routeId,
      path: entry.js,
      bytes: await fileBytes(rootDir, entry.js),
      priority: entry.priority,
      dependencies: entry.dependencies,
      css: entry.css,
    });
  }

  const islandEntries: BundleIslandEntry[] = [];
  for (const [islandId, entry] of Object.entries(manifest.islands ?? {})) {
    islandEntries.push({
      islandId,
      path: entry.js,
      bytes: await fileBytes(rootDir, entry.js),
      route: entry.route,
      priority: entry.priority,
    });
  }

  // Sort biggest-first — that's what the operator wants to see at the top.
  bundleEntries.sort((a, b) => b.bytes - a.bytes);
  islandEntries.sort((a, b) => b.bytes - a.bytes);

  const sharedBytes = sharedRuntime.bytes + sharedVendor.bytes + (sharedRouter?.bytes ?? 0);
  const bundleBytes = bundleEntries.reduce((sum, b) => sum + b.bytes, 0);
  const islandBytes = islandEntries.reduce((sum, b) => sum + b.bytes, 0);

  return {
    loaded: true,
    manifest: {
      version: manifest.version,
      buildTime: manifest.buildTime,
      env: manifest.env,
    },
    shared: {
      runtime: sharedRuntime,
      vendor: sharedVendor,
      router: sharedRouter,
    },
    bundles: bundleEntries,
    islands: islandEntries,
    totals: {
      totalBytes: sharedBytes + bundleBytes + islandBytes,
      sharedBytes,
      bundleBytes,
      islandBytes,
      bundleCount: bundleEntries.length,
      islandCount: islandEntries.length,
      largestIsland: islandEntries[0]
        ? { id: islandEntries[0].islandId, route: islandEntries[0].route, bytes: islandEntries[0].bytes }
        : undefined,
      largestBundle: bundleEntries[0]
        ? { routeId: bundleEntries[0].routeId, bytes: bundleEntries[0].bytes }
        : undefined,
    },
  };
}
