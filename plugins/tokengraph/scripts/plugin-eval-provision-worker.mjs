// Run only the pinned provisioner API; never invoke the benchmark runner.
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [evalRoot, targetRoot, inputRoot, statePath] = process.argv.slice(2);
const { provisionBenchmarkWorkspace } = await import(pathToFileURL(join(evalRoot, "src/core/benchmark-workspace.js")));
const provisioned = await provisionBenchmarkWorkspace({
  target: { kind: "plugin", name: "tokengraph", path: targetRoot },
  config: {
    workspace: { sourcePath: inputRoot, setupMode: "copy" },
    targetProvisioning: { mode: "workspace-plugin-marketplace" }
  },
  scenarioId: "host-preflight-v1"
});
await writeFile(statePath, JSON.stringify({
  workspacePath: provisioned.workspacePath,
  homePath: provisioned.homePath,
  codexHomePath: provisioned.codexHomePath
}), { flag: "wx", mode: 0o600 });
// The caller owns the containing temporary directory, including any partial
// provisioning failure, and removes it in finally. No worktree was registered.
