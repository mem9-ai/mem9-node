# Authentication, transport, and storage remediation

## Scope and verified state (2026-11-24, Asia/Shanghai)

Branch base: `origin/main` at `15b3b845dbbdeef7f665a9627965f058c59f62fe`.
AWS account `401696231252`, region `ap-southeast-1` was checked read-only.

| Finding | Verified behavior | Change / remaining gate |
| --- | --- | --- |
| `bf996712-a454-4b48-94c1-c46a4fb95064`: authentication | Source supports `noop` and trusts a cached `active` verdict for 300 seconds. Both deployed task definitions use `remote`; production does not currently run `noop`. | Remove `noop` in every environment and stop caching successful verification. Deploy and test revocation before requesting rescan. |
| `dff90ea3-cad7-4002-9235-a0e8f698de19`: staging HTTP | Staging retains an HTTP forwarding listener and HTTP upstream configuration, but both ECS services are already at 0 desired/running tasks and the ALB security group has **no ingress rules**. `deploy-staging.yml` is `disabled_manually`, with no running deployment. | Keep staging suspended, retaining data. Future enablement requires HTTPS prerequisites. No live resource mutation was needed to suspend it. |
| `1a952adf-7998-4e6e-b552-23893417af00`: storage | Both RDS instances have `StorageEncrypted=false`. Both Redis groups have `AtRestEncryptionEnabled=false`, `AuthTokenEnabled=false`, and TLS `required`. | Restore separate encrypted resources, validate, then cut over under a write freeze. Existing storage is retained. |
| Same compound storage finding: S3 | Both payload buckets already report default `AES256` encryption and all four public-access-block settings enabled. Neither has a bucket policy. Default encryption is not proof that every historical object was encrypted. | Manage encryption/public-access controls explicitly and add a deny for non-TLS requests. Inspect existing object encryption before claiming historical coverage. |

Production API/worker were at 6/6 and 2/2 tasks with image `15b3b84...`.
Production source and verifier URLs use HTTPS. Staging source/verifier URLs point
to an HTTP-only ALB and must not be carried into a future enabled deployment.
No claim of live exploitation, production remediation, or scanner closure is made.

The Go server's inspected `/v1alpha2/status` handler authenticates the supplied
`X-API-Key` against its control-plane state. It does not define a shared-secret
header. This patch therefore does not invent a header or claim mutual service
authentication. The existing `GO_INTERNAL_SHARED_SECRET` configuration is retained
for compatibility; any requirement for service-to-service authentication must be
agreed with the Go API owner and implemented on both sides.

## Application rollout

1. Existing `.env` files with `GO_VERIFY_MODE=noop` must change to `remote` and
   point at a real verifier. Tests inject mocks rather than bypass authentication.
2. Every successful authenticated request now calls the verifier. Old Redis
   `active` values are ignored immediately; no cache flush or key rotation is
   needed. Local disabled subjects and negative cache entries still deny access.
   Upstream failures return 503 even when an old positive cache entry exists.
3. Measure verifier latency, availability, and request volume during deployment.
   Removal of positive caching increases verifier calls. The existing pre-auth
   admission limits remain enabled; there is no new retry loop or stale-success
   fallback. Negative caches can delay reactivation for up to 60 seconds.
4. Check a valid key, revoke it in an authorized test tenant, and verify the next
   request fails. Test invalid keys and a verifier outage. Do not revoke a real
   customer key for a smoke test.
5. All external source/verifier/LLM URLs require HTTPS, including outside
   production. Only development/test loopback HTTP endpoints are allowed. An
   explicit `UPSTREAM_HTTPS_REQUIRED=false` cannot bypass the restriction.

## Keep staging suspended

`staging_enabled` defaults to false. In staging this forces API and worker task
counts to zero and omits the HTTPS listener and ingress rule, even if old variables
request nonzero task counts. The HTTP listener and port-80 rule are removed from
Terraform. RDS, Redis, S3, queues, and other data are retained; retained resources
continue to incur costs. This is suspension, not environment deletion.

The GitHub deployment job additionally requires repository variable
`STAGING_ENABLED=true`. Its current workflow is also manually disabled on GitHub.
Do not re-enable either gate until all of these are ready:

- A dedicated DNS hostname pointing to the staging ALB, and an issued certificate
  covering it in `ap-southeast-1`. The currently issued production certificate
  covers only `napi.mem9.ai`; this account has no `mem9.ai` Route53 hosted zone.
- HTTPS source and verifier endpoints, plus current runtime secrets/keyring.
- Explicitly reviewed `staging_enabled=true`, `api_domain_name`, and
  `api_certificate_arn` variables. The health check uses the certificate-covered
  HTTPS hostname, never a raw ALB DNS name and never `curl -k`.

The production deployment workflow retains its currently verified hostname and
certificate ARN. It never inherits staging's suspension flag.

## Infrastructure preparation

