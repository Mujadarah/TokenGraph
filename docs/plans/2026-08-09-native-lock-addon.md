# TokenGraph Phase 3 Native Lock Addon Implementation Plan

> **For Codex:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace TokenGraph's stale-mtime pathname locks with crash-released OS kernel locks while preserving a versioned diagnostic lease and safely excluding pre-upgrade runtimes.

**Architecture:** A pinned Rust Node-API addon holds `LockFileEx` or `flock` in the TokenGraph process. A closed eight-domain registry derives one fixed anchor and one fixed recovery journal per authorized storage root; keys in one domain intentionally serialize. The exact legacy `lockPath` becomes a temporary nonempty compatibility directory containing `lease.json` while owned, which blocks stale old locks and accidental same-key downgrades and is removed after clean release. TypeScript owns bounded retry, cancellation, journal reconciliation, lease recovery, heartbeat, nonce-checked cleanup, and error aggregation. Every v2 lock is disabled until the current process receives explicit confirmation that no v0.23.1 process is running; mixed-runtime concurrency is unsupported.

**Tech Stack:** Node.js 22+, TypeScript 5.9, Vitest 3, Rust 1.97.1, napi-rs 3, `windows-sys` 0.61.2, `rustix` 1.1.4, GitHub Actions native runners.

---

## Global Constraints

- Keep implementation under `plugins/tokengraph/`; `release/tokengraph/` is generated only by `pnpm package:plugin -- --release`.
- Pin Rust `1.97.1`, Node-API `9`, `napi = 3.12.0`, `napi-derive = 3.6.2`, `napi-build = 2.4.0`, `windows-sys = 0.61.2`, and `rustix = 1.1.4` in committed manifests and `Cargo.lock`.
- Ship exactly `win32/x64`, `win32/arm64`, `linux/x64` glibc, `linux/arm64` glibc, `darwin/x64`, and `darwin/arm64`; Linux musl and every unlisted target fail closed.
- Match Node 22 floors: Linux kernel 4.18 and glibc 2.28, Windows 10 or Server 2016 for x64, Windows 10 for arm64, and macOS 11.0.
- Define the compatibility directory as the exact canonical legacy `lockPath` passed to `withFileLock`; never redirect old-runtime exclusion to a hash-derived location.
- Derive the authoritative anchor and journal only through the closed `workspace-state`, `repository-state`, `runs`, `tasks`, `vault`, `wiki`, `artifacts`, and `git-info` registry. Store fixed `.tokengraph-native-anchor-v2.lock` and `.tokengraph-native-journal-v2.lock` in the registered root; reject arbitrary/dynamic parents.
- Remove a clean empty compatibility directory and commit the next neutral idle journal generation while still holding its domain anchor; after generation-zero bootstrap the journal target is never absent or deleted. Recover only valid dead crash residue. Permanent infrastructure and unresolved barrier count must not scale with run, task, or artifact ids.
- Treat the kernel lock as authority. `{schemaVersion,pid,nonce,startedAt,heartbeatAt}` is diagnostic state and never grants or breaks kernel ownership.
- Old-runtime files, malformed leases, partial leases, linked state, and unknown PID liveness fail closed. No automatic migration deletes ambiguous residue.
- Require a non-persisted, opaque process-lifetime activation capability before every v2 lock. MCP activation occurs only through confirmed `tokengraph_setup`; CLI activation lasts only an invocation with `--confirm-no-legacy-processes`. Starting any v0.23.1 process invalidates the operational assertion and requires v2 restart/reactivation.
- Use nonblocking native acquisition. JavaScript owns bounded wait and `AbortSignal`; no native wait blocks the event loop.
- Use no runtime download, compiler invocation, network lookup, sidecar process, or JavaScript lock fallback in installed runtime code.
- Fail-stop the TokenGraph process if native unlock/close cannot prove release; do not continue after uncertain ownership.
- Preserve exact-path same-process serialization, restrictive permissions, symlink/junction refusal, canonical keys, nonce-checked release, and operation-plus-cleanup `AggregateError` behavior.
- Reserve exactly `.tokengraph-native-journal-v2.lock.tokengraph-write-v2.tmp`
  in each domain root and `lease.json.tokengraph-write-v2.tmp` inside the sole
  journal-identified compatibility directory. Before an identity can be
  durably recorded, recovery may treat only these names, or the exact directory
  authorized by `pendingBarrier`, as TokenGraph-owned while the anchor is held
  and target-absent generation-zero bootstrap, a predecessor-bound journal
  successor, or a valid unchanged stale/dead active pending transition, full
  parent enumeration/classification, stable no-follow type,
  current owner, and restrictive mode all match. Require link count one only
  for regular files; validate compatibility directories by non-reparse
  directory type, stable identity, and closed contents. Preserve every
  recorded-identity mismatch, link, reparse point,
  unexpected entry, or indeterminate owner; equal bytes never prove identity.
- Explicit purge/reset requires a fresh per-operation `confirmedNoLegacyTokenGraphProcesses: true`; automatic cleanup requires the active process capability. Acquire affected domain anchors in canonical order, delete selectively with unlocked primitives, preserve anchor/journal/root infrastructure, and never recursively delete a domain root or active `.lock` barrier.
- Network filesystems and hostile same-account path replacement remain explicitly best-effort/out of scope; never claim a distributed or adversarial local lock.
- The reserved authority is the approved narrow relaxation for cooperative
  local TokenGraph processes: an accidental object at an exact reserved
  provisional name may be treated as protocol-owned only in target-absent
  bootstrap, a predecessor-bound journal successor, or its closed active
  pending transition. Active malicious same-account mutation remains out of
  scope.
- Do not accept native binaries from fork artifacts. The first published archive containing them requires checksums, license notices, provenance, signing, SBOM coverage, and all six real target executions.
- Use conventional commits. Mandatory independent concurrency/security review occurs after the full diff and again after any review fix.

## File Structure

### Native source

- Create `plugins/tokengraph/native/lock-addon/rust-toolchain.toml`: exact toolchain and components.
- Create `plugins/tokengraph/native/lock-addon/Cargo.toml`: pinned crate graph and `cdylib` output.
- Create `plugins/tokengraph/native/lock-addon/Cargo.lock`: locked transitive graph.
- Create `plugins/tokengraph/native/lock-addon/build.rs`: napi-rs setup only.
- Create `plugins/tokengraph/native/lock-addon/src/lib.rs`: Node-API ABI, opaque handle, explicit release, and fail-stop boundary.
- Create `plugins/tokengraph/native/lock-addon/src/platform/mod.rs`: common `PlatformLock` contract.
- Create `plugins/tokengraph/native/lock-addon/src/platform/windows.rs`: retained component handles plus `LockFileEx`.
- Create `plugins/tokengraph/native/lock-addon/src/platform/unix.rs`: `openat` component walk plus `flock`.
- Create `plugins/tokengraph/native/lock-addon/tests/lock_contract.rs`: native lifecycle and stable-error tests.

### TypeScript lock boundary

- Create `plugins/tokengraph/src/core/nativeLockAddon.ts`: manifest selection, integrity verification, ESM loading, and typed native wrapper.
- Create `plugins/tokengraph/src/core/legacyRuntimeActivation.ts`: opaque non-persisted process activation capability and fail-closed status.
- Create `plugins/tokengraph/src/core/fileLockLease.ts`: upgrade directory, retry, liveness, lease, heartbeat, cleanup, and same-process queue.
- Modify `plugins/tokengraph/src/core/storage.ts`: closed lock-domain registry, branded canonical lock objects, maintenance locking, and delegation to `fileLockLease.ts`.
- Modify all `withFileLock` callers listed by `rg -l 'withFileLock' plugins/tokengraph/src/core`: require a registry-produced branded lock object instead of appending `.lock` ad hoc.

### Native assets and packaging

- Create `plugins/tokengraph/assets/native-lock/manifest.json`: six sorted target records with ABI, target, floor, byte length, and SHA-256.
- Create `plugins/tokengraph/assets/native-lock/THIRD_PARTY_NOTICES.txt`: validated native dependency notices.
- Create six `plugins/tokengraph/assets/native-lock/<target>/tokengraph-lock.<target>.node` files.
- Create `plugins/tokengraph/scripts/build-native-lock-addon.mjs`: deterministic one-target build/copy command.
- Create `plugins/tokengraph/scripts/generate-native-lock-manifest.mjs`: exact sorted manifest and notices generation.
- Create `plugins/tokengraph/scripts/validate-native-lock-addon.mjs`: source/release asset allowlist, hash, ABI, libc, and current-target load checks.
- Create `plugins/tokengraph/scripts/native-lock-probe.mjs`: bounded test-only stdin protocol for cross-process acquisition probes; it is not copied to the release.
- Modify `plugins/tokengraph/scripts/package-plugin.mjs`, `plugins/tokengraph/scripts/validate-plugin.mjs`, `plugins/tokengraph/package.json`, and `.gitattributes`.
- Modify generated `release/tokengraph/**` only through the packaging command.

### Tests, CI, and documentation

- Create `plugins/tokengraph/tests/native-lock-addon.test.ts`: loader and real current-target addon tests.
- Create `plugins/tokengraph/tests/storage-lock.test.ts`: deterministic lease/state-machine tests.
- Create `plugins/tokengraph/tests/storage-lock-process.test.ts`: multi-process, crash, exact-path, and upgrade-barrier probes.
- Create `plugins/tokengraph/tests/native-lock-packaging.test.ts`: manifest, archive, release, and tamper tests.
- Create `plugins/tokengraph/tests/native-lock-workflow.test.ts`: six runner labels, immutable action pins, and gate ordering.
- Create `plugins/tokengraph/tests/fixtures/legacy-file-lock-worker.mjs`: frozen v0.23.1 lock behavior for bidirectional upgrade tests.
- Create `.github/workflows/native-lock.yml`: six real OS/architecture builds and tests.
- Modify `plugins/tokengraph/tests/foundations.test.ts`, `plugins/tokengraph/tests/cli-smoke.test.ts`, `plugins/tokengraph/tests/mcp-smoke.test.ts`, `plugins/tokengraph/tests/low-write-policy.test.ts`, `plugins/tokengraph/README.md`, `docs/trust/security.md`, `docs/trust/limitations.md`, and `docs/trust/release-install.md`.

---

### Task 1: Scaffold the pinned Node-API crate

**Files:**
- Create: `plugins/tokengraph/native/lock-addon/rust-toolchain.toml`
- Create: `plugins/tokengraph/native/lock-addon/Cargo.toml`
- Create: `plugins/tokengraph/native/lock-addon/Cargo.lock`
- Create: `plugins/tokengraph/native/lock-addon/build.rs`
- Create: `plugins/tokengraph/native/lock-addon/src/lib.rs`
- Create: `plugins/tokengraph/native/lock-addon/src/platform/mod.rs`
- Create: `plugins/tokengraph/native/lock-addon/tests/lock_contract.rs`

**Interfaces:**
- Produces native exports `abiVersion: 1`, `implementation(): "lockfileex" | "flock"`, and `tryAcquireAnchor(path: string): NativeLockHandle`.
- Produces `NativeLockHandle.protectCompatibilityDirectory(path)`, `releaseCompatibilityDirectory()`, and `release()`; handles are opaque, non-cloneable, and enforce transition order.
- Produces Rust `PlatformLock::try_acquire(&Path) -> Result<PlatformLock, LockError>` and `PlatformLock::release(self) -> Result<(), LockError>` for Tasks 2-3.

- [ ] **Step 1: Write the failing ABI contract test**

```rust
#[test]
fn abi_is_pinned_to_one() {
    assert_eq!(tokengraph_lock::ABI_VERSION, 1);
}

#[test]
fn stable_errors_never_include_the_anchor_path() {
    let error = tokengraph_lock::LockError::unsafe_anchor();
    assert_eq!(error.code(), "UNSAFE_ANCHOR");
    assert!(!error.safe_message().contains('/') && !error.safe_message().contains('\\'));
}
```

- [ ] **Step 2: Run the test to verify the crate is absent**

Run: `cargo test --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked`

Expected: FAIL because `Cargo.toml` does not exist.

- [ ] **Step 3: Add the exact crate configuration**

```toml
[package]
name = "tokengraph-lock"
version = "0.1.0"
edition = "2024"
rust-version = "1.97.1"
license = "Apache-2.0"
publish = false

[lib]
crate-type = ["cdylib", "rlib"]

[dependencies]
napi = { version = "=3.12.0", default-features = false, features = ["napi9"] }
napi-derive = { version = "=3.6.2", default-features = false, features = ["strict"] }

[target.'cfg(windows)'.dependencies]
windows-sys = { version = "=0.61.2", features = ["Win32_Foundation", "Win32_Storage_FileSystem", "Win32_System_IO", "Win32_System_Threading"] }

[target.'cfg(unix)'.dependencies]
rustix = { version = "=1.1.4", default-features = false, features = ["std", "fs", "process"] }

[build-dependencies]
napi-build = "=2.4.0"
```

`rust-toolchain.toml` must contain toolchain `1.97.1`, profile `minimal`, and components `rustfmt` and `clippy`. `build.rs` contains only `napi_build::setup();`.

- [ ] **Step 4: Implement the ABI and fail-stop ownership shell**

```rust
pub const ABI_VERSION: u32 = 1;

#[napi]
pub struct NativeLockHandle {
    inner: Option<platform::PlatformLock>,
}

#[napi]
impl NativeLockHandle {
    #[napi]
    pub fn protect_compatibility_directory(&mut self, path: String) -> napi::Result<()> {
        self.inner.as_mut().ok_or_else(LockError::already_released)?
            .protect_compatibility_directory(Path::new(&path)).map_err(Into::into)
    }

    #[napi]
    pub fn release(&mut self) -> napi::Result<()> {
        let lock = self.inner.take().ok_or_else(LockError::already_released)?;
        if let Err(error) = lock.release() {
            eprintln!("TokenGraph native lock release could not be proven: {}", error.code());
            std::process::abort();
        }
        Ok(())
    }
}
```

Use stable codes `LOCK_BUSY`, `UNSAFE_ANCHOR`, `UNSAFE_COMPATIBILITY_DIRECTORY`, `NATIVE_LOCK_ERROR`, `ALREADY_RELEASED`, and `INVALID_ARGUMENT`. Convert to `napi::Error` without including an absolute path or raw OS message. The finalizer closes on abandonment, but tests and TypeScript must use explicit compatibility release and anchor `release()`.

