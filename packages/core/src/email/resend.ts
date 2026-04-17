/**
 * @mandujs/core/email — Resend adapter
 *
 * Thin HTTP client for the Resend Send-Email API. Zero deps: uses `fetch`.
 *
 * Contract (https://resend.com/docs/api-reference/emails/send-email):
 *   POST https://api.resend.com/emails
 *   Headers:
 *     Authorization: Bearer <apiKey>
 *     Content-Type: application/json
 *   Body: {
 *     from, to (string | string[]), subject,
 *     html?, text?, cc?, bcc?, reply_to?, headers?
 *   }
 *   Response 200: { id: string, ... }
 *   Error 4xx/5xx: { name, message, statusCode }
 *
 * @module email/resend
 */

import {
  type EmailMessage,
  type EmailSender,
  type EmailSendResult,
  _coerceRecipients,
  _lowercaseHeaders,
  _validateMessage,
} from "./index.js";

/** Config for the Resend adapter. */
export interface ResendOptions {
  /** Resend API key. Required. Pull from env (e.g. `RESEND_API_KEY`). */
  apiKey: string;
  /**
   * Override API base URL. Useful for tests or private Resend deployments.
   * Default: `"https://api.resend.com"`. Trailing slash is stripped.
   */
  baseUrl?: string;
  /**
   * Fetch implementation. Default: `globalThis.fetch`. Injected in tests so
   * we never hit the real network.
   */
  fetch?: typeof globalThis.fetch;
}

/** Body shape posted to Resend. Fields are omitted when undefined. */
interface ResendRequestBody {
  from: string;
  to: string[];
  subject: string;
  html?: string;
  text?: string;
  cc?: string[];
  bcc?: string[];
  reply_to?: string;
  headers?: Record<string, string>;
}

/** Successful Resend response shape. We only care about `id`. */
interface ResendSuccessResponse {
  id: string;
}

/** How much of a failed-response body we include in the thrown error. */
const ERROR_BODY_EXCERPT_CHARS = 200;

/**
 * Builds the request body in exactly the shape Resend expects. Exported for
 * tests so they can assert the payload shape without running `send()`.
 *
 * @internal
 */
export function _buildResendBody(message: EmailMessage): ResendRequestBody {
  const recipients = _coerceRecipients(message);
  const body: ResendRequestBody = {
    from: message.from,
    to: recipients.to,
    subject: message.subject,
  };
  if (message.html !== undefined) body.html = message.html;
  if (message.text !== undefined) body.text = message.text;
  if (recipients.cc) body.cc = recipients.cc;
  if (recipients.bcc) body.bcc = recipients.bcc;
  if (message.replyTo !== undefined) body.reply_to = message.replyTo;
  const headers = _lowercaseHeaders(message.headers);
  if (headers && Object.keys(headers).length > 0) body.headers = headers;
  return body;
}

/**
 * Creates a Resend-backed `EmailSender`.
 *
 * @throws `TypeError` if `apiKey` is missing.
 */
export function createResendSender(options: ResendOptions): EmailSender {
  if (!options || typeof options.apiKey !== "string" || options.apiKey.length === 0) {
    throw new TypeError(
      "[@mandujs/core/email/resend] createResendSender: 'apiKey' is required.",
    );
  }

  const baseUrl = (options.baseUrl ?? "https://api.resend.com").replace(/\/+$/, "");
  const fetchImpl = options.fetch ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error(
      "[@mandujs/core/email/resend] globalThis.fetch is unavailable — provide `options.fetch` or run in an environment that supplies fetch.",
    );
  }

  const url = `${baseUrl}/emails`;
  const authHeader = `Bearer ${options.apiKey}`;

  async function send(message: EmailMessage): Promise<EmailSendResult> {
    _validateMessage(message);
    const body = _buildResendBody(message);

    let response: Response;
    try {
      response = await fetchImpl(url, {
        method: "POST",
        headers: {
          Authorization: authHeader,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch (err) {
      // Network-level failure (DNS, TCP reset, abort, offline). Re-throw
      // with clear context so ops dashboards can distinguish "provider said
      // no" from "we never reached the provider".
      const cause = err instanceof Error ? err.message : String(err);
      throw new Error(
        `[@mandujs/core/email/resend] email send failed: ${cause}`,
        { cause: err instanceof Error ? err : undefined },
      );
    }

    if (!response.ok) {
      // Read the body best-effort so the error is actionable, but don't let
      // a malformed body mask the HTTP status.
      let excerpt = "";
      try {
        const text = await response.text();
        excerpt = text.slice(0, ERROR_BODY_EXCERPT_CHARS);
      } catch {
        excerpt = "<unreadable body>";
      }
      throw new Error(
        `[@mandujs/core/email/resend] email send failed: status=${response.status} body=${excerpt}`,
      );
    }

    const parsed = (await response.json()) as ResendSuccessResponse;
    if (!parsed || typeof parsed.id !== "string") {
      throw new Error(
        "[@mandujs/core/email/resend] email send failed: provider response missing 'id'.",
      );
    }
    return { id: parsed.id, sentAt: Date.now() };
  }

  return { send };
}
