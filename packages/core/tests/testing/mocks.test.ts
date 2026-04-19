/**
 * mockMail + mockStorage — I/O mock tests.
 *
 * Verifies the memory email adapter captures sent messages, `lastTo()`
 * shortcut behaviour, in-memory storage round-trips, and the
 * `exists() / delete() / keys()` contract.
 */
import { describe, expect, it } from "bun:test";
import { mockMail, mockStorage } from "../../src/testing/index";

describe("mockMail", () => {
  it("captures every sent message in order", async () => {
    const mail = mockMail();
    await mail.send({ from: "a@x", to: "b@y", subject: "S1", html: "<p>1</p>" });
    await mail.send({ from: "a@x", to: "c@y", subject: "S2", html: "<p>2</p>" });

    expect(mail.sent).toHaveLength(2);
    expect(mail.sent[0].subject).toBe("S1");
    expect(mail.sent[1].subject).toBe("S2");
  });

  it("clear() empties the outbox", async () => {
    const mail = mockMail();
    await mail.send({ from: "a@x", to: "b@y", subject: "one", html: "<p/>" });
    expect(mail.sent).toHaveLength(1);
    mail.clear();
    expect(mail.sent).toHaveLength(0);
  });

  it("lastTo() finds the most recent message for a recipient", async () => {
    const mail = mockMail();
    await mail.send({ from: "a@x", to: "first@y", subject: "A", html: "<p/>" });
    await mail.send({ from: "a@x", to: "second@y", subject: "B", html: "<p/>" });
    await mail.send({ from: "a@x", to: "first@y", subject: "C", html: "<p/>" });

    const lastForFirst = mail.lastTo("first@y");
    expect(lastForFirst?.subject).toBe("C");

    const missing = mail.lastTo("never@y");
    expect(missing).toBeUndefined();
  });

  it("lastTo() handles array recipients", async () => {
    const mail = mockMail();
    await mail.send({
      from: "a@x",
      to: ["x@y", "z@y"],
      subject: "Multi",
      html: "<p/>",
    });
    expect(mail.lastTo("z@y")?.subject).toBe("Multi");
  });
});

describe("mockStorage", () => {
  it("upload / exists / peek round-trip via bytes", async () => {
    const s = mockStorage();
    const bytes = new Uint8Array([1, 2, 3, 4]);

    const url = await s.upload(bytes, { key: "u/1.bin" });
    expect(url).toContain("u/1.bin");
    expect(await s.exists("u/1.bin")).toBe(true);

    const stored = s.peek("u/1.bin");
    expect(stored).toBeDefined();
    expect(stored!.body).toEqual(bytes);
  });

  it("content-type defaults by extension when omitted", async () => {
    const s = mockStorage();
    await s.upload(new Uint8Array([0]), { key: "avatar.png" });
    expect(s.peek("avatar.png")?.contentType).toBe("image/png");
  });

  it("delete() removes the object, exists() returns false", async () => {
    const s = mockStorage();
    await s.upload(new Uint8Array([0]), { key: "bye.txt" });
    expect(await s.exists("bye.txt")).toBe(true);

    await s.delete("bye.txt");
    expect(await s.exists("bye.txt")).toBe(false);
  });

  it("presign returns a deterministic pseudo-URL with method", async () => {
    const s = mockStorage({ bucket: "test-bucket" });
    const url = await s.presign({ key: "x.png", method: "PUT", expiresIn: 60 });
    expect(url).toContain("test-bucket");
    expect(url).toContain("x.png");
    expect(url).toContain("method=PUT");
    expect(url).toContain("expires=60");
  });

  it("keys() lists every stored key", async () => {
    const s = mockStorage();
    await s.upload(new Uint8Array([0]), { key: "a/1" });
    await s.upload(new Uint8Array([0]), { key: "b/2" });
    expect(s.keys().sort()).toEqual(["a/1", "b/2"]);
  });

  it("clear() empties the store", async () => {
    const s = mockStorage();
    await s.upload(new Uint8Array([0]), { key: "x" });
    s.clear();
    expect(s.keys()).toEqual([]);
  });

  it("getReadable returns a stream that yields the stored bytes", async () => {
    const s = mockStorage();
    const bytes = new Uint8Array([9, 8, 7]);
    await s.upload(bytes, { key: "r.bin" });

    const stream = await s.getReadable("r.bin");
    const reader = stream.getReader();
    const { value, done } = await reader.read();
    expect(done).toBe(false);
    expect(value).toEqual(bytes);
  });

  it("getReadable throws for missing keys", async () => {
    const s = mockStorage();
    await expect(s.getReadable("ghost")).rejects.toThrow(/not found/);
  });
});
