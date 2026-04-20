/**
 * Phase C.5 — tagged exemplars for `streaming_ssr` prompt kind.
 */

// @ate-exemplar: kind=streaming_ssr depth=basic tags=shell,doctype
test("dashboard stream emits a well-formed shell", async () => {
  const res = await fetch(`${BASE_URL}/dashboard`);
  await assertStreamBoundary(res, {
    shellChunkContains: ["<!DOCTYPE", "<html"],
  });
});

// @ate-exemplar: kind=streaming_ssr depth=basic tags=boundary,count
test("dashboard has exactly 2 Suspense boundaries", async () => {
  const res = await fetch(`${BASE_URL}/dashboard`);
  await assertStreamBoundary(res, { boundaryCount: 2 });
});

// @ate-exemplar: kind=streaming_ssr depth=advanced tags=budget,ttfb
test("landing page shell stays under 20KB", async () => {
  const res = await fetch(`${BASE_URL}/`);
  await assertStreamBoundary(res, { firstChunkMaxSizeBytes: 20480 });
});

// @ate-exemplar: kind=streaming_ssr depth=advanced tags=islands,tail
test("tail chunk contains island bootstrap scripts", async () => {
  const res = await fetch(`${BASE_URL}/products`);
  await assertStreamBoundary(res, {
    tailChunkContainsAnyOf: ["<script", "islands"],
  });
});
