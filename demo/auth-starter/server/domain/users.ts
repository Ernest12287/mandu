/**
 * In-memory user store — Phase 2 demo only.
 *
 * Backed by a module-level `Map`. NOT intended for production:
 *   - state is lost on every server restart
 *   - not safe across multiple server instances
 *   - no pagination, no indexes beyond the email lookup
 *
 * A real app would replace this with a DB-backed repository while keeping
 * the same shape so callers (`app/api/signup/route.ts`, etc.) don't change.
 */
import { newId } from "@mandujs/core/id";

export interface User {
  id: string;
  email: string;
  passwordHash: string;
  createdAt: number;
}

/** Thrown by `create()` when the email is already registered. */
export class EmailTakenError extends Error {
  readonly statusCode = 409;
  constructor(email: string) {
    super(`Email already registered: ${email}`);
    this.name = "EmailTakenError";
  }
}

const byId = new Map<string, User>();
const byEmail = new Map<string, User>();

function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

export const userStore = {
  /**
   * Create a user with the given email + bcrypt/argon2id hash.
   * Throws `EmailTakenError` if the (normalized) email is already in use.
   */
  create(email: string, passwordHash: string): User {
    const key = normalizeEmail(email);
    if (byEmail.has(key)) {
      throw new EmailTakenError(key);
    }
    const user: User = {
      id: newId(),
      email: key,
      passwordHash,
      createdAt: Date.now(),
    };
    byId.set(user.id, user);
    byEmail.set(user.email, user);
    return user;
  },

  findByEmail(email: string): User | null {
    const key = normalizeEmail(email);
    return byEmail.get(key) ?? null;
  },

  findById(id: string): User | null {
    return byId.get(id) ?? null;
  },

  /** Test helper — wipe all users. NOT exposed through any API handler. */
  _reset(): void {
    byId.clear();
    byEmail.clear();
  },
};
