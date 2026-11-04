# Remove the Sentry upload token from runtime infrastructure

The Sentry organization auth token is a build credential used by
`scripts/sentry-sourcemaps.mjs`. Runtime error reporting uses `SENTRY_DSN`.
Terraform previously copied the auth token into the application secret's JSON,
which also persisted it in state. API and worker task definitions then injected
the token into running containers even though neither application uses it.

The configuration now writes an empty `SENTRY_AUTH_TOKEN` compatibility key and
does not inject it into new tasks. Retain that empty key while older rollback
task definitions reference it: removing the key can prevent those tasks from
starting. Never restore a live token to satisfy an old task definition.

## Prepare and verify

1. Confirm AWS account `401696231252`, region `ap-southeast-1`, and the S3 state
   keys `mem9-node/staging/terraform.tfstate` and
   `mem9-node/production/terraform.tfstate`. Inspect bucket access controls,
   encryption, versioning, and relevant read access without logging state or
   secret values. Restrict any excessive access separately after review.
2. Identify the specific Sentry token flagged by the scanner, its owner,
   permissions, and other consumers. Revoke it in Sentry. If sourcemap upload
   still needs a credential, supply a replacement only to the upload process
   with the required Sentry permissions. Do not rotate unrelated credentials.
3. Remove the `sentry_auth_token` assignment from `STAGING_TF_VARS`, `TF_VARS`,
   and any local Terraform variable files. Preserve every other value exactly;
   never reconstruct a complete secret from an incomplete example. GitHub
   secret values cannot be read back, so use the authoritative configuration
   source. Also remove retired token copies from local environment/CLI config
   files after checking their consumers. Do not print either token.

## Apply in staging, then production

1. Use an isolated Terraform working directory with the existing remote state,
   current sanitized variables, deployed image references, and required TLS
   settings. Do not initialize an empty state or use example credentials.
2. Produce a one-time plan targeting `aws_secretsmanager_secret_version.app`.
   Before applying, compare the old and new secret JSON in memory: only
   `SENTRY_AUTH_TOKEN` may change, from its previous value to `""`. Every other
   secret value, including DSN, database credentials, pepper, and Qwen key,
   must remain identical. Reject any plan that changes another resource or the
   secret's identity. Keep plan files private and remove them after validation;
   plans can contain the old secret even when terminal output is redacted.
3. Apply only that reviewed plan. A new version of the existing application
   secret is expected; the secret resource, databases, cache, queues, and
   stored business data must not be replaced or migrated. Confirm the current
   secret and current state have an empty compatibility value, without
   outputting their contents.
4. Run a full plan to detect unintended changes hidden by targeting. The normal
   deployment must now contain only allowed ECS task/service changes. Keep
   the existing release scope guards; do not widen them for this cleanup.
5. Deploy the new API and worker task definitions. Verify they contain no
   `SENTRY_AUTH_TOKEN` environment entry or secret reference, and that
   `SENTRY_DSN` is unchanged. Wait for old tasks to drain and exactly one
   `PRIMARY` deployment per service with rollout state `COMPLETED`. Check
   readiness, worker health, queue/DLQ depths, and startup errors. Verify a
   controlled Sentry event still arrives using the existing DSN.

Running containers can retain the old token in their environment until replaced.
Revocation prevents that copy from being useful during rollout. Rollback may use
the prior TLS-compatible task definitions with the empty secret key; it must
never restore the revoked token or old secret/state content.

## Historical copies and closure

New state and secret versions do not erase old ones. Inventory S3 object
versions, older Secrets Manager versions, local state/plan backups, and any
retained CI artifacts. Revoke the token before handling historical copies so
they no longer grant Sentry access. Follow retention requirements and explicitly
review any permanent deletion; do not delete the current state, lock file,
unrelated secrets, or recovery material indiscriminately.

Record revocation, current-state checks, deployment health, and the treatment of
historical copies separately. Submit the finding for scanner verification only
after those steps are complete and the exact status/reason has been approved.
The scanner finding is not closed by the code change alone. This remediation
does not claim to remove other application credentials from Terraform state.
