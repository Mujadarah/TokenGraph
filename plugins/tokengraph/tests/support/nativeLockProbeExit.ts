import type { ChildProcess } from "node:child_process";
import { captureProbeDiagnostic, probeDiagnosticMetadata, type ProbeDiagnosticContext } from "./nativeLockProbeDiagnostics.js";

const pendingDiagnostics = new WeakMap<Error, Promise<void>>();
const childErrorCodes = new Set(["EACCES", "EPERM", "ENOENT", "EAGAIN", "EIO", "EPIPE", "ESRCH",
  "EINVAL", "EMFILE", "ENFILE", "ENOMEM", "ECONNRESET", "ETIMEDOUT", "ECANCELED",
  "ERR_IPC_CHANNEL_CLOSED", "ERR_IPC_DISCONNECTED", "ERR_CHILD_PROCESS_IPC_REQUIRED"]);

function childErrorCode(error: Error): string {
  try {
    const code = (error as NodeJS.ErrnoException).code;
    return code !== undefined && childErrorCodes.has(code) ? code : "unclassified";
  } catch { return "unclassified"; }
}

// Call only after existing termination and tracking cleanup. Reporting can wait;
// containment must never await diagnostic filesystem I/O.
export async function finishProbeExitDiagnostic(error: unknown): Promise<void> {
  if (!(error instanceof Error)) return;
  await pendingDiagnostics.get(error);
  pendingDiagnostics.delete(error);
}

export function waitForProbeExit(child: ChildProcess, timeoutMs: number, context?: ProbeDiagnosticContext): Promise<number | null> {
  return new Promise((resolveExit, rejectExit) => {
    const rejectFailure = (message: string, code?: string): void => {
      let frozen: object | undefined;
      if (context !== undefined) {
        try { frozen = probeDiagnosticMetadata(context); } catch { /* Preserve the rejection even if metadata fails. */ }
      }
      const failure: NodeJS.ErrnoException = new Error(message);
      if (code !== undefined) failure.code = code;
      if (context !== undefined) failure.message += frozen === undefined ? " native-lock-probes=unavailable" :
        ` native-lock-probes=${JSON.stringify([{ ...frozen, observation: "capture-pending" }])}`;
      rejectExit(failure);
      if (context === undefined) return;
      // Queue after rejection so the caller's original finally starts first.
      const diagnostic = Promise.resolve().then(async () => {
        try {
          const state = await captureProbeDiagnostic(context);
          failure.message = `${message} native-lock-probes=${JSON.stringify([{ ...state, ...frozen }])}`;
        } catch {
          // Keep the safe failure-time metadata; never replace it with a raw error.
          failure.message = failure.message.replace('"capture-pending"', '"capture-unavailable"');
        }
      });
      pendingDiagnostics.set(failure, diagnostic);
    };
    const timer = setTimeout(() => {
      cleanup();
      rejectFailure("Native lock probe did not exit before its deadline.");
    }, timeoutMs);
    timer.unref?.();
    const cleanup = (): void => {
      clearTimeout(timer);
      child.off("error", onError);
      child.off("exit", onExit);
    };
    const onError = (error: Error): void => {
      cleanup();
      const code = childErrorCode(error);
      rejectFailure(`Native lock probe child wait failed. child-error-code=${code}`, code);
    };
    const onExit = (code: number | null): void => {
      cleanup();
      resolveExit(code);
    };
    child.once("error", onError);
    child.once("exit", onExit);
  });
}
