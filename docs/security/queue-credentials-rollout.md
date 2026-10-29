# Queue credential remediation

This change ports the queue credential portion of the local security draft onto the released `d0f3484` code. It addresses Helix finding `92ac9882-f8a6-4474-9a1f-915ac560c9d7` and its current equivalent `bb689a33-14e6-439d-be1d-8f9b6e67ee4f`.

## Problem and scope

Memory-report queue bodies previously contained the reusable upstream API key. Any principal able to receive these messages, including the shared API/worker runtime role, could recover that key. Failed messages could retain it in a DLQ. SQS managed encryption protects storage; authorized `ReceiveMessage` still returns the application message body.

The producer now sends an AES-256-GCM envelope. Its authenticated data binds the version, key ID, issue/expiry times, report ID, tenant fingerprint, and requested date range. The worker rejects altered envelopes, unknown keys, expired envelopes, plaintext legacy messages, credential/tenant mismatches, and report/tenant/range mismatches. Existing terminal-report and ownership checks remain in place. Logs and Sentry receive fixed error metadata rather than untrusted queue or provider exception text.

The admission lifetime is 10 minutes, matching existing queued-report expiry. A worker admitted before expiry may finish its current run. This is not upstream-key revocation, cryptographic erasure, or exactly-once processing: a duplicate delivery within the lifetime still follows the existing runner behavior. A principal with both an envelope and its encryption key can decrypt it offline, including after expiry. Full runtime compromise is outside the confidentiality provided by application encryption.

The API gets a dedicated runtime role with `SendMessage` on the two main queues. Workers retain receive/delete/visibility permissions on the main queues. Neither application role can read DLQs. Both retain the existing payload-object S3 permissions. SQS managed encryption is explicit on all four queues. There are no database schema, Redis, network, or model changes in this patch.

## Secret configuration and rotation

`QUEUE_ENCRYPTION_KEYS` is a required production setting with this format:

```text
current-id:<canonical-base64-32-byte-key>,previous-id:<canonical-base64-32-byte-key>
```

The first key encrypts new messages; all listed keys can decrypt. Use a separately generated cryptographically random 32-byte key for each environment. Do not reuse `APP_PEPPER`, an API key, or another application secret. Keep `APP_PEPPER` unchanged so existing tenant identity remains stable.

Terraform creates only the dedicated Secrets Manager secret metadata, exposed as `queue_credentials_secret_arn`. Provision the keyring as its full string value through the secret-management channel. Never put values in Terraform variables/state, repository files, command arguments, logs, or release evidence. ECS injects the secret into API and worker tasks. Production startup fails if the keyring is missing or invalid.

For rotation, first deploy workers with the old key first and the new key retained for reading. After every worker can read the new key, switch producers to the new key first. Restart tasks to pick up secret changes; changing a Secrets Manager value alone does not update running task environments. Retain the previous key until all old producer tasks are retired and old messages are drained or explicitly reconciled. Verify queues, DLQs, and in-flight work before removing it. A compromised key needs a separate incident response; TTL does not make previously disclosed upstream credentials safe.

## Deployment prerequisites

The existing application deployment workflows deliberately reject non-ECS infrastructure changes. Do not weaken those guards or use a normal application deployment to introduce the new IAM role or secret.

1. Prepare and review a dedicated infrastructure plan and exact rollback plan. It must have no unrelated changes or destructive replacements. Additive prerequisites (new API role/policy, secret metadata/value, and execution-role read permission) can be prepared before gating traffic. Keep the existing runtime-role policy unchanged during this preparation. Confirm the dedicated secret contains a valid value before any task definition using it starts. Record metadata only.
2. Update the externally managed deployment-role PassRole allowlists for the exact new API role ARN, conditioned on `iam:PassedToService = ecs-tasks.amazonaws.com`. The current staging and production deployment roles only allow the old runtime and execution roles. Confirm permission with the intended deployment identity.
3. Ensure the execution role can read the exact app-secret and queue-secret ARNs. Application task roles do not need Secrets Manager read access.
4. Prepare a coordinated API/worker replacement and an entry gate for every queue producer. The earlier deep-analysis-only maintenance gate is insufficient for this change.

The Terraform patch narrows the existing shared runtime role to worker permissions. Old API tasks still use that role and will lose `SendMessage` when this policy is applied. Gate producers and drain first; do not apply that policy while old API tasks are accepting submissions.

The normal deployment workflows reject a still-pending runtime-role policy change. For this release path, finish that separately reviewed narrowing after gate/drain and before dispatching the application deployment. Deferring it until after the API replacement requires a separately reviewed rollout path; do not bypass the existing workflow guard.

