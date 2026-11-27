import copy
import hashlib
import importlib.util
import io
import json
import subprocess
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("trusted_record", Path(__file__).with_name("trusted-release-record.py"))
trusted = importlib.util.module_from_spec(spec)
spec.loader.exec_module(trusted)

SHA = "a" * 40


def arn(role, revision=2):
    return f"arn:aws:ecs:ap-southeast-1:401696231252:task-definition/mem9-node-prod-{role}:{revision}"


def fixture(kind="release"):
    run = {
        "id": 10, "path": trusted.WORKFLOW, "event": "workflow_dispatch",
        "head_branch": "main", "head_sha": SHA, "status": "completed", "conclusion": "success",
        "repository": {"id": 1, "full_name": trusted.REPOSITORY},
        "head_repository": {"id": 1, "full_name": trusted.REPOSITORY},
    }
    artifact = {
        "id": 20, "name": f"production-{kind}-{SHA}-10", "expired": False,
        "workflow_run": {"id": 10, "repository_id": 1, "head_repository_id": 1,
                         "head_branch": "main", "head_sha": SHA},
    }
    record = {
        "repository": trusted.REPOSITORY, "runId": "10", "release": SHA,
        "status": "deployed" if kind == "release" else "prepared",
        "previousApiTaskDefinition": arn("api", 1), "previousWorkerTaskDefinition": arn("worker", 1),
    }
    if kind == "release":
        record.update(apiTaskDefinition=arn("api"), workerTaskDefinition=arn("worker"))
    return artifact, run, record


def archive_record(artifact, record, kind="release", extra=None):
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w", compression=zipfile.ZIP_DEFLATED) as bundle:
        bundle.writestr(f"{kind}.json", json.dumps(record))
        if extra:
            bundle.writestr(*extra)
    archive = buffer.getvalue()
    artifact.update(size_in_bytes=len(archive), digest="sha256:" + hashlib.sha256(archive).hexdigest())
    return archive


class TrustedRecordTests(unittest.TestCase):
    def test_successful_release_and_failed_deployment_restore_point(self):
        for kind, conclusion in [("release", "success"), ("restore-point", "failure"),
                                 ("restore-point", "cancelled"), ("restore-point", "timed_out")]:
            with self.subTest(kind=kind, conclusion=conclusion):
                artifact, run, record = fixture(kind)
                run["conclusion"] = conclusion
                archive = archive_record(artifact, record, kind)
                trusted.validate_provenance(artifact, run, 20, kind)
                self.assertEqual(trusted.read_record(archive, artifact, run, kind), record)

    def test_rejects_spoofed_workflow_branch_event_repository_and_incomplete_run(self):
        cases = [
            ("path", ".github/workflows/ci.yml"), ("event", "pull_request"),
            ("event", "pull_request_target"), ("head_branch", "feature"),
            ("head_sha", "b" * 40), ("id", 99),
            ("status", "in_progress"), ("conclusion", "failure"),
            ("repository", {"id": 2, "full_name": "attacker/repo"}),
            ("head_repository", {"id": 2, "full_name": "attacker/repo"}),
            ("head_repository", {"id": 2, "full_name": trusted.REPOSITORY}),
        ]
        for field, value in cases:
            with self.subTest(field=field, value=value):
                artifact, run, record = fixture()
                archive_record(artifact, record)
                run[field] = value
                with self.assertRaises(ValueError):
                    trusted.validate_provenance(artifact, run, 20, "release")

    def test_rejects_spoofed_or_expired_artifact(self):
        artifact, run, record = fixture()
        archive_record(artifact, record)
        changes = [
            {"name": "production-release-spoof"}, {"id": 99}, {"expired": True},
            {"size_in_bytes": trusted.MAX_ARCHIVE_BYTES + 1}, {"digest": None},
        ]
        for field in ["id", "repository_id", "head_repository_id", "head_sha", "head_branch"]:
            origin = copy.deepcopy(artifact["workflow_run"])
            origin[field] = "spoof"
            changes.append({"workflow_run": origin})
        for change in changes:
            with self.subTest(change=change), self.assertRaises(ValueError):
                trusted.validate_provenance({**artifact, **change}, run, 20, "release")

    def test_rejects_record_injection_or_cross_environment_task_definitions(self):
        changes = [
            {"release": SHA + "\nINJECTED=true"}, {"runId": "11"},
            {"repository": "attacker/repo"}, {"status": "prepared"},
            {"apiTaskDefinition": arn("api") + "\nINJECTED=true"},
            {"previousApiTaskDefinition": arn("api").replace("-prod-", "-staging-")},
            {"previousWorkerTaskDefinition": arn("api")},
            {"workerTaskDefinition": arn("worker").replace("401696231252", "000000000000")},
            {"previousWorkerTaskDefinition": None},
        ]
        for change in changes:
            with self.subTest(change=change):
                artifact, run, record = fixture()
                archive = archive_record(artifact, {**record, **change})
                with self.assertRaises(ValueError):
                    trusted.read_record(archive, artifact, run, "release")

    def test_rejects_modified_archive_unexpected_files_and_oversized_record(self):
        artifact, run, record = fixture()
        archive = archive_record(artifact, record)
        with self.assertRaises(ValueError):
            trusted.read_record(archive + b"modified", artifact, run, "release")
        archive = archive_record(artifact, record, extra=("../payload", "ignored"))
        with self.assertRaises(ValueError):
            trusted.read_record(archive, artifact, run, "release")
        record["extra"] = "a" * trusted.MAX_RECORD_BYTES
        archive = archive_record(artifact, record)
        with self.assertRaises(ValueError):
            trusted.read_record(archive, artifact, run, "release")

    def test_download_checks_provenance_before_fetching_archive(self):
        artifact, run, record = fixture()
        archive = archive_record(artifact, record)
        with patch.object(trusted, "gh_api", side_effect=[json.dumps(artifact), json.dumps(run), archive]) as api:
            self.assertEqual(trusted.download_record(20, "release"), record)
            self.assertEqual(api.call_count, 3)
        run["path"] = ".github/workflows/ci.yml"
        with patch.object(trusted, "gh_api", side_effect=[json.dumps(artifact), json.dumps(run)]) as api:
            with self.assertRaises(ValueError):
                trusted.download_record(20, "release")
            self.assertEqual(api.call_count, 2)

    def test_api_failure_aborts_instead_of_becoming_an_untrusted_candidate(self):
        with patch.object(trusted, "gh_api", side_effect=subprocess.CalledProcessError(1, ["gh"])):
            with self.assertRaises(subprocess.CalledProcessError):
                trusted.download_record(20, "release")


if __name__ == "__main__":
    unittest.main()
