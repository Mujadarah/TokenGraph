# Release packaging runbook

Release validation begins with the package script and its declared file selection. The bundled runtime entry point, install metadata, documentation, and host configuration must agree. Generated release output is never edited as the source of truth. The package command regenerates it from implementation inputs, after which validation checks required files, forbidden files, path privacy, and manifest shape.

Smoke testing runs the bundled release entry point rather than only source modules. The result records tool count and basic protocol behavior. Validation and smoke are separate gates: validation can catch packaging structure while smoke catches startup behavior. Both must pass before publication. A version change or release generation is outside this benchmark fixture; the fixture only supplies deterministic routing evidence for the relevant scripts.

Net savings subtract tool-call and compact-footer overhead. A positive gross difference is insufficient when the orchestration cost consumes it. Release evidence reports failure cases rather than hiding them. Fixture results are local and repeatable, not universal proof that Codex or Claude will select the same files or produce the same patch. Paired host evaluation remains a later release gate and should compare identical tasks, repository states, and acceptance checks.
