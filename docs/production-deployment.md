# Production deployment

Production is released manually from the current `main` commit. Image builds,
Terraform plan/apply, and ECS deployment happen in one workflow run, so there
is no separately selected image SHA or saved intermediate Terraform plan.

> **Temporary validation guard:** the workflow currently stops after the
> Terraform plan summary. Every step from the restore point through apply,
> ECS update, release recording, and retention has `if: false`; the rollback
> job is disabled the same way. Remove those guards only after the prepared
> images and Terraform plan have been verified.

## Workflows

### Pull-request checks

`.github/workflows/ci.yml` runs for pull requests targeting `main`:

1. Install dependencies from the lockfile.
2. Run `pnpm verify` (typecheck, unit tests, and application build).
3. Check Terraform formatting.
4. Initialize Terraform without a backend and validate the configuration.

The repository does not currently define a benchmark command. Add it to this
workflow after the project has a stable benchmark script and failure threshold.

### Production release

`.github/workflows/deploy-production.yml` has no inputs. Run it from the `main`
branch in GitHub Actions. The workflow:

1. Locks the run to the `main` commit identified by `github.sha`.
2. Assumes the image role through GitHub OIDC.
3. Builds and pushes API and worker images tagged with that full SHA. A rerun
   reuses an existing immutable image and builds only a missing image.
4. Reads both ECR image digests.
5. Assumes the deployment role through GitHub OIDC.
6. Reads the currently deployed API and worker task definitions for rollback.
7. Initializes the KMS-encrypted S3 Terraform backend.
8. Creates a local `tfplan` in the same runner.
9. Uploads a temporary restore point containing the task-definition pair that
   is currently online, then immediately applies the plan.
10. Waits for both ECS services to become stable.
11. Uploads a release record containing the SHA, image pair, task-definition
    pair, and previous task-definition pair.
12. Deletes the temporary restore point after the successful release record is
    safely uploaded. Failed runs keep their restore point for recovery.

Terraform owns the ECS task definitions and the ECS services' task-definition
references. Normal deployment must not call `aws ecs update-service` directly.

The workflow does not use a GitHub Environment. The **Run workflow** action is
the production release decision. The job-level branch check and both AWS role
trust policies must restrict production access to `refs/heads/main`.

### Production rollback

`.github/workflows/rollback-production.yml` also has no inputs. It finds the
release record matching the task-definition pair currently used by ECS and
switches both services to the previous pair recorded by that release.

If the current deployment failed before it could write a success record, the
workflow falls back to the newest recorded successful task-definition pair. If
there has never been a successful CI release, it uses the newest failed run's
pre-deployment restore point. It refuses to continue if it cannot find a usable
record or if either target task definition is inactive.

Rollback changes the ECS service references directly and intentionally leaves
Terraform state untouched. The next production release refreshes the state and
deploys its new task-definition pair. API and worker updates are coordinated by
one workflow but are not an atomic AWS transaction.

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

The bucket no longer stores `tfplan` or release-candidate files. Existing
`mem9-node/production/plans/` lifecycle rules and IAM permissions are harmless
but can be removed after the new workflow has been verified.

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
the ephemeral runner without printing it and removes the runner after the job.

Do not add these release-specific values to `TF_VARS`:

```text
release_id
api_image
worker_image
```

The workflow supplies those three values from the release SHA and its two ECR
images. Command-line `-var` values take precedence if an older local file still
contains them, but removing them from `TF_VARS` keeps ownership unambiguous.

Protect `main` and require the `Verify` status check before merge. Block force
pushes and branch deletion. A benchmark is not a required check until a real
benchmark command exists in the repository.

## AWS OIDC roles

Keep the two existing roles but restrict both trust policies to this repository
and the `main` branch subject:

```text
repo:mem9-ai/mem9-node:ref:refs/heads/main
```

- `mem9-node-prod-github-prepare`: ECR login, image lookup, and image push for
  the API and worker repositories only.
- `mem9-node-prod-github-apply`: Terraform state/KMS access, infrastructure
  plan/apply permissions, ECS read/update permissions, and task-definition
  retention permissions.

The apply role's old Environment-based subject must be changed before the new
deployment and rollback workflows can assume it. The unused GitHub
`production` Environment may remain or be deleted after verification.

## Retention

- ECR images use immutable full-SHA tags.
- ECS keeps the latest 30 active API revisions and 30 active worker revisions.
- GitHub keeps the latest 30 successful release-record artifacts, subject to
  the repository's artifact retention limit.
- A failed deployment keeps its temporary pre-deployment restore point. A
  successful deployment deletes that temporary record after uploading the
  permanent release record.
- Rollback records are stored separately and do not participate in selecting a
  rollback target.

Do not introduce a count-based ECR lifecycle rule until it can preserve every
image referenced by the retained release records.

## Database migrations

These workflows do not run database migrations. Schema changes require a
separately reviewed, backward-compatible migration process.
