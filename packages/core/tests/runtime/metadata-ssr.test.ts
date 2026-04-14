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

  it("resolves metadata on the pageHandlers (filling API) path as well", async () => {
    // #186 post-review: pageHandlers 경로(신규 filling API)가 pageLoaders 경로와
    // 동등하게 metadata를 캐시하는지 확인. 이전에는 pageLoaders에만 적용돼 있었음.
    registry.registerPageHandler("home", async () => ({
      component: MinimalPage,
      metadata: {
        title: "Handler Page",
        description: "From pageHandler",
      },
    } as any));

    server = startServer(buildStaticManifest(), { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>Handler Page</title>");
    expect(html).toContain("From pageHandler");
  });

  it("runs generateMetadata on the pageHandlers path with route params", async () => {
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "post/[id]",
          pattern: "/post/:id",
          kind: "page",
          componentModule: "app/post/[id]/page.tsx",
        },
      ],
    } as RoutesManifest;

    registry.registerPageHandler("post/[id]", async () => ({
      component: MinimalPage,
      generateMetadata: async ({ params }: { params: Record<string, string> }) => ({
        title: `Handler post ${params.id}`,
        description: `Dynamic handler ${params.id}`,
      }),
    } as any));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/post/42`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("Handler post 42");
    expect(html).toContain("Dynamic handler 42");
  });

  it("multi-layout chain merges in root→leaf order with child overrides", async () => {
    // 3-level chain: root layout → nested layout → page
    // Next.js 호환 시맨틱: title.template은 cascade되지만 openGraph 등은 child가 있으면
    // 부모를 완전히 대체한다 (shallow override, not deep merge).
    const manifest: RoutesManifest = {
      version: 1,
      routes: [
        {
          id: "nested",
          pattern: "/",
          kind: "page",
          componentModule: "app/page.tsx",
          layoutChain: ["app/layout.tsx", "app/nested/layout.tsx"],
        },
      ],
    } as RoutesManifest;

    registry.registerLayoutLoader("app/layout.tsx", async () => ({
      default: MinimalLayout,
      metadata: {
        title: { default: "Root", template: "%s | Root" },
        description: "root desc",
        openGraph: { siteName: "Root Site", type: "website" },
      },
    } as any));

    registry.registerLayoutLoader("app/nested/layout.tsx", async () => ({
      default: MinimalLayout,
      metadata: {
        // nested는 description만 override, openGraph는 건드리지 않음 → 부모 것 cascade
        description: "nested desc",
      },
    } as any));

    registry.registerPageLoader("nested", async () => ({
      default: MinimalPage,
      metadata: {
        title: "Leaf Page",
      },
    } as any));

    server = startServer(manifest, { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    // Root의 title.template 적용, leaf의 title과 병합
    expect(html).toContain("<title>Leaf Page | Root</title>");
    // nested가 description을 override
    expect(html).toContain("nested desc");
    expect(html).not.toContain("root desc");
    // Root의 openGraph는 nested가 건드리지 않았으므로 cascade
    expect(html).toContain("Root Site");
    expect(html).toContain('content="website"');
  });

  it("generateMetadata 실패 시 'Mandu App' fallback으로 복구", async () => {
    registry.registerPageLoader("home", async () => ({
      default: MinimalPage,
      generateMetadata: async () => {
        throw new Error("intentional metadata failure");
      },
    } as any));

    server = startServer(buildStaticManifest(), { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    expect(res.status).toBe(200);
    // fallback 제목으로 렌더 (500 에러가 아님)
    expect(html).toContain("<title>Mandu App</title>");
  });

  it("searchParams가 generateMetadata에 전파된다", async () => {
    registry.registerPageLoader("home", async () => ({
      default: MinimalPage,
      generateMetadata: async ({ searchParams }: { searchParams: Record<string, string> }) => ({
        title: `Q: ${searchParams.q ?? "none"}`,
        description: `Filter: ${searchParams.filter ?? "off"}`,
      }),
    } as any));

    server = startServer(buildStaticManifest(), { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/?q=hello&filter=on`);
    const html = await res.text();

    expect(res.status).toBe(200);
    expect(html).toContain("<title>Q: hello</title>");
    expect(html).toContain("Filter: on");
  });

  it("emits <title> exactly once (no duplication from strip regex)", async () => {
    registry.registerPageLoader("home", async () => ({
      default: MinimalPage,
      metadata: { title: "Unique", description: "Check once" },
    } as any));

    server = startServer(buildStaticManifest(), { port: 0, registry });
    const port = server.server.port;

    const res = await fetch(`http://localhost:${port}/`);
    const html = await res.text();

    const titleMatches = html.match(/<title>[^<]*<\/title>/g) ?? [];
    expect(titleMatches.length).toBe(1);
    expect(titleMatches[0]).toBe("<title>Unique</title>");
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
