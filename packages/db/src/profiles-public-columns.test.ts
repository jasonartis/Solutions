import { describe, expect, it } from 'vitest'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// TWO RATCHETS FOR THE EMAIL SLICE (docs/22 §21.3 and §11.6).
//
// WHY THEY EXIST, and it is the same story twice. `settings` was added to
// `public.profiles` in 20260727010000 and became readable by EVERY ORG-MATE
// the same day — because `profiles_select_shared_org` hands the whole row to
// anyone sharing an org, and a policy filters ROWS, NEVER COLUMNS. Nobody
// decided that; nobody noticed. The table's public nature had simply never
// been written down. Documentation did not stop it and will not stop the next
// one, so the rule gets teeth here.
//
// Both are ALLOW-LIST ratchets in the style this repo already uses
// (`view-as-coverage.test.ts`): they enumerate from `pg_catalog` and fail when
// reality drifts from a list a human has to edit on purpose.
// ---------------------------------------------------------------------------

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// ---------------------------------------------------------------------------
// RATCHET 1 — what may live on the PUBLIC identity row.
// ---------------------------------------------------------------------------
const PROFILES_PUBLIC_COLUMNS = ['user_id', 'display_name', 'created_at', 'updated_at'].sort()

// ---------------------------------------------------------------------------
// RATCHET 2 — who may read an email address.
//
// TWO PRECISION REQUIREMENTS, both verified 2026-09-16 and neither obvious
// (docs/22 §11.6):
//
//   * `email` and `auth.users` MATCH DIFFERENT SETS. Before this slice
//     `prosrc ~* 'email'` returned four functions and `prosrc ~* 'auth[.]users'`
//     returned exactly ONE — a different one. A ratchet that searches only one
//     pattern misses the other, so this searches BOTH.
//
//   * `prosrc` INCLUDES COMMENTS. That single pre-slice `auth.users` hit was
//     `vm_guard_last_conversation_admin`, whose match is inside a comment line —
//     it reads no such table. A ratchet whose baseline contains a known-wrong
//     entry is how an allow-list stops being read, so that function is listed
//     separately, as a comment match, rather than smuggled in beside the real
//     readers.
// ---------------------------------------------------------------------------

/** Functions that genuinely READ an address. Each needs a reason. */
const EMAIL_READERS: Record<string, string> = {
  org_member_profiles:
    'The admin-scoped member roster. Gated on is_org_admin(check_org_id) — an org admin sees the ' +
    'addresses of the people they administer, which is unchanged from before the slice.',
  org_find_user_by_email:
    'The INVITE lookup. Takes an address and returns a user_id; it never RETURNS an address, and ' +
    'since docs/22 decision 3 it does not return a name either. Gated on is_org_admin.',
  find_module_peer:
    'The three module resolvers (classroom/matchmaking/visual-messaging). Takes an address, returns ' +
    'a user_id and nothing else, and only for an ACTIVE member of the named org.',
  mm_mutual_matches:
    'The matchmaking mutual-match reveal — the one surface that deliberately shows another person\'s ' +
    'address. Both parties independently expressed interest, which is the authority test.',
  superadmin_user_emails: 'The Owner Console\'s five read sites. Gated on is_superadmin().',
  sd_match_contacts:
    'The speed-dating contact share. Gated on sd_can_organize_event, a revealed match, and the ' +
    'event\'s own shareContactOnMatch toggle.',
  // NOT LISTED, and worth a line because it is the interesting absence:
  // `handle_new_user` WAS one of the four pre-slice matches and is no longer a
  // match at all. It used to copy `new.email` into `profiles` at signup — the
  // write-once copy that no trigger ever refreshed, which is the bug this whole
  // slice removes. This ratchet FAILED when the entry was left here
  // speculatively, which is the allow-list working in the direction that
  // usually goes unnoticed: it refuses dead permission as well as new reach.
}

/** Matches on the PATTERN but reads nothing — recorded so the baseline is honest. */
const COMMENT_MATCHES_ONLY = ['vm_guard_last_conversation_admin']

