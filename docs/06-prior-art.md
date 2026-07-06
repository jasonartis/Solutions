# Prior Art Review — Founder's Existing Codebases (2026-07-06)

Two work codebases were assessed for reusable infrastructure. Conclusion: **no architecture changes** — both validate the platform's decisions (some by positive example, some as cautionary tales) — but several components are worth borrowing as reference designs when the relevant need arrives.

## Codebase A: `C:\Users\yarmishj\Desktop\Dascher - Code Base` (Artis Energy Playbook/Dascher)

React 18 SPA (webpack, MUI, Redux/RTK Query) + legacy Apollo/Sequelize API + newer `dascher.base` stack: Hasura over Azure Postgres/SQL Server, two Fastify TypeScript microservices (calc-engine ~14k LOC, insight-engine ~2k LOC). Azure Pipelines → ACR → App Service.

### Worth borrowing (reference designs, reimplemented not ported)

| What | Where | Relevance to platform |
|---|---|---|
| **Server-side formula evaluation service** — HyperFormula wrapped in Fastify: custom `FunctionPlugin`s, cyclic-dependency handling, typed `FormulaEvaluationError`, frequency/result transformers, formula macros | `dascher.base/calc-engine/src/lib/` (esp. `hyperformula-builder.ts`) | The platform has two mini expression languages planned (module 2 gradebook combination formulas; module 3 time rules). Ours are far smaller — build them as simple structured rules first — but if a future module needs real user-authored formulas, this is the proven design: evaluate server-side, centralize, type the errors. |
| **Pluggable LLM provider abstraction** — `InsightProvider` interface with openai-compatible + mock implementations, Zod-validated I/O | `dascher.base/insight-engine/src/lib/providers/` | Directly portable into our worker when AI features arrive (natural-language querying, report generation — docs/00). |
| **Fastify service template** — cors/helmet/sensible, auto-Swagger, route modules, warmup hook, Pino | `dascher.base/calc-engine/src/server.ts` | Baseline if the worker ever grows standalone HTTP services. |
| **Strict env validation in compose** (`${VAR:?error}`) + `.env.template` discipline | `dascher.base/docker-compose.yml` | Adopt in M0. |
| **Fully-local compose with hot-reload watch** (local postgres + services + frontend) | `dascher.initial.env/docker-compose.yaml` (early prototype) | Same philosophy as our `supabase start` parity approach — the *current* dascher stack develops against cloud Azure DBs, which is exactly the pain our local-first rule avoids. |

### Cautionary findings (validate our decisions)

- **Hasura deployed as the anti-pattern:** JWT secret configured but **zero permission rules** — everything runs as admin; empty migrations; frontend role-checks client-side only. Confirms both the no-Hasura decision and the RLS-from-day-one rule (docs/01). One permission system, enforced in the database.
- **Plaintext secrets committed** (`hasura/.env` with DB passwords/admin secret), 71 MB `hasura.exe` in git. Our rule stands: secrets never in git, binaries never in git (docs/05).
- Webpack/Babel SPA + Redux + MUI: workable but the opposite direction from Next.js/Tailwind; nothing to reuse there.

## Codebase B: `C:\Users\yarmishj\Desktop\Project_2024_08_16` (Artis Energy "artispy")

Six working copies of one Azure DevOps repo: Python 3.11/Flask apps (+ Flask-SocketIO, APScheduler) over Azure SQL via raw pyodbc; per-app Dockerfiles (no compose); apps double as Azure Functions; API-key/JWT auth without enforcement; no tenancy; prod credentials committed in `prod_config.py`.

### Worth borrowing (behavioral contracts and domain IP)

| What | Where | Relevance to platform |
|---|---|---|
| **Async job contract** — every operation is a topic: run synchronously (`run-<topic>` → `<topic>-result`) or async (`send-<topic>` → returns `resultId`, background task, `get-result` to fetch) | `base/artispy/utils/socket_io_manager.py` | A clean spec for our pg-boss job surface: jobs return result-ids; UI learns of completion via Supabase Realtime (instead of polling). Reimplement, don't port. |
| **Utility-rate DSL compiler** — SLY (lex/yacc) tariff expression language compiled over pandas DataFrames with dependency ordering | `base/rate_calculator/core/compiler/` | Real IP. Irrelevant to modules 1–6, but if an energy/utility-billing module ever joins the platform (founder's domain), this is the crown jewel to wrap as a service. |
| **Invoice OCR pipeline** — AWS Textract → structured charges from PDF invoices, Pydantic models | `base/invoice_data_collector/` | Reference for any future document-ingestion module. |
| **Forecasting library** — XGBoost + River (online learning) hybrid with model manifest/registry, data-quality checks | `base/usage_forecast/lib/` | Cleanest module there; conceptual reference for future analytics work. |
| **Alerting logger** — rate-limited SMTP alerts on ERROR | `artispy/utils/logger.py` | The idea (error → alert with rate limiting) maps to our Sentry setup; nothing to build. |

### Cautionary findings

- Committed production secrets (again) — the strongest recurring lesson across both codebases.
- Tenancy implicit via id columns with a single shared credential and no enforcement — precisely what RLS replaces.
- No compose, no migration tooling, `.bat`-driven local dev — reinforces our parity + migrations discipline.

## Standing conclusions

1. **Nothing changes in docs/01–05.** Both codebases independently confirm the two riskiest platform rules: database-enforced tenancy (RLS) and secrets-never-in-git.
2. When a need matches the table entries above, **read the referenced source as a design spec, then reimplement on the platform stack** — the codebases are Azure/Flask/MUI-shaped and don't transplant.
3. HyperFormula is the known-good engine if user-authored spreadsheet-style formulas ever become a platform primitive.
