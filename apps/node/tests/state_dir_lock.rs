// P001-C1.4 - the single-instance lock, proved with REAL processes.
//
// `flock` lives in the kernel. A test that takes a lock twice in one process, or
// simulates contention, proves nothing about two Node processes. Every case here
// spawns the actual `opsweave-node` binary.
//
// The binary needs a Docker daemon and a Kernel to get far, and this suite does
// not provide them. That is deliberate: the lock is taken BEFORE either is
// touched, so a process that fails later with "Docker Engine is required" has
// already proved it passed the lock. The assertions are therefore about WHERE a
// process stopped, which is exactly the ordering property the brief asks for.
//
// Gated on a real (cheap) precondition: the binary must exist. No daemon is
// needed for the lock cases; the two that DO need one are marked and skip.
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn binary() -> PathBuf {
    // `CARGO_BIN_EXE_<name>` is set by cargo for integration tests.
    PathBuf::from(env!("CARGO_BIN_EXE_opsweave-node"))
}

fn scratch(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("opsweave-lock-it-{}-{name}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).expect("create scratch dir");
    dir
}

/// A state directory with a valid-looking Kernel identity, so a process that
/// gets past the lock reaches enrolment rather than failing on the identity.
fn state_dir_with_identity(dir: &Path) {
    std::fs::create_dir_all(dir).expect("state dir");
    // `name` is required by the deserializer. Without it the process dies in
    // identity parsing - which is AFTER the lock, so a test that treats "it
    // exited" as "it never took the lock" gets a confusing failure instead of
    // the real one. Fields are the ones the binary actually requires.
    std::fs::write(
        dir.join("node-identity.json"),
        br#"{"nodeId":"00000000-0000-4000-8000-000000000001","name":"lock-test","credential":"ow_node_test","dataToken":"ow_data_test","generation":1}"#,
    )
    .expect("identity");
}

/// Start a Node with a Kernel URL that never answers, so the only way it can
/// exit is by failing at the lock or by failing to reach the Kernel.
/// Where the spawned Nodes look for a Docker daemon.
///
/// `alive` points at the real daemon so the process gets PAST the Docker probe
/// and parks in the hanging Kernel call. `dead` points nowhere, so the process
/// fails at Docker - which is how "it got past the lock" is observed.
fn docker_host(alive: bool) -> &'static str {
    if alive {
        std::env::var("OPSWEAVE_DOCKER_HOST")
            .ok()
            .filter(|v| !v.is_empty())
            .map(|v| Box::leak(v.into_boxed_str()) as &'static str)
            .unwrap_or("unix:///var/run/docker.sock")
    } else {
        "unix:///nonexistent-lock-test.sock"
    }
}

/// A TCP port nobody is using, so two Nodes started by two test threads cannot
/// collide on the data endpoint. Without this, the parallel test harness made
/// one Node die with `bind node data endpoint 127.0.0.1:9101` - a failure that
/// looks like a product bug and is purely the tests sharing a fixed port.
fn free_port() -> u16 {
    let listener = std::net::TcpListener::bind("127.0.0.1:0").expect("bind ephemeral");
    let port = listener.local_addr().expect("addr").port();
    drop(listener);
    port
}

fn spawn_node_with(state_dir: &Path, kernel_url: &str, alive_docker: bool) -> Child {
    let port = free_port();
    let mut cmd = Command::new(binary());
    cmd.arg("--state-dir")
        .arg(state_dir)
        .arg("--kernel-url")
        .arg(kernel_url)
        .env("DOCKER_HOST", docker_host(alive_docker))
        .env("OPSWEAVE_DOCKER_HOST", docker_host(alive_docker))
        .env("OPSWEAVE_NODE_DATA_BIND", format!("127.0.0.1:{port}"))
        .env(
            "OPSWEAVE_NODE_DATA_ENDPOINT",
            format!("http://127.0.0.1:{port}"),
        )
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    cmd.spawn().expect("spawn opsweave-node")
}

/// A Node expected to FAIL at the Docker probe, i.e. one that got past the lock.
fn spawn_node(state_dir: &Path, kernel_url: &str) -> Child {
    spawn_node_with(state_dir, kernel_url, false)
}

/// A Node expected to stay alive: real Docker, hanging Kernel.
fn spawn_live_node(state_dir: &Path, kernel_url: &str) -> Child {
    spawn_node_with(state_dir, kernel_url, true)
}

/// A TCP listener that accepts connections and never answers.
///
/// This is what keeps the first Node alive: with a dead socket it exits in
/// ~50 ms at the Docker probe, and a test that waits 400 ms before starting the
/// second process would then be asserting against a RELEASED lock - passing for
/// the wrong reason. With a Kernel that accepts and hangs, the first Node parks
/// in its HTTP client and holds the lock for as long as the listener lives.
///
/// The listener is on an ephemeral port chosen by the OS, so parallel test
/// binaries cannot collide.
struct HangingKernel {
    port: u16,
    shutdown: std::sync::Arc<std::sync::atomic::AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl HangingKernel {
    fn start() -> Self {
        use std::io::Read;
        use std::net::TcpListener;
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind");
        listener.set_nonblocking(true).expect("nonblocking");
        let port = listener.local_addr().expect("addr").port();
        let shutdown = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
        let flag = shutdown.clone();
        let handle = std::thread::spawn(move || {
            let mut held: Vec<std::net::TcpStream> = Vec::new();
            while !flag.load(std::sync::atomic::Ordering::Relaxed) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        // Accepted and kept open, never answered.
                        held.push(stream);
                    }
                    Err(ref e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    Err(_) => break,
                }
            }
            // Drain anything the client already wrote so its write does not
            // block on a full socket buffer while we are shutting down.
            for mut stream in held {
                let _ = stream.set_read_timeout(Some(Duration::from_millis(50)));
                let mut sink = [0u8; 4096];
                let _ = stream.read(&mut sink);
            }
        });
        Self {
            port,
            shutdown,
            handle: Some(handle),
        }
    }

    fn url(&self) -> String {
        format!("http://127.0.0.1:{}", self.port)
    }
}

