# Agent instructions

- Edit implementation under `plugins/tokengraph/`.
- Treat `release/tokengraph/` as generated output; regenerate it with `pnpm package:plugin -- --release`.
- Run typecheck, tests, build, smoke, and plugin validation before claiming a change is complete.
- Keep paths, secrets, and machine-local state out of public docs and release files.
- Use conventional commit messages and keep each phase in its own dependent branch.
- Treat published CHANGELOG entries and GitHub release notes as append-only; correct them with dated correction notes, never silent in-place edits.