- [ ] **Step 5: Generate and verify the locked dependency graph**

Run: `cargo generate-lockfile --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml`

Run: `cargo fmt --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml -- --check`

Run: `cargo test --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked`

Expected: all ABI/error tests PASS; no default napi async, serde, tokio, network, or subprocess feature is enabled in `cargo tree -e features`.

- [ ] **Step 6: Commit**

```bash
git add plugins/tokengraph/native/lock-addon
git commit -m "build(tokengraph): scaffold native lock addon"
```

### Task 2: Implement Windows retained-handle locking

**Files:**
- Create: `plugins/tokengraph/native/lock-addon/src/platform/windows.rs`
- Modify: `plugins/tokengraph/native/lock-addon/src/platform/mod.rs`
- Modify: `plugins/tokengraph/native/lock-addon/tests/lock_contract.rs`

**Interfaces:**
- Consumes `PlatformLock` and stable `LockError` from Task 1.
- Produces a Windows `PlatformLock` that retains every no-delete-share directory handle plus the anchor handle until release.

- [ ] **Step 1: Write failing Windows ownership and path tests**

```rust
#[cfg(windows)]
#[test]
fn second_process_cannot_acquire_or_rebind_anchor() {
    let fixture = WindowsLockFixture::new();
    let first = fixture.acquire();
    assert_eq!(fixture.child_try_acquire().code(), "LOCK_BUSY");
    assert!(fixture.try_rename_parent().is_err());
    first.release().unwrap();
    assert!(fixture.child_try_acquire().is_ok());
}
```

Add cases for a junction component, final reparse point, directory anchor, hard-linked anchor, long path, case alias, double release, and process termination followed by bounded reacquire.

- [ ] **Step 2: Run the focused native test and observe RED**

Run: `cargo test --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked --target x86_64-pc-windows-msvc windows -- --nocapture`

Expected: FAIL because the Windows platform implementation is absent.

- [ ] **Step 3: Implement the component walk and fixed-byte lock**

```rust
struct WindowsLock {
    directory_handles: Vec<OwnedHandle>,
    anchor: OwnedHandle,
    compatibility_directory: Option<OwnedHandle>,
    overlapped: Box<OVERLAPPED>,
    released: bool,
}
```

For each directory component, call `CreateFileW` with `FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS` and `FILE_SHARE_READ | FILE_SHARE_WRITE` only. Reject `FILE_ATTRIBUTE_REPARSE_POINT`. Retain every returned handle. Open the anchor with `OPEN_ALWAYS`, `FILE_FLAG_OPEN_REPARSE_POINT`, the same no-delete share mask, and least read/write access required for locking. Require disk-file type, hardlink count one, expected volume/file identity, and normalized `GetFinalPathNameByHandleW` confinement. Call nonblocking `LockFileEx(LOCKFILE_EXCLUSIVE_LOCK | LOCKFILE_FAIL_IMMEDIATELY)` over byte `[0,1)`.

Map only lock contention to `LOCK_BUSY`. Any sharing, reparse, identity, path, or file-type ambiguity is `UNSAFE_ANCHOR`; unexpected native failure is `NATIVE_LOCK_ERROR`.

`protect_compatibility_directory` opens the exact directory with
`FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS`, rejects reparse or
identity mismatch, denies delete sharing, and retains that handle until
`release_compatibility_directory`. It never creates or removes the directory.

- [ ] **Step 4: Implement proven release and crash cleanup**

Normal cleanup first closes the compatibility-directory handle while retaining
the anchor. Final release calls `UnlockFileEx`, closes the anchor, then closes
the retained anchor-directory handles in reverse order. If unlock or close
cannot be proven, call `std::process::abort()` before returning to JavaScript.
Never call `DeleteFileW`, `MoveFileExW`, or recursively remove a path.

- [ ] **Step 5: Verify Windows behavior repeatedly**

Run: `cargo fmt --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml -- --check`

Run: `cargo clippy --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked --target x86_64-pc-windows-msvc --all-targets -- -D warnings`

Run: `1..20 | ForEach-Object { cargo test --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked --target x86_64-pc-windows-msvc windows -- --nocapture; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`

Expected: every repetition PASS; the terminated owner is always reacquired and no parent/anchor replacement succeeds while held.

- [ ] **Step 6: Commit**

```bash
git add plugins/tokengraph/native/lock-addon/src/platform plugins/tokengraph/native/lock-addon/tests/lock_contract.rs
git commit -m "feat(tokengraph): implement Windows native locks"
```

### Task 3: Implement POSIX descriptor-identity locking

**Files:**
- Create: `plugins/tokengraph/native/lock-addon/src/platform/unix.rs`
- Modify: `plugins/tokengraph/native/lock-addon/src/platform/mod.rs`
- Modify: `plugins/tokengraph/native/lock-addon/tests/lock_contract.rs`

**Interfaces:**
- Consumes the Task 1 `PlatformLock` contract.
- Produces one retained anchor descriptor protected by nonblocking exclusive `flock` on Linux and macOS.

- [ ] **Step 1: Write failing POSIX path and ownership tests**

```rust
#[cfg(unix)]
#[test]
fn anchor_identity_is_verified_before_flock() {
    let fixture = UnixLockFixture::new();
    assert_eq!(fixture.try_symlink_anchor().code(), "UNSAFE_ANCHOR");
    assert_eq!(fixture.try_hardlink_anchor().code(), "UNSAFE_ANCHOR");
    let first = fixture.acquire();
    assert_eq!(fixture.child_try_acquire().code(), "LOCK_BUSY");
    first.release().unwrap();
    assert!(fixture.child_try_acquire().is_ok());
}
```

Add cases for a symlinked parent, non-directory component, wrong owner, group/world-writable anchor, crash recovery, and distinct anchors held concurrently.

- [ ] **Step 2: Cross-check the code on all four Unix compilation targets**

Run: `rustup target add x86_64-unknown-linux-gnu aarch64-unknown-linux-gnu x86_64-apple-darwin aarch64-apple-darwin`

Run each target with: `cargo check --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked --all-targets --target <target>`

Expected: FAIL because `unix.rs` is absent or does not satisfy the shared contract.

- [ ] **Step 3: Implement the `openat` walk and `flock`**

```rust
struct UnixLock {
    anchor: OwnedFd,
    compatibility_directory: Option<OwnedFd>,
    released: bool,
}
```

Open the filesystem root, then walk every directory component with `rustix::fs::openat` and `OFlags::DIRECTORY | OFlags::NOFOLLOW | OFlags::CLOEXEC`. Open the final anchor relative to the retained parent with `OFlags::CREATE | OFlags::NOFOLLOW | OFlags::CLOEXEC | OFlags::RDWR` and mode `0o600`. Require a regular file, current effective uid, `st_nlink == 1`, no group/world permission bits, and matching descriptor versus `statat` device/inode. Acquire `FlockOperation::LockExclusiveNonblock` and retain the descriptor.

- [ ] **Step 4: Implement explicit release without pathname mutation**

Call `flock(fd, Unlock)` and close the descriptor. Abort the process if either action cannot be proven. Never unlink or rename the anchor. Document in the Rust module that another process with the same uid can unlink a POSIX file and that the supported boundary is cooperative TokenGraph processes in a restrictively owned directory.

Open the compatibility directory with `OFlags::DIRECTORY | OFlags::NOFOLLOW |
OFlags::CLOEXEC`, verify its device/inode against the entry, retain it for the
critical section, and close it before JavaScript removes the empty directory
while the anchor remains locked.

- [ ] **Step 5: Run local cross-checks and native Linux/macOS tests**

Run: `cargo fmt --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml -- --check`

Run all four `cargo check --all-targets --target <target>` commands from Step 2.

When running on Linux or macOS, also run: `cargo test --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked -- unix --nocapture`.

Expected: target checks pass. A Windows cross-check proves compilation only; Task 9 supplies the required real Linux/macOS execution evidence before Phase 3 can complete.

- [ ] **Step 6: Commit**

```bash
git add plugins/tokengraph/native/lock-addon/src/platform plugins/tokengraph/native/lock-addon/tests/lock_contract.rs
git commit -m "feat(tokengraph): implement POSIX native locks"
```

### Task 4: Build and validate deterministic native assets

**Files:**
- Create: `plugins/tokengraph/scripts/build-native-lock-addon.mjs`
- Create: `plugins/tokengraph/scripts/generate-native-lock-manifest.mjs`
- Create: `plugins/tokengraph/scripts/validate-native-lock-addon.mjs`
- Create: `plugins/tokengraph/tests/native-lock-packaging.test.ts`
- Modify: `plugins/tokengraph/package.json`
- Modify: `.gitattributes`

**Interfaces:**
- Produces `pnpm native:build -- --target <rust-target> --out <directory>`.
- Produces `pnpm native:manifest -- --assets <directory>` and `pnpm native:validate -- --assets <directory> [--load-current]`.
- Produces manifest schema `NativeLockManifestV1` consumed by Task 5.

- [ ] **Step 1: Write failing build/manifest contract tests**

```ts
expect(packageJson.scripts).toMatchObject({
  "native:build": "node scripts/build-native-lock-addon.mjs",
  "native:manifest": "node scripts/generate-native-lock-manifest.mjs",
  "native:validate": "node scripts/validate-native-lock-addon.mjs"
});
expect(manifest).toEqual({
  schemaVersion: 1,
  addonAbiVersion: 1,
  nodeApiVersion: 9,
  rustToolchain: "1.97.1",
  artifacts: expect.any(Array)
});
expect(manifest.artifacts.map((entry) => entry.id)).toEqual([
  "darwin-arm64", "darwin-x64", "linux-arm64-gnu",
  "linux-x64-gnu", "win32-arm64", "win32-x64"
]);
```

