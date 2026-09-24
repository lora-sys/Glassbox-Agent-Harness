import { createHash, randomUUID } from "node:crypto";

export interface BrowserSessionBinding {
  runId: string;
  principalId: string;
  conversationId: string;
  workspaceId: string;
  policyVersion: string;
  purpose?: "tool" | "fallback";
}

export interface BrowserSession {
  /** Opaque CLI session name. Never use caller-controlled text as a CLI session name. */
  cliSession: string;
  opened: boolean;
}

export function browserSessionBindingKey(binding: BrowserSessionBinding): string {
  return JSON.stringify([
    binding.runId,
    binding.principalId,
    binding.conversationId,
    binding.workspaceId,
    binding.policyVersion,
    binding.purpose ?? "tool",
  ]);
}

/** Run-scoped session registry. Sessions are never shared across a Run or Principal. */
export class BrowserSessionRegistry {
  private readonly sessions = new Map<string, BrowserSession>();
  private readonly locks = new Map<string, Promise<void>>();

  constructor(private readonly createId: () => string = randomUUID) {}

  session(binding: BrowserSessionBinding): BrowserSession {
    const key = browserSessionBindingKey(binding);
    let session = this.sessions.get(key);
    if (!session) {
      const suffix = createHash("sha256")
        .update(`${key}\0${this.createId()}`)
        .digest("hex")
        .slice(0, 24);
      session = { cliSession: `gb-${suffix}`, opened: false };
      this.sessions.set(key, session);
    }
    return session;
  }

  /** Serialize commands for one browser session so actions cannot race each other. */
  async exclusive<T>(
    binding: BrowserSessionBinding,
    operation: (session: BrowserSession) => Promise<T>,
  ): Promise<T> {
    const key = browserSessionBindingKey(binding);
    const prior = this.locks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const current = new Promise<void>((resolve) => {
      release = resolve;
    });
    const queued = prior.then(() => current);
    this.locks.set(key, queued);
    await prior;
    try {
      return await operation(this.session(binding));
    } finally {
      release();
      if (this.locks.get(key) === queued) this.locks.delete(key);
    }
  }

  forget(binding: BrowserSessionBinding): void {
    this.sessions.delete(browserSessionBindingKey(binding));
  }
}
