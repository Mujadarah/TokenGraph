# Plugin Eval host-provenance preflight v1

This preflight corrects two Plugin Eval 0.1.2 provisioning assumptions: copied
Git marketplace settings require snapshots that a new Codex home does not have,
and `tokengraph@tokengraph` does not enable `tokengraph@plugin-eval-benchmark`.
It does not run a scenario, verifier, benchmark, model, hook, or TokenGraph server.

The versioned JSON contract pins Plugin Eval **0.1.2**, its provisioner source
SHA-256 (with LF normalization), and Codex CLI **0.159.2**. A different version
or provisioner requires a reviewed contract change. The plugin manifest is the
Plugin Eval version authority; its npm package.json still reports 0.1.0.

From `plugins/tokengraph`, supply existing tool locations:

```sh
node scripts/plugin-eval-preflight.mjs \
  --plugin-eval-root "$PLUGIN_EVAL_ROOT" \
  --codex-bin "$CODEX_BIN"
```

`CODEX_BIN` must identify the actual executable, rather than a Windows .ps1 or
.cmd shim. `--target` optionally selects a plugin package; the default is the
existing generated `release/tokengraph` from this checkout. No release files are
edited or regenerated. On POSIX hosts, `--auth-file` optionally supplies an
existing private authentication file. Windows v1 rejects that option before
reading or copying authentication: file modes do not establish Windows ACL
privacy. No authentication or caller configuration is copied by
default. Existing tooling is required; this script installs nothing.

The wrapper creates an owned temporary root and a seed config containing only:

```toml
[plugins."tokengraph@plugin-eval-benchmark"]
enabled = true
```

It passes that seed through Plugin Eval's existing
`PLUGIN_EVAL_CODEX_HOME_SOURCE` input, in a separate child process. Caller
marketplaces, enable entries, project trust, MCP settings, hook trust state and
credential environment variables are excluded. Explicit POSIX authentication
remains inside the 0700 temporary root with 0600 file permissions. Windows
catalog checks remain authentication-free. The unmodified
provisioner receives an empty workspace input in copy mode; no Git worktree is
registered. Even partial provisioning failures remain under the owned root.

CLI 0.159.2's plugin-list command does not supply cwd as a marketplace root.
The wrapper therefore supplies the generated workspace root with process-only
`marketplaces.plugin-eval-benchmark` configuration overrides. These do not
persist settings, install/refresh a marketplace, or approve hooks.

The report distinguishes these gates:

| Gate | Evidence |
| --- | --- |
| Catalog resolution | The actual read-only CLI listing resolves one exact benchmark plugin entry. |
| Configured enablement | The resolved entry reports enabled=true under the effective listing configuration. AVAILABLE alone is insufficient. |
| Host registration | Unverified: a catalog listing is not runtime MCP tool registration. The plugin is not installed. |
| SessionStart hook review | Unverified; no trust state is written and no hook is invoked. |
| Same-thread workspace attestation | Unverified; no attestation is constructed or copied. |

The report always sets `readyForLiveScenario=false`. Exit 0 means only the two
catalog/configuration gates and cleanup passed. Native OS-managed configuration
can still apply; the wrapper does not bypass enforced requirements. Raw command
output, private paths and auth contents are excluded from reports. Cleanup runs
in finally, checks the owned root's identity before deletion, and checks absence
afterward. A cleanup failure produces exit 1 and cleanup.verified=false.

[Official plugin documentation](https://developers.openai.com/plugins/build/plugins)
describes catalog roots, identity-specific enablement and project trust.
[Official App Server documentation](https://learn.chatgpt.com/docs/app-server)
provides `mcpServerStatus/list` for server/tool state. That is a possible supported
observation mechanism for a later authorized host session; it is not performed
here because this preflight neither installs nor starts the benchmark plugin.
No claim is made that supported no-model observation is impossible. App Server
`plugin/list` is documented as under development and is not used by this wrapper.

Focused regression command, using the existing dependencies and tools:

```sh
TOKENGRAPH_PLUGIN_EVAL_ROOT="$PLUGIN_EVAL_ROOT" \
TOKENGRAPH_CODEX_BIN="$CODEX_BIN" \
node node_modules/vitest/vitest.mjs run \
  tests/plugin-eval-preflight.test.ts tests/plugin-eval-contract.test.ts
```

Without those two tool variables, the real-host integration cases explicitly
skip. Static contract checks still run; skipped cases are not verification.
Tests use disposable fixtures and genuine read-only CLI calls, including the
inherited-snapshot failure and identity mismatch. They never run a live scenario.
Windows runs verify authentication refusal; POSIX authentication-copy cleanup
is exercised only by POSIX runs and remains unverified from Windows evidence.

The one next Linux-host action after independent review is to run this same
no-model preflight against the pinned tools and existing generated package,
retaining its privacy-safe JSON and cleanup result. Stop on any pin, gate, or
cleanup failure. Actual registration, review of the exact SessionStart hook,
genuine same-thread attestation, scenario execution, and the complete Phase 12
gate remain separate later work. No release-readiness claim follows from v1.
