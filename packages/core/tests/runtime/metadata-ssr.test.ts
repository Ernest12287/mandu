/**
 * #186: Metadata API end-to-end tests
 *
 * page/layout 모듈의 `export const metadata` + `generateMetadata`가
 * 해석되어 SSR `<head>` 로 주입되는 전체 파이프라인을 검증한다.
 */
import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import React from "react";
import {
  startServer,
  createServerRegistry,
  clearDefaultRegistry,
  type ManduServer,
  type ServerRegistry,
} from "../../src/runtime/server";
import type { RoutesManifest } from "../../src/spec/schema";
import {
  resolveMetadata,
  renderMetadata,
  renderTitle,
  type Metadata,
} from "../../src/seo";

// ---------------------------------------------------------------------------
// 1. Unit: resolveMetadata + renderMetadata (SEO 모듈 자체 sanity check)
// ---------------------------------------------------------------------------

describe("SEO resolve + render pipeline", () => {
  it("merges layout → page metadata with child override", async () => {
    const layoutMeta: Metadata = {
      title: { default: "Site", template: "%s | Site" },
      description: "Layout description",
      openGraph: { siteName: "Site", type: "website" },
    };
    const pageMeta: Metadata = {
      title: "Home",
      description: "Home page",
    };
    const resolved = await resolveMetadata([layoutMeta, pageMeta], {}, {});
    const titleHtml = renderTitle(resolved);
    expect(titleHtml).toContain("Home | Site");
    const head = renderMetadata(resolved);
    expect(head).toContain('name="description"');
    expect(head).toContain("Home page");
    expect(head).toContain("og:site_name");
  });

  it("runs generateMetadata with params", async () => {
    const pageMeta = async ({ params }: { params: Record<string, string> }) => ({
      title: `Post ${params.slug}`,
      description: `Dynamic post body`,
    });
    const resolved = await resolveMetadata([pageMeta], { slug: "hello" }, {});
    const titleHtml = renderTitle(resolved);
    expect(titleHtml).toContain("Post hello");
  });

  it("handles empty input", async () => {
    const resolved = await resolveMetadata([], {}, {});
    const head = renderMetadata(resolved);
    expect(typeof head).toBe("string");
  });
});

// ---------------------------------------------------------------------------
// 2. Integration: page metadata flows into SSR HTML <head>
// ---------------------------------------------------------------------------

function MinimalPage() {
  return React.createElement("main", null, "page body");
}

function MinimalLayout({ children }: { children: React.ReactNode }) {
  return React.createElement("div", { className: "layout" }, children);
}

function buildStaticManifest(): RoutesManifest {
  return {
    version: 1,
    routes: [
      {
        id: "home",
        pattern: "/",
        kind: "page",
        componentModule: "app/page.tsx",
        layoutChain: ["app/layout.tsx"],
      },
    ],
  } as RoutesManifest;
}

describe("SSR pipeline injects resolved metadata into <head>", () => {
  let server: ManduServer | null = null;
  let registry: ServerRegistry;

  beforeEach(() => {
    clearDefaultRegistry();
    registry = createServerRegistry();
  });

  afterEach(() => {
    if (server) {
      server.stop();
      server = null;
    }
  });

  it("renders static metadata.title as <title> with layout template merge", async () => {
    registry.registerLayoutLoader("app/layout.tsx", async () => ({
      default: MinimalLayout,
      metadata: {
        title: { default: "Fallback", template: "%s | My Site" },
        description: "Layout desc",
      },
    } as any));

    registry.registerPageLoader("home", async () => ({
      default: MinimalPage,
      metadata: {
        title: "Home Page",
        description: "Home description",
      },
    } as any));

    server = startServer(buildStaticManifest(), { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>Home Page | My Site</title>");
    expect(html).toContain('name="description"');
    expect(html).toContain("Home description");
  });

  it("runs generateMetadata with route params", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "blog/[slug]",
          pattern: "/blog/:slug",
          kind: "page",
          componentModule: "app/blog/[slug]/page.tsx",
        },
      ],
    } as RoutesManifest;

    registry.registerPageLoader("blog/[slug]", async () => ({
      default: MinimalPage,
      generateMetadata: async ({ params }: { params: Record<string, string> }) => ({
        title: `Post: ${params.slug}`,
        description: `About ${params.slug}`,
      }),
    } as any));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/blog/hello-world`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Post: hello-world");
    expect(html).toContain("About hello-world");
  });

  it("falls back to 'Mandu App' when no metadata is declared", async () => {
    registry.registerLayoutLoader("app/layout.tsx", async () => ({
      default: MinimalLayout,
    } as any));

    registry.registerPageLoader("home", async () => ({
      default: MinimalPage,
    } as any));

    server = startServer(buildStaticManifest(), { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>Mandu App</title>");
  });

  it("does not leak raw route.id like $lang when metadata missing (regression of #182)", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "$lang",
          pattern: "/:lang",
          kind: "page",
          componentModule: "app/[lang]/page.tsx",
        },
      ],
    } as RoutesManifest;

    registry.registerPageLoader("$lang", async () => ({
      default: MinimalPage,
    } as any));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/ko`);
    const html = await res.text();

    expect(html).not.toContain("$lang");
    expect(html).toContain("<title>Mandu App</title>");
  });
});