Add failures for a missing target, extra `.node`, wrong relative path, duplicate id, non-lowercase 64-character SHA-256, zero bytes, unsafe relative path, unsupported libc, ABI mismatch, and an unlisted dependency license.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/native-lock-packaging.test.ts --reporter=verbose`

Expected: FAIL because the scripts and package commands do not exist.

- [ ] **Step 3: Implement the exact target table**

```js
export const TARGETS = Object.freeze([
  { id: "darwin-arm64", platform: "darwin", arch: "arm64", libc: "none", rustTarget: "aarch64-apple-darwin", file: "tokengraph-lock.darwin-arm64.node", osFloor: "macos-11.0" },
  { id: "darwin-x64", platform: "darwin", arch: "x64", libc: "none", rustTarget: "x86_64-apple-darwin", file: "tokengraph-lock.darwin-x64.node", osFloor: "macos-11.0" },
  { id: "linux-arm64-gnu", platform: "linux", arch: "arm64", libc: "glibc", rustTarget: "aarch64-unknown-linux-gnu", file: "tokengraph-lock.linux-arm64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "linux-x64-gnu", platform: "linux", arch: "x64", libc: "glibc", rustTarget: "x86_64-unknown-linux-gnu", file: "tokengraph-lock.linux-x64.node", osFloor: "kernel-4.18-glibc-2.28" },
  { id: "win32-arm64", platform: "win32", arch: "arm64", libc: "none", rustTarget: "aarch64-pc-windows-msvc", file: "tokengraph-lock.win32-arm64.node", osFloor: "windows-10" },
  { id: "win32-x64", platform: "win32", arch: "x64", libc: "none", rustTarget: "x86_64-pc-windows-msvc", file: "tokengraph-lock.win32-x64.node", osFloor: "windows-10-server-2016" }
]);
```

Keep this table in `generate-native-lock-manifest.mjs` and export it for the validator. Reject target ids and output directories not in this table.

- [ ] **Step 4: Implement deterministic build output**

The build script invokes `process.env.CARGO || "cargo"` with `build --release --locked --manifest-path native/lock-addon/Cargo.toml --target <exact-target>`. Set `SOURCE_DATE_EPOCH` from the repository commit timestamp and add remap/strip flags without embedding the checkout path. Use `/Brepro` and explicit CRT linkage on Windows, `-mmacosx-version-min=11.0` and no random Mach-O UUID on macOS, and the RHEL 8/glibc 2.28 container in the Linux workflow. Copy only the final library bytes to `<out>/<target-id>/<exact-file>`; never copy PDB, dSYM, Cargo metadata, or source paths.

- [ ] **Step 5: Implement manifest and license generation**

For every sorted target, `lstat` without following links, require a regular nonempty file, compute byte length and SHA-256, and emit stable two-space JSON with a trailing newline. Generate `THIRD_PARTY_NOTICES.txt` from the native addon's complete resolved `cargo metadata --locked` dependency closure. The closed, exact-expression allowlist is: `Apache-2.0`, `Apache-2.0 WITH LLVM-exception`, `MIT`, `MIT OR Apache-2.0`, `Apache-2.0 OR MIT`, `ISC`, `Unlicense OR MIT`, `(MIT OR Apache-2.0) AND Unicode-3.0`, and `Apache-2.0 WITH LLVM-exception OR Apache-2.0 OR MIT`. Require each package's `license` to be a nonempty string matching one entry byte-for-byte; do not trim, case-fold, reorder, normalize whitespace or parentheses, or fall back to `license_file`. Reject `LicenseRef-*` and every missing, malformed, ambiguous, or unlisted expression, including otherwise known license identifiers in an unreviewed combination.

Validate the complete closure before writing output. Sort notice records deterministically by package name, version, and source; retain each exact declared expression; emit LF text with exactly one trailing newline and no timestamp or filesystem path. The validator regenerates the notices and requires byte equality. Tests must cover all nine accepted expressions, the real locked graph, missing/null/empty/non-string licenses, GPL and `LicenseRef-*`, standalone `Unlicense` and `Unicode-3.0`, `MIT AND Apache-2.0`, unknown identifiers inside `OR`, unlisted whitespace/order/parenthesis variants, repeatable byte-identical output, no partial output on failure, and notice tampering/omission/duplication/order drift.

- [ ] **Step 6: Implement validation and tamper tests**

The validator reparses the manifest, checks the exact directory allowlist, recomputes every hash and byte length, rejects links/extras, verifies `.node` binary magic for the declared OS, and optionally loads only the current target to assert ABI 1 and implementation. It never executes a noncurrent artifact.

Run: `pnpm vitest run tests/native-lock-packaging.test.ts --reporter=verbose`

Expected: PASS, including tampered byte, extra executable, wrong target, and notice failures.

- [ ] **Step 7: Build and validate the current target in a temporary output**

Run: `pnpm native:build -- --target x86_64-pc-windows-msvc --out .native-lock-build`

Run the manifest generator and validator against a six-fixture test directory; do not commit the incomplete current-target output. Remove `.native-lock-build` only after resolving and verifying it is inside this worktree.

- [ ] **Step 8: Commit**

```bash
git add .gitattributes plugins/tokengraph/package.json plugins/tokengraph/scripts/build-native-lock-addon.mjs plugins/tokengraph/scripts/generate-native-lock-manifest.mjs plugins/tokengraph/scripts/validate-native-lock-addon.mjs plugins/tokengraph/tests/native-lock-packaging.test.ts
git commit -m "build(tokengraph): validate native lock assets"
```

### Task 5: Load one exact verified addon

**Files:**
- Create: `plugins/tokengraph/src/core/nativeLockAddon.ts`
- Create: `plugins/tokengraph/tests/native-lock-addon.test.ts`

**Interfaces:**
- Consumes `NativeLockManifestV1` and six-target table from Task 4.
- Produces `NativeLockAddon`, `NativeLockHandle`, `NativeLockError`, and `loadNativeLockAddon(runtime?)`.
- Produces `tryAcquireAnchor(anchorPath): NativeLockHandle` with stable safe codes.

- [ ] **Step 1: Write failing selector and integrity tests**

```ts
const addon = await loadNativeLockAddon(fakeRuntime({
  platform: "linux",
  arch: "x64",
  glibcVersionRuntime: "2.28",
  loadModule: () => ({ abiVersion: 1, implementation: () => "flock", tryAcquireAnchor: vi.fn() })
}));
expect(addon.targetId).toBe("linux-x64-gnu");
```

Add RED cases for musl, glibc below 2.28, unsupported architecture, missing manifest, wrong schema, linked addon, identity change during hashing, length/hash mismatch, ABI mismatch, wrong implementation, loader throw, absolute-path leakage, and cache reuse after identity replacement.

- [ ] **Step 2: Run focused tests and verify RED**

Run: `pnpm vitest run tests/native-lock-addon.test.ts --reporter=verbose`

Expected: FAIL because `nativeLockAddon.ts` is absent.

- [ ] **Step 3: Define the exact TypeScript contracts**

```ts
export type NativeLockErrorCode =
  | "LOCK_BUSY" | "UNSAFE_ANCHOR" | "NATIVE_LOCK_ERROR"
  | "ADDON_MISSING" | "ADDON_INTEGRITY" | "ADDON_UNSUPPORTED" | "ADDON_ABI";

export interface NativeLockHandle {
  protectCompatibilityDirectory(lockPath: string): void;
  releaseCompatibilityDirectory(): void;
  release(): void;
}
export interface NativeLockAddon {
  readonly targetId: string;
  readonly implementation: "lockfileex" | "flock";
  tryAcquireAnchor(anchorPath: string): NativeLockHandle;
}
```

`NativeLockError` includes `code` and `retriable`; only `LOCK_BUSY` and an explicit allowlist of known-safe transient acquisition codes are retriable. Safe messages never contain the manifest path, addon path, workspace path, raw OS error, or PID.

- [ ] **Step 4: Implement source/dist asset discovery and exact selection**

Resolve `assets/native-lock` relative to `import.meta.url`: two parents from `src/core`, one parent from `dist`. Test both layouts explicitly. Detect Linux glibc only from `process.report.getReport().header.glibcVersionRuntime`; absent/musl is `ADDON_UNSUPPORTED`. Match one manifest record by platform, arch, and libc.

- [ ] **Step 5: Implement no-follow verification and ESM loading**

Open the bundled addon without following links, hash from the opened handle, compare identity before/after read, and revalidate the directory entry. Node 22 cannot load a native addon from a verified descriptor or `Buffer`, so production must not reopen the bundled pathname through `createRequire` or accept `require.cache`. Instead, create one fresh process-private staging root with `mkdtemp(join(tmpdir(), "tokengraph-native-addon-v1-<pid>-"))`, require it to be one direct child of the resolved OS temp directory, set/validate mode `0700` where supported, and place exactly `owner.json` plus `<target-id>-<verified-sha256>.node` inside it. Create the staged addon exclusively with mode `0600`, write the already verified source snapshot, flush, close, chmod it read-only, then independently reopen it without following links and revalidate its identity, length, SHA-256, root identity, marker, and exact two-entry allowlist. Load only this unique staged path with `process.dlopen({ exports: {} }, stagedPath)` and never insert it into `require.cache`. Strongly retain the raw module object, wrapped addon, verified source/staged identities, and staging lifecycle record for the process lifetime.

Before the first load, inspect at most 32 matching staging roots, oldest first. Parse and cross-check the decimal PID in the exact directory prefix and marker. Preserve alive, `EPERM`, indeterminate, linked/reparse, identity-changing, malformed, or unexpected state. Only `ESRCH` authorizes nonrecursive cleanup of an exact safe subset in file-marker-directory order. Before `process.dlopen` succeeds, any staging failure must remove the exact owned files/directory or fail `ADDON_INTEGRITY` if cleanup cannot be proven. After a successful POSIX load, unlink the staged addon, marker, and directory and prove the addon remains operational; on Windows, preserve the mapped DLL/root when sharing prevents removal, register best-effort synchronous exit cleanup, and let the next bounded dead-PID sweep reclaim it. A crash leaves at most one staging root per process outside workspace quotas; never recursively delete a staging root.

Verify `abiVersion === 1`, the OS-specific `implementation()`, and callable `tryAcquireAnchor` through own data-property descriptors without invoking accessors. Resolve handle methods from prototype data descriptors and invoke them with the native receiver. Accessor/prototype inspection failures and native error-field inspection failures become bounded safe errors; ordinary getters never run. A hostile in-process `Proxy` remains inside the explicitly excluded malicious same-account/in-process boundary.

Cache by loader provenance, normalized source path, exact source identity, target, byte length, and SHA-256. Production has a private provenance token; each injected loader function has a separate token and can never populate production cache state. Maintain a synchronous in-flight record per provenance/path: equal identities share one promise and immutable wrapper, a different identity fails integrity, failures clear only the in-flight entry for retry, and every caller verifies its own source snapshot before receiving a cached result. Cache only the successfully loaded immutable module instance and never accept a new path or identity under it.

- [ ] **Step 6: Run focused tests and current real-addon test**

Run: `pnpm native:build -- --target x86_64-pc-windows-msvc --out .native-lock-build`

Run: `pnpm vitest run tests/native-lock-addon.test.ts --reporter=verbose`

Expected: fixture tests PASS. Point the test runtime at `.native-lock-build/win32-x64` and require one acquire/busy/release/reacquire sequence to PASS; a fake module alone is insufficient. Also prove private staged bytes equal the verified source snapshot, bundled replacement cannot change executed staged bytes, staged tampering blocks `process.dlopen`, prepopulated `require.cache` is ignored, injected-loader provenance is isolated, equal concurrent loads share one wrapper, different concurrent identities fail, failed in-flight loads retry, accessor getters remain uncalled, and failure cleanup leaves no unsafe partial root. Remove the temporary build output after Task 5 verification using the same resolved-path check as Task 4. Task 9 supplies real Linux/macOS post-load unlink and all-six-platform crash/stale-root evidence.

- [ ] **Step 7: Commit**

```bash
git add plugins/tokengraph/src/core/nativeLockAddon.ts plugins/tokengraph/tests/native-lock-addon.test.ts
git commit -m "feat(tokengraph): load verified native lock addon"
```

### Task 6: Implement the lease state machine behind an injected native handle

**Files:**
- Create: `plugins/tokengraph/src/core/legacyRuntimeActivation.ts`
- Create: `plugins/tokengraph/src/core/lockDomain.ts`
- Create: `plugins/tokengraph/src/core/fileLockLease.ts`
- Create: `plugins/tokengraph/tests/storage-lock.test.ts`

**Interfaces:**
- Consumes `loadNativeLockAddon()` and `NativeLockHandle` from Task 5.
- Produces the opaque non-persisted `LegacyRuntimeShutdownCapability`, explicit
  process activation/status API, and the closed `LockDomain` registry.
- Produces `runWithFileLock<T>(lock, operation, options, runtime): Promise<T>`
  for `storage.ts`; the production path requires the process-local capability
  internally, while only the test seam accepts an injected capability.
- Produces `FileLockOptions { signal?: AbortSignal }`, `FileLockRuntime`, and `FileLockPolicy` test seams; production callers cannot override the policy.

- [ ] **Step 1: Write the deterministic RED suite**

```ts
it("keeps a live owner beyond the stale threshold", async () => {
  const runtime = fakeLockRuntime();
  const result = runWithFileLock(lockPath, async () => {
    runtime.advance(90_000);
    await runtime.flushHeartbeats();
    return "owned";
  }, {}, runtime);
  await expect(result).resolves.toBe("owned");
  expect(runtime.maxNativeOwners).toBe(1);
});
```

Add focused cases proving every lock refuses with
`LEGACY_RUNTIME_SHUTDOWN_UNCONFIRMED` before activation, activation requires the
literal confirmation and is not serialized to disk, then cover the exact
eight-domain registry, safe single-segment names,
unknown/dynamic parent refusal, complete journal intent before barrier creation,
every row of the phase/object reconciliation table, crash windows before and
after pending generation commit, provisional create/write/file flush,
temporary-identity commit, rename, parent-directory flush, and final generation
commit, no second barrier while residue exists,
complete initial lease write/close, heartbeat interval strictly below
`staleMs / 3`, nonce checked before every update, two unchanged reads, stale plus
confirmed-dead recovery, alive refusal, unknown refusal, PID reuse refusal,
malformed/partial/linked journal or lease occupied, nonce replacement
preservation, owner exception, cleanup exception, operation plus cleanup
`AggregateError`, native busy retry, timeout, abort while waiting, transient
Windows diagnostic errors, native nontransient failure, release ordering, and
same-process queue cleanup. Add foreign and same-text target replacement,
foreign provisional temporary, recorded temporary-identity mismatch, complete
parent-entry validation before mutation, link/reparse/regular-file-link-count/mode refusal,
post-acquisition signal abort, and hundreds of canceled waiters behind a hung
owner with physical queue-node removal. Add every generation-zero target/temp
bootstrap row including present-invalid-target preservation, neutral-idle reuse
without PID liveness, predecessor-generation/identity-bound `G + 1` journal
successor recovery, every allowed/forbidden phase cross-product, create roll-forward
with absent target, replace roll-forward with exact `fromIdentity`, post-rename
finalization, every listed `G -> G+1` row, stale/dead absent-intent rollback
without barrier retry, live same-process intent continuation, stale/dead adopted
or recorded empty-barrier cleanup without initiating lease creation, dead
lease-created cleanup without initiating heartbeat after resolving any already-
pending replacement, mandatory
cleanup-with-both to barrier-only cleanup before barrier removal, and rejection
before rename of direct cleanup-with-both to idle, idle-to-cleanup,
intent-to-lease-created, phase regression, skipped generation, changed
domain/key/PID/nonce/start time, decreasing heartbeat, or arbitrary same-phase
heartbeat. Also cover ordinary-data root entries left untouched, unknown reserved
prefix and unjournaled legacy `.lock` refusal, and exact-infrastructure-only
quota/enumeration behavior.

- [ ] **Step 2: Run the state-machine tests and verify RED**

Run: `pnpm vitest run tests/storage-lock.test.ts --reporter=verbose`

Expected: FAIL because `fileLockLease.ts` is absent.

- [ ] **Step 3: Define exact policy, lease, and runtime types**

```ts
export interface FileLockLeaseV1 {
  schemaVersion: 1;
  pid: number;
  nonce: string;
  startedAt: string;
  heartbeatAt: string;
}

export type LockDomain =
  | "workspace-state" | "repository-state" | "runs" | "tasks"
  | "vault" | "wiki" | "artifacts" | "git-info";

export interface CanonicalPersistenceLock {
  readonly domain: LockDomain;
  readonly domainRoot: string;
  readonly compatibilityPath: string;
  readonly anchorPath: string;
  readonly journalPath: string;
}

export interface PendingBarrierV2 {
  operation: "create";
}

export interface PendingLeaseWriteV2 {
  operation: "create" | "replace";
  fromIdentity?: string;
  payloadSha256: string;
  temporaryIdentity?: string;
}

export interface JournalPredecessorV2 {
  generation: number;
  identity: string;
}

export interface IdleLockRecoveryJournalV2 {
  schemaVersion: 2;
  generation: number;
  phase: "idle";
  predecessor?: JournalPredecessorV2;
}

export interface ActiveLockRecoveryJournalV2 {
  schemaVersion: 2;
  generation: number;
  predecessor: JournalPredecessorV2;
  relativeLegacyName: string;
  keyHash: string;
  pid: number;
  nonce: string;
  phase: "intent" | "barrier-created" | "lease-created" | "cleanup";
  startedAt: string;
  heartbeatAt: string;
  barrierIdentity?: string;
  leaseIdentity?: string;
  pendingBarrier?: PendingBarrierV2;
  pendingLeaseWrite?: PendingLeaseWriteV2;
}

export type LockRecoveryJournalV2 =
  | IdleLockRecoveryJournalV2
  | ActiveLockRecoveryJournalV2;

export interface FileLockPolicy {
  attempts: 200;
  waitMs: 10;
  staleMs: 30_000;
  heartbeatMs: 9_000;
}

export type ProcessLiveness = "alive" | "dead" | "unknown";
```

Require a nonnegative safe `generation` that increases exactly once per commit.
The exact generation-zero idle shape is
`{schemaVersion:2,generation:0,phase:"idle"}`. Later idle records contain only
those fields plus `predecessor`; no idle record contains an active PID, nonce,
timestamp, key, barrier/lease identity, or pending field.

Enforce the exact phase cross-product: generation-zero `idle` has no
predecessor, later `idle` has exactly one predecessor, and every idle has no
active-owner/lock-state field; `intent` has no identity and requires
`pendingBarrier`;
`barrier-created` requires only `barrierIdentity` and permits only create-form
`pendingLeaseWrite` without `fromIdentity`; `lease-created` requires both
identities and permits only replace-form `pendingLeaseWrite` whose
`fromIdentity` equals `leaseIdentity`; `cleanup` requires `barrierIdentity`,
permits `leaseIdentity` only until lease removal, and forbids pending fields.
The pending fields are mutually exclusive and omit `temporaryIdentity` until a
flushed temporary is stably reread. Reject every other combination before
mutation. Each valid generation implicitly authorizes only the fixed journal
temporary as its possible generation-plus-one successor. Every generation
above zero requires predecessor generation exactly `generation - 1` and the
exact stable predecessor journal-target identity.

Implement this closed `G -> G+1` matrix; reject every unlisted pair before
renaming the journal temporary:

| Predecessor G | Successor G+1 | Required condition |
|---|---|---|
| neutral idle | intent plus pending barrier | current PID, new key/nonce, equal canonical start/heartbeat |
| intent plus pending barrier | barrier-created plus exact barrier identity | normal still-live same-process continuation with its in-memory transition receipt exclusively created the path, or stale/dead recovery adopted the exact safe existing authorized directory; stale/dead path-absent recovery cannot take this row |
| intent plus pending barrier | neutral idle | exact path absent and active owner stale/dead; this rollback is mandatory and recovery never retries or creates the dead callback's barrier |
| barrier-created without pending | same phase plus pending create without temp identity | only the still-live same-process callback that created the barrier for its current operation and retains its in-memory transition receipt; lease target absent |
| barrier-created without pending | barrier-only cleanup retaining exact barrier identity | owner stale/dead and recorded barrier unchanged, safely empty, and stable; mandatory teardown including after stale/dead intent adoption, never lease creation for the dead callback |
| pending create without temp identity | same pending create with temp identity | exact temp flushed/stably reread |
| either pending create | barrier-created without pending | exact temp absent/removed and target absent |
| recorded-temp pending create | lease-created with exact new lease identity | authorized rename/flush/finalize |
| lease-created without pending | same phase plus pending replace from current lease identity, no temp identity | only the still-live same-process heartbeat holding its in-memory transition receipt may begin replacement |
| pending replace without temp identity | same pending replace with temp identity | exact temp flushed/stably reread |
| either pending replace | prior lease-created without pending | old target identity/heartbeat unchanged and temp absent/removed |
| recorded-temp pending replace | lease-created with exact new identity/heartbeat | authorized rename/flush/finalize and monotonic heartbeat |
| lease-created without pending | cleanup with both recorded identities | live operation/heartbeat stopped, or stale/dead recovery resolved any already-pending replacement and recorded barrier/lease remain unchanged; recovery never initiates a new heartbeat |
| cleanup with barrier and lease | cleanup with barrier only | exact lease is absent or was removed and the recorded barrier remains safely empty and stable; this `G + 1` commit is mandatory before compatibility-handle release or barrier removal |
| cleanup with barrier only | neutral idle | compatibility handle was released and the exact empty recorded barrier was removed, or recovery proves the barrier is already absent after that barrier-only removal step |

Every active-to-active successor preserves domain path, relative name, key hash,
PID, nonce, and start time; heartbeat never decreases. Only idle-to-intent may
create a new owner/key/nonce tuple. Stale/dead recovery uses only the matching
rollback, roll-forward, or cleanup row and never initiates pending lease create
or replace. It first resolves any already-pending create or replacement through
the listed rows, then moves the resulting no-pending `barrier-created` or
`lease-created` predecessor to its cleanup row. Only a live same-process
heartbeat with its transition receipt may begin replacement, and it must
traverse both pending-replace rows. Reject idle-to-cleanup, unrelated intent-to-lease-created,
phase regression, skipped generation, changed domain/key/nonce/owner, and
pending fields outside their listed row.

A `cleanup` record that still retains both barrier and lease identities never
transitions directly to neutral `idle`, even when the recorded lease is absent
and the recorded barrier is safely empty. It must first commit the next
barrier-only `cleanup` generation. Only that barrier-only generation authorizes
compatibility-handle release, barrier removal, and the following neutral idle
commit; a direct `cleanup`-with-both-to-idle shortcut fails closed.

`legacyRuntimeActivation.ts` keeps its brand private. It mints one opaque
capability only from the literal `{ confirmedNoLegacyTokenGraphProcesses: true
}` and holds MCP activation only in process memory. It exposes a read-only status
for Doctor. There is no disk marker, PID inference, environment default, or
cross-process cache.

The production runtime supplies cryptographic `randomUUID`, monotonic scheduling plus wall-clock ISO timestamps, conservative `process.kill(pid, 0)` liveness mapping, safe filesystem operations, and Task 5 native acquisition. The injected runtime and capability are accepted only by `runWithFileLockForTesting`; exported production `runWithFileLock` accepts no timing, liveness, or capability override and obtains the opaque capability only from the process-local activation guard. `AbortSignal` applies only while queued or acquiring the native anchor; detach it immediately after native ownership so later abort cannot poison heartbeat, reconciliation, operation, or cleanup.

- [ ] **Step 4: Implement the closed domain registry and bounded journal**

In `lockDomain.ts`, derive each domain root from the canonical workspace root;
derive `git-info` from the resolved Git common directory. Accept exactly one
safe data filename segment and return a runtime-branded object containing the
exact legacy compatibility path plus fixed
`.tokengraph-native-anchor-v2.lock` and
`.tokengraph-native-journal-v2.lock` paths. Reject separators, traversal,
unknown domains, an unrecognized root, or a data path that does not remain a
direct child of the registered root.

Validate/create the domain root with restrictive permissions. Acquire its fixed
anchor nonblockingly before touching the journal or exact legacy path. On
`LOCK_BUSY`, wait 10 ms with abort support and retry at most 200 attempts.
Reconcile the one fixed bounded schema-v2 journal before starting any key using
the design's bootstrap and closed phase/object tables. Under the anchor,
stably validate and enumerate the domain root. Only when the journal target is
absent and there is no protocol barrier, legacy `.lock`, unknown reserved
entry, link, or reparse point, bootstrap the complete neutral idle generation
zero exclusively through the reserved journal temporary. Cover
absent, partial, and complete target/temporary state after create, write, file
sync, rename, and parent flush. Bootstrap authority may remove only an exact
stable restrictive ordinary single-link invalid/partial journal temporary.
The protocol never writes a partial target: preserve and fail closed on every
present invalid journal target. After valid generation zero, never remove the
journal target and use the temporary for all later generations.

Each later generation uses exclusive create,
complete write, file flush, stable no-follow reread, same-directory replacement,
and parent-directory flush through the one exact reserved journal temporary.
Use an in-memory old/new-identity, generation, and payload-hash receipt for a
same-process post-rename retry; never accept equal bytes as identity proof.
For crash recovery, native-anchor possession replaces predecessor PID probing.
Require a valid unchanged predecessor target and either discard only a partial
or syntactically invalid exact reserved temporary, or roll forward a complete
candidate only when it is generation `G + 1`, binds predecessor generation and
identity exactly to target `G`, and represents an allowed phase transition.
Preserve and fail closed on every complete unbound, skipped, or invalid-
transition successor. Active-record stale/dead checks remain mandatory for
barrier/lease residue but never govern neutral idle reuse or journal-successor
recovery.

Before any recovery mutation, fully enumerate and classify the relevant
parent. Allow unrelated ordinary TokenGraph data entries untouched. Classify
only the exact anchor, journal, authorized journal temporary, current
compatibility barrier, and its state-authorized lease/temporary as protocol
entries. Unknown reserved-prefix entries, legacy `.lock` objects/barriers
outside the current journal, links/reparse points at protocol paths, and extra
current-barrier entries fail closed. Quota and ordinary enumeration ignore only
exact infrastructure, never a wildcard suffix/prefix. A complete unchanged
active stale/dead record may recover only its recorded barrier/lease objects or
exact pending provisional object; the predecessor-bound journal-successor rule
above is independent of PID liveness. One journal temporary, one lease temporary inside the sole
barrier, and one barrier are the maximum per domain.

- [ ] **Step 5: Implement the exact temporary barrier and conservative recovery**

At `lock.compatibilityPath`, use no-follow `lstat`. Prove it absent, then durably
write an `intent` with `pendingBarrier` before creating a temporary directory with
`mkdir(path, { recursive:false, mode:0o700 })`, revalidate identity, and durably
advance the journal to `barrier-created`. A crash after `mkdir` but before the
identity commit may adopt only that exact restrictive empty directory under an
unchanged stale/dead `pendingBarrier`; every unlisted intent shape fails before
mutation. If the journal identifies safe crash residue, validate the
complete directory entry set before mutation and allow only its matching
`lease.json` or exact pending lease temporary. A barrier-created record without
a pending create never authorizes an existing lease or lease temporary; only
the listed pending-create generations may roll back or forward. A stale/dead
barrier-created record with its exact empty stable barrier must instead commit
barrier-only `cleanup`; this is also the teardown path after stale/dead intent
adoption, and it never initiates lease creation for the dead callback. Reject a
legacy file, symlink,
junction, reparse point, non-directory, unjournaled directory, or extra entry
with stable `LEGACY_LOCK_BLOCKED`/`UNSAFE_LOCK_DIRECTORY`; do not remove or
rename it. Ask the native handle to protect the verified directory before
entering the operation.

While the domain anchor is held, read a complete bounded `lease.json` twice with
the injected wait between reads. Recover only when schema, PID, UUID nonce,
timestamps, nonce, and heartbeat are unchanged; age exceeds 30 seconds; and
liveness is exactly `dead`. Every other nonempty state is occupied and releases
the compatibility handle plus native anchor without running the operation. An
`intent` plus `pendingBarrier` with an absent path must advance only to neutral
idle after the recorded owner is confirmed dead; recovery never retries the
pending creation or creates a barrier for the dead callback. Only the normal
still-live same-process path immediately following its own committed intent may
continue through exclusive `mkdir` to `barrier-created`. A recorded barrier or
lease identity mismatch is never repaired.

- [ ] **Step 6: Implement exclusive lease, heartbeat, and journaled cleanup**

Only the still-live same-process callback holding its in-memory transition
receipt may create `lease.json` or begin its heartbeat replacement through
`pendingLeaseWrite`. First commit
operation `create` or `replace`, prior target identity when present, and the
payload SHA-256. Exclusively create
`lease.json.tokengraph-write-v2.tmp`, write the full JSON plus newline, sync,
close, and stably reread it; then commit its identity. Revalidate the old target
and temporary identities, rename in the same directory, flush the parent, and
commit the new lease identity while clearing the pending write. Only then enter
the operation or report the heartbeat.

Recovery uses the closed table. Pending create without a temporary may roll
back only when its target is absent. Pending replace without a temporary may
roll back only when the old target identity and heartbeat are unchanged. An
unrecorded exact safe temporary may be discarded under reserved authority, then
only the matching rollback condition applies. A recorded create temporary may roll forward
only when the target is absent. A recorded replace temporary may roll forward
only when the target identity equals `fromIdentity`. In both cases verify the
temporary identity/hash and full barrier classification before rename. If the
temporary is absent and the target already has the recorded temporary identity
and hash, finalize the completed rename. A create with any pre-rename target, a
replace with any other pre-rename target identity, or every other temporary
identity is preserved and fails closed.
After stale/dead recovery resolves an already-pending replacement through those
existing rows, a no-pending `lease-created` record must transition to `cleanup`
with both identities. Recovery never initiates a pending replacement or new
heartbeat for a dead callback.
Schedule heartbeat every 9 seconds through this protocol. Serialize heartbeat
and release so no update can finish after cleanup begins.

In `finally`, stop and await heartbeat, reread and validate the matching nonce,
durably set and flush the journal to `cleanup` with both recorded identities
before removing `lease.json`. After the recorded lease is absent, revalidate
the safely empty stable barrier and commit and flush the mandatory next
barrier-only `cleanup` generation. Only then release the native
compatibility-directory handle, revalidate that the exact directory is empty
and still owned, remove that directory nonrecursively, and commit and flush the
next neutral idle journal generation. Recovery from `cleanup` with both
identities and an already absent lease follows the same mandatory barrier-only
commit before any handle release or barrier removal; it never shortcuts
directly to idle. A barrier-only recovery that proves the recorded barrier was
already removed may commit the next neutral idle generation. The journal
target remains permanent. Then synchronously release the domain anchor. Preserve a
foreign/replaced lease, directory, or journal. Throw the cleanup error alone
after a successful operation; throw
`AggregateError([operationError, cleanupError])` when both fail. Native unproven
release does not return because the addon fail-stops.

- [ ] **Step 7: Implement and test same-process serialization**

Use a `Map<string, ExactPathQueue>` keyed by exact canonical path. Each queue
has one active node and removable waiting nodes. Cancellation or timeout before
a turn starts must unlink that node immediately, detach its abort listener,
abort its wait timer, and clear its operation, runtime, resolver, and controller
references. A later successor remains gated by the active predecessor; removing
a canceled middle node never permits overlap. Fulfillment and rejection remove
only their own active node, advance the next live node, and delete the map entry
only when the explicit queue is empty.

Assert two same-key operations never overlap, keys in one domain serialize on
the fixed anchor, keys in different domains can overlap, and the map returns to
size zero after success and failure. Queue hundreds of canceled callers behind
one hung owner and prove the physical node count returns to one while a later
live successor remains blocked. Create 1,000 unique clean run, task, and
artifact locks and assert each domain retains only its fixed anchor and journal,
with no compatibility directories. Crash repeatedly at every durable-write cut
and assert reconciliation never leaves more than one journal temporary, one
lease temporary, and one v2 barrier per domain.

- [ ] **Step 8: Run RED-to-GREEN repetitions**

Run: `pnpm vitest run tests/storage-lock.test.ts --reporter=verbose`

Run: `1..30 | ForEach-Object { pnpm vitest run tests/storage-lock.test.ts --reporter=dot; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`

Expected: every deterministic run PASS without real-time sleeps near 30 seconds.

- [ ] **Step 9: Commit**

```bash
git add plugins/tokengraph/src/core/legacyRuntimeActivation.ts plugins/tokengraph/src/core/lockDomain.ts plugins/tokengraph/src/core/fileLockLease.ts plugins/tokengraph/tests/storage-lock.test.ts
git commit -m "feat(tokengraph): implement native lock leases"
```

### Task 7: Migrate every caller and make destructive maintenance domain-safe

**Files:**
- Create: `plugins/tokengraph/src/core/nativeLockProvider.ts`
- Create: `plugins/tokengraph/scripts/run-tests.mjs`
- Create: `plugins/tokengraph/scripts/run-process-tree-windows.ps1`
- Create: `plugins/tokengraph/vitest.activated.config.ts`
- Create: `plugins/tokengraph/vitest.preactivation.config.ts`
- Create: `plugins/tokengraph/tests/native-lock-preactivation.test.ts`
- Create: `plugins/tokengraph/tests/test-runner-contract.test.ts`
- Create: `plugins/tokengraph/tests/support/nativeLockProvider.ts`
- Create: `plugins/tokengraph/tests/support/activateNativeLockRuntime.ts`
- Create: `plugins/tokengraph/tests/support/externalRuntime.ts`
- Modify: `plugins/tokengraph/src/core/storage.ts`
- Modify: `plugins/tokengraph/src/core/architectureRules.ts`
- Modify: `plugins/tokengraph/src/core/artifact.ts`
- Modify: `plugins/tokengraph/src/core/config.ts`
- Modify: `plugins/tokengraph/src/core/knowledgeReviewQueue.ts`
- Modify: `plugins/tokengraph/src/core/memoryStore.ts`
- Modify: `plugins/tokengraph/src/core/persistence.ts`
- Modify: `plugins/tokengraph/src/core/repositoryIdentity.ts`
- Modify: `plugins/tokengraph/src/core/routingControl.ts`
- Modify: `plugins/tokengraph/src/core/runner.ts`
- Modify: `plugins/tokengraph/src/core/storagePolicy.ts`
- Modify: `plugins/tokengraph/src/core/taskLedger.ts`
- Modify: `plugins/tokengraph/src/core/hostWorkspace.ts`
- Modify: `plugins/tokengraph/src/core/fileLockLease.ts`
- Modify: `plugins/tokengraph/src/hooks.ts`
- Modify: `plugins/tokengraph/src/cli.ts`
- Modify: `plugins/tokengraph/src/server.ts`
- Modify: `plugins/tokengraph/package.json`
- Modify: `plugins/tokengraph/vitest.config.ts`
- Modify: `plugins/tokengraph/tests/foundations.test.ts`
- Modify: `plugins/tokengraph/tests/core.test.ts`
- Modify: `plugins/tokengraph/tests/task-ledger.test.ts`
- Modify: `plugins/tokengraph/tests/runner.test.ts`
- Modify: `plugins/tokengraph/tests/knowledge-review-queue.test.ts`
- Modify: `plugins/tokengraph/tests/cli-runner.test.ts`
- Modify: `plugins/tokengraph/tests/cli-smoke.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`
- Modify: `plugins/tokengraph/tests/hooks.test.ts`
- Modify: `plugins/tokengraph/tests/low-write-policy.test.ts`
- Modify: `docs/hosts/codex.md`
- Modify: `docs/hosts/claude-code.md`
- Modify: `docs/trust/privacy.md`
- Modify: `docs/trust/limitations.md`
- Modify: every additional production caller or lock-taking test discovered by
  the Step 1 inventories; additions outside this closed purpose require review.
- Modify: `.github/workflows/ci.yml`
- Modify: `.github/workflows/release.yml`

**Interfaces:**
- Consumes `runWithFileLock` from Task 6.
- Consumes `LockDomain`, `CanonicalPersistenceLock`, and `canonicalPersistenceLock(root, domain, relativeDataName)` from Task 6.
- Produces `withFileLock(lock, operation, options?)`, canonical multi-domain maintenance acquisition, and `DestructiveMaintenanceConfirmation`.
- Produces `inspectTaskLedgerReadOnly(root, taskId)`, a strict current-schema
  view for permanently unactivated lifecycle-hook processes; it never repairs,
  migrates, quarantines, locks, or mutates project state.
- Produces a zero-configuration production native-provider facade and a
  hermetic, current-target test harness used only before Task 9 supplies the
  committed six-target assets.
- Removes direct string construction such as ``withFileLock(`${key}.lock`, operation)`` from production source.

- [ ] **Step 1: Write a failing caller-inventory test**

```ts
const productionFiles = await sourceFilesContaining("withFileLock");
expect(productionFiles).toEqual(EXPECTED_LOCK_CALLERS);
for (const file of productionFiles) {
  expect(await readFile(file, "utf8")).not.toMatch(/withFileLock\(`?\$\{[^}]+\}\.lock/);
}
```

`EXPECTED_LOCK_CALLERS` names every production file in this task that invokes
the lock. Add runtime assertions that every caller maps to exactly one of the
eight registered domains, a canonical Windows alias maps to one lowercase exact
compatibility directory, and the Git common-directory exclude lock remains
`<git-common>/info/exclude.lock`, not a `.tokengraph` hash path. Assert that
unknown domains, separators in relative data names, and dynamically supplied
parents fail closed.

Add maintenance assertions that anchors and journals are preserved; active,
ambiguous, or crash-residue barriers are not recursively removed; clean
compatibility directories disappear after release; and infrastructure is
excluded from quota totals, migration, export, enumeration, and removal
reports. Add RED cases proving every lock-taking operation fails before process
activation, `tokengraph_setup` activates only its current MCP process, and a CLI
lock-taking command requires `--confirm-no-legacy-processes`. Prove purge/reset
also refuses a missing or false fresh maintenance confirmation, automatic quota
cleanup refuses before activation but can run after activation, confirmed
new-runtime purge serializes with a new-runtime writer, and multi-domain reset
acquires unique anchors in sorted order and releases them in reverse.

Add hook-boundary assertions that `hooks/hooks.json` remains byte-for-byte
unchanged, every hook process remains unactivated, and no hook input, argument,
environment value, file, or prior process can confer activation. Inventory the
hook source and built bundle for calls to the activation API, native addon
loader/provider, `withFileLock`, `canonicalPersistenceLock`,
`attachTaskHostContext`, and the mutating `loadTaskLedger`; all are forbidden.
The source may use only the strict read-only ledger inspection described in
Step 6. Prove the lifecycle pointer uses schema version 2 and does not persist a
raw workspace root, prompt, transcript, tool input, or tool response.

Inventory every test or script that executes `dist/cli.js`, `dist/index.js`,
`dist/hooks.js`, or starts `scripts/smoke.mjs`. Runtime executions in
`cli-runner.test.ts`, `mcp-smoke.test.ts`, `hooks.test.ts`, and the actual
server-starting cases in `cli-smoke.test.ts` must use the external runtime from
Step 7. Smoke executions pass its `dist/index.js` through `--server`. Static
source, manifest, help, package-layout, and deliberately mutated-fixture
assertions remain pointed at the object they are testing. The inventory test
fails when a new executable `dist` consumer bypasses this routing.

- [ ] **Step 2: Run focused tests and typecheck to observe RED**

Run: `pnpm test:preactivation`

Run: `pnpm test:activated -- tests/foundations.test.ts tests/storage-lock.test.ts tests/task-ledger.test.ts tests/hooks.test.ts --reporter=verbose`

Run: `pnpm typecheck`

Expected: FAIL because the production provider, contained real-addon harness,
branded API, caller migration, and permanently unactivated read-only hook
boundary are absent.

- [ ] **Step 3: Delegate storage locking only through branded lock objects**

```ts
export async function withFileLock<T>(
  lock: CanonicalPersistenceLock,
  operation: () => Promise<T>,
  options: FileLockOptions = {}
): Promise<T> {
  return runWithFileLock(lock, operation, options);
}
```

Keep `canonicalPersistenceLockKey` only for non-lock queue keys that need it.
Do not expose the brand symbol, infer a domain from an arbitrary path, weaken
root/path checks, or accept a raw cast at callers.

Add `nativeLockProvider.ts` as the only production provider boundary. It calls
`loadNativeLockAddon()` without arguments. It has no environment lookup,
optional asset root, setter, fake, JavaScript fallback, or test branch.
`fileLockLease.ts` imports the literal `./nativeLockProvider.js` exactly once.

- [ ] **Step 4: Migrate every caller without changing its data path**

For each direct file, call `canonicalPersistenceLock` with its inventory domain
and unchanged data filename. Refactor `ArchitectureRuleStore` and `MemoryStore`
to receive their branded lock alongside the resolved file path; they cannot
derive a domain from the path. For `taskLedger.ts`, derive the same branded task
lock once for its queue key and filesystem lease. For `repositoryIdentity.ts`,
use `git-info` so the compatibility path remains the concrete resolved Git
`info/exclude.lock`.

- [ ] **Step 5: Implement canonical multi-domain destructive maintenance**

```ts
export interface DestructiveMaintenanceConfirmation {
  readonly confirmedNoLegacyTokenGraphProcesses: true;
}
```

Add a helper that resolves and deduplicates all affected registered domains,
sorts by canonical anchor path, acquires them in that order, calls only unlocked
deletion primitives, and releases in reverse. Its no-follow walker removes
ordinary data selectively, never recursively removes a domain root, and always
preserves both fixed infrastructure files and the parent skeleton. It refuses
regular legacy lock files, unexpected `.lock` directories, unresolved journals,
links, and identity mismatches.

Make `tokengraph_setup` accept the literal
`confirmNoLegacyProcesses: z.literal(true)` and activate only the current MCP
server process. Make every CLI command that can acquire a persistence lock
require `--confirm-no-legacy-processes` and activate only that CLI invocation.
Do not write an activation marker or infer activation from process scanning.
Pre-activation `withFileLock` must throw the typed error before loading the addon
or touching a domain root, anchor, journal, or compatibility path. Expose
read-only activation status to Doctor.

Require the fresh maintenance confirmation object in `purgeStorageClass`,
`purgeTokenGraphStorage`, `clearProjectWiki`, `clearProjectIndex`, and
`clearProjectState`. Add CLI flag `--confirm-no-legacy-processes` and MCP reset
input `confirmNoLegacyProcesses: z.literal(true)` with an explicit description;
the process activation alone does not authorize explicit deletion. Automatic
quota cleanup may run only after process activation and passes the opaque
capability internally. Update
storage traversal and migration/export/reporting filters so anchor, journal, and
temporary lock metadata never count as user data and are never presented as
removed state.

- [ ] **Step 6: Keep managed lifecycle hooks permanently unactivated and read-only against projects**

`hooks/hooks.json` remains byte-for-byte unchanged. Its five commands continue
to pass exactly one static event argument to `dist/hooks.js`; a static flag or
hook-input boolean is not a fresh operator assertion and can never activate a
hook process. `src/hooks.ts` must not import or call the activation API, native
addon loader/provider, `withFileLock`, `canonicalPersistenceLock`,
`attachTaskHostContext`, or any mutating project-ledger API. It never creates,
repairs, migrates, quarantines, renames, deletes, or otherwise writes project
state. Remove hook-side `attachTaskHostContext`; the already activated MCP
process sets `TaskLedger.host` when it creates the ledger. `sessionId` and
`turnId` remain private lifecycle-pointer state. Any future project-ledger
attachment must occur inside an activated MCP request using authenticated
request metadata, never in a hook, and the implementation must not invent
unavailable turn metadata.

Add this exact non-mutating interface to `taskLedger.ts`:

```ts
export type TaskLedgerReadOnlyInspection =
  | { status: "valid"; ledger: Readonly<TaskLedger> }
  | { status: "missing" | "invalid" | "unsupported" | "unstable" };

export async function inspectTaskLedgerReadOnly(
  root: string,
  taskId: string
): Promise<TaskLedgerReadOnlyInspection>;
```

The reader accepts a UUID and the exact current ledger schema only. It reads
only `<attested-root>/.tokengraph/tasks/<uuid>.json`, caps the file at 8 MiB,
rejects linked, reparse, non-regular, or multiply linked files, uses
`O_NOFOLLOW` where available, and compares the opened handle and directory
entry identity and stable size/time metadata before and after the bounded read.
It uses `lstat(path, { bigint: true })` and `handle.stat({ bigint: true })`
throughout. Device, inode, mode, link count, size, `birthtimeNs`, `mtimeNs`, and
`ctimeNs` remain `bigint`; never convert an identity or time field to `Number`.
Convert size only after proving `0n <= size && size <= BigInt(8 * 1024 *
1024)`. Every snapshot retains this full tuple, including birth and change
times, and a stable file read compares every listed field. Directory-object
binding continues to compare the immutable object/type fields `dev`, `ino`,
`mode`, and `birthtimeNs`, not child-sensitive directory size or timestamps.
Device plus inode are the authoritative filesystem-object identity.

The uniform cross-platform comparison after authorized same-directory link or
rename publication compares `dev`, `ino`, `mode`, `nlink`, `size`, and
`mtimeNs`; it deliberately omits both `birthtimeNs` and `ctimeNs`. Rename may
change `ctimeNs`, while Windows namespace publication can tunnel the replaced
name's cached creation time onto the published object. Birth time is therefore
stable snapshot metadata but not authoritative publication identity. Do not add
a platform branch, delay, retry, timestamp rewrite, no-op refresh, or generation
protocol for this condition.

The current-schema decoder is dedicated and recursive; it must not call the
legacy-aware `reconstructTaskLedger`, `reconstructTaskReport`,
`buildTaskReport`, or any migration/defaulting path. Exact allowed and required
key sets apply to the ledger and every nested repository identity, routing
observation, read policy, event, quality check, outcome, completed report,
estimate, range, category, and quality object. Reject unknown nested fields,
missing required fields, coercion, default insertion, deduplication, and invalid
status/optional-field combinations. Only the correct schema id paired with an
integral non-current schema version is `unsupported`; malformed identification
or an invalid current record is `invalid`. Return a fresh recursively cloned and
deep-frozen value rather than the parsed object.
`ENOENT` is `missing`; a syntactically identifiable older or newer schema is
`unsupported`; malformed JSON/schema or an oversized file is `invalid`; an
unsafe type, replacement, identity disagreement, permission ambiguity, or read
race is `unstable`. Results and hook warnings are bounded and contain no local
path. This function never calls `mkdir`, `chmod`, `rename`, `rm`,
`getRepositoryIdentity`, quarantine, migration, repair, a lock helper, or a
write primitive. Keep existing mutating `loadTaskLedger` for activated MCP/CLI
paths only.

For every invocation, require `process.argv.length === 3`, one of the five
known event names, and an exact `hook_event_name` pairing:
`session-start`/`SessionStart`,
`user-prompt-submit`/`UserPromptSubmit`,
`session-end`/`SessionEnd`, `post-tool-use`/`PostToolUse`, or `stop`/`Stop`.
Read at most 1 MiB of stdin JSON and require an object. Session and turn
identifiers, whenever accepted, must be nonblank and at most 1,024 characters;
`session_id` is required for every known event, while PostToolUse additionally
requires one bounded turn value selected in order from `turn_id`, `prompt_id`,
then `tool_use_id`. PostToolUse accepts only the existing closed tool allowlist:
`tokengraph_prepare_context`, `tokengraph_query_context`,
`tokengraph_compress`, `tokengraph_recall`, `tokengraph_analyze`,
`tokengraph_propose_knowledge`, and `tokengraph_task_report` after normalizing
the host namespace. Unknown events, extra arguments, malformed input, or an
injected confirmation-like field produce only a bounded warning or empty
output and make no filesystem change; no such field is ever read as authority.

Resolve hook storage from exactly one complete absolute environment pair:
`PLUGIN_ROOT` plus `PLUGIN_DATA`, or `CLAUDE_PLUGIN_ROOT` plus
`CLAUDE_PLUGIN_DATA`. If either member of a pair is present, its mate is
required. Never combine members from different pairs. When both complete pairs
are present as host aliases, both plugin-root real paths and both plugin-data
real paths and identities must agree exactly; a partial, relative, mixed, or
conflicting pair is invalid and causes zero mutation. The plugin-data root must
already exist as an ordinary non-link/non-reparse directory. Record its real
path and directory identity before using it. After the attested workspace is
known, reject equality or ancestor/descendant overlap in either direction
between the plugin-data root and attested workspace, using platform-correct
path comparison. The direct `sessions` child must be absent or an ordinary
non-link/non-reparse directory whose parent is that unchanged data-root
identity. Create only that one child with nonrecursive `mkdir`; bind and
revalidate the data-root and sessions identities before and after every pointer
read, write, replace, prune, or removal. Never follow a substituted parent that
is observed before the final syscall; the active-racer exclusion below applies.

`SessionStart` and `UserPromptSubmit` retain only the existing OS-temporary
host-workspace attestation. PostToolUse and Stop must load a valid, unexpired
attestation keyed by the real installed plugin root and exact `session_id`.
That attested real workspace root is the sole project-root authority. Never use
`cwd`, tool input/output roots, `CLAUDE_PROJECT_DIR`,
`TOKENGRAPH_WORKSPACE_ROOT`, or an existing pointer as a fallback authority. If
`cwd` or a tool input/output explicitly supplies a root, its real path must
equal the attested root or the hook warns and skips. An initial task id must be
a UUID extracted from a successful structured TokenGraph response. Success
requires `isError` and the host-compatibility `is_error`, when present, to be
boolean false; true, non-boolean, contradictory aliases, or an error-shaped
response is not authority. `structuredContent` or the compatibility
`structured_content` must be a plain record; if both occur, their values must
match exactly or the hook rejects the response. JSON-looking `TextContent` is
never parsed as task or root authority. A task id found only in tool input is
accepted solely when it equals the existing valid pointer for that session and
the corresponding tool response is successful; any structured task/root
conflict still rejects it. The strict ledger inspection must return `valid`
before a pointer can be written.

Harden `hostWorkspace.ts` itself rather than treating the current helper as a
safe primitive. Bind the real OS temporary root, its direct
`tokengraph-host-workspaces` child, the direct `<pluginRootHash>` child, and the
exact `<sessionHash>.json` entry by no-follow directory/file identities. A host
attestation is at most 64 KiB and has exactly `schemaId`, `schemaVersion`,
`pluginRootHash`, `sessionHash`, `root`, and `updatedAt`; reject unknown fields.
Require schema version 1, hashes matching the real installed plugin root and
exact session id, a canonical ISO timestamp between 24 hours old and five
minutes in the future, and a currently existing real workspace equal to its
stored absolute root. Read with `O_NOFOLLOW` where available and compare the
ordinary single-link file handle, entry, and every parent identity plus stable
size/time metadata before and after the bounded read. Use the same
BigInt/nanosecond identity rules as the ledger reader, including immutable-only
directory binding, `nlink === 1n`, bounded BigInt size checks, and the
rename-specific comparison that omits only `ctimeNs`. Missing, invalid,
expired, mismatched, unsupported, and unstable states remain distinct and
path-free. Refresh may replace only a stable structurally valid attestation for
the same plugin/session binding; it does not overwrite ambiguous or foreign
state observed before the final syscall. Before exact SessionEnd removal,
reread and revalidate the same schema, binding, file identity, and unchanged
parents; an observed replacement, link, hard link, or ambiguity is preserved
and only warns. Eliminate its unbounded `readFile`
and unchecked force-`rm` paths.

Expose the exact classification without throwing a path-bearing error:

```ts
export type HostWorkspaceAttestationLoad =
  | { status: "valid"; root: string }
  | {
      status:
        | "missing"
        | "invalid"
        | "unsupported"
        | "expired"
        | "mismatched"
        | "unstable";
    };
```

For SessionStart/UserPromptSubmit, canonicalize the candidate `cwd` first and
apply the data/workspace non-overlap rule before creating or refreshing the
attestation. For later events, apply it to the valid attested real root.

Replace `withPointerLock` and all stale-mtime `.lock` behavior. The plugin-data
pointer schema becomes version 2 with exactly `schemaId`, `schemaVersion`,
`sessionHash`, `taskId`, `turnId`, and `updatedAt`; it never stores the root.
Its only target is
`<plugin-data>/sessions/<sha256(sessionId)>.json`. Write no more than 16 KiB
through an exclusively created same-directory
`.tg-pointer-<sessionHash>-<pid>-<uuid>.tmp`, flush the complete restrictive
file, validate its ordinary single-link identity, atomically replace the exact
session-hash target, and durably flush the parent where supported. Windows
sharing failures receive only the existing bounded transient retry. Failure
cleanup and 30-day pruning revalidate exact identity before deleting; pruning
examines at most the first 64 deterministically sorted exact hash-named pointer
or `.tg-pointer-<64hex>-<decimal-pid>-<uuid>.tmp` entries per invocation and
skips links, replacements, and ambiguity. It never uses a stale-age ownership
inference. Concurrent events for one session have advisory
last-completed-writer-wins semantics; different session hashes remain isolated.
The pointer is cooperative lifecycle state, never activation, ownership, or
root authority.

Pointer reads use the same bounded stable no-follow discipline as ledger reads:
validate the bound data/sessions parents, `lstat`, `O_NOFOLLOW` open, bounded
handle read, handle restat, and entry restat, requiring one unchanged ordinary
single-link BigInt/nanosecond identity and stable size/time metadata. Pointer
age and pruning comparisons stay in nanoseconds; they do not round through
millisecond `Number` values. Decode exactly the six
schema-v2 keys and reject unknown fields. A canonical timestamp from 30 days
ago through five minutes in the future and the exact expected lowercase
`sessionHash` are required. Return distinct `missing`, `invalid`, `unsupported`,
`expired`, `mismatched`, and `unstable` classifications without a path.

```ts
type PointerInspection =
  | { status: "valid"; pointer: Readonly<SessionPointerV2> }
  | {
      status:
        | "missing"
        | "invalid"
        | "unsupported"
        | "expired"
        | "mismatched"
        | "unstable";
    };
```

Immediately before replacement, revalidate both parent identities and inspect
the existing exact target. Replacement is authorized only when the target is
absent or is an unchanged ordinary single-link exact schema-v2 pointer reserved
for the same session hash; an expired but otherwise valid same-session pointer
may be refreshed. Never replace or remove an unsupported, malformed, linked,
hard-linked, mismatched, or identity-changed entry observed before the final
syscall. Atomic replacement operates
on the reserved directory entry and never follows its contents. If a
cooperative concurrent writer changes the target, re-inspect it: another exact
valid same-session v2 pointer is an authorized advisory writer and may be
retried within the existing bound, with the last successfully completed atomic
replace winning. Any other concurrent replacement observed before the final
syscall fails and is preserved. Under the cooperative local-host-state
contract, the bound-parent and non-overlap checks prevent observed link,
reparse, hard-link, or parent substitution from redirecting an operation into
project state. Every observed pre-syscall parent or target identity failure
warns, preserves evidence, and performs no cleanup of the questionable entry.

Node's final `rename` and `unlink` calls remain path based: the interval between
the last successful validation and the syscall is best-effort against an
actively racing same-account or administrator process. Such mutation and
network filesystems remain outside this contract. This qualification does not
authorize following a path, continuing after an observed mismatch, loading the
addon in a hook, or weakening the exact same-binding rule. Tests can prove
substitution injected before the final validation and cooperative valid-writer
concurrency; they must not claim atomic protection from an adversarial local
racer.

Stop resolves the root again from the same valid attestation, loads only a
schema-v2 pointer, and calls only `inspectTaskLedgerReadOnly`. It may return the
existing exact pause/complete call or canonical-footer guidance. Missing,
legacy-v1, invalid, expired, mismatched, unsupported, or unstable state emits a
bounded path-free warning and allows Stop; `stop_hook_active` still prevents a
retry loop. The exact report call may return the attested root to that same
host, but the pointer, warning, and logs do not persist or expose it. SessionEnd
removes the exact session pointer and host attestation only after their
same-binding BigInt identities and parents validate under the cooperative
boundary. Both are non-project host state; an observed replacement or partial
cleanup only warns, preserves the questionable entry, and never intentionally
touches the workspace. The final path-syscall race retains the exclusion above.

Add RED-to-GREEN tests covering every validation branch; missing, corrupt,
expired, mismatched, legacy, newer, oversized, linked, hard-linked, replaced,
and read-raced ledger/pointer state; byte, identity, and mtime preservation of
the project and all eight lock domains; exact open/paused/completed/footer Stop
behavior; no mutation on warnings; no activation or addon load; privacy fields;
and concurrent same-session/different-session pointer writes with no `.lock` or
normal-completion temporary residue. Assert the static manifest has no
confirmation argument and remains unchanged. Assert source and built-hook
inventories contain no forbidden hook capability or mutating-ledger call.

Add exact identity regressions using a test-only injected stat seam: distinct
device/inode values above `Number.MAX_SAFE_INTEGER` that would round to the same
number, and distinct nanosecond timestamps within one millisecond, must never
compare equal. Prove directory bindings ignore only child-sensitive mutable
metadata, stable file reads detect every identity/content-time change, and
post-publication identity accepts birth-time and change-time differences while
rejecting a change to any retained `dev`, `ino`, `mode`, `nlink`, `size`, or
`mtimeNs` field. On Windows, refresh the same valid fixed-name host attestation
and session pointer without a delay or retry; both operations must succeed, and
the published target must retain the temporary's exact device/inode even when
NTFS tunnels the target name's creation time. Add nested extra/missing-field
cases for every current-ledger subobject and prove the strict reader never
reconstructs legacy state, inserts defaults, deduplicates values, or builds a
report.

Include all host-environment combinations: each valid single pair, matching
dual aliases, missing mates, mixed families, conflicting aliases, relative
paths, non-directory/link/reparse data roots, data/workspace equality and both
ancestor directions, substituted data root, and substituted/direct-linked
sessions child. Exercise the attestation's exact schema, 64 KiB cap, canonical
timestamp window, plugin/session hashes, current real root, parent/entry
identity replacement during read/refresh/removal, symlink/reparse/hardlink
state, and safe SessionEnd partial cleanup. Exercise pointer target absent,
valid-current, valid-expired, invalid, unsupported, mismatched, linked,
hard-linked, and replacement-race rows. Two cooperative valid writers may
replace each other only under the documented bounded advisory rule; any foreign
replacement observed before the final syscall is preserved. Add successful
structured-response authority rows: `isError`/`is_error` true, non-boolean or
conflicting status, error-shaped output, text-only JSON, conflicting structured
aliases, an input-only task id paired with failure, and structured task/root
conflicts all leave the pointer unchanged; canonical successful structured
output and a successful input-only existing-pointer match remain positive.

Update the Codex, Claude Code, privacy, and limitations documentation: hooks are
cooperative, permanently unactivated observers; the attestation alone grants
root authority but never process activation; the root-free pointer is advisory;
and invalid state fails open for lifecycle enforcement while remaining closed
against project mutation.

- [ ] **Step 7: Implement the contained real-native test runner**

Remove the package `pretest` lifecycle script. `test` invokes
`node scripts/run-tests.mjs` directly. `test:preactivation` invokes the same
runner in fixed `--preactivation-only` mode. `test:activated` invokes it with
`--activated-only --`. The parser removes at most one literal separator and
forwards all remaining file filters and Vitest options only to the activated
run. The preactivation suite is always fixed and unfiltered.

The outer runner invokes direct Node entrypoints only: `process.execPath` plus
`node_modules/vitest/vitest.mjs`, `scripts/build.mjs`, or
`scripts/build-native-lock-addon.mjs`. It never recursively invokes a package
test script, `pnpm`, or a platform `.cmd` shim. Every phase, including
preactivation, TypeScript/esbuild and their descendants, native build and its
Cargo descendants, and activated Vitest and its descendants, runs in an
isolated process tree.

The runner implements this exact state machine:

1. Run `vitest.preactivation.config.ts` with the production provider, no alias,
   no setup file, no native-test environment, and no preceding build. Its
   dedicated tests prove every production lock path rejects before addon load
   or any domain-root, anchor, journal, or compatibility-path mutation. Stop
   before creating the harness root if this fixed suite fails.
2. Create one fresh direct child of the resolved OS temporary directory with a
   fixed TokenGraph test prefix. Record its no-follow type, real path, and
   identity, then create only its expected build, runtime, asset, and staging
   children. Pass `TEMP`, `TMP`, and `TMPDIR` as the staging child for every
   later subprocess; restore nothing globally because the outer process passes
   a child-only environment.
3. Run a fresh `scripts/build.mjs`. Scan every source `dist` JavaScript/CommonJS
   bundle and later every mirrored bundle for test environment names, the test
   provider/configuration names, and `tests/support` paths. Any marker fails.
4. Select the exact current record from the closed Task 4 target table; Linux
   additionally requires the reported glibc runtime to be at least 2.28. Run
   `scripts/build-native-lock-addon.mjs` once for its exact Rust target into the
   owned build child. Hash and measure the real resulting addon. Generate a
   clearly test-only loader manifest with the six canonical sorted records
   required by the Task 5 schema: the current record binds the real bytes and
   hash, while the other five name absent files so wrong-target selection fails
   closed. Never pass this harness to native validation, packaging, release, or
   any six-target evidence gate.
5. Assemble a complete external runtime under the owned root: byte-for-byte
   copy all fresh `dist/**`, `package.json`, and existing assets except the
   entire source `assets/native-lock/**` subtree. Then construct a new isolated
   `assets/native-lock` containing only the current test addon and loader-only
   manifest. This exclusion remains mandatory after Task 9 adds six committed
   binaries; the harness never overlays or mixes with them. Enumerate,
   no-follow validate, and hash the mirror; reject links, extras, omissions, or
   source/mirror disagreement outside that deliberately reconstructed subtree.
6. Run `vitest.activated.config.ts` with only test-owned runtime, asset,
   staging, and entry paths plus all three temporary variables. Its Vite plugin
   resolves the literal `./nativeLockProvider.js` to
   `tests/support/nativeLockProvider.ts` only when the query-stripped importer
   real path is exactly `src/core/fileLockLease.ts`; every other importer or
   specifier falls through. The test provider fails on absent or malformed
   harness state and calls the real `loadNativeLockAddon` with the verified
   asset and staging roots. A setup file explicitly calls
   `activateLegacyRuntimeShutdown({ confirmedNoLegacyTokenGraphProcesses: true
   })` in each isolated Vitest worker. Spawned CLI, MCP, and smoke processes use
   the mirrored production bundles and resolve the adjacent real addon. Spawned
   `dist/hooks.js` processes also use the mirror but remain deliberately
   unactivated, must not load the addon, and exercise only the attested
   read-only lifecycle path from Step 6. Every child inherits the confined
   temporary variables.
7. Wait for the test root process and its complete process tree to drain. On
   POSIX, start a dedicated process group and require `kill(-pgid, 0)` to report
   `ESRCH` after the root exits. On Windows, each contained phase gets a fresh
   runner-owned control directory and an exclusively created, restrictive JSON
   specification with exact `schemaVersion`, absolute `exe`, `argv`, absolute
   `cwd`, complete child `env`, bounded `timeoutMs`, and
   absolute owned `statusPath` fields. The outer runner invokes Windows
   PowerShell hidden and noninteractively with `-NoLogo -NoProfile
   -NonInteractive -File`; the checked-in supervisor uses only `Add-Type` with
   embedded C# P/Invoke and operating-system APIs, with no module or executable
   dependency. The C# code validates NUL-free arguments and environment,
   applies the Windows inverse-`CommandLineToArgvW` quoting rules, emits a
   double-NUL-terminated environment block in deterministic case-insensitive
   key order, and calls `CreateProcessW` with
   `CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT | CREATE_NO_WINDOW`,
   `STARTF_USESTDHANDLES`, and explicitly inherited standard-input/output/error
   handles. It assigns the suspended process to a newly created Job Object with
   `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` before `ResumeThread`. `Start-Process`
   and spawning a running child before assignment are forbidden because either
   permits an uncontained descendant race.

   If Job Object creation/configuration or `AssignProcessToJobObject` fails
   before assignment, the supervisor must call `TerminateProcess` directly on
   the still-suspended root process; `TerminateJobObject` and handle closure are
   not accepted as containment for that path. It then performs a bounded wait
   on the process handle and proves the root exited before emitting a
   forced-failure status. The control and harness roots are preserved. If direct
   termination or the wait result is ambiguous, the supervisor retains the
   process and thread handles through the bounded resolution attempt, reports
   failure, preserves both roots, and never resumes the child or reports safe
   containment.

   The supervisor exclusively writes an owned, bounded status file with exact
   `schemaVersion`, `state`, `childPid`, `exitCode`, `forced`,
   `activeProcesses`, and bounded `errorCode` fields. An unforced success is
   valid only when `state` is `completed`, `forced` is false, `exitCode` is an
   integer, and the queried Job Object count is zero. The outer runner
   no-follow validates the status file and its control directory before and
   after reading. A missing, malformed, linked, replaced, incomplete, or
   contradictory status, a nonzero active count, or any job creation,
   assignment, resume, wait, or query ambiguity fails closed and preserves the
   applicable control and harness roots.
8. A timeout, forced `SIGTERM`/`SIGKILL`, or `TerminateJobObject` is a failed
   phase even if all processes later exit. Terminate the entire containment,
   prove zero remaining members, preserve the owned root for evidence, and do
   not continue or clean it. After an unforced completion, including an
   ordinary test assertion failure, clean only after proving tree zero:
   revalidate the exact recorded root identity and expected closed layout,
   remove it without following links, and prove absence before returning the
   original result.

Add exact contract tests for state ordering, argument forwarding, containment
failure behavior, external-entry routing, the one production provider import,
the importer-scoped alias, the permanently unactivated hook exception, and
test-marker absence from built bundles. Launch the complete external mirror
with `cwd` exactly equal to its real plugin runtime root and no trust metadata;
assert `pluginRootLaunch: true`, `blockingReason: "missing-trusted-workspace"`,
and no cwd fallback. Then supply matching host metadata and a valid attestation
for a separate workspace and prove that workspace resolves while
`pluginRootLaunch` remains true. Windows
mapped DLLs may remain under the owned staging root while their worker or child
is alive; cleanup occurs only after the Job Object proves every mapping process
has exited. POSIX retains Task 5's immediate post-load unlink behavior.

Install Rust 1.97.1 and the exact current Linux target in both `ci.yml` and
`release.yml` before `pnpm test`, because the full test command now builds and
loads a real current-target addon. Keep these test assets separate from the
pinned RHEL 8/glibc 2.28 six-target release build.

- [ ] **Step 8: Verify inventory, maintenance boundaries, hook isolation, harness isolation, and type safety**

Run: `rg -n 'withFileLock\(` plugins/tokengraph/src/core`

Expected: every call receives a branded object returned by
`canonicalPersistenceLock`; no raw `.lock` concatenation or domain inference
remains.

Run: `pnpm typecheck`

Run: `pnpm test:preactivation`

Run: `pnpm test:activated -- tests/foundations.test.ts tests/core.test.ts tests/task-ledger.test.ts tests/runner.test.ts tests/knowledge-review-queue.test.ts tests/cli-runner.test.ts tests/cli-smoke.test.ts tests/mcp-smoke.test.ts tests/hooks.test.ts tests/low-write-policy.test.ts tests/test-runner-contract.test.ts --reporter=dot`

Run: `pnpm test -- --reporter=dot`

Expected: PASS. Preactivation ran before any build or harness creation, the
activated workers and lock-taking CLI/MCP/smoke children used the real current
addon, every hook child stayed unactivated and project-read-only, every
contained process tree drained without forced termination, the owned temporary
root was removed, and no test-provider marker entered `dist`.

- [ ] **Step 9: Commit**

```bash
git add .github/workflows/ci.yml .github/workflows/release.yml plugins/tokengraph/package.json plugins/tokengraph/vitest.config.ts plugins/tokengraph/vitest.activated.config.ts plugins/tokengraph/vitest.preactivation.config.ts plugins/tokengraph/scripts/run-tests.mjs plugins/tokengraph/scripts/run-process-tree-windows.ps1 plugins/tokengraph/src plugins/tokengraph/tests docs/hosts/codex.md docs/hosts/claude-code.md docs/trust/privacy.md docs/trust/limitations.md
git commit -m "refactor(tokengraph): enforce lock maintenance domains"
```

Task 9 remains the release boundary. Its current-target source-asset tests run
without the importer alias or harness paths and exercise the default production
provider against the committed, independently assembled six-target asset set.

### Task 8: Prove cross-process exclusion, crash recovery, and the rollout boundary

**Files:**
- Create: `plugins/tokengraph/scripts/native-lock-probe.mjs`
- Create: `plugins/tokengraph/tests/storage-lock-process.test.ts`
- Create: `plugins/tokengraph/tests/fixtures/legacy-file-lock-worker.mjs`
- Modify: `plugins/tokengraph/tests/foundations.test.ts`

**Interfaces:**
- Consumes the real current-target addon and production `withFileLock` integration.
- Produces a test-only newline-delimited JSON stdin protocol: `hold`, `try`, `crash`, and `release`; stdout emits only bounded `{status, owner, maxOwners}` records.
- The probe is excluded from release packaging.
- Preserves Task 7's process boundary: every controlled lock probe explicitly
  activates itself, while any spawned production hook remains unactivated and
  can use only attested strict read-only lifecycle inspection.

- [ ] **Step 1: Write failing six-contender and crash tests**

```ts
it("allows exactly one native owner across six processes", async () => {
  const results = await runContenders({ count: 6, key: lockPath, holdMs: 100 });
  expect(Math.max(...results.map((result) => result.maxOwners))).toBe(1);
  expect(results.filter((result) => result.status === "acquired")).toHaveLength(6);
});

it("reacquires after the owning process aborts", async () => {
  await crashOwner(lockPath);
  await expect(tryOwner(lockPath, 2_000)).resolves.toMatchObject({ status: "acquired" });
});
```

Add tests that unactivated child processes refuse before touching filesystem
state, then activate each controlled v2 child explicitly. Cover 20 repetitions,
same-domain keys serializing, different-domain
keys overlapping, timeout, cancellation while waiting, parent termination,
operation exception, long operation beyond 30 seconds using injected time,
anchor/domain-root rename attempts, and no orphan child process. Exercise 1,000
unique run, task, and artifact keys and assert constant per-domain
anchor/journal cardinality plus zero clean compatibility barriers. Repeatedly
crash in each journal phase and assert recovery leaves at most one barrier per
domain. Kill real children after stale/dead intent adoption records the barrier
identity but before any pending lease create, and after lease-created
finalization with no pending replacement; the next process must take cleanup,
never initiate lease creation or heartbeat for the dead callback, and then
reacquire normally.

- [ ] **Step 2: Freeze the old-runtime fixture and test defense-in-depth barriers**

The fixture must reproduce v0.23.1 exactly: `open(lockPath, "wx", 0o600)`, run operation, close, `rm(lockPath, {force:true})`; on `EEXIST`, use `stat.mtimeMs`, and after 30 seconds attempt nonrecursive `rm`.

Test both directions at a normal TokenGraph lock and at real Git common-directory `info/exclude.lock`:

1. Existing old lock file causes upgraded code to return `LEGACY_LOCK_BLOCKED` without deleting or modifying it.
2. Upgraded nonempty temporary lock directory causes the old fixture to fail
   without running its operation or removing `lease.json`; the persistent anchor
   remains in the registered domain root.
3. Calling `getRepositoryIdentity()` creates the exact Git exclude lock directory and still updates `.git/info/exclude` once.
4. A legacy file at the Git exclude path yields `LOCAL_EXCLUDE_WARNING` and leaves Git exclude content unchanged.
5. The cleanup race in which an old same-key creator runs after v2 removes its
   lease is safe: the v2 callback has finished, foreign state is preserved, and
   the next v2 owner fails closed.

These controlled probes establish stale-file handling and accidental same-key
downgrade defense only. They must not be described as safe mixed-runtime
coexistence. A contract test requires setup, CLI help, limitations, and release
installation guidance to say that every v0.23.1 process must be stopped before
v2 activation and must not be restarted while v2 runs.

- [ ] **Step 3: Run the process tests to observe RED**

Run: `pnpm test:activated -- tests/storage-lock-process.test.ts tests/foundations.test.ts --reporter=verbose`

Expected: FAIL because the probe and legacy fixture are absent.

- [ ] **Step 4: Implement bounded probe coordination**

The probe reads one JSON object from stdin with maximum 8 KiB, validates operation/key/timeout, loads the current verified addon, and never echoes the absolute key. Use a small counter file only inside the test's temporary coordination directory; update it while holding the native lock to record current/max owner count. `crash` calls `process.abort()` while the handle is strongly retained. Every timer has a hard deadline and all spawned processes use `windowsHide:true`, `shell:false`, bounded stdio, and explicit teardown.

- [ ] **Step 5: Run repeated real Windows tests**

Run: `1..30 | ForEach-Object { pnpm test:activated -- tests/storage-lock-process.test.ts --reporter=dot; if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE } }`

Expected: all repetitions PASS, unactivated processes refuse without mutation,
maximum owners always one, crash reacquire is bounded, and both controlled
legacy-barrier directions preserve foreign state without claiming coexistence.
Every repetition constructs and removes its own real current-addon harness;
none may bypass the activated provider merely to reuse a prior build.

- [ ] **Step 6: Run focused persistence-heavy tests**

Run: `pnpm test:activated -- tests/foundations.test.ts tests/core.test.ts tests/task-ledger.test.ts tests/runner.test.ts tests/knowledge-review-queue.test.ts --reporter=dot`

- [ ] **Step 7: Commit**

```bash
git add plugins/tokengraph/scripts/native-lock-probe.mjs plugins/tokengraph/tests/storage-lock-process.test.ts plugins/tokengraph/tests/fixtures/legacy-file-lock-worker.mjs plugins/tokengraph/tests/foundations.test.ts
git commit -m "test(tokengraph): verify native lock recovery"
```

### Task 9: Build and execute all six native targets in GitHub Actions

**Files:**
- Create: `.github/workflows/native-lock.yml`
- Create: `plugins/tokengraph/tests/native-lock-workflow.test.ts`
- Create: six `plugins/tokengraph/assets/native-lock/<target>/tokengraph-lock.<target>.node`
- Create: `plugins/tokengraph/assets/native-lock/manifest.json`
- Create: `plugins/tokengraph/assets/native-lock/THIRD_PARTY_NOTICES.txt`

**Interfaces:**
- Consumes Tasks 1-4 build/test/manifest commands.
- Produces six real runner proofs and the committed source asset set consumed by the default Task 5 loader.
- Does not change the hook boundary: committed assets never authorize a hook to
  load the addon or mutate project state, and hook success is not native-target
  execution evidence.

- [ ] **Step 1: Write the failing workflow contract test**

```ts
expect(matrix).toEqual(expect.arrayContaining([
  expect.objectContaining({ runner: "windows-2025", target: "x86_64-pc-windows-msvc" }),
  expect.objectContaining({ runner: "windows-11-arm", target: "aarch64-pc-windows-msvc" }),
  expect.objectContaining({ runner: "ubuntu-24.04", target: "x86_64-unknown-linux-gnu" }),
  expect.objectContaining({ runner: "ubuntu-24.04-arm", target: "aarch64-unknown-linux-gnu" }),
  expect.objectContaining({ runner: "macos-15-intel", target: "x86_64-apple-darwin" }),
  expect.objectContaining({ runner: "macos-15", target: "aarch64-apple-darwin" })
]));
```

Assert `permissions: contents: read`, Rust 1.97.1, Node 22, exact six entries, native test before upload, current-target Node load from the built output, archive-path confinement, and immutable action pins. Approved pins are checkout `11d5960a326750d5838078e36cf38b85af677262`, setup-node `49933ea5288caeca8642d1e84afbd3f7d6820020`, upload-artifact `ea165f8d65b6e75b540449e92b4886f43607fa02`, and download-artifact `d3f86a106a0bac45b974a628896c90dbdf5c8093`.

- [ ] **Step 2: Run the workflow test and verify RED**

Run: `pnpm vitest run tests/native-lock-workflow.test.ts --reporter=verbose`

Expected: FAIL because the workflow is absent.

- [ ] **Step 3: Implement the six-entry native matrix**

Each matrix job checks out, installs Node 22 and Rust 1.97.1, builds one exact target, runs `cargo test` on that real OS/architecture, runs the production private-staging loader plus Node acquire/busy/release/crash probe against the built `.node`, validates its target identity, and uploads only the `.node` plus one JSON build receipt. Linux jobs run in or link against the pinned RHEL 8/glibc 2.28 environment. Windows uses explicit reproducible/static CRT flags; macOS uses deployment target 11.0. Linux and macOS must prove the staged file/root can be unlinked immediately after successful `process.dlopen` while acquire/busy/release still works. Windows must prove a live mapped DLL is preserved, a child crash leaves at most one exact safe root, and a later process reclaims that dead-PID root through the bounded nonrecursive sweep. Every runner rejects staged tampering, unexpected/link entries, live or indeterminate owners, and identity replacement without executing the candidate.

On every Windows, Linux, and macOS matrix entry, kill a real child after every
generation-zero bootstrap create, write, file sync, rename, and parent flush;
for every later journal generation—intent, `pendingBarrier`, barrier identity,
pending lease create, pending lease replace, temporary identity, lease-identity
finalization, heartbeat, cleanup, and idle—after journal-temporary create,
write, file sync, rename, and parent flush; after durable `pendingBarrier`;
after `mkdir`; after barrier-identity commit; after stale/dead barrier adoption
commits its identity but before pending lease create; after lease-created
finalization while no pending replacement exists; and after every lease
temporary create, payload write, file flush, temporary-identity commit, rename,
parent-directory flush, and lease finalization. A fresh process must recover
those dead states without initiating the dead callback's lease or heartbeat,
recover every other authorized state, reacquire, and leave at most one
journal temporary, one lease temporary, and one barrier per domain. Inject a
foreign or same-text replacement at the old target, recorded temporary, and
fully enumerated parent classification; every such recorded-identity mismatch, link/reparse point, or
extra entry must be preserved and fail closed on the real filesystem.

The workflow runs for pull requests and pushes as verification. A `workflow_dispatch` input `assemble` may upload the six bootstrap artifacts only from a branch in `Mujadarah/TokenGraph`; fork events can test but their artifacts are never accepted into source assets.

- [ ] **Step 4: Verify workflow syntax and immutable pins locally**

Run: `pnpm vitest run tests/native-lock-workflow.test.ts tests/release-workflow.test.ts --reporter=verbose`

Expected: PASS; no `uses: owner/action@vN` reference exists.

- [ ] **Step 5: Run the trusted bootstrap build**

Push only the dedicated temporary Phase 3 bootstrap branch, dispatch `.github/workflows/native-lock.yml` with `assemble=true`, and wait for all six jobs. Record run id, commit SHA, runner labels, conclusions, and artifact digests. Do not use a fork run, rerun against a different commit, or accept a partially successful matrix.

Download with authenticated GitHub CLI into a newly created worktree-local staging directory. Verify each receipt commit equals the local Phase 3 commit and each target matches its directory. Generate manifest/notices locally with Task 4 scripts, validate all six, then copy the verified files into `plugins/tokengraph/assets/native-lock/`. Remove the temporary remote bootstrap branch after the committed asset set is independently rebuilt/verified; do not remove any pre-existing remote branch.

- [ ] **Step 6: Run current-target source-asset tests**

Run: `pnpm native:validate -- --assets assets/native-lock --load-current`

Run on the Windows verification host (see the decision-complete amendment in
`docs/plans/2026-08-13-task9-contained-native-source-verification-decision.md`):

```powershell
$env:TOKENGRAPH_NATIVE_CURRENT_ASSET = (Resolve-Path "assets/native-lock/win32-x64/tokengraph-lock.win32-x64.node").Path
pnpm vitest run tests/native-lock-addon.test.ts tests/native-lock-packaging.test.ts --reporter=verbose
pnpm test:activated tests/storage-lock-process.test.ts --reporter=verbose
Remove-Item Env:\TOKENGRAPH_NATIVE_CURRENT_ASSET
```

Expected: PASS using the committed `win32-x64` source asset rather than fresh
harness build output.

- [ ] **Step 7: Commit**

```bash
git add .github/workflows/native-lock.yml plugins/tokengraph/assets/native-lock plugins/tokengraph/tests/native-lock-workflow.test.ts
git commit -m "ci(tokengraph): verify six native lock targets"
```

### Task 10: Package, validate, and document the native runtime

**Files:**
- Modify: `plugins/tokengraph/scripts/package-plugin.mjs`
- Modify: `plugins/tokengraph/scripts/validate-plugin.mjs`
- Modify: `plugins/tokengraph/tests/native-lock-packaging.test.ts`
- Modify: `plugins/tokengraph/tests/cli-smoke.test.ts`
- Modify: `plugins/tokengraph/tests/mcp-smoke.test.ts`
- Modify: `plugins/tokengraph/tests/hooks.test.ts`
- Modify: `plugins/tokengraph/README.md`
- Modify: `docs/hosts/codex.md`
- Modify: `docs/hosts/claude-code.md`
- Modify: `docs/trust/security.md`
- Modify: `docs/trust/privacy.md`
- Modify: `docs/trust/limitations.md`
- Modify: `docs/trust/release-install.md`
- Regenerate: `release/tokengraph/**`

**Interfaces:**
- Consumes the complete source assets and validator from Task 9.
- Produces a generated release/archive containing exactly the six addons, manifest, and notices with source/release byte parity.

- [ ] **Step 1: Write failing source/release/archive parity tests**

```ts
for (const artifact of manifest.artifacts) {
  expect(await sha256(releaseAsset(artifact.path))).toBe(artifact.sha256);
  expect(await sha256(archiveAsset(artifact.path))).toBe(artifact.sha256);
}
expect(archiveListing.filter((path) => path.endsWith(".node"))).toHaveLength(6);
```

Add failures for a missing addon, extra executable, changed mode, mismatched manifest, source/release byte difference, archive omission, `src|tests|native|scripts` leakage, absolute path leakage, and release operation without a validated asset set.

- [ ] **Step 2: Run packaging tests and verify RED**

Run: `pnpm vitest run tests/native-lock-packaging.test.ts tests/cli-smoke.test.ts tests/mcp-smoke.test.ts tests/hooks.test.ts --reporter=verbose`

Expected: FAIL because packaging/validation does not yet enforce native assets.

- [ ] **Step 3: Gate packaging on native validation**

Before copying installable files, call the shared native validator against source assets. Continue copying the whole validated `assets` directory, but assert the exact native allowlist before and after copy. Normalize addon modes to `0o644`; Node loads them as libraries, not executables. Extend generated release metadata to state that six prebuilt addons are included and no compiler/download is required.

- [ ] **Step 4: Extend strict plugin validation**

Have `validate-plugin.mjs` invoke/export the native validator for source and
`release/tokengraph/assets/native-lock`, compare manifest and every binary
byte-for-byte, verify current-target load from both layouts, and reject
additional executables. Validate that security/limitations/install docs state
OS floors, musl refusal, stale legacy-file blocking, local-filesystem scope,
integrity behavior, private OS-temp staging, bounded dead-PID cleanup, possible
single-root Windows crash residue, and the unsupported mixed-runtime boundary without
machine-local paths. Document the exact rollout: stop every v0.23.1 MCP/CLI
process, start v2, activate that MCP server through confirmed
`tokengraph_setup` or each CLI invocation through
`--confirm-no-legacy-processes`, and restart/reactivate v2 if any old runtime is
started. State that Doctor reports activation but never grants it.

Validate the packaged `hooks/hooks.json` remains byte-identical to source and
contains no activation or legacy-shutdown confirmation argument. Execute the
packaged `dist/hooks.js` lifecycle suite without activating that process or
loading any addon. Confirm it trusts only the matching host-workspace
attestation, reads only current-schema ledgers through the strict read-only
path, stores only the root-free schema-v2 pointer, and never mutates project
state. Codex, Claude Code, privacy, and limitations docs must describe that
cooperative fail-open lifecycle behavior without implying that attestation or
plugin-data state grants activation.

- [ ] **Step 5: Regenerate and test the release**

Run: `pnpm build`

Run: `pnpm package:plugin -- --release`

Run: `pnpm validate:plugin`

Run: `pnpm package:plugin -- --json`

Run: `pnpm vitest run tests/native-lock-packaging.test.ts tests/cli-smoke.test.ts tests/mcp-smoke.test.ts tests/hooks.test.ts --reporter=verbose`

Run: `git diff --check`

Expected: all commands PASS; the archive and generated release load the current addon without `node_modules`.

- [ ] **Step 6: Commit source and generated release together**

```bash
git add plugins/tokengraph/scripts/package-plugin.mjs plugins/tokengraph/scripts/validate-plugin.mjs plugins/tokengraph/tests/native-lock-packaging.test.ts plugins/tokengraph/tests/cli-smoke.test.ts plugins/tokengraph/tests/mcp-smoke.test.ts plugins/tokengraph/tests/hooks.test.ts plugins/tokengraph/README.md docs/hosts/codex.md docs/hosts/claude-code.md docs/trust/security.md docs/trust/privacy.md docs/trust/limitations.md docs/trust/release-install.md release/tokengraph
git commit -m "build(tokengraph): package native lock addons"
```

### Task 11: Run complete gates and mandatory independent review

**Files:**
- Modify only files named by a validated review finding.
- Record review/gate evidence in the existing ignored SDD progress/report files; do not add machine-local evidence to public source or release files.

**Interfaces:**
- Consumes the complete Phase 3 branch.
- Produces a merge-ready Phase 3 commit range based on verified Phase 2, or a documented stop with no merge claim.

- [ ] **Step 1: Verify branch ancestry and scope**

Run: `git merge-base --is-ancestor codex/stack-phase-2 HEAD`

Run: `git diff --stat codex/stack-phase-2...HEAD`

Run: `git status --short --branch`

Expected: ancestry succeeds; only approved Phase 3 source, assets, tests, workflow, docs, and generated release changes appear; worktree is clean.

- [ ] **Step 2: Run native formatting, lint, and current-platform tests**

Run: `cargo fmt --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml -- --check`

Run: `cargo clippy --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked --all-targets -- -D warnings`

Run: `cargo test --manifest-path plugins/tokengraph/native/lock-addon/Cargo.toml --locked -- --nocapture`

Run: `pnpm native:validate -- --assets assets/native-lock --load-current`

Expected: PASS.

- [ ] **Step 3: Run TypeScript and full regression gates**

From `plugins/tokengraph` run:

```text
pnpm typecheck
pnpm test -- --reporter=dot
pnpm build
pnpm smoke -- --root . --json
pnpm smoke -- --root . --surface full --json
pnpm validate:plugin
pnpm package:plugin -- --release
pnpm package:plugin -- --json
```

Then from repository root run `git diff --exit-code -- release/tokengraph` and `git diff --check`.

Expected: every command exits zero and regeneration leaves no diff.

- [ ] **Step 4: Re-run concurrency and package stress gates**

Run the Windows storage-lock process suite 50 times. In GitHub Actions, require fresh green conclusions for all six native matrix entries at the exact review commit. Extract the generated archive on each runner and load that runner's packaged addon before accepting its result.

Expected: maximum observed same-key ownership is one; same-domain keys
serialize; different-domain keys overlap; owner termination reacquires; journal
reconciliation leaves at most one barrier per domain; and all six extracted
archives load and pass.

- [ ] **Step 5: Request independent concurrency/security review**

Give the reviewer the approved design, this plan, `codex/stack-phase-2...HEAD`, the failed Node-only trace, six-runner evidence, and packaging hashes. Require explicit review of:

1. Windows retained handle chain and no-delete sharing.
2. POSIX descriptor/directory-entry identity and cooperative limitation.
3. Exact-path stale/downgrade barrier, especially Git `info/exclude.lock`,
   without claiming concurrent mixed-runtime safety.
4. Native release fail-stop and JavaScript `AggregateError` ordering.
5. Loader integrity/libc/ABI fail-closed paths.
6. Six binary provenance, notices, generated release, and no-fallback behavior.
7. Closed domain inventory, journal-v2 pending transitions, exact reserved
   authority, complete-entry validation before mutation, one-journal-temp/
   one-lease-temp/one-barrier cardinality, removable canceled queue nodes,
   post-acquisition signal detachment, and caller coverage.
8. Canonically ordered multi-domain maintenance, infrastructure preservation,
   and the explicit no-legacy-process confirmation on CLI, MCP, and quota paths.
9. Process-local activation before every v2 lock and the documented requirement
   to stop all v0.23.1 processes before activation.

Expected: written `APPROVE` or actionable findings; silence is not approval.

- [ ] **Step 6: Address findings test-first and repeat all affected gates**

For every accepted finding, add a failing regression test, verify RED, implement the smallest correction, verify GREEN, rerun the complete relevant native/TypeScript/package gates, and request re-review. Use one conventional fix commit per coherent finding group. Do not mark Phase 3 complete with an unresolved severity finding, a skipped supported target, or a dirty worktree.

- [ ] **Step 7: Produce the Phase 3 handoff**

Record final commit range, exact gate counts, six workflow run/job URLs, archive hashes, review verdict, known best-effort network/POSIX boundary, and the explicit fact that the failed Node-only implementation was not merged. The next branch must be created from this verified Phase 3 head; do not cherry-pick the rejected Phase 3 worktree.
