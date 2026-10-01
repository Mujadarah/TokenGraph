# v0.25 Source Integration Decision

Date: 2026-09-20

## Decision

The Phase 4 through Phase 11 implementation stack is integrated in source as v0.25.0. The v0.24 runtime-foundation work is absorbed into v0.25 rather than presented as a separately published release.

Routing remains shadow-only. B7 polyglot parsing remains independently active. Managed hooks remain permanently unactivated and project-read-only.

The repository has no canonical terms-of-service URL. This integration explicitly accepts the current Plugin Eval warning for the absent `interface.termsOfServiceURL`; the privacy-policy URL will not be reused as a terms-of-service URL.

## Evidence boundary

This commit prepares source, manifests, contracts, and documentation only. At maintainer direction, it does not run local typecheck, tests, builds, smoke tests, benchmarks, Plugin Eval, package validation, or release packaging.

`release/tokengraph/` therefore remains generated output from the last published source state. It must be regenerated only with `pnpm package:plugin -- --release`, never edited by hand.

Before merge, tag, or publication, Phase 12 still requires the complete source gate, regenerated-release byte parity, extracted-ZIP smoke and checksum validation, independent review, and live Plugin Eval evidence. An actual publication additionally requires fresh managed-runtime verification and redownloaded public ZIP, SBOM, Sigstore, GitHub attestation, and release-note verification.

## Publication boundary

This source-integration branch is not merge-ready, tagged, or published by this decision. Any pull request must disclose the deferred executable evidence and generated-release state. Merge, tag, publication, and installed-runtime changes require separate explicit approval.
