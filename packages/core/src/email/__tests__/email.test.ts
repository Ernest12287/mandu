/**
 * @mandujs/core/email tests
 *
 * Exercises the memory adapter end-to-end (real spool, real timers) and the
 * Resend adapter with a fully injected fetch — we never touch the network.
 * The Resend tests also pin the exact wire format (headers, snake_case body
 * field names) so a future refactor can't silently break the contract.
 */

import { describe, it, expect } from "bun:test";
import {
  createMemoryEmailSender,
  createResendSender,
  createSmtpSender,
  _validateMessage,
  type EmailMessage,
} from "../index";
import { _buildResendBody } from "../resend";

// ─── Fixtures ───────────────────────────────────────────────────────────────

const VALID_MSG: EmailMessage = {
  from: "sender@example.com",
  to: "user@example.com",
  subject: "Hello",
  html: "<p>Hi</p>",
};

/**
 * Builds a fetch stub that returns a JSON response with the supplied `body`
 * and `status`. Records every call for assertions.
 */
interface FetchCall {
  url: string;
  init: RequestInit;
}
function makeFetchStub(options: {
  status?: number;
  body?: unknown;
  rawBody?: string;
  throwError?: Error;
}): { fetch: typeof globalThis.fetch; calls: FetchCall[] } {
  const calls: FetchCall[] = [];
  const fetchImpl = async (
    input: URL | RequestInfo,
    init?: RequestInit,
  ): Promise<Response> => {
    calls.push({
      url: typeof input === "string" ? input : (input as URL).toString(),
      init: init ?? {},
    });
    if (options.throwError) throw options.throwError;
    const status = options.status ?? 200;
    const body =
      options.rawBody !== undefined
        ? options.rawBody
        : JSON.stringify(options.body ?? {});
    return new Response(body, {
      status,
      headers: { "Content-Type": "application/json" },
    });
  };
  // Bun's `typeof globalThis.fetch` has a `preconnect` callable property.
  // Attach a no-op so the stub satisfies the structural type.
  (fetchImpl as unknown as { preconnect: (url: string) => void }).preconnect =
    () => {};
  return { fetch: fetchImpl as unknown as typeof globalThis.fetch, calls };
}

// ─── Memory adapter ─────────────────────────────────────────────────────────

