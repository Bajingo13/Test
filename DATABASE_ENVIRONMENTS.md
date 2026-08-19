# Database Environments

This project uses three separate databases: **production** (Railway,
live), **development** (your own local database), and **test** (a
separate local database that automated tests are free to wipe). Before
this checkpoint, all three were actually the same Railway production
database - this document describes the fix and how to finish setting it
up.

## Why this exists

`accounting-ui/src/backend/db.js` used to load one `.env` file
unconditionally, regardless of what you were doing with the backend
(running `npm start`, running `npm test`, experimenting locally). That
`.env` file has always pointed at the live Railway MySQL database,
because there was never a second database to point at instead. Every
Jest test, every Playwright fixture, every migration "run locally" -
all of it happened against the same database the deployed app serves
real users from.

That is now fixed at the code level. It is not yet fixed at the
*infrastructure* level, because creating an actual second database
requires either a decision (local MySQL vs. a second Railway service)
or credentials this assistant does not have. See "Manual steps you must
perform" below.

## The three environments

| | `NODE_ENV` | Database | Who can reset it |
|---|---|---|---|
| **Production** | `production` (or unset) | Live Railway MySQL | Nobody, ever, via this project's tooling |
| **Development** | `development` | Your own local (or dedicated Railway) database | You, manually, if you choose - no automated reset command exists |
| **Test** | `test` | A separate local (or dedicated Railway) database | `npm run db:test:reset` - drops and rebuilds every table |

**Development and test must be two different databases**, not two
`.env` files pointing at the same one. `npm run db:test:reset` drops
every table it finds - if test and development shared a database, that
command would destroy your manually-entered development data.

## How environment selection works

Everything routes through one function:
`accounting-ui/src/backend/config/database.js` → `resolveDatabaseConfig()`.

```
NODE_ENV=test        -> TEST_DATABASE_URL (or TEST_MYSQL_* vars). Throws
                         if missing. Throws if it resolves to the known
                         production host/database name, even if someone
                         set it there by mistake.
NODE_ENV=development -> DEV_DATABASE_URL (or DEV_MYSQL_* vars). Same two
                         guarantees as test.
anything else         -> production config, resolved exactly the way it
(including unset)        always was: Railway's injected MYSQL_URL, or
                         the MYSQLHOST/MYSQLUSER/etc. fallback chain.
```

**Why an unset `NODE_ENV` means production, not development:** this
project cannot currently confirm whether Railway's deployed service
actually sets `NODE_ENV=production` (no dashboard/CLI access from this
environment). If this resolver defaulted an unset `NODE_ENV` to
`development`, and Railway does not set it, the next deploy would try
to connect using a `DEV_DATABASE_URL` that doesn't exist there and the
live app would fail to boot. Defaulting to production is the only
choice that cannot break the currently-working deployment. **You should
still add `NODE_ENV=production` in the Railway dashboard's environment
variables** as a belt-and-suspenders measure - see "Manual steps" below.

Local scripts (`npm test`, `npm run dev:backend`, the migration runner,
the test reset script) all set `NODE_ENV` explicitly via `cross-env`
in `package.json`, so you never need to set it by hand for normal use.

### Two independent safety nets, not one

1. `resolveDatabaseConfig()` itself refuses to build a `test`/`development`
   config that is missing its URL, or that resolves to a known production
   identifier (`reseau.proxy.rlwy.net`, any `*.rlwy.net` host, or a
   database literally named `accounting_system`).
2. `accounting-ui/src/backend/lib/testDatabaseGuard.js`'s
   `assertNotProductionDatabase()` (called by the two HTTP integration
   test files) checks `NODE_ENV=production` *and independently* re-resolves
   the connection config and checks it against the same denylist - so
   even a `NODE_ENV` mix-up doesn't bypass the host check.

Both are exercised by `src/backend/config/__tests__/database.test.js`
and `src/backend/scripts/__tests__/migrationSafety.test.js`, which are
pure-logic tests with no real database connection, safe to run any time.

## Everyday commands

```powershell
# See what database a given NODE_ENV would resolve to, without connecting
npm run db:verify-env
$env:NODE_ENV="test"; npm run db:verify-env
$env:NODE_ENV="development"; npm run db:verify-env

# Run the backend locally against the development database
npm run dev:backend

# Run the full test suite (always uses NODE_ENV=test automatically)
npm test

# Build a fresh test database from the migrations (safe - refuses non-test)
npm run db:test:reset

# Apply migrations to development or test without wiping existing data
npm run db:migrate:dev
npm run db:migrate:test

# Production - unchanged, still just:
npm start
```

