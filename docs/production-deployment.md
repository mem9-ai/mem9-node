# Production release preparation

The first rollout phase prepares and inspects production materials without
changing the running service. There is currently no active CI deployment or
rollback workflow.

## Pull-request checks

`.github/workflows/ci.yml` runs for pull requests targeting `main`:

1. Install dependencies from the lockfile.
2. Run `pnpm verify` (typecheck, unit tests, and application build).
3. Check Terraform formatting.
4. Initialize Terraform without a backend and validate the configuration.

The repository does not currently define a benchmark command. Add one only
after the project has a stable benchmark script and failure threshold.

## Prepare a production release

After this workflow has been merged, open GitHub Actions, select **Prepare
production release**, and run it from `main`. It:

1. Locks the run to the current `main` commit identified by `github.sha`.
2. Assumes the image role through GitHub OIDC.
3. Builds and pushes API and worker images tagged with the full commit SHA.
4. Resolves both ECR image digests and verifies the built entrypoint files.
5. Assumes the Terraform role through GitHub OIDC.
6. Initializes the KMS-encrypted S3 Terraform backend.
7. Creates a local, ephemeral production `tfplan`.
8. Writes the image identities and Terraform change counts to Job Summary.

The workflow writes SHA-tagged images to ECR. It does **not**:

- run `terraform apply`;
- register or activate new ECS task-definition revisions;
- update either ECS service;
- run database migrations;
- save the `tfplan` after the runner is deleted.

Rerunning the same commit reuses an existing image and rebuilds only a missing
one. Normal operation must not overwrite a SHA tag.

## What to review

Before enabling real deployment, run the preparation workflow and confirm:

- both images exist under the expected SHA and have valid digests;
- both container entrypoint files pass the image-content check;
- the Terraform change counts are expected;
- the detailed Terraform log contains no unexpected resource changes;
- OIDC, the remote backend, and `TF_VARS` all work in GitHub Actions.

A later, separately reviewed change can add Terraform apply, ECS stability
waiting, release records, retention, and rollback. That keeps the first
production-affecting run out of this initial CI change.

## Terraform state

Terraform state and its lock file use the existing S3 backend:

```text
s3://mem9-node-prod-terraform-state/mem9-node/production/terraform.tfstate
s3://mem9-node-prod-terraform-state/mem9-node/production/terraform.tfstate.tflock
```

The bucket must keep:

- versioning;
- default SSE-KMS encryption;
- Block Public Access;
- an HTTPS-only bucket policy;
- state and lock-file permissions scoped to the two objects above.

The bucket does not store `tfplan`. Existing
`mem9-node/production/plans/` lifecycle rules and IAM permissions are harmless
but can be removed after this workflow has been verified.

### Migrate an existing local state

Run this once from the machine holding the real production
`terraform.tfstate`. Never run production Terraform against a new empty state.

```bash
terraform -chdir=infra/terraform init -migrate-state \
  -backend-config="bucket=mem9-node-prod-terraform-state" \
  -backend-config="key=mem9-node/production/terraform.tfstate" \
  -backend-config="region=ap-southeast-1" \
  -backend-config="encrypt=true" \
  -backend-config="kms_key_id=<TF_STATE_KMS_KEY_ARN>" \
  -backend-config="use_lockfile=true"
```

Confirm the remote state before removing the local backup.

## GitHub configuration

Create one repository-level GitHub Actions secret named `TF_VARS`. Its value is
the complete production `terraform.tfvars` content. The workflow writes it to
the ephemeral runner without printing it; GitHub deletes the runner after the
job.

Do not add these release-specific values to `TF_VARS`:

```text
release_id
api_image
worker_image
```

The workflow supplies those values from the release SHA and its two images.

Protect `main` and require the `Verify` status check before merge. Block force
pushes and branch deletion. A benchmark is not a required check until a real
benchmark command exists in the repository.

## AWS OIDC roles

Both trust policies must restrict production access to this repository and the
`main` branch subject:

```text
repo:mem9-ai/mem9-node:ref:refs/heads/main
```

- `mem9-node-prod-github-prepare`: ECR login, image lookup, and image push for
  the API and worker repositories only.
- `mem9-node-prod-github-apply`: currently used for Terraform state access and
  read-only planning. Its broader apply permissions are reserved for the later
  deployment phase.

The preparation workflow has no GitHub Environment approval because it does
not change the running service. The **Run workflow** action only starts material
preparation.

## Retention and rollback

The current workflow does not clean up ECR images, task-definition revisions,
or release records. Keep the prepared SHA images during validation. Add bounded
retention together with real deployment and release records so cleanup cannot
delete an image needed for rollback.

There is no active rollback workflow until CI owns at least one successful
production release record. Existing manual rollback procedures remain the
fallback in the meantime.

## Database migrations

The workflow does not run database migrations. Schema changes require a
separately reviewed, backward-compatible migration process.
