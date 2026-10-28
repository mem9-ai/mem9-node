# Deep analysis daily quota

This change addresses Helix finding
[b035efc2](https://helix.pingcap.net/me/github/code-security/findings/b035efc2-761f-4ea6-b15f-3decaa7c24e9).
Production permits at most three deep-analysis report requests per API-key
fingerprint per UTC day, and one active deep-analysis report at a time.

Previously, the client-supplied timezone formed part of the quota key. Switching
timezones selected another quota bucket. Deleting a completed or failed report
also removed its usage from the count. Admission used a separate read and insert;
the unique key only protected the same timezone/slot, and an active report from a
previous date did not block a new request.

## Behavior

- Count requests by their persisted `requestedAt` within the UTC day, including
  existing rows with legacy timezone keys and deleted reports. Failed requests
  continue to consume quota. The reset is 00:00 UTC (08:00 Asia/Shanghai).
- Keep the user's timezone for report presentation. It cannot select a quota day.
- Lock the authenticated active `ApiKeySubject` row with `SELECT ... FOR UPDATE`,
  then check active reports across all dates, check daily usage, and insert the
  new report in the same transaction. All API instances use this path.
- Sample the admission time after obtaining the lock and use it for both the
  UTC counting interval and persisted `requestedAt`. Generate the internal
  `requestDayKey` from this date and a unique report ID, avoiding legacy slot gaps.
- Deletion still removes report/source objects through the existing service.
  Retain a content-cleared report row with `deletedAt` so usage is not refunded.
  Hide this row from lists, details, and internal readers; reject late updates
  that would repopulate its content. Clear previews, internal diagnostics, object
  references, and error text.
- Preserve the server-configured daily-limit allowlist and development behavior.
  Allowlisted production keys still cannot start another active report. Request
  body fields cannot enable quota bypass.

This scope is the deep-analysis report API. It does not change the separate
memory-analysis report quota, queue credential format, or infrastructure.

## Abandoned execution recovery

New reports have a five-minute initial scheduling lease. Source preparation and
worker execution each atomically claim a unique token and heartbeat every 30
seconds, extending a five-minute lease. Source preparation has a 30-minute total
deadline; worker processing has a 60-minute total deadline. The ready-to-worker
handoff has a separate 30-minute queue-wait deadline. A healthy heartbeat does
not extend the total execution deadline.

The API checks expired leases at startup and once per minute. A single atomic
update marks abandoned work `FAILED` with `DEEP_ANALYSIS_INTERRUPTED`, releasing
the active-report slot while preserving daily usage. It does not automatically
replay model calls. The user can request another report within their remaining
quota. Both failed and completed queue deliveries are terminal, and duplicate
deliveries cannot claim an already-running report.

Every execution write checks owner, token, nondeleted active state, lease, and
total deadline. An expired token cannot renew or publish a late result. Each
worker attempt writes to its own S3 path and publishes the pointer through the
same guard; ambiguous publication is reconciled before any orphan cleanup.
Already-dispatched upstream/model requests may finish after lease loss, but
their old execution cannot publish a result or start another guarded model call.

Source preparation hands the persisted snapshot to the queued-worker state
before sending SQS. An ambiguous send does not overwrite a worker that already
claimed the report; it is resolved by delivery or queue-wait expiry. The raw API
key stays in API memory and is not added to the queue or lease records.
An explicit, nonretryable client rejection on the only SQS send attempt marks
still-unclaimed queued work failed immediately. This releases the active slot,
retains daily usage, and cannot overwrite a worker that won the claim race.

Legacy active reports with null lease fields are intentionally excluded from
automatic expiry. Reconcile them against worker/task/queue evidence once the old
binaries stop. Never infer that an old task is abandoned merely from its age.

## Release requirements

1. Rehearse the additive `20261028000000_deep_analysis_quota_tombstones` and
   `20261028001000_deep_analysis_execution_leases` migrations
   in staging before deploying either application image. Existing rows get a
   null `deletedAt`. The production application release does not automatically
   run database migrations.
2. In staging, use multiple real MySQL connections/API instances to verify that
   concurrent requests for one owner admit only one active report, while another
   owner can proceed. Complete three requests, delete one, change timezones, and
   verify another request is refused. Verify UTC reset and previous-day active
   reports, allowlisted keys, listing/details, and late worker messages.
3. Pause deep-report creation and deletion during application cutover. Complete
   in-flight requests and replace all API/worker instances before reopening these
   operations. Old API code uses timezone buckets and hard deletes; old workers
   do not honor tombstones. Mixed versions do not provide the new guarantees.
4. Confirm schema, image versions, report behavior, queues, and errors after
   rollout. Record Helix verification separately from deployment health.

Existing hard-deleted usage cannot be reconstructed from report rows. Full daily
accounting is guaranteed for complete UTC days after cutover; the cutover day's
historical count may be incomplete. Do not purge tombstones from the current UTC
day. A future retention job must preserve this invariant.

Keep the additive column on rollback. Restoring old application code would expose
cleared tombstones and restore quota bypasses; keep affected endpoints paused and
prefer a forward fix. Do not remove retained usage to make old code work.

## Local verification

Regression coverage checks timezone-independent admission, UTC boundaries,
owner-lock ordering, legacy keys, deleted usage, active-report checks, allowlist
behavior, and tombstone read/write protection. Repository tests mock Prisma;
they do not prove real MySQL concurrency, migrations, or cloud rollout.
