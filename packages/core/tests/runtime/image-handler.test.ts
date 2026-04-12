/**
 * Image Handler Tests
 */
import { describe, it, expect } from "bun:test";
import { handleImageRequest } from "../../src/runtime/image-handler";
import path from "path";
import fs from "fs/promises";
import os from "os";

const rootDir = path.join(os.tmpdir(), `mandu-img-test-${Date.now()}`);
const publicDir = "public";

async function setup() {
  const imgDir = path.join(rootDir, publicDir, "photos");
  await fs.mkdir(imgDir, { recursive: true });
  // 1x1 red PNG
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8/5+hHgAHggJ/PchI7wAAAABJRU5ErkJggg==",
    "base64"
  );
  await fs.writeFile(path.join(imgDir, "test.png"), png);
}

function sniffImageMime(bytes: Uint8Array): string | null {
  if (
    bytes[0] === 0x89 &&
    bytes[1] === 0x50 &&
    bytes[2] === 0x4e &&
    bytes[3] === 0x47
  ) {
    return "image/png";
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    return "image/jpeg";
  }
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  ) {
    return "image/webp";
  }
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70 &&
    bytes[8] === 0x61 &&
    bytes[9] === 0x76 &&
    bytes[10] === 0x69 &&
    bytes[11] === 0x66
  ) {
    return "image/avif";
  }
  return null;
}

describe("handleImageRequest", () => {
  it("returns null for non-image paths", async () => {
    const req = new Request("http://localhost/api/users");
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result).toBeNull();
  });

  it("returns 400 for missing url param", async () => {
    const req = new Request("http://localhost/_mandu/image");
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
  });

  it("returns 400 for path traversal attempts", async () => {
    const req = new Request("http://localhost/_mandu/image?url=/../etc/passwd&w=100&q=80");
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(400);
  });

  it("returns 400 for invalid width", async () => {
    const req = new Request("http://localhost/_mandu/image?url=/photos/test.png&w=0&q=80");
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result!.status).toBe(400);
  });

  it("returns 404 for non-existent image", async () => {
    const req = new Request("http://localhost/_mandu/image?url=/photos/nope.png&w=100&q=80");
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result!.status).toBe(404);
  });

  it("serves existing image with cache headers", async () => {
    await setup();
    const req = new Request("http://localhost/_mandu/image?url=/photos/test.png&w=100&q=80");
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result).not.toBeNull();
    expect(result!.status).toBe(200);
    expect(result!.headers.get("Cache-Control")).toContain("immutable");
    expect(result!.headers.get("Vary")).toBe("Accept");
  });

  it("returns cached response on second request", async () => {
    await setup();
    const req = new Request("http://localhost/_mandu/image?url=/photos/test.png&w=100&q=80");
    await handleImageRequest(req, rootDir, publicDir);
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result!.headers.get("X-Mandu-Image-Cache")).toBe("HIT");
  });

  it("keeps content-type aligned with the returned bytes", async () => {
    await setup();
    const req = new Request("http://localhost/_mandu/image?url=/photos/test.png&w=100&q=80", {
      headers: { Accept: "image/webp,image/*" },
    });
    const result = await handleImageRequest(req, rootDir, publicDir);
    expect(result).not.toBeNull();

    const bytes = new Uint8Array(await result!.arrayBuffer());
    const detectedMime = sniffImageMime(bytes);

    expect(detectedMime).not.toBeNull();
    expect(result!.headers.get("Content-Type")).toBe(detectedMime);
  });
});
