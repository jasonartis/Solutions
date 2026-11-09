# External Accounts — the moving pieces, in one place

Every external service this platform depends on: what it is, where to sign in,
and what it's used for. **Credentials (usernames + passwords) are NOT here** —
they live in the git-ignored `.env.accounts` file at the repo root (template:
`.env.accounts.example`). This doc is the map; that file is the keychain.

- **Setup steps** (how each account was first created): [docs/07-account-setup.md](07-account-setup.md).
- **Security rules**: secrets never go in git, chat, or docs — only in
  `.env.accounts`, your password manager, and the service dashboards. The
  Supabase `service_role` key never touches the web app or browser (worker/CI only).
- **Adding a new service later:** add a row here, a block to `.env.accounts`
  **and** `.env.accounts.example`, and note it in [docs/07](07-account-setup.md) if it needs setup steps.

## The list now lives on the vendor accounts page (2026-11-09)

**This doc's two tables (active and planned accounts) are RETIRED.** The list is the
superadmin page **`/console/vendors`** (Owner Console → "Vendor accounts"; docs/28 Part A).
It holds, per account: sign-in page and method, owner, two-step status, plan and cost,
payment, dates not to miss, where credentials are kept **by name**, what breaks if it is
lost (linked to its docs/28 Part B plan), notes, and a "last opened" history. Its badges
feed the Owner Console dashboard. It was seeded on 2026-11-09 from the tables that stood
here (see this file's git history) and from docs/28 Part B's re-measured inventory.

**Keeping one list:** add, change or close an account on the page, not here. Before
adopting a new outside service, give it a row on the page AND a docs/28 Part B plan, in the
same session.

The page can never hold a password or key (docs/28 "Part A AS BUILT"); credentials stay in
`.env.accounts` / `.env.deploy` / the service dashboards, as the rules above say. When you add
a new credential, also add its name to the page and a block to `.env.accounts.example`.