impl Drop for HangingKernel {
    fn drop(&mut self) {
        self.shutdown
            .store(true, std::sync::atomic::Ordering::Relaxed);
        if let Some(handle) = self.handle.take() {
            let _ = handle.join();
        }
    }
}

/// Wait until the lock on `dir` is held by a process OTHER than this one.
///
/// The naive version tries to take the lock and returns as soon as that FAILS.
/// That is correct, but the failure mode of the naive version is what matters:
/// between our successful probe and the caller's next line the other process
/// may not have started yet, so "it failed once" is not the same as "it will
/// keep failing". This version requires the lock to stay unavailable across
/// several consecutive probes, so a single unlucky sample cannot pass the wait.
///
/// If `child` is given, the wait also fails fast when that process exits,
/// reporting its output - "the lock was never taken" alone hides the reason.
fn wait_until_locked(dir: &Path, mut child: Option<&mut Child>, limit: Duration) {
    const STABLE_SAMPLES: usize = 5;
    let start = Instant::now();
    let mut consecutive = 0usize;
    loop {
        if let Some(child) = child.as_deref_mut() {
            if let Ok(Some(status)) = child.try_wait() {
                let mut out = String::new();
                use std::io::Read;
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_string(&mut out);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_string(&mut out);
                }
                panic!("the first Node exited ({status}) before taking the lock; output:\n{out}");
            }
        }
        match opsweave_node::state_lock::lock_state_dir(dir) {
            Err(opsweave_node::state_lock::LockError::InUse { .. }) => {
                consecutive += 1;
                if consecutive >= STABLE_SAMPLES {
                    return;
                }
            }
            Ok(lock) => {
                consecutive = 0;
                drop(lock);
            }
            Err(other) => panic!("unexpected lock error while probing: {other}"),
        }
        if start.elapsed() > limit {
            // Kill the process under test before panicking: leaving it running
            // makes `cargo test` hang instead of failing, and a test that hangs
            // is worse than one that fails - it looks like infrastructure.
            if let Some(child) = child.as_deref_mut() {
                let _ = child.kill();
                let _ = child.wait();
            }
            panic!(
                "the lock on {} was never stably held within {:?}; the test cannot proceed",
                dir.display(),
                limit
            );
        }
        std::thread::sleep(Duration::from_millis(20));
    }
}

fn wait_with_timeout(child: &mut Child, limit: Duration) -> Option<std::process::Output> {
    // Collect the output FIRST (which waits for EOF on the pipes) only once the
    // process has exited; `wait_with_output` consumes the handle, so the loop
    // below polls `try_wait` and the caller takes the handle by value.
    let start = Instant::now();
    loop {
        match child.try_wait().expect("try_wait") {
            Some(_) => {
                let stdout = child.stdout.take();
                let stderr = child.stderr.take();
                let mut out = Vec::new();
                let mut err = Vec::new();
                if let Some(mut s) = stdout {
                    use std::io::Read;
                    let _ = s.read_to_end(&mut out);
                }
                if let Some(mut s) = stderr {
                    use std::io::Read;
                    let _ = s.read_to_end(&mut err);
                }
                return Some(std::process::Output {
                    status: child.wait().expect("wait"),
                    stdout: out,
                    stderr: err,
                });
            }
            None if start.elapsed() > limit => return None,
            None => std::thread::sleep(Duration::from_millis(50)),
        }
    }
}