The ordinary production release guard intentionally rejects data-resource and
Secrets Manager changes. Do not widen it to allow this migration. Use a separate,
reviewed infrastructure plan against the existing environment state before the
normal application release. Keep state/plan artifacts private because they
contain secrets. Never initialize an empty state for an existing environment.

For the first infrastructure plan keep both migration flags false. Expect only
the reviewed S3 controls and removal of port-80 ingress/listener, plus approved
task-definition configuration changes. Existing RDS/Redis endpoints, identifiers,
and data must remain unchanged. Verify existing S3 encryption/public-access
settings before managing/importing those resources; preserve any additional
controls or policies not represented by this provider version. Production already
uses port 443; confirm consumers do not rely on HTTP redirects before closing 80.

Do not report the compound storage finding fixed at this stage. The old RDS and
Redis resources remain unencrypted until the following migration is completed.

## Data-preserving migration window

RDS cannot turn on encryption in place; use an encrypted snapshot copy and
restore. Redis at-rest encryption likewise needs a new replication group. These
constraints are documented by [RDS](https://docs.aws.amazon.com/AmazonRDS/latest/UserGuide/Overview.Encryption.html)
and [ElastiCache](https://docs.aws.amazon.com/AmazonElastiCache/latest/dg/at-rest-encryption.html).

1. Agree the maintenance window and allowed downtime. Record original endpoints,
   desired counts, task revisions, secret version, database version, encryption
   key, and the exact existing state. Rehearse separately before the final window.
   Do not use a stale rehearsal snapshot for the final cutover.
2. Stop new API admissions at the ingress boundary. Drain active requests/jobs;
   inspect both main queues, both DLQs, in-flight SQS messages, scheduled writers,
   database connections, and leases. Do not purge queues. Stop API/worker tasks
   only after agreed drain/cancellation handling; prove no process can write to
   either store. Keep ingress closed through validation.
3. Take final RDS and Redis snapshots during that same write freeze. Copy the RDS
   snapshot with encryption enabled and the chosen KMS key; wait until all final
   snapshots/copies are available. Retain originals. Capture database row counts,
   key tenant/report invariants, Redis key counts and TTL expectations, and queue
   state for validation. Redis TTLs may naturally expire during the window.
4. Supply protected variables:

   ```hcl
   provision_encrypted_storage            = true
   use_encrypted_storage                  = false
   encrypted_database_snapshot_identifier = "<final-encrypted-copy>"
   redis_migration_snapshot_name          = "<final-redis-snapshot>"
   # encrypted_redis_auth_token comes from a protected variable, never a commit.
   ```

   Create `mysql_encrypted[0]` and `redis_encrypted[0]` alongside the originals.
   The RDS snapshot must be encrypted MySQL 8.4. Redis enables at-rest encryption,
   required TLS, and required AUTH (`SET`, not optional `ROTATE`). The password is
   stored in Secrets Manager, not in task environment values or connection URLs.
   Its key is retained while provisioning remains enabled, including rollback.
   Review the plan: **no deletion or replacement of either original store**.
5. Validate the restored database/schema, encrypted snapshots/backups, private
   access and TLS. Compare the captured tenant/report invariants and Redis data.
   Prove passwordless/wrong-password Redis commands fail and TLS+AUTH succeeds.
   Ensure the database user/password in the existing secret matches the restored
   snapshot. Reconcile any earlier writes before proceeding.
6. With writes still frozen, plan `use_encrypted_storage=true`. This changes the
   database secret endpoint, Redis endpoint and ECS password injection together.
   Apply the reviewed configuration with services stopped; then register/start
   the new application task revisions and verify private readiness and authorized
   business smoke tests. Only then reopen ingress and resume normal desired counts.
7. Confirm one completed ECS deployment per service, healthy targets, normal
   queues/DLQs, no authentication/TLS errors, and expected business results. Preserve
   both originals and snapshots until the retention and rollback decision is
   explicitly approved. Never set `provision_encrypted_storage=false` after creation;
   `prevent_destroy` intentionally blocks removal.

## Rollback boundary

Before new writes are admitted, keep ingress closed and switch both endpoints
back to the original stores with matching task revisions. Keep provisioning true
so the encrypted copies and the Redis secret remain available. Start the original
clients, validate, then reopen ingress.

After any new write reaches the encrypted stores, **do not simply flip the flag
back**: the old database/cache are stale. Freeze writes again and reconcile/replay
the new data, or fix forward. A rollback that silently loses accepted writes is
not acceptable. Task-definition rollback alone cannot reverse database-secret
endpoint changes safely.

## Validation and closure

Local checks cover authentication/revocation, HTTPS restrictions, typechecking,
builds, and mocked Terraform plans for default, restore, cutover, invalid inputs,
unencrypted snapshot rejection, and suspended staging. Mock tests never contact
AWS and do not prove restore/data integrity or a zero-downtime migration.

Helix changes require separate review of exact wording. Request rescans only for
the scope actually deployed/validated; do not close the compound storage finding
from application tests, default S3 encryption, or an undeployed migration plan.
