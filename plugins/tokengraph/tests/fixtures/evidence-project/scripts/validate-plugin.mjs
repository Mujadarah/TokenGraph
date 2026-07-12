import { releaseFiles } from "./package-plugin.mjs";
export function validatePlugin() { return releaseFiles.includes("dist/index.js"); }
