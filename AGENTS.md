# Agent & Contributor Conventions

This is the contract for changing code in this repo. It exists because the
codebase already has strong *de-facto* conventions that were never written down —
and that vacuum is what lets the architecture drift. When in doubt, match an
existing, recently-touched file in the same domain; when a rule below conflicts
with an old file, the rule wins and the old file is the bug.

The stack is deliberately singular: **one ORM** (GORM), **one migration tool**
(goose, `internal/migrations/sql`), **one task runner** (asynq via
`internal/enqueue`), **one logger** (`internal/logging` / slog), **one HTTP
router** (chi), **one frontend API layer** (generated `$api` hooks). Do not
introduce a second way to do any of these.

---

## Backend (Go)

### 1. Handler shape
Every HTTP handler follows the same pipeline, in this order:

```
decode → validate → authorize → do work → writeJSON
```

- **Decode** the request body into a typed `xxxRequest` struct.
- **Validate/normalize** with a `normalize*ForRequest(...) (T, bool)` helper that
  writes the 4xx itself and returns `false` on failure (see the sheets/apps
  handlers). Handlers stay flat: `if v, ok := normalize…; !ok { return }`.
- **Authorize** via `internal/access` (see rule 2) — never inline a new predicate.
- **Do work**, then `writeJSON(w, status, typedResponse)`.

New domains get their own **service package** with **sentinel errors** and exactly
one `write<Domain>Error(w, err)` mapper. The canonical example is
`internal/sheets` + `writeSheetsError` and `internal/apps` + `writeAppsError`
(`apps.ErrNotFound`, `apps.ErrNotDeployed`, …). Copy that shape; do not invent a
new error-handling style per handler.

### 2. Authorization lives in `internal/access`
- **All** channel/team/role predicates are implemented **once** in
  `internal/access`; handlers delegate (`access.Resolve(ctx, db, orgID, userID)`
  then `actor.CanUseChannelID(...)`, `actor.CanManageTeamResource(...)`,
  `actor.IsOrgManager()`). Do **not** hand-mirror the predicate into a handler.
- **Foreign / unauthorized resources return `404`, never `403`** — a caller must
  not be able to distinguish "exists but forbidden" from "does not exist" across a
  tenant or team boundary.
- **Missing auth context returns `401`, never `403`** (`errorResponse{Error:
  "missing org context"}`). `403` is reserved for "authenticated, identified, but
  not permitted" within your own org.
- The handler gate is the real authorization. Never rely on the route group alone
  ("it's behind `RequireOrgAdmin` so the handler can skip the check") — route
  groups change; the in-handler gate must stand on its own.

### 3. Every query is org-scoped and context-carrying
- Every org-scoped query carries `Where("org_id = ?", org.ID)`.
- Every GORM call carries the request context: `.WithContext(r.Context())` (or the
  ctx in service code). No exceptions — this is what makes tracing and cancellation
  work.

### 4. Response envelopes
- **Errors** use the shared `errorResponse{Error: "..."}` struct. **Never**
  `map[string]string{"error": ...}` or `map[string]any{...}`. Multi-field error
  bodies get a named struct (e.g. `pluginInstallConflictResponse`).
- **Success** bodies are **keyed envelopes or typed objects, never bare arrays.**
  A bare `[]T` cannot gain a cursor/pagination field later without breaking every
  client. (Legacy bare-array endpoints already in the OpenAPI contract are
  grandfathered; do not add new ones.)
- **Create → `201`.** **Delete → `200` with `statusResponse{Status: "deleted"}`**
  (or `"uninstalled"`, etc.), not an ad-hoc `204`/`200` split.

### 5. Status mapping via sentinels only
Map HTTP status from **typed sentinel errors** with `errors.Is` / `errors.As`.
**String-matching `err.Error()` for status is banned** — a reworded message must
never silently flip a `400` into a `500`. Producing packages export the sentinels
(`var ErrNotFound = errors.New(...)`) and wrap them with `%w`. Driver-level
conditions use the driver, not text: unique violations are detected via
`pgconn.PgError.Code == "23505"` (see `isDuplicateKeyError` in
`internal/handler/helpers.go`), not `strings.Contains(err, "duplicate key")`.

