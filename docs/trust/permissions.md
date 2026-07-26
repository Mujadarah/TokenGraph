# Permissions

TokenGraph reads local workspace files to build a local project graph. It writes local state under `.tokengraph/` in the indexed workspace.

On Codex, the reviewed lifecycle hook writes a privacy-minimal, session-keyed workspace attestation under the operating-system temporary directory. The installed MCP server reads only the attestation matching its host-provided `CODEX_THREAD_ID`; it does not treat tool arguments as trust authority.

Users can delete indexes and memories. Index reset preserves memory and config by default unless a full state reset is explicitly requested.

TokenGraph does not require an OpenAI API key, cloud sync, embeddings service, hosted database, or paid external API.
