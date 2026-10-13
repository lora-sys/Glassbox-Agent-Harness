export type VerifiedProcessStatus = "running" | "stopped" | "unknown";

export function stopVerifiedProcess(options: {
  getStatus: () => Promise<VerifiedProcessStatus> | VerifiedProcessStatus;
  signal: (signal: "SIGTERM") => unknown;
  force: (signal: "SIGKILL") => unknown;
  delay?: (milliseconds: number) => unknown;
  now?: () => number;
  gracefulMs?: number;
  forcedMs?: number;
  pollMs?: number;
}): Promise<{ status: "stopped"; signalSent: boolean; forced?: boolean }>;