### 6. Never leak internal errors
Never write `err.Error()` into a `5xx` body. Log the raw error
(`logging.FromContext(ctx).ErrorContext(ctx, "load plugin details", "error",
err)` — which also reaches Sentry) and return a **static** message
(`errorResponse{Error: "failed to load plugin details"}`). Raw KMS / Qdrant /
Nango / SQL text must never reach a client.

### 7. Check every write; assert `RowsAffected` on security gates
- Every DB write's `.Error` is checked. A logout/revocation/confirmation that
  "succeeds" while its write silently failed is a security bug.
- Writes that are themselves the security gate (token revocation, single-use OTP,
  email confirmation) **additionally** assert `RowsAffected == 1` and use a single
  conditional `UPDATE ... WHERE ... AND used_at IS NULL` instead of
  SELECT-then-UPDATE (no TOCTOU).
- `_ =` on a write is allowed **only** for best-effort telemetry, and must carry a
  comment saying so.

### 8. Transactions, tasks, goroutines
- Multi-row invariants run inside `db.Transaction(func(tx) error { ... })`.
- Async work is enqueued **only** through `internal/enqueue.Client` with explicit
  `Queue`, `MaxRetry`, `Timeout`, and an idempotency key. Task types live in
  `internal/tasks/types.go`; payload constructors in `internal/tasks/payloads_*`.
  A task type with **no enqueuer** is dead code — delete it, don't leave it wired.
- Background goroutines are spawned via `internal/goroutine.Go` (panic-safe), never
  a bare `go func()`.

### 9. Config, not constants
Anything environment- or deployment-specific is `HIVY_*` env, resolved through
config — not hardcoded. That includes domains, image repos (`ghcr.io/usehivy/*`),
utility/model IDs (resolve model IDs through `internal/registry`), and tunable
thresholds. Hardcoding `usehivy.com` anywhere is a self-hosting blocker.

### 10. One name per concept (glossary)
Use these exact terms; don't introduce synonyms:
- **org** = the tenant. "Workspace" is product copy only, never a code identifier.
- **agent**, **channel**, **team**, **member**, **actor** — each defined once.
- **connection** = a Nango OAuth link. **credential** = an LLM/provider API key.
  **integration** = a Nango provider config. These are three different things;
  don't collapse them into one word.

### Logging
Use `internal/logging` (`logging.FromContext(ctx).ErrorContext(ctx, "msg",
"error", err)`) or `logging.Capture(ctx, err)`. The stdlib `log` package is banned
by lint (`depguard` `no-stdlib-log`); slog attribute style is enforced by
`sloglint` (snake_case keys, static messages, no `msg`/`level`/`time`/`source`
keys).

---

## Frontend (`apps/web`, Next.js + TanStack Query)

### 11. All Hivy REST goes through `$api`
- Every call to the Hivy backend uses a **generated `$api` hook**. The raw `api`
  client is permitted only inside `_lib/*-api.ts` when composition genuinely
  requires it. **No hand-written fetch clients.**
- Raw `fetch` is permitted for **exactly three** things, each with an inline
  comment naming which: (1) signed-storage upload, (2) direct-sandbox calls,
  (3) SSE/`EventSource` streams. This is enforced by an ESLint
  `no-restricted-syntax` rule — a raw `fetch` to the API fails lint.

### 12. Routes are contract-first
Every backend route carries a `@Router` annotation, **including SSE routes** the
frontend consumes. Regenerating the spec (`make openapi`) and the client
(`pnpm generate`) lands in the **same PR** as the route change, so the frontend
can never hardcode a path the contract doesn't know about.

### 13. No hand-written keys, no redundant casts
- Query keys import from the **one** shared `query-keys` module. Never inline a
  key literal — a library upgrade that changes key semantics must have a single
  edit site.
