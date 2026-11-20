# Queue credential encryption rollout

Memory-report queue messages change from `rawApiKey` to an authenticated,
short-lived `encryptedApiKey` envelope. The API and worker need the same
independent `QUEUE_CREDENTIAL_KEYRING`. This change does not migrate stored
reports or change tenant fingerprints. Upstream mem9 PR #483 is already merged;
the remaining application rollout is mem9-node PR #32.

## Prepare without changing running tasks

1. Verify the merged branch with `pnpm verify`, Terraform formatting and
   validation, and the PR's required CI check.
2. Confirm the AWS account and production profile. Record the running API and
   worker task-definition pair, image digests, target health, recent error
   rate, queue counts, and DLQ counts before making changes.
3. Generate a fresh 32-byte encryption key for production and store it using
   the keyring format documented in `.env.example`. Never use the example
   key, upstream mem9's keyring, or `APP_PEPPER`. Do not print keys, queue
   bodies, Terraform state, or secret-bearing plans into logs.
4. Store the same keyring JSON in the repository secret
   `QUEUE_CREDENTIAL_KEYRING` and the production Terraform variable
   `queue_credential_keyring`. The release workflow writes a separate variable
   file, so the existing `TF_VARS` secret is preserved. Use the production
   remote state, not a new local state. Review a
   targeted plan for `aws_secretsmanager_secret_version.app`; apply only the
   intended secret-version update. Verify key presence without printing its
   value. Existing tasks continue running with their current environment.

Staging is intentionally disabled. Do not restart it as part of this rollout.

## Find an idle production window

Prefer a continuous ten-minute window with no business requests and no
queued or running reports. Check both `analysis-batch` and `analysis-llm`:
visible, not-visible (in-flight), and delayed messages must all be zero.
Check current report execution as well as queue counts. Sample repeatedly;
a single empty-queue observation is insufficient.

Use recent ALB request/error metrics and application request logs to distinguish
business requests from health checks. CloudWatch data can lag: a missing data
point is not proof of zero traffic. Confirm services and targets are healthy
and that no other deployment is running. Recheck the window immediately before
dispatching the release; if business activity resumes, keep observing.

An idle observation does not prevent new requests during deployment. The
standard release updates both services but is not atomic. Old plaintext
messages reaching a new worker are rejected and acknowledged; encrypted
messages reaching an old worker can fail and enter the DLQ. Affected reports
may expire after ten minutes and need resubmission. Do not promise zero
interruption based only on a quiet pre-release window.

## Release and observe

1. Merge the verified PR and dispatch **Deploy production** from `main`.
   Preserve the existing plan scope guard: the normal release may update only
   API/worker task definitions and services. Do not bypass it to apply unrelated
   infrastructure changes or mutate ECS service references manually.
2. Follow the workflow through service stability and its readiness check.
   Verify both running task definitions use the intended release and contain
   the keyring secret reference; do not expose secret values.
3. Observe at least fifteen minutes after rollout: healthy targets,
   `/health/ready`, API 5xx, task restarts, queue age/counts, DLQ growth,
   `memory_analysis_report_credential_rejected`, and report failures.
4. Verify a successful report through the updated API and worker using an
   approved test tenant or the next normal report. If there is no report
   traffic, record that end-to-end production verification is still pending.

If the release regresses service health, use **Rollback production** with its
recorded task-definition pair. This restores plaintext producers and is a
temporary recovery, not resolution of the security finding.

## Historical messages and closure

The deployment does not remove old plaintext messages or revoke credentials
that previously entered a queue or DLQ. Inventory that exposure separately.
Do not purge a mixed-use DLQ: it may contain unrelated deep-analysis work.
Any selective cleanup or upstream credential rotation needs its own scoped
plan. Keep the Helix findings open until production verification and the
historical-message assessment are recorded. Extend their deadlines if needed.
