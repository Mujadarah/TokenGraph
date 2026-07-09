# Privacy

TokenGraph is local-first. It stores project state under `.tokengraph/` in the indexed workspace.

TokenGraph does not require an OpenAI API key. It does not require cloud sync. It does not require embeddings service. It does not add telemetry.

TokenGraph respects .gitignore, excludes secrets by default, and excludes dependency folders and build output by default.
