# Codex host lifecycle baseline

This diagnosis preserves the v0.23 Desktop workspace-trust design. It records
the host rows that the regression suite protects; it is not a request to add a
new fallback or loosen the trust boundary.

## Resolver history

v0.22.2 used a five-tier process resolver, in this order:

1. `CLAUDE_PROJECT_DIR`
2. `TOKENGRAPH_WORKSPACE_ROOT`
3. `CODEX_THREAD_ID` matched to a lifecycle-hook attestation
4. MCP Roots
5. The process working directory when the server was not launched from its
   installed plugin root

Earlier v0.22 releases predated the complete five-tier host bridge. That v0.22.2
model was safe for a single task but could not prove that an MCP request
belonged to the process-level Codex thread. v0.23 resolves the Codex request
metadata for every call. Its advertised project root and thread id must match
the lifecycle attestation for the same thread and installed plugin root. A
request with Codex metadata never falls back to a process-wide root when that
proof is missing or mismatched.

## Verified Desktop rows

| Host lifecycle | Required evidence | Expected setup result |
| --- | --- | --- |
| Normal Desktop task | Matching request metadata and trusted hook attestation | `ready` with the attested project root |
| Fresh Desktop task | `SessionStart` payload with `session_id`, `turn_id`, and `cwd`, followed by matching request metadata | `ready`; the hook persists only hashed plugin and session identities plus the canonical root |
| Prompt refresh | `UserPromptSubmit` payload with the same host fields | The matching attestation is refreshed and the next matching request is `ready` |
| Concurrent projects | Separate thread ids, roots, and attestations on concurrent MCP calls | Each call selects only its own root; no process-global state is used |
| Restarted Desktop task | A new trusted lifecycle attestation followed by matching metadata | `ready` for the new task only |
| Reinstalled plugin | A trusted lifecycle attestation created under the new installed plugin root | `ready` only after the new root's hook has attested the task; the old plugin-root hash cannot satisfy it |

The automated baseline covers the fresh, prompt-refresh, concurrent, mismatch,
and blocked cases using the built hook entrypoint and built stdio server. The
restart and reinstall rows follow the same installed-plugin-root and
session-keyed attestation contract; they require a fresh trusted Desktop task.

## Deliberately blocked rows

| Host condition | Result | Reason |
| --- | --- | --- |
| Hooks disabled or untrusted, no MCP Roots, no explicit override | `blocked` with `missing-trusted-workspace` | There is no host authority for project files |
| `codex exec` or a CLI-launched server with only `CODEX_THREAD_ID` | `blocked` with `missing-trusted-workspace` | A shell environment variable is not a lifecycle attestation or per-call Desktop metadata |
| Metadata thread does not match its attestation | `blocked` | It must not select another task's state |
| Metadata root does not match the attested root for its thread | `blocked` | It must not select another project's state |

For a supported compatibility launch when hooks are unavailable, set
`TOKENGRAPH_WORKSPACE_ROOT` before starting Codex. Do not treat a tool argument
as a trust override.

## Decision

Preserve the current implementation. The request-metadata plus lifecycle-
attestation check, `AsyncLocalStorage` request isolation, existing compatibility
sources, public setup fields, hooks, and `.mcp.json` working-directory contract
remain unchanged. This baseline intentionally does not promote routing or alter
B7 parser activation.