- Never cast a `$api` response with `as Type[]`. The generated hooks are already
  typed; let inference flow. A cast that "fixes" a type is hiding a real mismatch.

### 14. One writer for org context
`auth-context` is the **sole** owner of the active-org cookie and org switching.
- Switching orgs goes through `setActiveOrg`, which does a **full
  `queryClient.invalidateQueries()`** so the previous org's cached data can't bleed
  into the new one.
- **Never** write `document.cookie` for org state from a page/component, and never
  fake a switch with `setTimeout`.

### 15. Role gating and shared components
- Gate UI on roles **only** via `useIsAdmin` / `useIsOwner`, and the gate must
  match the backend route group. Any comment asserting an authz behavior cites the
  backend file it mirrors (so a stale "admin-only" comment can't outlive the
  server change).
- **One** component per kind: one agent-avatar component, one
  `components/confirm-dialog.tsx`. Don't fork a near-duplicate.

---

## Before you open a PR
- `go build ./...` and `go vet ./...` are clean.
- `golangci-lint run` is clean (it enforces rules 5, 6, and the logging ban).
- Backend route changes: `make openapi` + `pnpm -C apps/web generate` committed.
- Frontend: `pnpm -C apps/web tsc --noEmit` and `pnpm -C apps/web lint` are clean.
- New tables/columns: add the goose migration under `internal/migrations/sql`
  **and** bump `latestMigrationVersion` + the `migratedTables` list in
  `internal/testdb/migrations.go` to match.

---

## Base44 dev environment

The repo's own `docker-compose.yml` is already dev-oriented (air live-reload for
Go, `next dev --turbopack` for the frontend, bind-mounted source). Base44 runs it
with a small override (`docker-compose.base44.yml`) and a `.env` file copied from
`.env.example`.

### Startup sequence (order matters)
1. `docker compose -f docker-compose.yml -f docker-compose.base44.yml up -d --build`
   — starts infra (postgres, redis cluster, nango, qdrant) and the Go API/worker.
   The API will crash on first boot because migrations haven't run yet.
2. `docker compose -f docker-compose.yml -f docker-compose.base44.yml run --rm --no-deps api go run ./cmd/server migrate up`
   — applies goose migrations.
3. Retrieve the Nango secret key (Nango generates its own, not the `.env`
   placeholder): `docker compose exec -T postgres sh -lc "psql -U hivy -d nango -Atc \"SELECT secret_key FROM nango._nango_environments WHERE name='prod' LIMIT 1\""`
   and update `HIVY_NANGO_SECRET_KEY` + `HIVY_NANGO_WEBHOOKS_SECRET` in `.env`.
4. `docker compose up -d api worker` — recreate with the real Nango key; API now
   boots and passes `/healthz`.
5. `docker compose run --rm --no-deps -e HIVY_DEV_SEED_ENABLED=true api go run ./cmd/dev-seed`
   — seeds a login-ready org (dev@hivy.local / local-development).
6. `docker compose up -d web` — starts the Next.js dev server on port 3000.

### Quirks
- **Minio images are not pullable** in the Base44 sandbox (`minio/minio`,
  `minio/mc` return "pull access denied"). The override disables minio and
  minio-setup via compose profiles. The S3 client is lazy (AWS SDK), so the API
  starts and passes `/healthz` without it. RAG filestore features are unavailable
  until minio is restored.
- **Nango secret key** is generated by Nango on first start, not the `.env`
  placeholder. It must be retrieved from the `nango` database and written back to
  `.env` before the API can sync its integration catalog.
- **Next.js `allowedDevOrigins`** is set in `apps/web/next.config.mjs` from
  `BASE44_PUBLIC_HOST_SUFFIX` so the preview origin can access dev assets/HMR.
- The frontend proxies all API calls through `/api/proxy` (single-origin pattern),
  so the browser only needs port 3000. The API is also exposed on port 8000 for
  OAuth redirects and SSE.
- Dev login: **dev@hivy.local** / **local-development**
