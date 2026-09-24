const semanticVersion = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export function assertReleaseVersion(version) {
  if (!version) throw new Error("release version is required.");
  if (!semanticVersion.test(version)) throw new Error("release version must be a semantic version in x.y.z form.");
  return version;
}

export function normalizeReleaseNotes(notes) {
  return notes.replace(/\r\n?/g, "\n");
}

export function renderReleaseNotes(version) {
  const resolvedVersion = assertReleaseVersion(version);
  return `TokenGraph ${resolvedVersion} release notes.

Automated release built from the tagged commit. CI produces the installable ZIP, checksum files, SPDX JSON, and keyless Sigstore bundles, verifies the signatures before upload, and records GitHub build-provenance and SBOM attestations.

Native file locking ships for six Windows, macOS, and glibc Linux targets. Doctor remains read-only, low-write telemetry stays local and content-free, and change capsules derive only from local Git state and bounded target content.

Plugin Eval scenarios and the existing paired-host and deterministic benchmark tracks remain release evidence, not universal quality or token-savings claims.

Current release contract:
B7 polyglot indexing is active by default and independent of routing promotion.
Routing remains shadow-only.
Enforcement remains disabled.
`;
}