describe('profiles is PUBLIC, and the email surface is enumerable (docs/22 §21.3, §11.6)', () => {
  it('RATCHET 1: public.profiles carries only the declared PUBLIC columns', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const rows = await sql`
        select attname from pg_attribute
        where attrelid = 'public.profiles'::regclass and attnum > 0 and not attisdropped
        order by attname`
      const actual = rows.map((r) => r.attname as string)

      expect(
        actual,
        'THE COLUMNS OF public.profiles CHANGED.\n' +
          '`profiles` is PUBLIC — profiles_select_shared_org grants the whole row to every ' +
          'co-member, and a POLICY FILTERS ROWS, NEVER COLUMNS. So anything added here is visible ' +
          'to every co-member by definition.\n' +
          'If this column is PRIVATE to the user, it belongs in public.user_private.\n' +
          'If it is SHAREABLE but org-scoped, it belongs in the in-org profile (docs/22 §16).\n' +
          'If it really is public identity, add it to PROFILES_PUBLIC_COLUMNS here, on purpose.',
      ).toEqual(PROFILES_PUBLIC_COLUMNS)
    } finally {
      await sql.end()
    }
  })

  it('RATCHET 1 CONTROL: the companion table exists and holds what left profiles', async () => {
    // Without this, ratchet 1 would pass just as happily if `settings` and
    // `is_superadmin` had been DELETED rather than moved.
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      const rows = await sql`
        select attname from pg_attribute
        where attrelid = 'public.user_private'::regclass and attnum > 0 and not attisdropped
        order by attname`
      const cols = rows.map((r) => r.attname as string)
      expect(cols).toContain('settings')
      expect(cols).toContain('is_superadmin')

      // And it is genuinely private: no blanket co-member read like the one on
      // `profiles`. Asserted as the ABSENCE of a shares_org_with arm, with the
      // presence of the self/superadmin policy as the control.
      const pols = await sql`
        select polname, pg_get_expr(polqual, polrelid) as using_expr
        from pg_policy where polrelid = 'public.user_private'::regclass`
      expect(pols.length, 'user_private has no policies at all').toBeGreaterThan(0)
      for (const p of pols) {
        expect(
          /shares_org_with/.test((p.using_expr as string) ?? ''),
          `user_private.${p.polname} grants a co-member read — that is the bug this table was created to fix`,
        ).toBe(false)
      }
      expect(
        pols.some((p) => /auth\.uid\(\)/.test((p.using_expr as string) ?? '')),
        'no user_private policy keys on auth.uid() — this check is vacuous',
      ).toBe(true)
    } finally {
      await sql.end()
    }
  })

  it('RATCHET 2: only allow-listed functions touch an email address or auth.users', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      // BOTH patterns, because they match different sets.
      const rows = await sql`
        select p.proname, p.prosrc
        from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
          and (p.prosrc ~* 'email' or p.prosrc ~* 'auth[.]users')
        order by p.proname`

      const allowed = new Set([...Object.keys(EMAIL_READERS), ...COMMENT_MATCHES_ONLY])
      const unexpected = rows.map((r) => r.proname as string).filter((n) => !allowed.has(n))
      expect(
        unexpected,
        'These functions reference an email address or auth.users and are not allow-listed.\n' +
          'The email boundary is a FUNCTION surface now, not a policy surface (docs/22 §4.5 item 1), ' +
          'so this list IS the audit. Add each with a reason to EMAIL_READERS — or to ' +
          'COMMENT_MATCHES_ONLY if the match is only inside a comment.',
      ).toEqual([])

      // The allow-list must not rot either: an entry for a function that no
      // longer exists is dead permission.
      const present = new Set(rows.map((r) => r.proname as string))
      for (const fn of allowed) {
        expect(present.has(fn), `${fn} is allow-listed but no longer matches — remove it`).toBe(true)
      }

      // CONTROL: the pattern is capable of NOT matching. 148 functions live in
      // `public`; if the query returned all of them the allow-list would be
      // meaningless, and if it returned none the whole test would be vacuous.
      const total = await sql`
        select count(*)::int as n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'`
      expect(rows.length, 'the email query matched nothing at all').toBeGreaterThan(0)
      expect(rows.length, 'the email query matched every function — the filter is not filtering').toBeLessThan(
        (total[0]!.n as number) / 2,
      )

      // CONTROL for the comment trap: the one function on COMMENT_MATCHES_ONLY
      // must really match only in a comment. If a future edit makes it a real
      // reader, this fails and it has to move to EMAIL_READERS with a reason.
      for (const fn of COMMENT_MATCHES_ONLY) {
        const src = (rows.find((r) => r.proname === fn)?.prosrc as string) ?? ''
        const withoutComments = src.replace(/--.*$/gm, '')
        expect(
          /email|auth\.users/i.test(withoutComments),
          `${fn} is listed as a comment-only match but now references it in real code`,
        ).toBe(false)
      }
    } finally {
      await sql.end()
    }
  })

  it('RATCHET 2 CONTROL: no api role can read auth.users, by table OR by column', async () => {
    // The guarantee the whole design rests on (docs/22 §2.2). It is a grant
    // this repo does not control, so it is asserted rather than assumed — and
    // the column check is genuinely independent of the table check, since a
    // column grant could be issued without a table grant.
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      for (const role of ['anon', 'authenticated', 'service_role']) {
        const r = await sql`
          select has_table_privilege(${role}, 'auth.users', 'select') as tbl,
                 has_column_privilege(${role}, 'auth.users', 'email', 'select') as col`
        expect(r[0]!.tbl, `${role} can SELECT auth.users`).toBe(false)
        expect(r[0]!.col, `${role} can SELECT auth.users.email`).toBe(false)
      }
      // CONTROL: a role that CAN, so the three falses are a real measurement
      // and not a broken privilege query.
      const ctl = await sql`
        select has_table_privilege('postgres', 'auth.users', 'select') as tbl,
               has_column_privilege('postgres', 'auth.users', 'email', 'select') as col`
      expect(ctl[0]!.tbl, 'postgres cannot read auth.users — the privilege query is broken').toBe(true)
      expect(ctl[0]!.col).toBe(true)
    } finally {
      await sql.end()
    }
  })
})
