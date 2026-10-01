# Phase 8 specialized-skill compaction boundary

Status: source contract prepared; execution and packaged-host evidence are
deferred by the maintainer.

The `tokengraph` skill is the single canonical owner of setup, trusted-root,
task-id, pause, completion, hook, artifact-key, and fallback lifecycle rules.
The eight specialized skills retain only their trigger, negative trigger,
unique core-tool sequence, evidence requirements, failure boundaries, and
completion criteria.

- All nine skill names remain present and invocation-compatible.
- Every specialized skill explicitly loads the shared router contract before
  calling TokenGraph. If that bundled router cannot be loaded, the skill makes
  no TokenGraph call; its unique evidence and fallback boundary remain readable
  rather than reconstructing a partial lifecycle.
- Specialized skills reference only the eight core tools. They do not repeat
  setup, task reporting, paused-task, normal-Stop, or unavailable-tool prose.
- The router remains independently complete. Specialized files remain useful
  as role-specific instructions only when the same plugin installation also
  provides its router, which is a packaging invariant checked for source,
  generated release, and extracted archives.
- Each specialized file is at most 170 words and the eight-file total is at
  most 1,300 words. Safety sections and role-specific evidence markers are not
  removed to meet the budget.
- The checked-in generated release remains on the legacy skill contract until
  the authorized release-generation stage. Transitional validation accepts an
  entirely legacy release or an entirely core source set, never a mixed set.

Required deferred evidence includes the static skill contracts, source plugin
validation, regenerated release parity, extracted-ZIP validation, and actual
Codex plugin loading with the router and a specialized skill. No RED, GREEN,
packaged, or host execution is claimed here.
