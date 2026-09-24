import { lstat } from "node:fs/promises";

import { activateLegacyRuntimeShutdown } from "../../src/core/legacyRuntimeActivation.js";
import { loadHarnessState } from "./externalRuntime.js";

if (!process.env.TOKENGRAPH_TEST_HARNESS_MANIFEST) throw new Error("Activated native lock test harness is unavailable.");
const harness = await loadHarnessState();
const staging = await lstat(harness.children.staging.path);
if (!staging.isDirectory() || staging.isSymbolicLink()) throw new Error("Activated native lock test harness is invalid.");

activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true });
