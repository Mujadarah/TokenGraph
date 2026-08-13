# Task 9 Native Build Path Remapping Decision

Date: 2026-08-13

Status: decided

## Context

Task 9 produced and independently verified all six native addons. Task 10 then
applied the existing public-release machine-path scan to the committed source
assets. Both Windows PE files contain the hosted runner's user-profile prefix.
Their manifests and receipts are otherwise valid, but packaging those bytes
would violate the repository rule that machine-local state must not enter public
release files.

The existing build flags remap the repository checkout only. Rust dependencies
and toolchain inputs can still contribute paths rooted at the Windows user
profile, so checkout-only remapping is insufficient.

## Decision

1. The native validator rejects an addon containing a Windows user-profile,
   POSIX home-directory, or macOS user-directory path even when its declared
   byte length and SHA-256 are correct. The error remains path-free.
2. Windows native builds add a deterministic Rust path-prefix remap from the
   build user's profile directory to `/tokengraph-build-user`, in addition to
   the existing checkout remap and reproducible/static-CRT flags.
3. Task 9 is reopened. The temporary bootstrap branch, exact-SHA six-target
   workflow dispatch, receipt verification, source asset regeneration, cleanup,
   and independent adversarial review must be repeated from the corrected build
   commit.
4. Task 10 remains at RED until the corrected source assets pass native
   validation. Packaging or validation must not exclude native binaries from
   the machine-path boundary and must not weaken the existing public-file scan.

## Rejected alternatives

- Treating a hosted-runner username as harmless: it is still machine-local
  build state and would make the stated release boundary false.
- Excluding `.node` files from path scanning: that would hide the defect rather
  than prevent it.
- Editing the PE files after signing or assembly: byte mutation would invalidate
  the trusted receipt, manifest, and exact-SHA workflow evidence.
- Rebuilding only the two Windows files locally: Task 9 requires one trusted
  six-target assembly from a single workflow commit.

## Consequences

The corrected artifacts will have new hashes and Task 9 evidence. No runtime
selection, activation, lock, identity, attestation, or hook boundary changes.
The temporary profile value is used only to construct compiler remapping flags;
it is not written to receipts, manifests, documentation, or generated release
metadata.
