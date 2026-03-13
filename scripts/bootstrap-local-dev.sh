#!/usr/bin/env sh
set -eu

cp -n .env.example .env || true
docker compose up -d
pnpm install
pnpm prisma:generate
pnpm migrate
pnpm seed
