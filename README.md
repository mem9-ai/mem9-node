# Memories Dashboard Analysis Service

Async, batch-based backend for browser-uploaded MEM9 memories. The browser sends `x-mem9-api-key` plus memory batches to the Node service, the API stores batch payloads in S3, enqueues work to SQS, and the worker writes incremental progress and aggregates into Redis while MySQL holds only durable metadata and state.

## Monorepo Layout

```text
apps/
  api/       NestJS + Fastify HTTP API
  worker/    NestJS standalone SQS worker
packages/
  config/    typed env loading
  contracts/ shared DTOs/contracts/enums
  shared/    fingerprinting, Prisma/Redis/AWS adapters, analyzer logic
prisma/      schema, migration, seed
infra/       Terraform skeleton
scripts/     local bootstrap helpers
```

## Local Development

1. `cp .env.example .env`
2. `docker compose up -d`
3. `pnpm install`
4. `pnpm prisma:generate`
5. `pnpm migrate`
6. `pnpm seed`
7. `pnpm dev`

API docs: [http://127.0.0.1:3000/docs](http://127.0.0.1:3000/docs)

Worker health: `http://127.0.0.1:3001/health/live`

## Main Commands

- Install: `pnpm install`
- Generate Prisma client: `pnpm prisma:generate`
- Apply migrations: `pnpm migrate`
- Seed data: `pnpm seed`
- Start API + worker in watch mode: `pnpm dev`
- Lint: `pnpm lint`
- Typecheck: `pnpm typecheck`
- Test: `pnpm test`
- Build: `pnpm build`

## API Flow

### Create a job

```bash
curl -X POST http://127.0.0.1:3000/v1/analysis-jobs \
  -H 'content-type: application/json' \
  -H 'x-mem9-api-key: your-mem9-key' \
  -d '{
    "dateRange": {
      "start": "2025-12-12T00:00:00Z",
      "end": "2026-03-12T23:59:59Z"
    },
    "expectedTotalMemories": 1500,
    "expectedTotalBatches": 15,
    "batchSize": 100,
    "options": {
      "lang": "zh-CN",
      "taxonomyVersion": "v3",
      "llmEnabled": false,
      "includeItems": true,
      "includeSummary": true
    }
  }'
```

### Upload a batch

```bash
curl -X PUT http://127.0.0.1:3000/v1/analysis-jobs/aj_xxx/batches/1 \
  -H 'content-type: application/json' \
  -H 'x-mem9-api-key: your-mem9-key' \
  -d '{
    "memoryCount": 2,
    "memories": [
      {
        "id": "m_001",
        "content": "我最近在做 AI agent 产品",
        "createdAt": "2026-03-01T10:00:00Z",
        "metadata": {}
      },
      {
        "id": "m_002",
        "content": "今天很开心",
        "createdAt": "2026-03-02T10:00:00Z",
        "metadata": {}
      }
    ]
  }'
```

### Poll snapshot and updates

```bash
curl -H 'x-mem9-api-key: your-mem9-key' \
  http://127.0.0.1:3000/v1/analysis-jobs/aj_xxx

curl -H 'x-mem9-api-key: your-mem9-key' \
  'http://127.0.0.1:3000/v1/analysis-jobs/aj_xxx/updates?cursor=0'
```

## Privacy Guarantees

- No plaintext MEM9 API key is stored in MySQL, Redis, S3 metadata, or logs.
- No raw memory content is stored in MySQL.
- Raw memory bodies are stored only in temporary gzipped S3 objects.
- Durable state in MySQL contains metadata, policies, jobs, batches, taxonomy, and audit metadata.
- Redis stores ephemeral progress, aggregate data, batch summaries, dedupe sets, and locks.

## Known Local Constraints

- This workspace currently targets Node 22 but the shell that built it reported Node 25. Runtime should use Node 22 or the provided Dockerfiles.
- Full `pnpm migrate` and `pnpm seed` require MySQL/Redis/LocalStack to be running.
- The worker health server is intentionally minimal; ECS readiness should normally be driven by container health and queue lag metrics.
