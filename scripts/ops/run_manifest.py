#!/usr/bin/env python3
"""Capture a read-only run-manifest for the azra quality loop.

Pins the identity of every running service the demo pipeline depends on
(process start time, config, model files, repo state) so a graded run can
prove "same binary, same model, same config" across iterations. A silent
model swap or service restart between two "consecutive clean runs" makes
stability claims fiction; this manifest is the guard.

Read-only by design: no service is touched, no config mutated. Safe under
feature freeze.

Usage:
    run_manifest.py [--out FILE] [--no-hash]

  --out FILE   also write the manifest JSON to FILE
  --no-hash    skip content hashing of model/config files (fast mode;
               identity falls back to path+size+mtime)

The manifest_id is a sha256 over the stable identity fields (processes,
repos, artifacts) — env metrics are captured but excluded from the id, so
two captures of an unchanged deployment yield the same id.
"""

import argparse
import glob
import hashlib
import json
import os
import re
import shlex
import subprocess
import sys
import time

# cmdline regex -> service label. Extend when the fleet grows.
# Order matters: first match wins. The secret-keeper runs the same `medd up`
# binary as the clinical fleet but is a DIFFERENT service (always-on, serves
# OPENAI_API_KEY, survives bounces by design, relaunched from a dead pidfile
# by run-laptop.sh). Labeling it separately keeps it out of the clinical
# fleet's single-generation assertion — an old SHA on the keeper is expected
# after a bounce, not a mixed-generation grading hazard (learned 2026-07-12:
# it was nearly reaped twice as a "straggler").
SERVICE_PATTERNS = [
    (r"medd up .*secrets-expanded", "meddaemon-secret-keeper"),
    (r"medd up", "meddaemon-worker"),
    (r"llama-server", "llm-inference"),
    (r"whisper-server", "asr-inference"),
    (r"azra_exporter", "azra-metrics-exporter"),
    (r"drive_metrics_exporter", "drive-metrics-exporter"),
]

# Repos whose working-tree state feeds the running services.
REPOS = [
    os.path.expanduser("~/projects/azra/azra"),
    os.path.expanduser("~/projects/azra-agent"),
    os.path.expanduser("~/projects/meddaemon"),
]

HASH_CACHE = os.path.expanduser("~/.bukowski/ops/hash-cache.json")

# File extensions from process cmdlines worth pinning (models, configs).
ARTIFACT_EXT = (".gguf", ".bin", ".yaml", ".yml", ".json", ".safetensors")

# Graded model artifacts that never appear on a cmdline: the router head
# weights are loaded by path from worker config, so a head retrain (the
# exact change iter-7 grades) would be invisible to cmdline-derived
# artifacts. Globbed and pinned like any other artifact; which one the
# router actually serves is asserted by the router lane, but a changed or
# new head file changes the manifest id — that's the guard.
EXTRA_ARTIFACT_GLOBS = [
    os.path.expanduser("~/projects/azra-agent/storage/nlu/router_head_*.npz"),
]

# Ports whose ownership identifies the live fleet generation. A graded run
# must assert the broker port is held by the intended generation's pid —
# a stale worker keeping a client connection to the live broker can still
# receive dispatches, so pid identity here is a grading precondition.
SERVICE_PORTS = [5555, 8080, 8082, 9109, 9154]


