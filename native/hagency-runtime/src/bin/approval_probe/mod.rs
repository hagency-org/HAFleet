//! Offline callbacks use the pinned native shape and read real response bytes.
use super::*;

fn callback(id: &str) -> io::Result<()> {
    send(
        json!({"id":id,"method":"item/commandExecution/requestApproval","params":{
            "threadId":"owned-thread","turnId":"owned-turn","itemId":id,
            "startedAtMs":1,"command":"echo approved","cwd":std::env::current_dir()?.to_string_lossy(),
            "availableDecisions":["accept","decline"]
        }}),
    )
}
fn resolved(id: &str) -> io::Result<()> {
    note(
        "serverRequest/resolved",
        json!({"threadId":"owned-thread","requestId":id}),
    )
}
/// Announce that the probe reached a stage, by writing the marker file the
/// test polls for.
pub(super) fn announce(marker: &Path, extension: &str) -> io::Result<()> {
    fs::write(marker.with_extension(extension), b"ready")
}

/// Wait until the test writes the release marker, bounded by the original
/// six-second gate budget.
pub(super) fn await_release(marker: &Path, extension: &str) -> io::Result<()> {
    let until = Instant::now() + Duration::from_secs(6);
    while !marker.with_extension(extension).is_file() {
        if Instant::now() >= until {
            return Err(io::ErrorKind::TimedOut.into());
        }
        std::thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}

/// One half of the original gate: announce readiness, then wait.
pub(super) fn gate(marker: &Path) -> io::Result<()> {
    announce(marker, "approval-ready")?;
    await_release(marker, "approval-release")
}

/// Append one raw response frame to the probe-read stream.
pub(super) fn append_bytes(marker: &Path, response: &Value) -> io::Result<()> {
    OpenOptions::new()
        .create(true)
        .append(true)
        .open(marker.with_extension("approval-bytes"))?
        .write_all(&serde_json::to_vec(response)?)
}

/// Bounded probe for one more inbound frame: `Ok(line)` when a frame arrives
/// inside the bound, `Err(TimedOut)` when none did. The caller's buffered
/// reader cannot be bounded, so a fresh stdin lock runs on a reader thread.
pub(super) fn timeout_read(duration: Duration) -> io::Result<String> {
    let (sent, received) = std::sync::mpsc::channel::<String>();
    std::thread::spawn(move || {
        let mut stdin = io::stdin().lock();
        let mut line = String::new();
        let _ = stdin.read_line(&mut line);
        let _ = sent.send(line);
    });
    received
        .recv_timeout(duration)
        .map_err(|_| io::ErrorKind::TimedOut.into())
}
pub(super) fn run(mode: &str, reader: &mut impl BufRead, marker: &Path) -> io::Result<bool> {
    callback("approval-1")?;
    if mode == "owned-approval-eof" {
        return Ok(false);
    }
    if mode == "owned-approval-resolve" {
        gate(marker)?;
        resolved("approval-1")?;
        pulse(marker)?;
        return Ok(false);
    }
    if mode == "owned-approval-resolve-first" {
        // The pre-send resolution case: the resolution is emitted while the
        // host is held at the recheck gate — before the first byte of the
        // frame. The retained ADR-046 rule is the quiet path: the host drops
        // the armed frame without sending (never `Closed`, never a named
        // failure) and the drive completes. No frame may reach the wire.
        gate(marker)?;
        resolved("approval-1")?;
        // Handshake: the resolution bytes are on the wire. The test waits for
        // this marker before releasing the host's gate, so the resolution can
        // never be emitted before the host is in flight nor after its send.
        fs::write(marker.with_extension("approval-resolving"), b"resolving")?;
        if let Ok(extra) = timeout_read(Duration::from_millis(300)) {
            return Err(io::Error::other(format!(
                "frame after pre-first-byte resolution: {extra:?}"
            )));
        }
        // Deterministic ordering (review E4): do not end the turn until the
        // test confirms the host took the quiet path (its trace gains
        // `resolved-before-send`); the test then writes the turn-release
        // marker. The turn end therefore cannot precede the F2 check, so the
        // recheck pump's two endings (`Completed` / `ApprovalCancelled`) are
        // not a race.
        await_release(marker, "approval-turn-release")?;
        // Return into the parent's terminal turn: turn/completed ends the
        // drive promptly, quietly, with no approval frame on the wire.
        return Ok(true);
    }
    if mode == "owned-approval-gate-resolve" {
        // Host is held at the recheck gate: in_flight is set and the frame is
        // armed but not yet committed to the OS. Emit the resolution for the
        // in-flight id, then let the host write: the write must still arrive.
        announce(marker, "approval-ready")?;
        await_release(marker, "approval-release")?;
        resolved("approval-1")?;
        // Handshake: the resolution bytes are on the wire. The test waits for
        // this marker before releasing the host's gate, so the resolution can
        // never be emitted before the host is in flight nor after the write.
        fs::write(marker.with_extension("approval-resolving"), b"resolving")?;
        let response = read(reader, marker)?;
        let id = response["id"].as_str().ok_or(io::ErrorKind::InvalidData)?;
        if !id.starts_with("approval-")
            || response.get("method").is_some()
            || !matches!(
                response["result"]["decision"].as_str(),
                Some("accept" | "decline")
            )
        {
            return Err(io::Error::other("invalid approval response"));
        }
        append_bytes(marker, &response)?;
        fs::write(
            marker.with_extension("approval-continued"),
            b"actual responses received",
        )?;
        // Return into the parent's terminal turn so the operation completes.
        return Ok(true);
    }
    if mode == "owned-approval-admitted-resolve-count" {
        // Frame 1 is written and read, then the resolution arrives (the legal
        // order). Any further response frame for this id must never arrive.
        let response = read(reader, marker)?;
        append_bytes(marker, &response)?;
        resolved("approval-1")?;
        if let Ok(extra) = timeout_read(Duration::from_millis(300)) {
            return Err(io::Error::other(format!(
                "second frame after resolution: {extra:?}"
            )));
        }
        // Return into the parent's terminal turn: turn/completed ends the
        // drive promptly without another approval frame.
        return Ok(true);
    }
    if mode == "owned-approval-barriers" {
        callback("approval-2")?;
    }
    if mode == "owned-approval-queued" {
        gate(marker)?;
        callback("approval-2")?;
    }
    if matches!(mode, "owned-approval-usage" | "owned-approval-queued-usage") {
        gate(marker)?;
        for n in 1..=3 {
            note(
                "thread/tokenUsage/updated",
                json!({"threadId":"owned-thread","turnId":"owned-turn","tokenUsage":{
                    "total":{"totalTokens":n*11,"inputTokens":n*10,"cachedInputTokens":0,"outputTokens":n,"reasoningOutputTokens":0},
                    "last":{"totalTokens":11,"inputTokens":10,"cachedInputTokens":0,"outputTokens":1,"reasoningOutputTokens":0},"modelContextWindow":200000
                }}),
            )?;
        }
    }
    if mode == "owned-approval-queued-usage" {
        callback("approval-2")?;
    }
    let count = if mode == "owned-approval-barriers" {
        3
    } else if matches!(
        mode,
        "owned-approval-reuse" | "owned-approval-queued" | "owned-approval-queued-usage"
    ) {
        2
    } else {
        1
    };
    let mut ids = std::collections::BTreeSet::new();
    for index in 0..count {
        let response = read(reader, marker)?;
        let id = response["id"].as_str().ok_or(io::ErrorKind::InvalidData)?;
        if !id.starts_with("approval-")
            || !ids.insert(id.to_owned())
            || response.get("method").is_some()
            || !matches!(
                response["result"]["decision"].as_str(),
                Some("accept" | "decline")
            )
        {
            return Err(io::Error::other("invalid or duplicated approval response"));
        }
        OpenOptions::new()
            .create(true)
            .append(true)
            .open(marker.with_extension("approval-bytes"))?
            .write_all(&serde_json::to_vec(&response)?)?;
        if mode == "owned-approval-barriers" && index == 0 {
            callback("approval-3")?;
        }
        resolved(id)?;
        if mode == "owned-approval-reuse" && index == 0 {
            callback("approval-2")?;
        }
    }
    fs::write(
        marker.with_extension("approval-continued"),
        b"actual responses received",
    )?;
    Ok(true)
}