## Setup status: DONE

`astrea_accounting_dev` and `astrea_accounting_test` exist on the local
MySQL 8.0 server (`MySQL80` Windows service, `127.0.0.1:3306`),
`.env.development.local` / `.env.test.local` are configured, and both
databases have been fully migrated and execution-tested end to end
(including a full `npm run db:test:reset` drop-and-rebuild cycle). If
you need to redo this on another machine, the steps below still apply.

### 1. Create the two databases

```powershell
& "C:\Program Files\MySQL\MySQL Server 8.0\bin\mysql.exe" -u root -p
```

At the `mysql>` prompt:

```sql
CREATE DATABASE astrea_accounting_dev  CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
CREATE DATABASE astrea_accounting_test CHARACTER SET utf8mb4 COLLATE utf8mb4_0900_ai_ci;
EXIT;
```

### 2. Create the env files

In `accounting-ui/src/backend/`, copy the two example files to
`.env.development.local` / `.env.test.local` and fill in
`DEV_MYSQL_PASSWORD` / `TEST_MYSQL_PASSWORD` with your local MySQL
password. Both files are covered by `.gitignore`'s `.env.*` rule and
will never be committed.

### 3. Build the schema

```powershell
npm run db:migrate:dev
npm run db:migrate:test
```

**Execution-tested end to end** against both freshly-empty databases -
all 30 migrations apply cleanly in the documented order. Three real
gaps were found and fixed in the process (none by rewriting an existing
migration file - see "What execution-testing found" below).

### 4. Verify

```powershell
npm run db:verify-env          # confirms production config is untouched
$env:NODE_ENV="test"; npm run db:verify-env    # confirms test resolves correctly
npm test                       # runs the full suite for real
```

### 5. (Recommended) Set `NODE_ENV=production` on Railway

In the Railway dashboard, add `NODE_ENV=production` to the deployed
service's environment variables if it isn't already set. This is not
required for correctness (see "why unset means production" above) but
closes the one remaining assumption this checkpoint could not verify
from here.

## What if you'd rather use a second Railway database instead of local MySQL?

Provisioning a new Railway MySQL plugin/service was intentionally not
done automatically (it can incur cost, and the task explicitly required
stopping for your approval first). If you'd prefer that over local
MySQL:

1. In the Railway dashboard, add a new MySQL database service to a
   project (a *separate* one from production, or a separate service
   within the same project - either works as long as it's a distinct
   database).
2. Copy its connection variables into `.env.development.local` /
   `.env.test.local` the same way as step 2 above (Railway will show you
   a `MYSQL_URL`-shaped value you can use directly as `DEV_DATABASE_URL`
   / `TEST_DATABASE_URL`).
3. Continue from step 3 above.

## Migration order

See `accounting-ui/src/backend/scripts/migrationOrder.js` for the
authoritative, commented list of all 30 files. In short:

1. `000_baseline_schema_migration.sql` - **new, generated by this
   checkpoint.** 32 core tables (`users`, `audit_logs`, `jv_headers`,
   `jv_lines`, `chart_of_accounts`, `invoice_headers`, `apv_headers`,
   `cv_headers`, `or_headers`, `purchase_order_headers`,
   `general_libraries`, the AR/AP/GL beginning balance tables,
   `transaction_applications`, etc.) have **no `CREATE TABLE` anywhere in
   this repo's version history** - they predate the `*_migration.sql`
   convention entirely. This file represents each of those tables'
   structure immediately *before* this repo's migration-file history
   begins (every column a later migration file adds via `ALTER` is
   programmatically excluded, so that later file's own `ADD COLUMN` runs
   exactly as originally written). It must run first.
