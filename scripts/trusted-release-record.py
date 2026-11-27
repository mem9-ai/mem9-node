"""Download a rollback record only after checking GitHub-owned provenance.

Exit 2 means an untrusted candidate; API/download failures abort rollback (exit 1).
Never print record contents, and never execute commands from artifact fields.
"""

import hashlib
import io
import json
import os
import re
import subprocess
import sys
import zipfile
from pathlib import Path

REPOSITORY = "mem9-ai/mem9-node"
WORKFLOW = ".github/workflows/deploy-production.yml"
MAX_ARCHIVE_BYTES = 1024 * 1024
MAX_RECORD_BYTES = 64 * 1024


def require(condition, message):
    if not condition:
        raise ValueError(message)


def task_definition(value, role):
    return isinstance(value, str) and re.fullmatch(
        rf"arn:aws:ecs:ap-southeast-1:401696231252:task-definition/mem9-node-prod-{role}:[1-9][0-9]*",
        value,
    ) is not None


def validate_provenance(artifact, run, artifact_id, kind):
    require(kind in ("release", "restore-point"), "Invalid record kind")
    require(artifact.get("id") == artifact_id and artifact.get("expired") is False,
            "Invalid or expired artifact")
    origin = artifact.get("workflow_run") or {}
    require(type(origin.get("id")) is int and origin["id"] > 0 and origin["id"] == run.get("id"),
            "Artifact run mismatch")
    repo = run.get("repository") or {}
    head_repo = run.get("head_repository") or {}
    require(repo.get("full_name") == REPOSITORY and head_repo.get("full_name") == REPOSITORY,
            "Unexpected repository")
    require(type(repo.get("id")) is int and repo["id"] == head_repo.get("id")
            == origin.get("repository_id") == origin.get("head_repository_id"),
            "Artifact repository mismatch")
    require(run.get("path") == WORKFLOW and run.get("event") == "workflow_dispatch"
            and run.get("head_branch") == "main" and origin.get("head_branch") == "main",
            "Not a main-branch production deployment")
    require(run.get("status") == "completed", "Deployment is not complete")
    allowed = ("success",) if kind == "release" else ("success", "failure", "cancelled", "timed_out")
    require(run.get("conclusion") in allowed, "Unexpected deployment conclusion")
    sha = run.get("head_sha")
    require(isinstance(sha, str) and re.fullmatch(r"[0-9a-f]{40}", sha)
            and origin.get("head_sha") == sha, "Commit mismatch")
    require(artifact.get("name") == f"production-{kind}-{sha}-{run['id']}",
            "Artifact name does not match its deployment")
    size = artifact.get("size_in_bytes")
    require(type(size) is int and 0 < size <= MAX_ARCHIVE_BYTES, "Artifact exceeds size limit")
    digest = artifact.get("digest")
    require(isinstance(digest, str) and re.fullmatch(r"sha256:[0-9a-f]{64}", digest),
            "Missing artifact digest")


def read_record(archive, artifact, run, kind):
    require(len(archive) <= MAX_ARCHIVE_BYTES, "Archive exceeds size limit")
    require("sha256:" + hashlib.sha256(archive).hexdigest() == artifact["digest"],
            "Artifact digest mismatch")
    with zipfile.ZipFile(io.BytesIO(archive)) as bundle:
        entries = bundle.infolist()
        require(len(entries) == 1 and entries[0].filename == f"{kind}.json"
                and entries[0].file_size <= MAX_RECORD_BYTES, "Unexpected archive contents")
        record = json.loads(bundle.read(entries[0]))
    require(isinstance(record, dict), "Expected a release record")
    require(record.get("repository") == REPOSITORY and record.get("runId") == str(run["id"])
            and record.get("release") == run["head_sha"], "Record provenance mismatch")
    require(record.get("status") == ("deployed" if kind == "release" else "prepared"),
            "Record status mismatch")
    fields = {"previousApiTaskDefinition": "api", "previousWorkerTaskDefinition": "worker"}
    if kind == "release":
        fields.update({"apiTaskDefinition": "api", "workerTaskDefinition": "worker"})
    for field, role in fields.items():
        require(task_definition(record.get(field), role), "Invalid production task definition")
    return record


def gh_api(path):
    return subprocess.run(["gh", "api", path], check=True, stdout=subprocess.PIPE, timeout=60).stdout


def download_record(artifact_id, kind):
    artifact = json.loads(gh_api(f"/repos/{REPOSITORY}/actions/artifacts/{artifact_id}"))
    run_id = (artifact.get("workflow_run") or {}).get("id")
    require(type(run_id) is int and run_id > 0, "Missing artifact run")
    run = json.loads(gh_api(f"/repos/{REPOSITORY}/actions/runs/{run_id}"))
    validate_provenance(artifact, run, artifact_id, kind)
    archive = gh_api(f"/repos/{REPOSITORY}/actions/artifacts/{artifact_id}/zip")
    return read_record(archive, artifact, run, kind)


def main():
    require(os.environ.get("GITHUB_REPOSITORY") == REPOSITORY, "Unexpected rollback repository")
    require(len(sys.argv) == 4 and re.fullmatch(r"[1-9][0-9]*", sys.argv[1]), "Invalid arguments")
    artifact_id, kind, destination = sys.argv[1:]
    record = download_record(int(artifact_id), kind)
    Path(destination).write_text(json.dumps(record), encoding="utf-8")


if __name__ == "__main__":
    try:
        main()
    except (ValueError, KeyError, TypeError, zipfile.BadZipFile):
        print("Skipping untrusted production rollback artifact", file=sys.stderr)
        sys.exit(2)
