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
