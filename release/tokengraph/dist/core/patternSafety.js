import { Worker } from "node:worker_threads";
const PATTERN_FIELDS = [
    "fromPattern",
    "targetPattern",
    "allowedTargetPattern",
    "modulePattern",
    "testPattern",
    "namePattern",
    "sqlPattern"
];
const PROBE = `${"a".repeat(12_000)}!`;
const TIMEOUT_MS = 250;
function assertSafePattern(pattern) {
    return new Promise((resolve, reject) => {
        const worker = new Worker(`const { parentPort, workerData } = require("node:worker_threads");
try {
  new RegExp(workerData.pattern).test(workerData.probe);
  parentPort.postMessage({ ok: true });
} catch (error) {
  parentPort.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) });
}`, { eval: true, workerData: { pattern, probe: PROBE } });
        let settled = false;
        const finish = (error) => {
            if (settled)
                return;
            settled = true;
            clearTimeout(timeout);
            void worker.terminate();
            if (error)
                reject(error);
            else
                resolve();
        };
        const timeout = setTimeout(() => {
            finish(new Error("pattern evaluation exceeded the safety time limit"));
        }, TIMEOUT_MS);
        worker.once("message", (message) => {
            if (message.ok)
                finish();
            else
                finish(new Error(message.message ?? "pattern could not be compiled"));
        });
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => {
            if (code !== 0)
                finish(new Error(`pattern worker exited with code ${code}`));
        });
    });
}
export async function assertSafeArchitectureRulePatterns(input) {
    for (const field of PATTERN_FIELDS) {
        const pattern = input[field];
        if (typeof pattern !== "string" || !pattern)
            continue;
        try {
            await assertSafePattern(pattern);
        }
        catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Unsafe architecture rule pattern in ${field}: ${message}`);
        }
    }
}
