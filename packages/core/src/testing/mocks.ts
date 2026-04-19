/**
 * @mandujs/core/testing/mocks
 *
 * Swap-in mocks for the I/O primitives tests typically stub:
 *
 * - `mockMail()` → the production `MemoryEmailSender` (Phase 5 email
 *   primitive), wrapped so tests get a uniform async-dispose cleanup helper.
 * - `mockStorage()` → an in-memory `S3Client`-shaped handle satisfying the
 *   public `@mandujs/core/storage/s3` interface without booting `Bun.S3Client`.
 *
 * Both return objects that are **drop-in replacements** for their production
 * counterparts. Pass them to the handler/service under test via whatever
 * dependency-injection path your code already uses — there is no magic here.
 *
 * ```ts
 * import { mockMail, mockStorage } from "@mandujs/core/testing";
 *
 * const mail = mockMail();
 * const storage = mockStorage();
 *
 * await sendWelcomeEmail({ mail }, "u@x.com");
 * expect(mail.sent[0].subject).toBe("Welcome");
 *
 * await uploadAvatar({ storage }, buffer);
 * expect(await storage.exists("u/avatar.png")).toBe(true);
 * ```
 *
 * @module testing/mocks
 */

import {
  createMemoryEmailSender,
  type EmailMessage,
  type MemoryEmailSender,
} from "../email/index";
import { getContentType, type S3Client, type S3UploadOptions, type S3PresignOptions } from "../storage/s3/index";

// ═══════════════════════════════════════════════════════════════════════════
// Email mock
// ═══════════════════════════════════════════════════════════════════════════

/** Handle returned by {@link mockMail}. Extends the production sender 1:1. */
export interface MockMail extends MemoryEmailSender {
  /**
   * Find the most recently sent message whose recipient matches `to`
   * (single-address equality). Returns `undefined` if none matched.
   *
   * Convenience shortcut around a reverse scan of `sent` — the common
   * assertion in verification / password-reset tests.
   */
  lastTo(to: string): (EmailMessage & { id: string; sentAt: number }) | undefined;
  /** `using mail = mockMail()` — clears the outbox on exit. */
  [Symbol.dispose](): void;
}

/**
 * Create an in-process email sender. Backing store is a plain array —
 * read via `mail.sent`, clear between cases with `mail.clear()`.
 *
 * This is a thin wrapper around the production `createMemoryEmailSender`
 * so tests do not depend on an implementation detail of the email package.
 */
export function mockMail(): MockMail {
  const inner = createMemoryEmailSender();

  // MemoryEmailSender's `sent` is declared readonly at the type level; the
  // runtime object exposes .push under the covers. We add the convenience
  // helper without widening the surface.
  //
  // Reverse-iterating by index (vs. `.findLast`) avoids dependency on the
  // ES2023 `Array.prototype.findLast` lib type — older tsconfig targets
  // (`"lib": ["ES2022"]`) do not declare it. The runtime has it regardless.
  return Object.assign(inner, {
    lastTo(
      to: string,
    ): (EmailMessage & { id: string; sentAt: number }) | undefined {
      for (let i = inner.sent.length - 1; i >= 0; i--) {
        const m = inner.sent[i];
        if (Array.isArray(m.to)) {
          if (m.to.includes(to)) return m;
        } else if (m.to === to) {
          return m;
        }
      }
      return undefined;
    },
    [Symbol.dispose]() {
      inner.clear();
    },
  }) as MockMail;
}

// ═══════════════════════════════════════════════════════════════════════════
// Storage (S3-compatible) mock
// ═══════════════════════════════════════════════════════════════════════════

/** Stored blob + metadata for assertions. */
export interface MockStoredObject {
  readonly body: Uint8Array;
  readonly contentType: string;
  readonly acl?: "private" | "public-read";
}

/** Handle returned by {@link mockStorage}. Extends `S3Client` with test-only affordances. */
export interface MockStorage extends S3Client {
  /** Every key currently present. */
  keys(): string[];
  /** Raw access to a stored object. Returns `undefined` for missing keys. */
  peek(key: string): MockStoredObject | undefined;
  /** Wipe all stored objects. */
  clear(): void;
  /** `using s = mockStorage()` — clears the store on exit. */
  [Symbol.dispose](): void;
}

/**
 * Convert the production `S3Client` body types into a normalized Uint8Array
 * so `peek()` returns a stable type regardless of what callers uploaded.
 */
function normalizeBody(body: Blob | ArrayBuffer | Uint8Array): Promise<Uint8Array> {
  if (body instanceof Uint8Array) return Promise.resolve(new Uint8Array(body));
  if (body instanceof ArrayBuffer) return Promise.resolve(new Uint8Array(body));
  // Blob → ArrayBuffer → Uint8Array.
  return body.arrayBuffer().then((ab) => new Uint8Array(ab));
}

/**
 * Create an in-memory S3-compatible storage client. Satisfies the full
 * `S3Client` interface — handlers written against the production API can
 * be called with this mock unchanged.
 *
 * Presigned URLs are synthesized as opaque `mandu-mock://bucket/<key>`
 * strings. They are not de-serializable back into real uploads — only used
 * for identity assertions (presign returned? key matches?).
 */
export function mockStorage(options?: { bucket?: string }): MockStorage {
  const bucket = options?.bucket ?? "mandu-test-bucket";
  const store = new Map<string, MockStoredObject>();

  async function upload(
    body: Blob | ArrayBuffer | Uint8Array,
    opts: S3UploadOptions,
  ): Promise<string> {
    if (!opts.key) {
      throw new TypeError(
        "[testing/mocks] mockStorage.upload: 'key' is required.",
      );
    }
    const contentType = opts.contentType ?? getContentType(opts.key);
    const bytes = await normalizeBody(body);
    store.set(opts.key, { body: bytes, contentType, acl: opts.acl });
    return `mandu-mock://${bucket}/${opts.key}`;
  }

  async function presign(opts: S3PresignOptions): Promise<string> {
    if (!opts.key) {
      throw new TypeError(
        "[testing/mocks] mockStorage.presign: 'key' is required.",
      );
    }
    const method = opts.method ?? "PUT";
    const expiresIn = opts.expiresIn ?? 900;
    return `mandu-mock://${bucket}/${opts.key}?method=${method}&expires=${expiresIn}`;
  }

  async function deleteObject(key: string): Promise<void> {
    store.delete(key);
  }

  async function getReadable(key: string): Promise<ReadableStream> {
    const obj = store.get(key);
    if (!obj) {
      throw new Error(
        `[testing/mocks] mockStorage.getReadable: key not found: ${JSON.stringify(key)}`,
      );
    }
    return new ReadableStream({
      start(controller) {
        controller.enqueue(obj.body);
        controller.close();
      },
    });
  }

  async function exists(key: string): Promise<boolean> {
    return store.has(key);
  }

  const handle: MockStorage = {
    upload,
    presign,
    delete: deleteObject,
    getReadable,
    exists,
    keys: () => [...store.keys()],
    peek: (key) => store.get(key),
    clear: () => store.clear(),
    [Symbol.dispose]() {
      store.clear();
    },
  };
  return handle;
}
