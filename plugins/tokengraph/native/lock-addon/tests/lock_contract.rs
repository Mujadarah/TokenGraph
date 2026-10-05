use std::{
    fs,
    path::{Path, PathBuf},
    process::{Command, Output, Stdio},
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[cfg(unix)]
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
#[cfg(any(windows, unix))]
use std::process::Child;
#[cfg(windows)]
use std::{
    ffi::OsString,
    os::windows::{
        ffi::{OsStrExt, OsStringExt},
        fs::OpenOptionsExt,
    },
};
#[cfg(windows)]
use windows_sys::Win32::Storage::FileSystem::FILE_SHARE_READ;

#[test]
fn abi_is_pinned_to_one() {
    assert_eq!(tokengraph_lock::ABI_VERSION, 1);
}

#[test]
fn cargo_cdylib_names_cover_windows_linux_and_macos() {
    assert_eq!(cargo_cdylib_name("windows"), "tokengraph_lock.dll");
    assert_eq!(cargo_cdylib_name("linux"), "libtokengraph_lock.so");
    assert_eq!(cargo_cdylib_name("macos"), "libtokengraph_lock.dylib");
}

#[test]
fn addon_exports_abi_version_as_a_numeric_non_callable_property() {
    let temp = TestTempDir::new("abi-shape");
    let manifest = Path::new(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
    let target_dir = temp.path().join("target");
    let build = run_bounded(
        Command::new(env!("CARGO"))
            .arg("build")
            .arg("--quiet")
            .arg("--manifest-path")
            .arg(&manifest)
            .arg("--locked")
            .env("CARGO_TARGET_DIR", &target_dir),
        "cargo build for native ABI shape test",
    );
    assert!(
        build.status.success(),
        "cargo build failed: {}",
        String::from_utf8_lossy(&build.stderr)
    );

    let addon = target_dir
        .join("debug")
        .join(cargo_cdylib_name(std::env::consts::OS));
    assert!(
        addon.is_file(),
        "missing Windows cdylib: {}",
        addon.display()
    );
    let node_addon = temp.path().join("tokengraph-lock.node");
    fs::copy(&addon, &node_addon).unwrap();

    let node = run_bounded(
        Command::new("node")
            .arg("-e")
            .arg(
                "const addon = require(process.argv[1]);\n\
                 if (typeof addon.abiVersion === 'function') throw new Error('abiVersion must not be callable');\n\
                 if (typeof addon.abiVersion !== 'number') throw new Error(`abiVersion must be a number, received ${typeof addon.abiVersion}`);\n\
                 if (addon.abiVersion !== 1) throw new Error(`abiVersion must equal 1, received ${addon.abiVersion}`);",
            )
            .arg("--")
            .arg(node_loadable_path(&node_addon)),
        "node native ABI shape test",
    );
    assert!(
        node.status.success(),
        "node native ABI shape assertion failed: {}",
        String::from_utf8_lossy(&node.stderr)
    );
}

#[test]
fn stable_errors_never_include_the_anchor_path() {
    let error = tokengraph_lock::LockError::unsafe_anchor();
    assert_eq!(error.code(), "UNSAFE_ANCHOR");
    assert!(!error.safe_message().contains('/') && !error.safe_message().contains('\\'));
}

#[cfg(unix)]
const UNIX_CHILD_MODE: &str = "TOKENGRAPH_UNIX_LOCK_CHILD_MODE";
#[cfg(unix)]
const UNIX_CHILD_PATH: &str = "TOKENGRAPH_UNIX_LOCK_CHILD_PATH";
#[cfg(unix)]
const UNIX_CHILD_READY: &str = "TOKENGRAPH_UNIX_LOCK_CHILD_READY";

#[cfg(unix)]
#[test]
fn unix_child_entrypoint() {
    let Some(mode) = std::env::var_os(UNIX_CHILD_MODE) else {
        return;
    };
    let path =
        PathBuf::from(std::env::var_os(UNIX_CHILD_PATH).expect("child lock path must be provided"));

    match mode.to_string_lossy().as_ref() {
        "expect-busy" => {
            let error = expect_acquire_error(&path);
            assert_napi_error_code(&error, "LOCK_BUSY");
        }
        "expect-ok" => {
            let mut handle = tokengraph_lock::try_acquire_anchor(path_string(&path)).unwrap();
            handle.release().unwrap();
        }
        "hold" => {
            let mut handle = tokengraph_lock::try_acquire_anchor(path_string(&path)).unwrap();
            let ready = PathBuf::from(
                std::env::var_os(UNIX_CHILD_READY).expect("child readiness path must be provided"),
            );
            fs::write(ready, b"ready").unwrap();
            thread::sleep(Duration::from_secs(60));
            handle.release().unwrap();
        }
        unexpected => panic!("unexpected Unix child mode: {unexpected}"),
    }
}

#[cfg(unix)]
#[test]
fn unix_rejects_a_symlinked_anchor() {
    let fixture = UnixLockFixture::new("symlink-anchor");
    let target = fixture.domain.join("target.lock");
    fs::write(&target, b"").unwrap();
    symlink(&target, &fixture.anchor).unwrap();

    let error = expect_acquire_error(&fixture.anchor);
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
}

#[cfg(unix)]
#[test]
fn unix_rejects_a_hard_linked_anchor() {
    let fixture = UnixLockFixture::new("hard-link-anchor");
    fs::write(&fixture.anchor, b"").unwrap();
    fs::hard_link(&fixture.anchor, fixture.domain.join("other-link.lock")).unwrap();

    let error = expect_acquire_error(&fixture.anchor);
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
}

#[cfg(unix)]
#[test]
fn unix_rejects_a_symlinked_parent_component() {
    let temp = TestTempDir::new("symlink-parent");
    let real_parent = temp.path().join("real-parent");
    let linked_parent = temp.path().join("linked-parent");
    fs::create_dir(&real_parent).unwrap();
    symlink(&real_parent, &linked_parent).unwrap();

    let error = expect_acquire_error(&linked_parent.join("anchor.lock"));
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
    assert!(!real_parent.join("anchor.lock").exists());
}

#[cfg(unix)]
#[test]
fn unix_rejects_a_non_directory_parent_component() {
    let temp = TestTempDir::new("non-directory-parent");
    let file_component = temp.path().join("ordinary-file");
    fs::write(&file_component, b"not a directory").unwrap();

    let error = expect_acquire_error(&file_component.join("anchor.lock"));
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
}

#[cfg(unix)]
#[test]
fn unix_rejects_group_or_world_writable_anchor() {
    for (label, mode) in [("group-writable", 0o620), ("world-writable", 0o602)] {
        let fixture = UnixLockFixture::new(label);
        fs::write(&fixture.anchor, b"").unwrap();
        fs::set_permissions(&fixture.anchor, fs::Permissions::from_mode(mode)).unwrap();

        let error = expect_acquire_error(&fixture.anchor);
        assert_napi_error_code(&error, "UNSAFE_ANCHOR");
    }
}

#[cfg(unix)]
#[test]
fn unix_second_process_observes_busy_then_acquires_after_release() {
    let fixture = UnixLockFixture::new("ownership");
    let mut first = fixture.acquire();

    fixture.child_expect("expect-busy", &fixture.anchor);
    first.release().unwrap();
    fixture.child_expect("expect-ok", &fixture.anchor);
}

#[cfg(unix)]
#[test]
fn unix_distinct_anchors_can_be_held_concurrently() {
    let first = UnixLockFixture::new("distinct-first");
    let second = UnixLockFixture::new("distinct-second");
    let mut first_handle = first.acquire();
    let mut second_handle = second.acquire();

    second_handle.release().unwrap();
    first_handle.release().unwrap();
}

#[cfg(unix)]
#[test]
fn unix_process_termination_allows_bounded_reacquire() {
    const REACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

    let fixture = UnixLockFixture::new("terminated-owner");
    let ready = fixture.temp.path().join("owner-ready");
    let mut owner = fixture.spawn_holder(&ready);
    wait_for_path(&ready, Duration::from_secs(5));
    assert_napi_error_code(&expect_acquire_error(&fixture.anchor), "LOCK_BUSY");

    owner.terminate();
    let deadline = Instant::now() + REACQUIRE_TIMEOUT;
    loop {
        match tokengraph_lock::try_acquire_anchor(path_string(&fixture.anchor)) {
            Ok(mut handle) => {
                handle.release().unwrap();
                break;
            }
            Err(error) if error.reason.starts_with("LOCK_BUSY:") && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!(
                "terminated Unix owner was not reacquired within {} seconds: {}",
                REACQUIRE_TIMEOUT.as_secs(),
                error.reason
            ),
        }
    }
}

#[cfg(unix)]
#[test]
fn unix_release_does_not_mutate_the_anchor_path() {
    let fixture = UnixLockFixture::new("persistent-anchor");
    let mut handle = fixture.acquire();
    let before = fs::metadata(&fixture.anchor).unwrap();

    handle.release().unwrap();

    let after = fs::metadata(&fixture.anchor).unwrap();
    assert_eq!((after.dev(), after.ino()), (before.dev(), before.ino()));
    assert_eq!(after.mode() & 0o777, 0o600);
}

#[cfg(unix)]
#[test]
fn unix_compatibility_directory_rejects_links_and_releases_explicitly() {
    let fixture = UnixLockFixture::new("compatibility-directory");
    let real_directory = fixture.temp.path().join("real-compatibility.lock");
    let linked_directory = fixture.temp.path().join("linked-compatibility.lock");
    fs::create_dir(&real_directory).unwrap();
    fs::set_permissions(&real_directory, fs::Permissions::from_mode(0o700)).unwrap();
    symlink(&real_directory, &linked_directory).unwrap();
    let mut handle = fixture.acquire();

    let error = handle
        .protect_compatibility_directory(path_string(&linked_directory))
        .unwrap_err();
    assert_napi_error_code(&error, "UNSAFE_COMPATIBILITY_DIRECTORY");
    handle
        .protect_compatibility_directory(path_string(&real_directory))
        .unwrap();
    handle.release_compatibility_directory().unwrap();
    fs::remove_dir(&real_directory).unwrap();
    handle.release().unwrap();
}

#[cfg(windows)]
const WINDOWS_CHILD_MODE: &str = "TOKENGRAPH_WINDOWS_LOCK_CHILD_MODE";
#[cfg(windows)]
const WINDOWS_CHILD_PATH: &str = "TOKENGRAPH_WINDOWS_LOCK_CHILD_PATH";
#[cfg(windows)]
const WINDOWS_CHILD_READY: &str = "TOKENGRAPH_WINDOWS_LOCK_CHILD_READY";

#[cfg(windows)]
#[test]
fn windows_child_entrypoint() {
    let Some(mode) = std::env::var_os(WINDOWS_CHILD_MODE) else {
        return;
    };
    let path = PathBuf::from(
        std::env::var_os(WINDOWS_CHILD_PATH).expect("child lock path must be provided"),
    );

    match mode.to_string_lossy().as_ref() {
        "expect-busy" => {
            let error = expect_acquire_error(&path);
            assert_napi_error_code(&error, "LOCK_BUSY");
        }
        "expect-ok" => {
            let mut handle = tokengraph_lock::try_acquire_anchor(path_string(&path)).unwrap();
            handle.release().unwrap();
        }
        "hold" => {
            let mut handle = tokengraph_lock::try_acquire_anchor(path_string(&path)).unwrap();
            let ready = PathBuf::from(
                std::env::var_os(WINDOWS_CHILD_READY)
                    .expect("child readiness path must be provided"),
            );
            fs::write(ready, b"ready").unwrap();
            thread::sleep(Duration::from_secs(60));
            handle.release().unwrap();
        }
        unexpected => panic!("unexpected Windows child mode: {unexpected}"),
    }
}

#[cfg(windows)]
#[test]
fn windows_second_process_cannot_acquire_or_rebind_anchor() {
    let fixture = WindowsLockFixture::new("ownership");
    let mut first = fixture.acquire();

    fixture.child_expect("expect-busy", &fixture.anchor);
    assert!(
        fs::rename(&fixture.anchor, fixture.domain.join("replacement.lock")).is_err(),
        "the retained anchor handle must deny rename"
    );
    assert!(
        fs::rename(
            &fixture.domain,
            fixture.temp.path().join("replacement-domain")
        )
        .is_err(),
        "the retained directory chain must deny parent rename"
    );

    first.release().unwrap();
    fixture.child_expect("expect-ok", &fixture.anchor);
}

#[cfg(windows)]
#[test]
fn windows_rejects_a_junction_directory_component() {
    let temp = TestTempDir::new("junction-component");
    let target = temp.path().join("target");
    let junction = temp.path().join("junction");
    fs::create_dir(&target).unwrap();
    create_junction(&junction, &target);

    let error = expect_acquire_error(&junction.join("anchor.lock"));
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
    fs::remove_dir(&junction).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_rejects_a_final_reparse_point() {
    let temp = TestTempDir::new("final-reparse");
    let target = temp.path().join("target");
    let anchor = temp.path().join("anchor.lock");
    fs::create_dir(&target).unwrap();
    create_junction(&anchor, &target);

    let error = expect_acquire_error(&anchor);
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
    fs::remove_dir(&anchor).unwrap();
}

#[cfg(windows)]
#[test]
fn windows_rejects_a_directory_anchor() {
    let fixture = WindowsLockFixture::new("directory-anchor");
    fs::create_dir(&fixture.anchor).unwrap();

    let error = expect_acquire_error(&fixture.anchor);
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
}

#[cfg(windows)]
#[test]
fn windows_rejects_a_hard_linked_anchor() {
    let fixture = WindowsLockFixture::new("hard-linked-anchor");
    fs::write(&fixture.anchor, b"").unwrap();
    fs::hard_link(&fixture.anchor, fixture.domain.join("other-link.lock")).unwrap();

    let error = expect_acquire_error(&fixture.anchor);
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
}

#[cfg(windows)]
#[test]
fn windows_acquires_and_releases_a_long_anchor_path() {
    let temp = TestTempDir::new("long-path");
    let mut directory = temp.path().to_path_buf();
    while directory.as_os_str().len() < 300 {
        directory.push("retained-directory-component");
    }
    fs::create_dir_all(&directory).unwrap();
    let anchor = directory.join("anchor.lock");

    let mut handle = tokengraph_lock::try_acquire_anchor(path_string(&anchor)).unwrap();
    handle.release().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_acquires_when_an_existing_handle_shares_only_read() {
    let fixture = WindowsLockFixture::new("read-share-only");
    fs::write(&fixture.anchor, b"").unwrap();
    let _read_only_holder = fs::OpenOptions::new()
        .read(true)
        .share_mode(FILE_SHARE_READ)
        .open(&fixture.anchor)
        .unwrap();

    let mut handle = tokengraph_lock::try_acquire_anchor(path_string(&fixture.anchor)).unwrap();
    handle.release().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_rejects_embedded_nul_before_creating_the_truncated_anchor() {
    let fixture = WindowsLockFixture::new("embedded-nul");
    let nul_path = format!("{}\0suffix", path_string(&fixture.anchor));

    let error = match tokengraph_lock::try_acquire_anchor(nul_path) {
        Ok(mut handle) => {
            handle.release().unwrap();
            panic!("embedded NUL anchor unexpectedly acquired")
        }
        Err(error) => error,
    };
    assert_napi_error_code(&error, "UNSAFE_ANCHOR");
    assert!(
        !fixture.anchor.exists(),
        "embedded NUL validation must run before OPEN_ALWAYS creates the truncated prefix"
    );
}

#[cfg(windows)]
#[test]
fn windows_case_alias_contends_on_the_same_anchor() {
    let fixture = WindowsLockFixture::new("case-alias");
    let mut first = fixture.acquire();
    let case_alias = PathBuf::from(path_string(&fixture.anchor).to_uppercase());

    fixture.child_expect("expect-busy", &case_alias);
    first.release().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_compatibility_directory_is_protected_until_explicit_release() {
    let fixture = WindowsLockFixture::new("compatibility-directory");
    let compatibility = fixture.temp.path().join("compatibility.lock");
    fs::create_dir(&compatibility).unwrap();
    let mut handle = fixture.acquire();

    handle
        .protect_compatibility_directory(path_string(&compatibility))
        .unwrap();
    assert!(
        fs::rename(&compatibility, fixture.temp.path().join("replacement.lock")).is_err(),
        "the compatibility handle must deny rename"
    );
    handle.release_compatibility_directory().unwrap();
    fs::remove_dir(&compatibility).unwrap();
    handle.release().unwrap();
}

#[cfg(windows)]
#[test]
fn windows_double_release_reports_the_stable_state_error() {
    let fixture = WindowsLockFixture::new("double-release");
    let mut handle = fixture.acquire();
    handle.release().unwrap();

    let error = handle.release().unwrap_err();
    assert_napi_error_code(&error, "ALREADY_RELEASED");
}

#[cfg(windows)]
#[test]
fn windows_process_termination_allows_bounded_reacquire() {
    const REACQUIRE_TIMEOUT: Duration = Duration::from_secs(5);

    let fixture = WindowsLockFixture::new("terminated-owner");
    let ready = fixture.temp.path().join("owner-ready");
    let mut owner = fixture.spawn_holder(&ready);
    wait_for_path(&ready, Duration::from_secs(5));
    assert_napi_error_code(&expect_acquire_error(&fixture.anchor), "LOCK_BUSY");

    owner.terminate();
    let deadline = Instant::now() + REACQUIRE_TIMEOUT;
    loop {
        match tokengraph_lock::try_acquire_anchor(path_string(&fixture.anchor)) {
            Ok(mut handle) => {
                handle.release().unwrap();
                break;
            }
            Err(error) if error.reason.starts_with("LOCK_BUSY:") && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(25));
            }
            Err(error) => panic!(
                "terminated owner was not reacquired within {} seconds: {}",
                REACQUIRE_TIMEOUT.as_secs(),
                error.reason
            ),
        }
    }
}

#[cfg(windows)]
struct WindowsLockFixture {
    temp: TestTempDir,
    domain: PathBuf,
    anchor: PathBuf,
}

#[cfg(windows)]
impl WindowsLockFixture {
    fn new(label: &str) -> Self {
        let temp = TestTempDir::new(label);
        let domain = temp.path().join("domain");
        fs::create_dir(&domain).unwrap();
        let anchor = domain.join("anchor.lock");
        Self {
            temp,
            domain,
            anchor,
        }
    }

    fn acquire(&self) -> tokengraph_lock::NativeLockHandle {
        tokengraph_lock::try_acquire_anchor(path_string(&self.anchor)).unwrap()
    }

    fn child_expect(&self, mode: &str, path: &Path) {
        let output = run_bounded(
            Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("windows_child_entrypoint")
                .arg("--nocapture")
                .env(WINDOWS_CHILD_MODE, mode)
                .env(WINDOWS_CHILD_PATH, path),
            "Windows lock child",
        );
        assert!(
            output.status.success(),
            "Windows lock child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn spawn_holder(&self, ready: &Path) -> TerminatedChild {
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("windows_child_entrypoint")
            .arg("--nocapture")
            .env(WINDOWS_CHILD_MODE, "hold")
            .env(WINDOWS_CHILD_PATH, &self.anchor)
            .env(WINDOWS_CHILD_READY, ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        TerminatedChild { child: Some(child) }
    }
}

#[cfg(any(windows, unix))]
struct TerminatedChild {
    child: Option<Child>,
}

#[cfg(any(windows, unix))]
impl TerminatedChild {
    fn terminate(&mut self) {
        if let Some(mut child) = self.child.take() {
            child.kill().unwrap();
            child.wait().unwrap();
        }
    }
}

#[cfg(any(windows, unix))]
impl Drop for TerminatedChild {
    fn drop(&mut self) {
        if let Some(mut child) = self.child.take() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

#[cfg(any(windows, unix))]
fn assert_napi_error_code(error: &napi::Error, expected: &str) {
    assert!(
        error.reason.starts_with(&format!("{expected}:")),
        "expected {expected}, received {}",
        error.reason
    );
}

#[cfg(any(windows, unix))]
fn expect_acquire_error(path: &Path) -> napi::Error {
    match tokengraph_lock::try_acquire_anchor(path_string(path)) {
        Ok(mut handle) => {
            handle.release().unwrap();
            panic!("expected anchor acquisition to fail")
        }
        Err(error) => error,
    }
}

#[cfg(any(windows, unix))]
fn path_string(path: &Path) -> String {
    path.to_str()
        .expect("native lock tests require Unicode temporary paths")
        .to_owned()
}

#[cfg(windows)]
fn create_junction(link: &Path, target: &Path) {
    let output = run_bounded(
        Command::new("cmd.exe")
            .arg("/d")
            .arg("/c")
            .arg("mklink")
            .arg("/J")
            .arg(link)
            .arg(target),
        "junction creation",
    );
    assert!(
        output.status.success(),
        "junction creation failed: {}",
        String::from_utf8_lossy(&output.stderr)
    );
}

#[cfg(any(windows, unix))]
fn wait_for_path(path: &Path, timeout: Duration) {
    let deadline = Instant::now() + timeout;
    while !path.is_file() {
        assert!(
            Instant::now() < deadline,
            "timed out waiting for child readiness"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
struct UnixLockFixture {
    temp: TestTempDir,
    domain: PathBuf,
    anchor: PathBuf,
}

#[cfg(unix)]
impl UnixLockFixture {
    fn new(label: &str) -> Self {
        let temp = TestTempDir::new(label);
        let domain = temp.path().join("domain");
        fs::create_dir(&domain).unwrap();
        let anchor = domain.join("anchor.lock");
        Self {
            temp,
            domain,
            anchor,
        }
    }

    fn acquire(&self) -> tokengraph_lock::NativeLockHandle {
        tokengraph_lock::try_acquire_anchor(path_string(&self.anchor)).unwrap()
    }

    fn child_expect(&self, mode: &str, path: &Path) {
        let output = run_bounded(
            Command::new(std::env::current_exe().unwrap())
                .arg("--exact")
                .arg("unix_child_entrypoint")
                .arg("--nocapture")
                .env(UNIX_CHILD_MODE, mode)
                .env(UNIX_CHILD_PATH, path),
            "Unix lock child",
        );
        assert!(
            output.status.success(),
            "Unix lock child failed: {}",
            String::from_utf8_lossy(&output.stderr)
        );
    }

    fn spawn_holder(&self, ready: &Path) -> TerminatedChild {
        let child = Command::new(std::env::current_exe().unwrap())
            .arg("--exact")
            .arg("unix_child_entrypoint")
            .arg("--nocapture")
            .env(UNIX_CHILD_MODE, "hold")
            .env(UNIX_CHILD_PATH, &self.anchor)
            .env(UNIX_CHILD_READY, ready)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        TerminatedChild { child: Some(child) }
    }
}

struct TestTempDir {
    path: PathBuf,
}

impl TestTempDir {
    fn new(label: &str) -> Self {
        let parent = fs::canonicalize(std::env::temp_dir()).unwrap();
        for attempt in 0..8 {
            let nonce = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let path = parent.join(format!(
                "tokengraph-lock-addon-{label}-{}-{nonce}-{attempt}",
                std::process::id()
            ));
            match fs::create_dir(&path) {
                Ok(()) => return Self { path },
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => panic!(
                    "could not create test directory {}: {error}",
                    path.display()
                ),
            }
        }
        panic!("could not create a unique test directory")
    }

    fn path(&self) -> &Path {
        &self.path
    }
}

impl Drop for TestTempDir {
    fn drop(&mut self) {
        let physical_temp = fs::canonicalize(std::env::temp_dir()).unwrap();
        if self.path.starts_with(physical_temp) {
            let _ = fs::remove_dir_all(&self.path);
        }
    }
}

fn run_bounded(command: &mut Command, label: &str) -> Output {
    const TIMEOUT: Duration = Duration::from_secs(120);

    let mut child = command
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .unwrap_or_else(|error| panic!("could not start {label}: {error}"));
    let deadline = Instant::now() + TIMEOUT;
    loop {
        if child.try_wait().unwrap().is_some() {
            return child.wait_with_output().unwrap();
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("{label} exceeded the {} second timeout", TIMEOUT.as_secs());
        }
        thread::sleep(Duration::from_millis(10));
    }
}

fn cargo_cdylib_name(target_os: &str) -> &'static str {
    match target_os {
        "windows" => "tokengraph_lock.dll",
        "linux" => "libtokengraph_lock.so",
        "macos" => "libtokengraph_lock.dylib",
        unsupported => panic!("unsupported cdylib target OS: {unsupported}"),
    }
}

#[cfg(windows)]
fn node_loadable_path(path: &Path) -> PathBuf {
    let wide = path.as_os_str().encode_wide().collect::<Vec<_>>();
    let verbatim_unc = r"\\?\UNC\".encode_utf16().collect::<Vec<_>>();
    let verbatim = r"\\?\".encode_utf16().collect::<Vec<_>>();
    let ordinary = if wide.starts_with(&verbatim_unc) {
        r"\\"
            .encode_utf16()
            .chain(wide.into_iter().skip(verbatim_unc.len()))
            .collect()
    } else if wide.starts_with(&verbatim) {
        wide.into_iter().skip(verbatim.len()).collect()
    } else {
        wide
    };
    PathBuf::from(OsString::from_wide(&ordinary))
}

#[cfg(not(windows))]
fn node_loadable_path(path: &Path) -> PathBuf {
    path.to_path_buf()
}