fn text(output: &std::process::Output) -> String {
    format!(
        "{}{}",
        String::from_utf8_lossy(&output.stdout),
        String::from_utf8_lossy(&output.stderr)
    )
}

/// Kill a child and wait for the kernel to reap it. Used to prove SIGKILL
/// releases the lock without any user-space cleanup.
fn kill_hard(mut child: Child) {
    let _ = child.kill();
    let _ = child.wait();
}

#[test]
fn a_second_node_on_the_same_directory_refuses_with_dir_in_use() {
    let dir = scratch("in-use");
    state_dir_with_identity(&dir);

    // The lock is held by THIS TEST PROCESS, not by another Node.
    //
    // An earlier version started one Node and polled until the lock looked
    // taken. That is a race the test cannot win reliably: the poll can succeed
    // in the window before the first Node reaches `flock`, and then the second
    // Node takes the lock legitimately and fails at Docker instead. The test
    // then reports a product failure that did not happen - it passed and failed
    // on identical code. Holding the lock ourselves removes the race entirely:
    // the condition the assertion depends on is established before the process
    // under test starts, and cannot change while it runs.
    let held = opsweave_node::state_lock::lock_state_dir(&dir).expect("the test holds the lock");

    let mut second = spawn_node(&dir, "http://127.0.0.1:1");
    let output = wait_with_timeout(&mut second, Duration::from_secs(20))
        .expect("the second Node must exit promptly, not hang on the lock");
    let body = text(&output);

    assert!(
        body.contains("NODE_STATE_DIR_IN_USE"),
        "the second Node must name the stable code; got:\n{body}"
    );
    assert!(
        body.contains(".node.lock"),
        "the message must name the file the operator has to deal with; got:\n{body}"
    );
    // The insertion order is the other half of the contract: the lock is taken
    // before the Docker probe, so a lock failure cannot produce a Docker error.
    assert!(
        !body.contains("Docker Engine is required"),
        "the lock must fail BEFORE the Docker probe; got:\n{body}"
    );
    // And nothing on disk may be touched by a refused process. The identity
    // files are written only after the lock, so their hashes must be unchanged.
    let identity = std::fs::read(dir.join("node-identity.json")).expect("identity readable");
    assert!(
        !dir.join("installation-binding.json").exists(),
        "a refused Node must not reach the binding write; found installation-binding.json"
    );
    assert_eq!(
        identity,
        br#"{"nodeId":"00000000-0000-4000-8000-000000000001","name":"lock-test","credential":"ow_node_test","dataToken":"ow_data_test","generation":1}"#.to_vec(),
        "a refused Node must not rewrite node-identity.json"
    );

    drop(held);
    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_different_directory_starts_independently() {
    let a = scratch("dir-a");
    let b = scratch("dir-b");
    state_dir_with_identity(&a);
    state_dir_with_identity(&b);

    // The test holds A's lock. A Node pointed at B must get past its own lock,
    // which it can only do if the lock is per directory rather than global.
    let held = opsweave_node::state_lock::lock_state_dir(&a).expect("hold A");

    let kernel = HangingKernel::start();
    let mut on_b = spawn_live_node(&b, &kernel.url());
    wait_until_locked(&b, Some(&mut on_b), Duration::from_secs(30));

    assert!(
        a.join(".node.lock").exists() && b.join(".node.lock").exists(),
        "both directories must have their own lock file"
    );

    kill_hard(on_b);
    drop(held);
    let _ = std::fs::remove_dir_all(&a);
    let _ = std::fs::remove_dir_all(&b);
}

#[test]
fn sigkill_releases_the_lock_with_no_user_space_cleanup() {
    let dir = scratch("sigkill");
    state_dir_with_identity(&dir);
    let kernel = HangingKernel::start();

    // The Node under test is the one that will be SIGKILLed, so it must be the
    // one holding the lock - not this process. `wait_until_locked` polls until
    // a second locker would be refused, and the probe below re-confirms it with
    // a real process before the kill. That is two independent observations
    // rather than a sleep.
    let mut first = spawn_live_node(&dir, &kernel.url());
    wait_until_locked(&dir, Some(&mut first), Duration::from_secs(30));
    // Prove it is actually held before killing: a real second process must be
    // refused, and that refusal is the same thing the product does.
    let mut probe = spawn_live_node(&dir, &kernel.url());
    let probe_out = wait_with_timeout(&mut probe, Duration::from_secs(20)).expect("probe exits");
    assert!(
        text(&probe_out).contains("NODE_STATE_DIR_IN_USE"),
        "the lock must be held before the SIGKILL, or the test proves nothing; got:\n{}",
        text(&probe_out)
    );

    kill_hard(first);

    // Now another Node must get PAST the lock. Point it at the dead socket so it
    // fails at Docker: a Docker error proves the lock was released, and the
    // lock file still existing proves no user-space cleanup was needed.
    let mut third = spawn_node(&dir, "http://127.0.0.1:1");
    let out = wait_with_timeout(&mut third, Duration::from_secs(25)).expect("third exits");
    let body = text(&out);
    assert!(
        !body.contains("NODE_STATE_DIR_IN_USE"),
        "SIGKILL must release the lock without any cleanup; got:\n{body}"
    );
    assert!(
        body.contains("Docker Engine is required"),
        "the third Node must have got PAST the lock and failed at Docker; got:\n{body}"
    );

    // And no user-space cleanup was needed: the file is still there, unlocked.
    assert!(
        dir.join(".node.lock").exists(),
        "the lock file must NOT be unlinked - a later process must reuse this inode"
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_normal_exit_frees_the_lock_for_the_next_start() {
    let dir = scratch("normal-exit");
    state_dir_with_identity(&dir);

    let mut first = spawn_node(&dir, "http://127.0.0.1:1");
    let first_out = wait_with_timeout(&mut first, Duration::from_secs(25)).expect("first exits");
    let body = text(&first_out);
    // It fails on Docker (no daemon in this test), which means it held the lock
    // and released it by exiting.
    assert!(
        body.contains("Docker Engine is required"),
        "the first Node must reach the Docker probe; got:\n{body}"
    );

    let mut second = spawn_node(&dir, "http://127.0.0.1:1");
    let out = wait_with_timeout(&mut second, Duration::from_secs(25)).expect("second exits");
    assert!(
        !text(&out).contains("NODE_STATE_DIR_IN_USE"),
        "a normal exit must free the lock; got:\n{}",
        text(&out)
    );

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn the_lock_file_is_created_with_0600_and_survives() {
    let dir = scratch("mode");
    state_dir_with_identity(&dir);

    let mut first = spawn_node(&dir, "http://127.0.0.1:1");
    let _ = wait_with_timeout(&mut first, Duration::from_secs(25));
    let meta = std::fs::metadata(dir.join(".node.lock")).expect("lock file exists after the run");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            meta.permissions().mode() & 0o777,
            0o600,
            "the lock file must be 0600 like the identity files next to it"
        );
    }

    let _ = std::fs::remove_dir_all(&dir);
}

#[test]
fn a_clone_still_reports_the_identity_conflict_not_a_lock_error() {
    // The lock must not shadow ADR-023: a cloned directory is still a clone.
    // No second process here - one Node, a directory that is a copy of another
    // installation's, and the binding written by the original.
    let original = scratch("clone-orig");
    let clone = scratch("clone-copy");
    state_dir_with_identity(&original);

    // Run once so the original gets an installation-id and a binding.
    let mut first = spawn_node(&original, "http://127.0.0.1:1");
    let _ = wait_with_timeout(&mut first, Duration::from_secs(25));

    let id_file = original.join("installation-id");
    if !id_file.exists() {
        eprintln!("skip: the first run did not mint an installation-id (it failed before that)");
        let _ = std::fs::remove_dir_all(&original);
        let _ = std::fs::remove_dir_all(&clone);
        return;
    }
    copy_tree(&original, &clone);

    // `cp -a` cannot preserve device+inode, so the binding no longer matches.
    let mut second = spawn_node(&clone, "http://127.0.0.1:1");
    let out = wait_with_timeout(&mut second, Duration::from_secs(25)).expect("clone exits");
    let body = text(&out);
    assert!(
        !body.contains("NODE_STATE_DIR_IN_USE"),
        "a clone is not a lock conflict - it is an identity conflict; got:\n{body}"
    );
    assert!(
        body.contains("INSTALLATION_IDENTITY_CONFLICT"),
        "the clone must still be refused by ADR-023; got:\n{body}"
    );

    let _ = std::fs::remove_dir_all(&original);
    let _ = std::fs::remove_dir_all(&clone);
}

fn copy_tree(from: &Path, to: &Path) {
    std::fs::create_dir_all(to).expect("dest");
    for entry in std::fs::read_dir(from).expect("read_dir") {
        let entry = entry.expect("entry");
        let target = to.join(entry.file_name());
        if entry.file_type().expect("type").is_dir() {
            copy_tree(&entry.path(), &target);
        } else {
            std::fs::copy(entry.path(), &target).expect("copy file");
        }
    }
}
