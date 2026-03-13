# Architecture Notes

- API responsibility: validate ownership via HMAC fingerprint, stage compressed payloads to S3, enqueue SQS messages, and expose polling endpoints.
- Worker responsibility: consume SQS messages, enforce idempotency, read payloads from S3, analyze memories with taxonomy rules, write Redis aggregates, and update MySQL state.
- MySQL persists only metadata and state. Redis is the ephemeral progress plane. S3 is the temporary payload plane.
- `packages/shared` owns the cross-process primitives: Prisma service/repository, Redis aggregate merge logic, AWS clients, fingerprinting, analyzer, and state guards.
- `GoVerifyService` and `LlmFallbackService` are explicit seams for later integration and are no-op in v1.