## Staging, then production cutover

1. Validate configuration, encryption/tamper/expiry tests, tenant guards, enqueue-failure bookkeeping, and safe error handling. An isolated staging task with candidate code and fixture rows supplements local tests but does not prove live SQS transport, IAM, secret injection, or resident-service rollout.
2. Gate new submissions to `POST /v1/memory-analysis`, `POST /v1/memory-analysis/report`, `POST /v1/deep-analysis/reports`, `PUT /v1/analysis-jobs/:jobId/batches/:batchIndex`, and `POST /v1/analysis-jobs/from-source`. Also gate `POST /v1/analysis-jobs` to prevent admitting new uploads during the drain. Cover any internal producer too. Keep read/status endpoints available; finalize/cancel do not enqueue work. Verify the gate through the real ingress before changing infrastructure.
3. Let the old workers and outstanding API source-preparation work finish. The from-source route schedules asynchronous work that can still enqueue batches after its HTTP response and after the ingress gate closes. Inspect both main queues and both DLQs with an operator identity. Reconcile queued/running reports, uploading jobs, and source preparation as well as visible, in-flight, and delayed messages. Empty approximate queue counts alone do not prove no running work.

   Source preparation currently has no durable lease or in-process task registry, and its rate-limit loop can wait repeatedly. Inspect incomplete-upload jobs created since the oldest running API task started, together with their batch records; resolve ambiguous candidates before replacing those API tasks. Historical parent job status alone is insufficient. Neither bootstrap enables Nest shutdown hooks, so process termination is not proof of graceful drain.
4. Reconcile any legacy plaintext message under an explicit per-job recovery decision. Do not dump bodies into logs, blindly replay a DLQ, or purge messages without accounting for their jobs and reports. The new worker intentionally rejects plaintext. A rejected message remains subject to existing SQS retries/redrive; it does not automatically complete or repair its report.
5. With producers gated and legacy work reconciled, apply the reviewed infrastructure prerequisite changes, provision/verify the dedicated secret, and replace both API and worker task definitions with the tested candidate and correct roles. Retire all old API/worker tasks before reopening ingress. Keep producers gated while incompatible versions coexist.
6. Verify exact image/commit, all task definitions, secret references, IAM permissions, target health, and readiness. With synthetic staging data, test one real queue round trip through the new resident services, confirm report completion, inspect safe logs, and prove API/DLQ receive permission denial. Run an invalid-envelope test only in an isolated validation queue/task; do not poison a shared queue.
7. Clean up precisely the synthetic owner, report, memory, payload, and helper objects created by validation. Record queue/DLQ state and the cleanup result. Observe the reopened staging service before proposing the production window.
8. Repeat the gate, drain/reconcile, prerequisite, coordinated replacement, smoke, and observation process in production after staging acceptance. Record image and task revisions, queue/job state, ingress checks, errors, and cleanup. Deployment evidence is separate from Helix rescan acceptance.

The existing staging workflow temporarily sets both service counts to zero, runs migrations, then starts them again; staging reads are also unavailable during that interval. Production uses rolling ECS updates without setting counts to zero. Neither workflow automatically executes a rollback on failure. Keep the producer gate closed until exact API/worker task revisions and health are verified; a saved restore-point artifact alone is not a recovery action.

## User impact and rollback

Normal requests keep the same API contract and report behavior. The cutover temporarily rejects new analysis submissions at the ingress gate; existing read/status operations remain available. Incorrect or missing secret wiring prevents new tasks from becoming healthy. Queue delivery delayed past ten minutes is rejected and relies on existing report expiry/recovery rather than using an unbounded credential.

Keep the ingress gate available throughout validation. If the new task version fails, stop new producers, reconcile any encrypted messages and running reports, and repair or deploy a compatible encrypted-protocol build. Do not automatically revert to plaintext producers or start old workers against encrypted messages. Restoring an old image/shared IAM role reintroduces the finding and requires a separately reviewed incident decision. Retain the secret and required decryption keys during rollback; the Terraform secret has deletion protection and a 30-day recovery window.

## Evidence boundaries

Local tests and Terraform validation establish code/configuration validity. A staged candidate-code overlay establishes only the exercised code path against its stated dependencies. Neither establishes that new service roles, secret injection, real SQS routing, or a production release work. Mark the finding as declared fixed only after the actual remediation is deployed and verified; scanner closure requires a successful rescan and the approved Helix status transition.
