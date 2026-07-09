# Permissions

TokenGraph reads local workspace files to build a local project graph. It writes local state under `.tokengraph/` in the indexed workspace.

Users can delete indexes and memories. Index reset preserves memory and config by default unless a full state reset is explicitly requested.

TokenGraph does not require an OpenAI API key, cloud sync, embeddings service, hosted database, or paid external API.