describe("createMemoryEmailSender", () => {
  it("stores the message in .sent with id and sentAt", async () => {
    const sender = createMemoryEmailSender();
    const result = await sender.send(VALID_MSG);
    expect(sender.sent.length).toBe(1);
    expect(sender.sent[0].id).toBe(result.id);
    expect(sender.sent[0].sentAt).toBe(result.sentAt);
    expect(sender.sent[0].subject).toBe("Hello");
    expect(typeof result.id).toBe("string");
    expect(result.id.length).toBeGreaterThan(0);
    expect(typeof result.sentAt).toBe("number");
  });

  it("returns the same id that was stored", async () => {
    const sender = createMemoryEmailSender();
    const r1 = await sender.send(VALID_MSG);
    const r2 = await sender.send(VALID_MSG);
    expect(sender.sent[0].id).toBe(r1.id);
    expect(sender.sent[1].id).toBe(r2.id);
    expect(r1.id).not.toBe(r2.id); // unique per send
  });

  it("preserves send order across multiple calls", async () => {
    const sender = createMemoryEmailSender();
    for (let i = 0; i < 5; i++) {
      await sender.send({ ...VALID_MSG, subject: `msg-${i}` });
    }
    expect(sender.sent.map((m) => m.subject)).toEqual([
      "msg-0",
      "msg-1",
      "msg-2",
      "msg-3",
      "msg-4",
    ]);
  });

  it("clear() empties the spool", async () => {
    const sender = createMemoryEmailSender();
    await sender.send(VALID_MSG);
    await sender.send(VALID_MSG);
    expect(sender.sent.length).toBe(2);
    sender.clear();
    expect(sender.sent.length).toBe(0);
  });

  it("waitFor(3) resolves after 3 sends", async () => {
    const sender = createMemoryEmailSender();
    // Drive the sends on a delay so waitFor actually has to poll.
    setTimeout(() => {
      void sender.send(VALID_MSG);
    }, 5);
    setTimeout(() => {
      void sender.send(VALID_MSG);
    }, 15);
    setTimeout(() => {
      void sender.send(VALID_MSG);
    }, 25);
    await sender.waitFor(3, 500);
    expect(sender.sent.length).toBeGreaterThanOrEqual(3);
  });

  it("waitFor(3, 50) rejects with timeout if fewer than 3 sent in 50ms", async () => {
    const sender = createMemoryEmailSender();
    await sender.send(VALID_MSG); // only one, not three
    await expect(sender.waitFor(3, 50)).rejects.toThrow(/waitFor timed out/);
  });

  it("waitFor() with default args resolves immediately when already satisfied", async () => {
    const sender = createMemoryEmailSender();
    await sender.send(VALID_MSG);
    await sender.waitFor(); // default n=1 — already satisfied
    expect(sender.sent.length).toBe(1);
  });

  it("send() throws TypeError on missing html AND text", async () => {
    const sender = createMemoryEmailSender();
    await expect(
      sender.send({
        from: "a@b.com",
        to: "c@d.com",
        subject: "x",
      }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("send() throws TypeError on empty to array", async () => {
    const sender = createMemoryEmailSender();
    await expect(
      sender.send({ ...VALID_MSG, to: [] }),
    ).rejects.toThrow(/'to' must be a non-empty/);
  });

  it("send() accepts a single-string to", async () => {
    const sender = createMemoryEmailSender();
    await sender.send({ ...VALID_MSG, to: "one@example.com" });
    expect(sender.sent[0].to).toBe("one@example.com");
  });

  it("send() accepts an array to", async () => {
    const sender = createMemoryEmailSender();
    await sender.send({ ...VALID_MSG, to: ["a@x.com", "b@x.com"] });
    expect(sender.sent[0].to).toEqual(["a@x.com", "b@x.com"]);
  });

  it("send() accepts display-name from", async () => {
    const sender = createMemoryEmailSender();
    await sender.send({ ...VALID_MSG, from: "Alice <alice@example.com>" });
    expect(sender.sent[0].from).toBe("Alice <alice@example.com>");
  });

  it("send() throws TypeError on malformed from", async () => {
    const sender = createMemoryEmailSender();
    await expect(
      sender.send({ ...VALID_MSG, from: "not-an-email" }),
    ).rejects.toBeInstanceOf(TypeError);
  });

  it("send() throws TypeError on empty subject", async () => {
    const sender = createMemoryEmailSender();
    await expect(
      sender.send({ ...VALID_MSG, subject: "" }),
    ).rejects.toThrow(/subject/);
  });

  it("send() accepts text-only body", async () => {
    const sender = createMemoryEmailSender();
    await sender.send({
      from: "a@b.com",
      to: "c@d.com",
      subject: "plain",
      text: "hello",
    });
    expect(sender.sent[0].text).toBe("hello");
    expect(sender.sent[0].html).toBeUndefined();
  });

  it("_validateMessage throws on non-object input", () => {
    expect(() =>
      _validateMessage(null as unknown as EmailMessage),
    ).toThrow(/must be an object/);
  });
});

// ─── Resend adapter ─────────────────────────────────────────────────────────

describe("createResendSender", () => {
  it("requires an apiKey", () => {
    expect(() => createResendSender({ apiKey: "" })).toThrow(/apiKey/);
  });

  it("happy path: returns id + sentAt on 2xx", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "resend-123" } });
    const sender = createResendSender({ apiKey: "re_test", fetch });
    const result = await sender.send(VALID_MSG);
    expect(result.id).toBe("resend-123");
    expect(typeof result.sentAt).toBe("number");
    expect(calls.length).toBe(1);
  });

  it("posts with correct headers and JSON body shape", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "id-1" } });
    const sender = createResendSender({ apiKey: "re_abcdef", fetch });
    await sender.send({
      from: "Alice <alice@a.com>",
      to: "bob@b.com",
      subject: "hi",
      html: "<p>hi</p>",
    });
    const call = calls[0];
    expect(call.url).toBe("https://api.resend.com/emails");
    expect(call.init.method).toBe("POST");
    const headers = call.init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("Bearer re_abcdef");
    expect(headers["Content-Type"]).toBe("application/json");
    const body = JSON.parse(call.init.body as string);
    expect(body.from).toBe("Alice <alice@a.com>");
    expect(body.to).toEqual(["bob@b.com"]);
    expect(body.subject).toBe("hi");
    expect(body.html).toBe("<p>hi</p>");
  });

  it("passes array to through as array", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "id-2" } });
    const sender = createResendSender({ apiKey: "k", fetch });
    await sender.send({ ...VALID_MSG, to: ["a@x.com", "b@x.com"] });
    const body = JSON.parse(calls[0].init.body as string);
    expect(Array.isArray(body.to)).toBe(true);
    expect(body.to).toEqual(["a@x.com", "b@x.com"]);
  });

  it("converts replyTo → reply_to (snake_case)", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "id-3" } });
    const sender = createResendSender({ apiKey: "k", fetch });
    await sender.send({ ...VALID_MSG, replyTo: "reply@x.com" });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.reply_to).toBe("reply@x.com");
    expect(body.replyTo).toBeUndefined();
  });

  it("lowercases custom headers", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "id-4" } });
    const sender = createResendSender({ apiKey: "k", fetch });
    await sender.send({
      ...VALID_MSG,
      headers: { "X-Tag": "promo", "X-Campaign": "spring" },
    });
    const body = JSON.parse(calls[0].init.body as string);
    expect(body.headers).toEqual({ "x-tag": "promo", "x-campaign": "spring" });
  });

  it("throws on non-2xx with status and body excerpt", async () => {
    const { fetch } = makeFetchStub({
      status: 422,
      rawBody: "validation failed: invalid from address",
    });
    const sender = createResendSender({ apiKey: "k", fetch });
    await expect(sender.send(VALID_MSG)).rejects.toThrow(/status=422/);
    await expect(sender.send(VALID_MSG)).rejects.toThrow(/validation failed/);
  });

  it("throws on network failure with cause context", async () => {
    const { fetch } = makeFetchStub({
      throwError: new Error("ECONNRESET"),
    });
    const sender = createResendSender({ apiKey: "k", fetch });
    await expect(sender.send(VALID_MSG)).rejects.toThrow(/email send failed/);
    await expect(sender.send(VALID_MSG)).rejects.toThrow(/ECONNRESET/);
  });

  it("honors baseUrl override (trailing slash stripped)", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "id-5" } });
    const sender = createResendSender({
      apiKey: "k",
      fetch,
      baseUrl: "https://private.resend.example.com/",
    });
    await sender.send(VALID_MSG);
    expect(calls[0].url).toBe("https://private.resend.example.com/emails");
  });

  it("throws when provider response is missing id", async () => {
    const { fetch } = makeFetchStub({ body: { somethingElse: 1 } });
    const sender = createResendSender({ apiKey: "k", fetch });
    await expect(sender.send(VALID_MSG)).rejects.toThrow(/missing 'id'/);
  });

  it("validates message before calling fetch (fast-fail)", async () => {
    const { fetch, calls } = makeFetchStub({ body: { id: "x" } });
    const sender = createResendSender({ apiKey: "k", fetch });
    await expect(
      sender.send({ ...VALID_MSG, from: "bad" }),
    ).rejects.toBeInstanceOf(TypeError);
    expect(calls.length).toBe(0);
  });

  it("_buildResendBody omits undefined optional fields", () => {
    const body = _buildResendBody(VALID_MSG);
    expect(body.text).toBeUndefined();
    expect(body.cc).toBeUndefined();
    expect(body.bcc).toBeUndefined();
    expect(body.reply_to).toBeUndefined();
    expect(body.headers).toBeUndefined();
  });

  it("_buildResendBody includes cc/bcc arrays when provided", () => {
    const body = _buildResendBody({
      ...VALID_MSG,
      cc: "c@c.com",
      bcc: ["d@d.com", "e@e.com"],
    });
    expect(body.cc).toEqual(["c@c.com"]);
    expect(body.bcc).toEqual(["d@d.com", "e@e.com"]);
  });
});

// ─── SMTP stub ──────────────────────────────────────────────────────────────

describe("createSmtpSender (stub)", () => {
  it("throws with the planned-but-not-implemented message", () => {
    expect(() =>
      createSmtpSender({ host: "smtp.example.com" }),
    ).toThrow(/not yet implemented/);
  });
});
