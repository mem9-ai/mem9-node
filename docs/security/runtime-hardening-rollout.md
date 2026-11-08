# Runtime hardening rollout

## Data preservation

This change does not alter schemas, fingerprints, queue messages, Redis keys, or
stored reports. Terraform prevents destruction of the existing MySQL and Redis
resources. RDS deletion protection and final snapshots provide additional guards.
Do not bypass these guards to enable storage encryption.

## Infrastructure before application deployment

The release workflows allow only ECS task and service changes. Review and apply
the infrastructure separately, first in staging, then in production:

1. Verify live database ingress and retain the API and worker security groups.
   Remove unrelated world-open access. Verify a new database connection from an
   ECS task, not only an existing connection pool.
2. Set RDS public accessibility to false and deletion protection to true. Confirm
   the plan is an update with no replacement or credential change.
3. Create separate API and worker runtime roles. The API sends to the two main
   queues; workers receive, acknowledge, and extend visibility. Neither role
   accesses dead-letter queues. Add only these exact role ARNs to the deployment
   roles' ECS PassRole allowlist. Retain the previous runtime role during rollout.
4. Enable Redis transit encryption in `preferred` mode and seven days of
   snapshots. Wait for the replication group to become available and report TLS
   enabled. Read its new primary endpoint from AWS; do not reuse a cached endpoint.
5. Test TLS certificate validation, PING, and a short-lived synthetic key's
   write/read/delete from the application's VPC. Existing plaintext clients must
   remain functional during this phase.

Deploy the application with `rediss://` and the separate roles. Production
upstream source and verification requests require HTTPS, and source clients reject
redirects. Staging's existing internal HTTP upstream is an explicit temporary
exception; its ingress/upstream TLS findings remain open.

Verify API and worker rollouts, readiness, queue processing, and absence of TLS,
IAM, database, and upstream errors. After every active Redis client uses TLS,
change `transit_encryption_mode` to `required` in a separate reviewed change.
Before doing so, prepare rollback task definitions that retain `rediss://` and
the new endpoint; old plaintext task definitions will no longer work. Remove the
legacy broad runtime role after the rollback window and confirm no tasks use it.

## Require TLS for existing Redis and MySQL

This stage changes connection policy only. It must not replace either resource,
rotate database credentials or `APP_PEPPER`, alter schemas, or rewrite data.
Staging HTTP is a separate deferred issue. Use the same steps in staging before
production, and retain the Terraform plans and live validation results.

1. Check running analysis work and queue/DLQ counts. Record the current task
   revisions and service counts. Both runtime images now package the public AWS
   RDS CA bundle and a shared entrypoint; `DATABASE_TLS_CA_FILE` makes that
   entrypoint add `sslcert` and `sslaccept=strict` to the existing secret URL.
   This also covers overridden commands such as `pnpm migrate`. It fails closed
   if the CA file is absent and does not print the connection string.
2. Prepare the database parameter group with
   `database_require_secure_transport=false` and keep
   `redis_transit_encryption_mode=preferred`. Apply only the reviewed parameter
   group and database association plan. The family is `mysql8.4`, matching both
   existing instances; confirm the live major version before applying elsewhere.
   Do not apply an unrelated pending database change. Association may report
   `pending-reboot`; a newly associated group is not proof of active enforcement.
3. Deploy the TLS-capable images and task definitions with both enforcement
   overrides still set as above. The release workflow only permits ECS changes,
   so reconcile the infrastructure before invoking it. API, worker, migration,
   administrative clients, and rollback task revisions must all use TLS before
   enforcement. Roll back only to an image containing the CA bundle and shared
   entrypoint, retaining `DATABASE_TLS_CA_FILE` and the TLS Redis endpoint.
   Dispatch the first deployment with `data_tls_phase=compatibility`; after
   enforcement, normal releases use the default `enforced`. This input changes
   the expected Terraform policy only: existing plan guards still reject any
   non-ECS change, including attempts to relax server enforcement through CI.
4. From the real VPC, check MySQL `Ssl_cipher` / `Ssl_version` and successful
   Prisma migration status with the trusted CA. Wrong-CA and wrong-hostname
   connections must fail. Confirm every active database client is accounted for;
   one successful test connection does not prove all service pools migrated.
5. Verify Redis plaintext client count is zero. Apply a Redis-only plan with
   `redis_transit_encryption_mode=required`. Wait for completion, then prove TLS
   PING and synthetic write/read/delete succeed and a plaintext connection fails.
   The old plaintext DNS endpoint disappears; use the TLS primary endpoint.