def read_file(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None


def proc_processes():
    procs = []
    for stat_path in glob.glob("/proc/[0-9]*/cmdline"):
        raw = read_file(stat_path)
        if not raw:
            continue
        cmdline = raw.replace(b"\0", b" ").decode("utf-8", "replace").strip()
        for pattern, label in SERVICE_PATTERNS:
            if re.search(pattern, cmdline):
                pid = int(stat_path.split("/")[2])
                procs.append({
                    "label": label,
                    "pid": pid,
                    "cmdline": cmdline,
                    "start_time": proc_start_time(pid),
                })
                break
    procs.sort(key=lambda p: (p["label"], p["start_time"] or 0, p["pid"]))
    return procs


def proc_start_time(pid):
    # /proc/<pid>/stat field 22 is starttime in clock ticks since boot.
    raw = read_file(f"/proc/{pid}/stat")
    if not raw:
        return None
    try:
        ticks = int(raw.rsplit(b")", 1)[1].split()[19])
        hertz = os.sysconf("SC_CLK_TCK")
        with open("/proc/uptime") as f:
            uptime = float(f.read().split()[0])
        return int(time.time() - uptime + ticks / hertz)
    except (ValueError, IndexError, OSError):
        return None


def load_hash_cache():
    try:
        with open(HASH_CACHE) as f:
            return json.load(f)
    except (OSError, ValueError):
        return {}


def save_hash_cache(cache):
    try:
        os.makedirs(os.path.dirname(HASH_CACHE), exist_ok=True)
        with open(HASH_CACHE, "w") as f:
            json.dump(cache, f)
    except OSError:
        pass


def sha256_file(path, cache):
    st = os.stat(path)
    key = f"{path}:{st.st_size}:{int(st.st_mtime)}"
    if key in cache:
        return cache[key]
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    digest = h.hexdigest()
    cache[key] = digest
    return digest


def artifacts_from(procs, do_hash):
    cache = load_hash_cache()
    seen, artifacts = set(), []

    def add(path, used_by):
        path = os.path.realpath(path)
        if path in seen or not os.path.isfile(path):
            return
        seen.add(path)
        st = os.stat(path)
        entry = {
            "path": path,
            "size": st.st_size,
            "mtime": int(st.st_mtime),
            "used_by": used_by,
        }
        if do_hash:
            try:
                entry["sha256"] = sha256_file(path, cache)
            except OSError as e:
                entry["hash_error"] = str(e)
        artifacts.append(entry)

    for proc in procs:
        for tok in shlex.split(proc["cmdline"]):
            if tok.startswith("/") and tok.lower().endswith(ARTIFACT_EXT):
                add(tok, proc["label"])
    for pattern in EXTRA_ARTIFACT_GLOBS:
        for path in sorted(glob.glob(pattern)):
            add(path, "config-loaded")
    if do_hash:
        save_hash_cache(cache)
    artifacts.sort(key=lambda a: a["path"])
    return artifacts


def git(repo, *args):
    try:
        out = subprocess.run(
            ["git", "-C", repo, *args],
            capture_output=True, text=True, timeout=10,
        )
        return out.stdout.strip() if out.returncode == 0 else None
    except (OSError, subprocess.TimeoutExpired):
        return None


def head_at(repo, ts):
    """The commit that was HEAD at unix time ts, from the reflog.

    This is the SHA a service started at ts is actually running (modulo
    uncommitted files), as opposed to the current HEAD. Returns None when
    the reflog doesn't reach back that far.
    """
    log = git(repo, "reflog", "--date=unix", "--format=%H %gd")
    if not log:
        return None
    for line in log.splitlines():
        m = re.match(r"([0-9a-f]{40}) HEAD@\{(\d+)\}", line)
        if m and int(m.group(2)) <= ts:
            return m.group(1)
    return None


def repo_states(procs):
    states = []
    for repo in REPOS:
        if not os.path.isdir(os.path.join(repo, ".git")):
            continue
        head = git(repo, "rev-parse", "HEAD")
        if not head:
            continue
        head_ts = git(repo, "show", "-s", "--format=%ct", "HEAD")
        dirty = git(repo, "status", "--porcelain")
        head_ts = int(head_ts) if head_ts and head_ts.isdigit() else None
        # Bounce-independent services (the secret-keeper) are excluded from
        # generation tracking: they outlive clinical-fleet bounces by design,
        # so their older boot SHA is expected, not a mixed-generation hazard.
        # Their pid+start still pin them in the identity via the process list.
        mine = [
            p for p in procs
            if repo in p["cmdline"] and p["start_time"]
            and p["label"] != "meddaemon-secret-keeper"
        ]
        # A service started before the current HEAD commit may be running
        # code that predates it (the stale-deploy failure mode).
        stale = [
            {"label": p["label"], "pid": p["pid"]}
            for p in mine
            if head_ts and p["start_time"] < head_ts
        ]
        # The SHA(s) the still-running services booted on — grades must
        # stamp THESE, not the current HEAD. More than one entry means
        # mixed generations are serving simultaneously (attribution hazard).
        running = {}
        for p in mine:
            sha = head_at(repo, p["start_time"])
            if sha:
                running.setdefault(sha, []).append(p["pid"])
        states.append({
            "repo": repo,
            "head": head,
            "head_commit_ts": head_ts,
            "dirty_files": len(dirty.splitlines()) if dirty else 0,
            "running_shas": running,
            "possibly_stale_processes": stale,
        })
    return states


def port_owners():
    """Map each SERVICE_PORT to the pid/process listening on it (via ss)."""
    try:
        out = subprocess.run(
            ["ss", "-tlnpH"], capture_output=True, text=True, timeout=10,
        ).stdout
    except (OSError, subprocess.TimeoutExpired):
        return {}
    owners = {}
    for line in out.splitlines():
        cols = line.split()
        if len(cols) < 4:
            continue
        port_m = re.search(r":(\d+)$", cols[3])
        pid_m = re.search(r"pid=(\d+)", line)
        if not port_m:
            continue
        port = int(port_m.group(1))
        if port in SERVICE_PORTS:
            owners[str(port)] = {
                "pid": int(pid_m.group(1)) if pid_m else None,
                "addr": cols[3],
            }
    return owners


def env_snapshot():
    snap = {"ts": int(time.time())}
    try:
        with open("/proc/meminfo") as f:
            mem = dict(
                line.split(":", 1) for line in f.read().splitlines() if ":" in line
            )
        snap["mem_available_kb"] = int(mem["MemAvailable"].split()[0])
        snap["swap_used_kb"] = (
            int(mem["SwapTotal"].split()[0]) - int(mem["SwapFree"].split()[0])
        )
    except (OSError, KeyError, ValueError):
        pass
    try:
        with open("/proc/loadavg") as f:
            snap["loadavg_1m"] = float(f.read().split()[0])
    except (OSError, ValueError):
        pass
    lid = subprocess.run(
        ["busctl", "get-property", "org.freedesktop.login1",
         "/org/freedesktop/login1", "org.freedesktop.login1.Manager",
         "HandleLidSwitch"],
        capture_output=True, text=True,
    )
    if lid.returncode == 0:
        snap["handle_lid_switch"] = lid.stdout.split('"')[1] if '"' in lid.stdout else lid.stdout.strip()
    return snap


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out")
    ap.add_argument("--no-hash", action="store_true")
    args = ap.parse_args()

    procs = proc_processes()
    manifest = {
        "kind": "azra-quality-loop-run-manifest",
        # Bump on any change to what feeds the identity hash (schema or
        # semantics). Ids only compare within one schema version; the field
        # makes a cross-version mismatch self-explaining instead of a mystery.
        "schema": 4,
        "host": os.uname().nodename,
        "captured_at": int(time.time()),
        "processes": procs,
        "repos": repo_states(procs),
        "artifacts": artifacts_from(procs, not args.no_hash),
        "ports": port_owners(),
        "env": env_snapshot(),
    }
    # Stable identity: what is RUNNING, not what the repos look like.
    # Repo HEAD and dirty counts churn whenever any agent commits or edits —
    # two captures seconds apart would mint different ids for an unchanged
    # deployment. Identity therefore keeps only running_shas from the repo
    # section; head/dirty stay in the manifest as observability context.
    identity = json.dumps(
        {
            "schema": manifest["schema"],
            "host": manifest["host"],
            "processes": manifest["processes"],
            "running": {r["repo"]: r["running_shas"] for r in manifest["repos"]},
            "artifacts": manifest["artifacts"],
            "ports": manifest["ports"],
        },
        sort_keys=True,
    )
    manifest["manifest_id"] = hashlib.sha256(identity.encode()).hexdigest()[:16]

    out = json.dumps(manifest, indent=2)
    print(out)
    if args.out:
        with open(args.out, "w") as f:
            f.write(out + "\n")


if __name__ == "__main__":
    sys.exit(main())
