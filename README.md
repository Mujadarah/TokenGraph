# TokenGraph

[![CI](https://github.com/Mujadarah/TokenGraph/actions/workflows/ci.yml/badge.svg)](https://github.com/Mujadarah/TokenGraph/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/Mujadarah/TokenGraph)](https://github.com/Mujadarah/TokenGraph/releases/latest)

TokenGraph is a local-first plugin for Codex and Claude Code. It indexes a trusted workspace locally, then helps coding agents use compact project maps, context plans, SQL summaries, wiki pages, memories, failure traces, and compressed logs before broad raw-file reads.

- No OpenAI or Anthropic API key required.
- No cloud index, embeddings service, telemetry, or paid external service.
- Current release: `0.20.0`.
- Runtime: Node.js 22 or newer.
- Source-available under the repository [license](LICENSE).

## Install from GitHub

The GitHub marketplace route is the recommended installation path. It installs the committed, self-contained plugin under `release/tokengraph`; users do not run `pnpm install` or build TypeScript.

### Codex

```powershell
codex plugin marketplace add Mujadarah/TokenGraph
codex plugin add tokengraph@tokengraph
codex plugin list --json
```

Codex must provide a trusted project root. When the client does not support MCP Roots, start Codex from the project with the environment variable set:

```powershell
$env:TOKENGRAPH_WORKSPACE_ROOT=(Get-Location).Path
codex
```

```bash
TOKENGRAPH_WORKSPACE_ROOT="$PWD" codex
```

Start a new task after installation or configuration changes. In Codex Desktop, the task must receive MCP Roots from the host or the app must be launched with `TOKENGRAPH_WORKSPACE_ROOT` already configured. TokenGraph deliberately stays blocked rather than trusting an arbitrary tool argument.

### Claude Code

Run these commands inside Claude Code:

```text
/plugin marketplace add Mujadarah/TokenGraph
/plugin install tokengraph@tokengraph
/reload-plugins
```

Non-interactive equivalents are also available:

```bash
claude plugin marketplace add Mujadarah/TokenGraph
claude plugin install tokengraph@tokengraph
```

Claude Code forwards `CLAUDE_PROJECT_DIR` to TokenGraph automatically.

## Install the release ZIP

Download `tokengraph-0.20.0.zip` from the [latest GitHub release](https://github.com/Mujadarah/TokenGraph/releases/latest) and extract it. The extracted directory is a standalone marketplace root containing both host catalogs and the installable `tokengraph/` plugin.

```powershell
codex plugin marketplace add C:\path\to\tokengraph-0.20.0
codex plugin add tokengraph@tokengraph
```

```bash
claude plugin marketplace add /path/to/tokengraph-0.20.0
claude plugin install tokengraph@tokengraph
```

Use a generic placeholder or your own local path; never publish a machine-specific profile path.

## First use

Ask the agent:

> Use TokenGraph to check setup, index this project, and plan compact context before reading raw files.

The expected sequence is:

1. `tokengraph_setup` reports `ready` and identifies the host-provided trust source.
2. `tokengraph_prepare_context` indexes or refreshes the workspace, plans focused context, and returns one task id plus the trusted root.
3. Reuse that exact task id and root with `tokengraph_query_context`, `tokengraph_compress`, `tokengraph_recall`, or `tokengraph_analyze` only as the task requires.
4. Call `tokengraph_task_report` with `pause` or `complete` before stopping.

The setup diagnostic never grants filesystem trust. If it reports `blocked`, follow its recovery steps and restart or reload the host.

## What agents can use

TokenGraph exposes eight compact intent-level tools by default and 42 tools on the opt-in full compatibility surface. Nine focused skills cover:

- setup diagnosis and workspace-safe indexing;
- project maps, symbol/import search, and context planning;
- PostgreSQL and Supabase migration/RLS summaries;
- local wiki and memory lifecycle workflows;
- architecture rules, failure tracing, and regression risk;
- context, logs, builds, tests, diffs, and SQL compression;
- token-saving profiles and release-package auditing.

See the [source plugin guide](plugins/tokengraph/README.md) for the complete tool catalog.

## v0.20 behavior and evidence

Every measured task has one canonical completion footer backed by a task ledger. JSON-only MCP successes return one serialized JSON `TextContent` item; `tokengraph_export_project_map` remains the documented resource-link exception. Wiki and memory updates use source-linked review-before-apply proposals: listing and proposing do not mutate derived knowledge, approval rechecks current provenance, and stale or expired proposals fail.

The checked-in 30-task benchmark preserves 100% of critical constraints, has zero critical false negatives, reaches 100% required-file recall, and reports median estimated net savings of 30.5 tokens after response, schema, and footer overhead. Its 25th percentile is -166 tokens and 11 tasks remain individually non-positive. Every category has fewer than 10 observations, so confidence remains low. These are deterministic estimates, not provider billing counts or universal quality proof.

Lifecycle hooks are cooperative automation. Users must review and trust them; they can be disabled, and interrupts, process termination, StopFailure, or API failure do not run normal completion enforcement. Missing or corrupt hook state fails open with a warning.

## Documentation

- [Codex installation and runtime](docs/hosts/codex.md)
- [Claude Code installation and runtime](docs/hosts/claude-code.md)
- [Generic MCP clients](docs/hosts/generic-mcp.md)
- [Privacy and local storage](docs/trust/privacy.md)
- [Security and workspace trust](docs/trust/security.md)
- [Release installation](docs/trust/release-install.md)
- [Benchmark methodology and claims](docs/benchmarks/methodology.md)
- [Release history and roadmap](ROADMAP.md)

## Troubleshooting

- Setup is blocked: call `tokengraph_setup` and apply the host-specific recovery steps.
- Plugin is missing: inspect `codex plugin marketplace list` and `codex plugin list --json`, or `/plugin` in Claude Code.
- Tools are missing after install: start a new Codex task or run `/reload-plugins` in Claude Code.
- Context is stale: start a fresh task and rerun `tokengraph_prepare_context`; it refreshes the index before planning.
- Release ZIP will not install: add the extracted bundle root, not its nested `tokengraph/` directory.

## Maintainer workflow

Implementation lives under `plugins/tokengraph/`. The committed `release/tokengraph/` directory is generated output.

```powershell
cd plugins/tokengraph
pnpm install
pnpm typecheck
pnpm test
pnpm build
pnpm smoke -- --root . --json
pnpm validate:plugin
pnpm package:plugin -- --json
pnpm package:plugin -- --release --json
```

The default package command creates `artifacts/tokengraph-<version>/` and a deterministic, standalone `artifacts/tokengraph-<version>.zip`.

## Privacy

Indexes, configuration, wiki pages, token events, rules, and memories stay under `.tokengraph/` in the trusted workspace. Token savings are estimates, and TokenGraph does not replace code review or guarantee correctness.