6. Apply the MySQL parameter-only plan with
   `database_require_secure_transport=true` and `apply_method=immediate`. Check
   the actual server value of `@@GLOBAL.require_secure_transport`. If a reboot is
   needed, stop admission and drain workers before the maintenance operation;
   resume only after database health and TLS validation succeed. Confirm a fresh
   plaintext connection is rejected and fresh TLS connections still work.
7. Remove temporary overrides so both defaults enforce TLS. A final full plan
   must contain no unintended resource changes. Run an isolated full analysis
   pipeline, then remove its test data and confirm queues, health, and errors.

For a client rollout failure before enforcement, restore the previous task
revisions. After enforcement, prefer the prepared TLS-capable rollback release.
If relaxing a server policy is necessary during an incident, explicitly restore
the compatibility setting and verify it takes effect before rolling clients
back; never assume an old plaintext revision will work. No data restore is part
of this rollback. Storage encryption and Redis authentication remain separate.
The automated rollback workflow refuses a target that drops the current database
CA configuration or changes a TLS Redis endpoint. The first TLS release is the
minimum compatible baseline; an older plaintext release needs explicit incident
handling, not a blind rollback. The production deploy workflow still does not
execute database migrations. Existing production migration-history discrepancies
must be reconciled separately, never by applying old migrations as part of TLS.

## Storage encryption migration

Existing unencrypted RDS and Redis cannot be made encrypted at rest by replacing
their Terraform resources in place. Treat this as a separate migration:

1. Rehearse with staging: snapshot, create an encrypted copy where required, and
   restore to a new private resource. Preserve the original resource and snapshot.
2. Inventory every writer, including workers, queues, administrative jobs, and
   upstream applications. Pause admission and drain work before the final
   snapshot. Low traffic is not evidence that there are no writes.
3. Record row counts and stable business-data checksums for MySQL; inventory
   Redis key types, persistent values, and expiration semantics. Validate the
   restored copy without logging business data or credentials. Account for keys
   whose TTL naturally expires during migration.
4. Switch only after validation. Keep writers paused until a read-only acceptance
   check succeeds. If the new database accepts writes, rollback requires
   reconciling those writes; switching back blindly would lose data.
5. Retain the old resources until acceptance and the rollback window end. Their
   deletion is a separate operation, not part of this hardening rollout.

## Finding status

Runtime readiness does not close scanner findings. Composite findings retain
their unresolved parts, including plaintext credentials in queue payloads,
unencrypted database/cache storage, and staging HTTP. Verify S3/SQS encryption
against live configuration rather than assuming it from missing Terraform flags.

## User profile ReDoS and pre-authentication admission

Profile punctuation trimming uses a backwards character scan, preserving the
existing output and full source text. No migration, report rewrite, key rotation,
queue change, or staging HTTPS change is included.

The API installs admission in Fastify's `onRequest` hook, before body parsing and
Nest authentication guards. Token buckets are local to each API process: by
default each source IP gets 20 requests/second with a burst of 100; the process
as a whole gets 100 requests/second with a burst of 300. The corresponding
`PREAUTH_*` settings must be positive. Existing authenticated tenant quotas still
apply. A 429 includes `Retry-After`; it does not query MySQL, Redis, or the verifier.
This limits backend work per process, not fleet-wide traffic or network-level DoS.
Restarts reset budgets and scaling multiplies the fleet allowance.

IP state is capped at 10,000 entries, with idle expiry. New addresses are rejected
when state is full; active counters are not evicted to admit rotating identities.
The global bucket also bounds work when a client rotates IPs or API keys.

`PREAUTH_TRUSTED_PROXY_CIDRS` is empty locally. ECS task configuration derives it
from the ALB's public subnet CIDRs (requires read access to EC2 DescribeSubnets
during planning). This assumes the existing API security group continues to admit
port 3000 only from the ALB security group, and ALB keeps the default append mode
for X-Forwarded-For. Before deployment, verify both conditions against AWS. Never
use universal proxy trust or a hop count. With additional proxies, the nearest
untrusted proxy is the source IP and its users share a budget; only expand the
allowlist after verifying that proxy's network boundary and header handling.

Only GET/HEAD requests for the exact `/health/live` and `/health/ready` paths
bypass business admission. Liveness is dependency-free. Readiness coalesces
concurrent checks and caches both success and failure for one second. Probe
responses time out after two seconds with 503, but timed-out dependency calls
remain single-flight until they actually settle. An outage must not cause
replacement queries to accumulate. Readiness can lag a dependency change by the
one-second cache window.

Roll out application and task-environment changes together, first in staging.
Check the actual proxy chain, normal browser polling/batch-upload traffic,
429/retry behavior, ALB target health, and dependency load. Tune thresholds using
observed traffic, especially where users share NAT or a frontend proxy. Do not
declare the Helix finding fixed from local tests alone; retain deployment and
rescan evidence separately.