2. `beginning_balance_delete_permission_migration.sql` - **new.** Must
   run immediately after `user_access_control_migration.sql` (see "What
   execution-testing found" below).
3. Then every existing `*_migration.sql` file, in dependency order
   (foundational permissions/roles first, then currency infrastructure,
   then the checkpoint-numbered migrations in the order they were
   actually written, ending with Checkpoint 5's period locking).

All migrations, including the two new files, are idempotent **when run
against a database that doesn't already have their result** - `CREATE
TABLE IF NOT EXISTS`, `INSERT IGNORE`, or `information_schema`-guarded
conditional `ALTER` throughout. Not every original migration file is
safely *re-runnable* against an already-migrated database, though - see
"What execution-testing found" below. `npm run db:test:reset` is the
supported way to get back to a known-good state; it always drops
everything and rebuilds from empty rather than trying to apply on top of
existing tables.

## What execution-testing found

Running the migration order against real empty databases (not just
reading the SQL) surfaced three real, narrow gaps - all now fixed,
none by rewriting an existing migration file:

1. **`audit_logs` was missing from the baseline.**
   `permission_templates_migration.sql` needs it, but its only
   `CREATE TABLE IF NOT EXISTS` lives inside `bank_reconciliation_migration.sql`,
   much later in the order. Fixed by adding it to the baseline.
2. **`jv_headers`/`jv_lines` were missing too**, same root cause. Their
   later `ALTER`s (in `checkpoint3c`/`4h`/`4i`) are all
   `information_schema`-guarded, so they were safe to add to the
   baseline in their fully-evolved form without needing any column
   stripped back out.
3. **`FILESETUP.BEGINNING_BALANCES.DELETE` has never been seeded by any
   migration** - production has had it (and its ADMIN/ACCOUNTANT grants)
   only via an undocumented manual insert. Caught because
   `periodLocking.http.test.js`'s Beginning Balance test got a `403`
   instead of the `409` it was actually testing for, against a freshly-
   migrated database. Fixed via the new
   `beginning_balance_delete_permission_migration.sql`.

A fourth, structurally different issue was found during full-regression
verification and is **not fixed** (out of scope for this checkpoint -
see "Known limitations"): `currencyService.getRateHistory()` and a few
related currency-resolution queries `ORDER BY created_at DESC` with no
tiebreaker, on a whole-second-precision `TIMESTAMP` column. Two writes
landing in the same clock-second sort non-deterministically. Railway's
network latency happens to keep consecutive writes in different
seconds, which is why this has never surfaced there; local MySQL's
much faster round-trips expose it. This is a genuine latent bug in
existing accounting/currency code, not something introduced by this
checkpoint - fixing it is feature/business-logic work, out of scope
here per the explicit "do not implement additional features"
instruction this checkpoint was scoped under.

## Known limitations

- **Currency rate-history ordering is non-deterministic under fast
  writes** (see "What execution-testing found" above) - 7 tests across
  `exchangeRateResolverService.test.js`, `transactionCurrencyService.test.js`,
  `currencyService.test.js`, and `checkpoint3cCurrency.test.js` fail
  intermittently against local MySQL for this reason. Confirmed via
  `SHOW COLUMNS`: `currency_rates.created_at` is a plain `timestamp`
  (whole-second precision), and `getRateHistory()`'s query is
  `ORDER BY cr.created_at DESC` with no secondary sort key. Not fixed
  here - flagged for a future small, targeted fix (add `id DESC` as a
  tiebreaker, or widen the column to `TIMESTAMP(6)`), not a new
  checkpoint.
- Migration files are only safely *re-runnable* against an
  already-migrated database to the extent each original file is itself
  idempotent - most are, but at least one (`quotation_migration.sql`)
  uses a plain `ALTER TABLE ADD COLUMN` with no guard, which fails with
  "Duplicate column name" on a second run. `npm run db:test:reset`
  (drop everything, then rebuild from empty) is the supported recovery
  path, not re-running `db:migrate:*` on top of existing tables.
- `000_baseline_schema_migration.sql` captures production's schema *as
  of the day it was generated*. If production's schema changes later
  without a corresponding new `*_migration.sql` file (i.e., someone
  manually `ALTER`s a table on Railway directly), this baseline will
  drift out of date. Treat any future schema change as required to go
  through a migration file, the same discipline the rest of this project
  already follows.
- No production fingerprint table (`environment_metadata`) was added.
  Section 11 of the task explicitly preferred environment-based
  protection first and asked not to add anything to production
  automatically unless clearly necessary - the host/database-name
  denylist plus the `NODE_ENV` check together already provide two
  independent hard blocks, which was judged sufficient without also
  writing to production.