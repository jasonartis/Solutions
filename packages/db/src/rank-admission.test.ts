// What a rank gate ADMITS — the check docs/13 asked for (2026-08-07 entry) and
// CLAUDE.md's Next list carried as the rank/tier-wrapper verification gap.
//
// THE GAP THIS CLOSES. `module_position_rank()` is one ladder read by eight
// different functions, across fourteen call sites. Four ask `rank >= 2` against
// a literal (`cls_can_manage`, `sal_can_manage`, `sd_can_organize`,
// `module_has_manager_grant`); one — `module_caller_covers_rank` — takes its
// threshold as a PARAMETER, which is why the call-site resolution machinery
// below exists at all; `module_roles_guard_last_director` asks `rank >= 4` and
// `rank < 4` twice; and two compare two positions' ranks to each other
// (`module_caller_can_manage_seat`, which ALSO carries a `rank = 3` peer arm,
// and `view_as_guard_session`). Change one number in the ladder and every one of
// those answers moves — silently.
// Promote nail-salon `cashier` from 1 to 2 and `sal_can_manage_location` starts
// returning true for it, which hands the cashier `sal_earnings_ledger`: the
// module's single most documented asymmetry, gone, with every existing test
// still green. Until this file, that case was caught only BY ACCIDENT, because
// manager and cashier becoming equal rank happens to break their view-as pair
// entry and fail typecheck. Remap a position with no pair entries — every
// position in five of the eight modules — and nothing caught it at all.
//
// WHAT THE CHECKS THAT ALREADY EXIST DO NOT COVER, so this file is not
// mistaken for a duplicate of them: `rls.test.ts`'s parity loop proves the TS
// rank numbers equal SQL's, and `viewAsCompleteness()` proves every
// rank-differential PAIR is answered. Both are keyed on the rank numbers.
// Neither says one word about what a threshold built on those numbers lets
// through. Remap cashier in BOTH places and they stay green together.
//
// HOW IT WORKS — three assertions, in order of what they defend:
//
//   1. THE RULE SET AND THE VOCABULARY ARE BOTH DISCOVERED, NOT DECLARED. The
//      functions that read rank come out of `pg_proc.prosrc`, and the position
//      names come out of the ladder's OWN body (`when '<role>' then <n>`, parsed
//      per module block), so a ninth rule or a new tier name is caught the day it
//      lands rather than the day someone remembers a list exists. Both are
//      asserted against tripwire constants; a newcomer and a disappearance both
//      fail. Matching is case-insensitive and quoted-identifier tolerant, and a
//      catalog-side count control proves this file and Postgres agree on how many
//      bodies mention the ladder — a body the regex cannot see would otherwise be
//      a rank rule with no coverage AND no failure. A companion assertion proves
//      nothing OUTSIDE a public function body (policy, CHECK, default, view,
//      index predicate, trigger WHEN, other schema) reads the ladder, since the
//      parser would not see those either.
//
//   2. EVERY RANK USAGE MUST PARSE. A comparison this file cannot classify is a
//      FAILURE, never a skip. That inversion is the whole point: a checker that
//      quietly ignores what it does not understand goes green while covering
//      less and less, which is the exact shape of the miss that created this
//      gap. Same for a threshold whose value is a parameter we cannot resolve
//      to a literal at every call site.
//
//   3. THE ADMITTED SETS ARE SNAPSHOTTED. For every THRESHOLD test found, the
//      set of (module, position) pairs satisfying it is computed by asking the
//      DATABASE for each rank — never the TypeScript mirror — and written to
//      docs/rank-admission-map.md. A remap changes an admitted set, the snapshot
//      mismatches, and the diff names the gate and the tables behind it. That
//      file doubles as the readable "what does rank 2 mean in this module?" table
//      docs/13 asked for as piece 1.
//
//      RELATIVE gates are deliberately NOT rendered as admitted sets: `rank(a) >
//      rank(b)` has no per-position answer. They are still defended, because the
//      per-module `Ladder:` line encodes the whole outranks relation and any
//      remap moves it. Stated here rather than left implied — claiming coverage
//      this does not have is the failure mode the file exists to prevent.
//
// THE POSITION VOCABULARY IS DELIBERATELY NOT `moduleRegistry`, which the
// MODULES env var filters for white-label builds — the database holds every
// module's ladder regardless, so a filtered registry would silently shrink the
// check to whatever that deployment happens to include (the same trap
// data-browser-coverage.test.ts calls out, and one the existing parity loop in
// rls.test.ts still has). It is the ladder's own parsed vocabulary unioned with
// `viewAsDeclarations`, including the four GENERIC tier names that carry ranks
// 4/3/2/1 in EVERY module — `module_position_rank('sample','lead')` is 2 today,
// so any module_key can reach a `>= 2` gate through a name nothing declares.
//
// TWO THINGS TO KNOW BEFORE "FIXING" A FAILURE HERE:
//   * An ordinary plpgsql idiom — `r := rank(a,b); if r >= 2 then` — fails on
//     purpose, because pass 3 only clears a bound variable that is compared to
//     another RANK. It is the likeliest first false alarm. Teach the parser the
//     shape; do not relax the rule that unrecognised means failure.
//   * A MISSING docs/rank-admission-map.md passes locally (vitest writes new
//     snapshots) and fails under CI=true. The file is only a safeguard once the
//     .md is COMMITTED.
//
// Local-only. Sound for the FUNCTIONS in the same way data-browser-coverage.test.ts
// is — the ladder and every gate body live in migrations, so local and prod agree
// by construction, unlike GRANTs where prod's ALTER DEFAULT PRIVILEGES diverges.
// Weaker for the POLICY→table attribution, which is convention rather than
// construction; `scripts/prod-verify-view-as.mts` probe [5] checks the ladder
// itself against prod from this file's own map.
import { describe, expect, it } from 'vitest'
import postgres from 'postgres'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { viewAsDeclarations } from '@platform/core'

const dbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

// fileURLToPath, not `new URL(...).pathname` — the repo path contains a space,
// and pathname leaves it percent-encoded, so the snapshot lands in a directory
// named `Solutions%20Platform` that nobody ever looks in and git never sees.
// Same family as CLAUDE.md's `import.meta.dirname` gotcha.
const SNAPSHOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../../docs/rank-admission-map.md')

/**
 * The generic tier vocabulary from the 1-arg overload, which the 2-arg one
 * falls back to for any role it has no block for. Live in EVERY module.
 */
const GENERIC_VOCABULARY = ['director', 'coordinator', 'lead', 'position'] as const

/**
 * Every function whose body reads the ladder, as `oid::regprocedure`. Asserted
 * both ways against what the catalog actually holds — this list is a tripwire,
 * not a source of truth. Adding a name here without understanding what its
 * comparison admits defeats the file.
 */
const KNOWN_READERS = [
  'cls_can_manage(uuid)',
  'module_caller_can_manage_seat(uuid,text,text,uuid)',
  'module_caller_covers_rank(uuid,text,uuid,integer)',
  'module_has_manager_grant(uuid,text)',
  'module_roles_guard_last_director()',
  'sal_can_manage(uuid)',
  'sd_can_organize(uuid)',
  'view_as_guard_session()',
].sort()

// ---------------------------------------------------------------------------
// Tiny SQL-text readers. Deliberately dumb and deliberately strict: anything
// they cannot read is raised, never shrugged off.
// ---------------------------------------------------------------------------

/**
 * Blank out SQL comments, preserving every offset so the parser's indices stay
 * valid. Comments are not code, and treating them as code fails BOTH ways: a
 * commented-out rank test becomes a live entry in the map (asserting a rule that
 * no longer exists), and a gate name mentioned in a comment manufactures a
 * phantom call site that invents a threshold on somebody else's gate. Neither
 * is a leak — both are false claims in a document whose only job is to be true.
 */
function blankComments(src: string): string {
  const out = src.split('')
  let i = 0
  while (i < src.length) {
    const ch = src[i]
    if (ch === "'") {
      i++
      while (i < src.length) {
        if (src[i] === "'") {
          if (src[i + 1] === "'") i += 2
          else { i++; break }
        } else i++
      }
      continue
    }
    if (ch === '-' && src[i + 1] === '-') {
      while (i < src.length && src[i] !== '\n') { out[i] = ' '; i++ }
      continue
    }
    if (ch === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2)
      const stop = end < 0 ? src.length : end + 2
      while (i < stop) { if (src[i] !== '\n') out[i] = ' '; i++ }
      continue
    }
    i++
  }
  return out.join('')
}

/** Text of the balanced argument list whose `(` is at `open`. */
function readArgs(src: string, open: number): { args: string; end: number } {
  let depth = 0
  let inStr = false
  for (let i = open; i < src.length; i++) {
    const ch = src[i]
    if (inStr) {
      if (ch === "'") {
        if (src[i + 1] === "'") i++
        else inStr = false
      }
      continue
    }
    if (ch === "'") inStr = true
    else if (ch === '(') depth++
    else if (ch === ')') {
      depth--
      if (depth === 0) return { args: src.slice(open + 1, i), end: i + 1 }
    }
  }
  throw new Error(`unbalanced parentheses starting at ${open}`)
}

/** Split an argument list on top-level commas only (subqueries nest). */
function splitArgs(args: string): string[] {
  const out: string[] = []
  let depth = 0
  let inStr = false
  let start = 0
  for (let i = 0; i < args.length; i++) {
    const ch = args[i]
    if (inStr) {
      if (ch === "'") {
        if (args[i + 1] === "'") i++
        else inStr = false
      }
      continue
    }
    if (ch === "'") inStr = true
    else if (ch === '(') depth++
    else if (ch === ')') depth--
    else if (ch === ',' && depth === 0) {
      out.push(args.slice(start, i).trim())
      start = i + 1
    }
  }
  out.push(args.slice(start).trim())
  return out.map((a) => a.trim()).filter((a) => a.length > 0)
}

/** Every call to `name` in `src`, as its split argument list. */
function callsTo(src: string, name: string): string[][] {
  const out: string[][] = []
  const re = new RegExp(`\\b"?${name}"?\\s*\\(`, 'gi')
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1
    const { args, end } = readArgs(src, open)
    out.push(splitArgs(args))
    re.lastIndex = end
  }
  return out
}

type Fn = { sig: string; name: string; src: string; params: string[] }

/** A single resolved rank comparison. */
type RankTest =
  | {
      kind: 'threshold'
      op: '>=' | '>' | '<' | '<=' | '='
      value: number
      module: string | null
      /**
       * Set only on a threshold whose value came from a CALL SITE rather than
       * the body — it names the caller that supplied it. Load-bearing for the
       * closure below: `module_caller_covers_rank` is instantiated four times
       * across three modules, and without this every wrapper that calls it
       * would inherit all four, so `sal_can_manage_location` would claim a
       * classroom rank test and the salon's admitted set would be wrong.
       */
      via?: string
    }
  | { kind: 'relative' }

type Usage = {
  fn: string
  raw: string
  tests: RankTest[]
  note: string
}

// ---------------------------------------------------------------------------
// The parser. Every occurrence of module_position_rank(...) in a body must land
// in exactly one recognised shape, or the test fails naming the text.
// ---------------------------------------------------------------------------

type Occurrence = { start: number; end: number; args: string[] }

function occurrences(src: string): Occurrence[] {
  const out: Occurrence[] = []
  // Case-INsensitive and tolerant of a quoted identifier. `prosrc` stores the
  // body verbatim, so `MODULE_POSITION_RANK(...)` and `public."module_position_rank"(...)`
  // are valid SQL resolving to the same function that a case-sensitive bare-name
  // regex would not see — and an undiscovered gate is a silent green, the exact
  // failure this file exists to prevent. The catalog-side control below proves
  // the JS regex and Postgres agree on how many functions read the ladder.
  const re = /\b"?module_position_rank"?\s*\(/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(src))) {
    const open = m.index + m[0].length - 1
    const { args, end } = readArgs(src, open)
    out.push({ start: m.index, end, args: splitArgs(args) })
    re.lastIndex = end
  }
  return out
}

/** The module a rank call is asked about: a literal, a parameter, or unknown. */
function moduleArg(o: Occurrence): { literal: string } | { param: string } | { unknown: true } {
  const a = o.args[0]
  if (o.args.length < 2 || a === undefined) return { unknown: true } // 1-arg overload: generic ladder
  const lit = a.match(/^'([^']*)'$/)
  if (lit?.[1] !== undefined) return { literal: lit[1] }
  const ident = a.match(/^(?:new\.|old\.|[a-z_]+\.)?([A-Za-z_]\w*)$/)
  if (ident?.[1] !== undefined) return { param: ident[1] }
  return { unknown: true }
}

type Parsed = { usages: Usage[]; problems: string[] }

function parseFunction(fn: Fn, all: Fn[]): Parsed {
  const src = fn.src
  const occ = occurrences(src)
  const consumed = new Set<number>()
  const boundVars = new Map<string, number>() // varName -> occurrence index
  const usages: Usage[] = []
  const problems: string[] = []

  // Pass 1: rank calls bound straight to a local (`target_rank := rank(...);`).
  // These are not comparisons themselves; the variable must be compared later,
  // and pass 3 fails if it never is.
  //
  // The trailing `;` is load-bearing and was found by this test failing on its
  // first run. `module_roles_guard_last_director` says
  // `losing := rank(...) < 4 or new.org_id <> old.org_id or ...` — an assignment
  // whose right-hand side is a BOOLEAN EXPRESSION containing a comparison, not a
  // rank bound to a variable. Matching on `:=` alone swallowed a real threshold
  // and reported it as an unknown shape.
  occ.forEach((o, i) => {
    const before = src.slice(Math.max(0, o.start - 60), o.start)
    const asn = before.match(/([A-Za-z_]\w*)\s*:=\s*(?:public\.)?$/)?.[1]
    if (asn !== undefined && /^\s*;/.test(src.slice(o.end))) {
      boundVars.set(asn, i)
      consumed.add(i)
    }
  })

  // Pass 2: comparisons.
  occ.forEach((o, i) => {
    if (consumed.has(i)) return
    const after = src.slice(o.end)
    const opM = after.match(/^\s*(>=|<=|<>|!=|>|<|=)\s*/)
    // The comparison rendered from its parsed parts, not sliced blindly out of
    // the body — a fixed-width slice truncates mid-token and drags in whatever
    // follows (`)); `, `then return case when …`), which makes the generated map
    // unreadable and its diffs untrustworthy.
    const lhs = `module_position_rank(${o.args.join(', ')})`
    if (!opM?.[1]) {
      problems.push(`${fn.sig}: rank call in no comparison we recognise — \`${lhs}\``)
      return
    }
    const op = opM[1]
    if (op === '<>' || op === '!=') {
      problems.push(`${fn.sig}: inequality against a rank is not a shape this check models — \`${lhs} ${op} …\``)
      return
    }
    const restIdx = o.end + opM[0].length
    const rest = src.slice(restIdx)
    const mod = moduleArg(o)
    const where = 'literal' in mod ? 'module pinned in the body' : 'module supplied by the caller'

    // A negation wrapping the comparison INVERTS it, and the map would then list
    // the exact COMPLEMENT of who the gate admits. A security document naming
    // the wrong positions is worse than no document, so this is a hard failure
    // rather than an attempt to interpret.
    //
    // Only a DIRECT negation counts. `not exists (select 1 … and rank >= 4 …)`
    // negates the EXISTS, not the threshold — it is live in
    // `module_roles_guard_last_director` today and `>= 4` is the correct reading
    // of it. So the test is on the token IMMEDIATELY before the call (after
    // stepping over any `public.` qualifier), never on a window that would sweep
    // up the enclosing `not`.
    const justBefore = src.slice(Math.max(0, o.start - 60), o.start).replace(/\s*(?:public\s*\.\s*)?"?\s*$/, '')
    if (/\bnot\s*\(?$/i.test(justBefore)) {
      problems.push(
        `${fn.sig}: the rank comparison \`${lhs} ${op} …\` is directly negated. This check does not ` +
          `model negation, and reading it as un-negated would publish the complement of the truth.`,
      )
      return
    }
    if (/^[^\s)]+\s*\)?\s*is\s+(not\s+)?(true|false)\b/i.test(rest)) {
      problems.push(
        `${fn.sig}: the rank comparison \`${lhs} ${op} …\` is post-qualified with \`is [not] true/false\`, ` +
          `which can invert it. Not modelled.`,
      )
      return
    }

    // rank(...) <op> rank(...)  — a relative comparison. Consume the right side.
    const rightRank = rest.match(/^(?:public\.)?module_position_rank\s*\(/)
    if (rightRank) {
      const j = occ.findIndex((x) => x.start === restIdx + rest.indexOf('module_position_rank'))
      if (j >= 0) consumed.add(j)
      const rightArgs = j >= 0 ? `module_position_rank(${occ[j]!.args.join(', ')})` : 'module_position_rank(…)'
      usages.push({ fn: fn.sig, raw: `${lhs} ${op} ${rightArgs}`, tests: [{ kind: 'relative' }], note: 'rank vs rank' })
      return
    }

    // rank(...) <op> <integer literal>
    const litM = rest.match(/^(\d+)\b/)
    if (litM?.[1]) {
      usages.push({
        fn: fn.sig,
        raw: `${lhs} ${op} ${litM[1]}`,
        tests: [
          {
            kind: 'threshold',
            op: op as Extract<RankTest, { kind: 'threshold' }>['op'],
            value: Number(litM[1]),
            module: 'literal' in mod ? mod.literal : null,
          },
        ],
        note: where,
      })
      return
    }

    // rank(...) <op> <identifier>
    const identM = rest.match(/^([A-Za-z_]\w*)\b/)
    const ident = identM?.[1]
    if (ident === undefined) {
      problems.push(`${fn.sig}: rank compared to something unparseable — \`${lhs} ${op} …\``)
      return
    }

    // ...a local bound from another rank call: relative, just via a variable.
    if (boundVars.has(ident)) {
      usages.push({
        fn: fn.sig,
        raw: `${lhs} ${op} ${ident}`,
        tests: [{ kind: 'relative' }],
        note: `rank vs rank, via the local \`${ident}\``,
      })
      boundVars.delete(ident)
      return
    }

    // ...an integer parameter: resolve it from every call site, or fail.
    const ordinal = fn.params.indexOf(ident)
    if (ordinal < 0) {
      problems.push(
        `${fn.sig}: rank compared to \`${ident}\`, which is neither a literal, a parameter, nor a rank — ` +
          `\`${lhs} ${op} ${ident}\``,
      )
      return
    }
    const modOrdinal = 'param' in mod ? fn.params.indexOf(mod.param) : -1
    const sites: RankTest[] = []
    const vias: string[] = []
    for (const caller of all) {
      if (caller.sig === fn.sig) continue
      for (const args of callsTo(caller.src, fn.name)) {
        const arg = args[ordinal]
        if (arg === undefined) continue
        const v = arg.match(/^(\d+)$/)
        if (!v) {
          problems.push(
            `${fn.sig}: threshold parameter \`${ident}\` is passed the non-literal \`${arg}\` ` +
              `by ${caller.sig} — this check cannot say what that gate admits.`,
          )
          continue
        }
        let m: string | null = null
        const modArg = modOrdinal >= 0 ? args[modOrdinal] : undefined
        if (modArg !== undefined) m = modArg.match(/^'([^']*)'$/)?.[1] ?? null
        sites.push({
          kind: 'threshold',
          op: op as Extract<RankTest, { kind: 'threshold' }>['op'],
          value: Number(v[1]),
          module: m,
          via: caller.name,
        })
        vias.push(caller.name)
      }
    }
    if (sites.length === 0) {
      problems.push(
        `${fn.sig}: threshold parameter \`${ident}\` has no resolvable call site, so what this gate ` +
          `admits is unknown. A rank gate nobody can evaluate is exactly the hole this file exists to close.`,
      )
      return
    }
    usages.push({
      fn: fn.sig,
      raw: `${lhs} ${op} ${ident}`,
      tests: sites,
      note: `${where}; threshold instantiated by ${[...new Set(vias)].sort().join(', ')}`,
    })
  })

  // Pass 3: a rank bound to a variable that is never compared to a rank.
  for (const [v] of boundVars) {
    problems.push(
      `${fn.sig}: rank is assigned to \`${v}\` but \`${v}\` is never compared to another rank — ` +
        `this check does not know what that value is used for.`,
    )
  }

  return { usages, problems }
}

// ---------------------------------------------------------------------------

/**
 * Thresholds only. Relative gates are deliberately NOT rendered as admitted
 * sets: `rank(a) > rank(b)` has no fixed answer per position, and the per-module
 * `Ladder:` line already encodes the entire outranks relation, so a rank change
 * still fails the snapshot through that line. The header says exactly that
 * rather than claiming a coverage this does not have.
 */
function admits(test: Extract<RankTest, { kind: 'threshold' }>, rank: number): boolean {
  switch (test.op) {
    case '>=':
      return rank >= test.value
    case '>':
      return rank > test.value
    case '<':
      return rank < test.value
    case '<=':
      return rank <= test.value
    case '=':
      return rank === test.value
  }
}

/**
 * Code-unit ordering. NOT `localeCompare`, whose ICU collation can order the
 * same two names differently on a Windows dev box and an Ubuntu CI runner —
 * which would churn the snapshot for no reason and train reviewers to update it
 * without reading it.
 */
const byCodeUnit = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

function describeTest(t: RankTest): string {
  return t.kind === 'relative' ? 'rank(a) > rank(b)' : `rank ${t.op} ${t.value}`
}

describe('rank admission: what each rank gate lets through (docs/13, CLAUDE.md Next list)', () => {
  it('the ladder, the gates and what they admit all match the checked-in map', async () => {
    const sql = postgres(dbUrl, { prepare: false, max: 1 })
    try {
      // -- Every public function, with its body and parameter names. pg_catalog
      // -- rather than information_schema, per data-browser-coverage.test.ts:
      // -- the routines view does not expose prosrc for every language and the
      // -- wrong query returns zero rows while looking right.
      const fnRows = (await sql`
        select p.oid::regprocedure::text as sig,
               p.proname                 as name,
               p.prosrc                  as src,
               pg_get_function_arguments(p.oid) as args
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public'
        order by 1
      `) as unknown as { sig: string; name: string; src: string; args: string }[]

      // CONTROL. If this read were broken — wrong schema, wrong column, a view
      // that silently excludes rows — every assertion below would pass while
      // examining nothing. The platform has well over a hundred functions and
      // must have both rank overloads.
      expect(fnRows.length, 'catalog read found almost no functions — every check below would be vacuous')
        .toBeGreaterThan(100)
      const rankOverloads = fnRows.filter((r) => r.name === 'module_position_rank').map((r) => r.sig)
      expect(
        rankOverloads.sort(),
        'the rank function itself was not found by the catalog read — the search is broken, not the schema',
      ).toEqual(['module_position_rank(text)', 'module_position_rank(text,text)'])

      const all: Fn[] = fnRows.map((r) => ({
        sig: r.sig,
        name: r.name,
        // Comments blanked (offsets preserved) so neither the parser nor the
        // closure can be fooled by SQL that is not code. See blankComments().
        src: blankComments(r.src),
        params: r.args
          .split(',')
          .map((a) => a.trim().split(/\s+/)[0] ?? '')
          .filter((a) => a.length > 0),
      }))

      // CONTROL on the assumption every name-keyed structure below rests on:
      // that `proname` identifies a function uniquely. It does today for every
      // public function except the ladder itself. If a second overload of some
      // gate ever appears, the closure would merge two functions into one row
      // and `fn.params.indexOf()` would read one overload's parameter names
      // against the other's arguments — so fail here rather than quietly
      // mis-attribute.
      const overloaded = [...new Map(fnRows.map((r) => [r.name, 0])).keys()]
        .filter((n) => fnRows.filter((r) => r.name === n).length > 1 && n !== 'module_position_rank')
        .sort()
      expect(
        overloaded,
        `These public functions are overloaded. Everything below keys gates, tables and call\n` +
          `sites on the bare NAME, so an overload silently merges two different functions:\n` +
          `  ${overloaded.join(', ')}`,
      ).toEqual([])

      // ---- 1. The rule set is DISCOVERED. -------------------------------
      const readers = all
        .filter((f) => /\b"?module_position_rank"?\s*\(/i.test(f.src) && f.name !== 'module_position_rank')
        .sort((a, b) => byCodeUnit(a.sig, b.sig))

      // CONTROL on the DISCOVERY ITSELF, which is the one thing nothing else can
      // catch. Everything downstream is conditioned on this JS regex having
      // found every function that reads the ladder; if it misses one, `found`
      // still equals KNOWN_READERS, nothing is parsed, no map row appears, and
      // the suite is green while covering less. So ask POSTGRES how many
      // function bodies mention the ladder and require the two to agree.
      const catalogMentions = (await sql`
        select count(*)::int as n
        from pg_proc p
        join pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.prosrc ~* 'module_position_rank'
      `) as unknown as { n: number }[]
      const jsMentions = all.filter((f) => /"?module_position_rank"?/i.test(f.src)).length
      expect(
        jsMentions,
        `Postgres and this file disagree about how many function bodies mention the ladder\n` +
          `(catalog ${catalogMentions[0]?.n}, this file ${jsMentions}). A body the regex cannot see\n` +
          `is a rank rule with no coverage and no failure — fix the matching, do not adjust this.`,
      ).toBe(catalogMentions[0]?.n)

      // ---- 1b. Nothing OUTSIDE a public function body reads the ladder. --
      // The discovery pass only reads `pg_proc`. A rank test written inline in a
      // policy, a CHECK constraint, a column default, a generated column, a view,
      // a trigger WHEN clause, an index predicate, or a function in another
      // schema would be invisible to every assertion in this file. None exist
      // today — so this asserts that ABSENCE, with its own control, exactly as
      // scripts/prod-verify-superadmin-log.mts asserts the absence of a rank arm.
      // An incidental absence that nothing checks is one migration from being a
      // silent gap.
      const elsewhere = (await sql`
        with hits as (
          select 'view '     || schemaname || '.' || viewname   as what from pg_views
            where definition ~* 'module_position_rank'
          union all
          select 'check constraint ' || conname from pg_constraint
            where contype = 'c' and pg_get_constraintdef(oid) ~* 'module_position_rank'
          union all
          select 'default on ' || adrelid::regclass::text from pg_attrdef
            where pg_get_expr(adbin, adrelid) ~* 'module_position_rank'
          union all
          select 'policy ' || schemaname || '.' || tablename || '.' || policyname from pg_policies
            where coalesce(qual, '') ~* 'module_position_rank'
               or coalesce(with_check, '') ~* 'module_position_rank'
          union all
          select 'index ' || indexrelid::regclass::text from pg_index
            where pg_get_expr(indpred, indrelid) ~* 'module_position_rank'
          union all
          select 'trigger ' || tgname from pg_trigger
            where not tgisinternal and pg_get_triggerdef(oid) ~* 'when .*module_position_rank'
          union all
          select 'function ' || n.nspname || '.' || p.proname from pg_proc p
            join pg_namespace n on n.oid = p.pronamespace
            where n.nspname not in ('public', 'pg_catalog', 'information_schema')
              and p.prosrc ~* 'module_position_rank'
        )
        select what from hits order by 1
      `) as unknown as { what: string }[]

      // The control for that negative: the catalogs it searched are populated.
      const catalogSizes = (await sql`
        select (select count(*) from pg_views)                          as views,
               (select count(*) from pg_constraint where contype = 'c')  as checks,
               (select count(*) from pg_attrdef)                         as defaults,
               (select count(*) from pg_policies)                        as policies
      `) as unknown as { views: number; checks: number; defaults: number; policies: number }[]
      const sizes = catalogSizes[0]
      expect(
        [Number(sizes?.views), Number(sizes?.checks), Number(sizes?.defaults), Number(sizes?.policies)].every(
          (n) => n > 20,
        ),
        `the catalogs searched for out-of-band rank readers came back near-empty ` +
          `(${JSON.stringify(sizes)}) — the absence asserted below would be vacuous`,
      ).toBe(true)
      expect(
        elsewhere.map((r) => r.what),
        `Something outside a public function body reads module_position_rank(). This file only\n` +
          `parses pg_proc, so these are rank rules with NO coverage — neither discovered, nor\n` +
          `parsed, nor snapshotted. Extend the parser to cover them before shipping:\n` +
          `  ${elsewhere.map((r) => r.what).join('\n  ')}`,
      ).toEqual([])

      const found = readers.map((f) => f.sig).sort()
      expect(
        found,
        `The set of functions reading module_position_rank() changed.\n` +
          `Every one of them turns a rank number into an authority decision, so a new\n` +
          `entry is a new rule and a missing entry is a rule that quietly went away.\n` +
          `Read the new function, work out what its comparison admits, then update\n` +
          `KNOWN_READERS in packages/db/src/rank-admission.test.ts.\n` +
          `  found:   ${found.join(', ')}\n` +
          `  known:   ${KNOWN_READERS.join(', ')}`,
      ).toEqual(KNOWN_READERS)

      // ---- 2. Every usage must parse, or this fails. --------------------
      const usages: Usage[] = []
      const problems: string[] = []
      for (const f of readers) {
        const p = parseFunction(f, all)
        usages.push(...p.usages)
        problems.push(...p.problems)
      }
      expect(
        problems,
        `A rank comparison this check cannot classify is a FAILURE, not a skip — a checker\n` +
          `that ignores what it does not understand goes green while covering less and less.\n` +
          `Teach the parser in packages/db/src/rank-admission.test.ts the new shape, and only\n` +
          `then decide whether the snapshot below should change:\n  ${problems.join('\n  ')}`,
      ).toEqual([])

      // CONTROL. The parser returning nothing would make the snapshot trivially
      // stable and the whole file decorative.
      expect(usages.length, 'the parser recognised no rank comparisons at all — it is broken')
        .toBeGreaterThanOrEqual(8)

      // ---- 3. Ask the DATABASE for every rank. --------------------------
      //
      // THE VOCABULARY IS DISCOVERED TOO, and it has to be, for the same reason
      // the rule set is. Assertion 1's whole argument is "a list here rots, so
      // read it from the catalog" — a hand-written position list would do
      // exactly what that argument condemns. Concretely: add
      // `when 'supervisor' then 3` to the 1-arg overload and every module gains
      // a rank-3 name that satisfies the `= 3` peer arm, every `>= 2` gate and
      // every `< 4` exemption. Against a declared vocabulary the map never
      // mentions it and CI stays green. So the ladder's OWN body is parsed for
      // its `when '<role>' then <n>` arms, per module block, and unioned in.
      const ladderSrc = (n: number) =>
        all.find((f) => f.sig === `module_position_rank(${n === 1 ? 'text' : 'text,text'})`)?.src ?? ''
      const genericFromLadder = [...ladderSrc(1).matchAll(/when\s+'([^']+)'\s+then\s+(\d+)/gi)].map((m) => m[1]!)
      // The hardcoded list stays, but demoted to a tripwire asserted against SQL
      // rather than used as the source — so a generic tier appearing or vanishing
      // fails loudly instead of silently changing what every module admits.
      expect(
        [...genericFromLadder].sort(),
        `The generic tier vocabulary in module_position_rank(text) no longer matches this file.\n` +
          `These four names carry ranks in EVERY module, so a change here moves every gate at once.`,
      ).toEqual([...GENERIC_VOCABULARY].sort())

      // Per-module blocks: `when '<module>' then case role when '<r>' then <n> ... end`.
      const perModuleLadder = new Map<string, string[]>()
      {
        const two = ladderSrc(2)
        const blocks = [...two.matchAll(/when\s+'([^']+)'\s+then\s+case\s+role\b/gi)]
        blocks.forEach((b, i) => {
          const start = b.index! + b[0].length
          const end = i + 1 < blocks.length ? blocks[i + 1]!.index! : two.length
          perModuleLadder.set(
            b[1]!,
            [...two.slice(start, end).matchAll(/when\s+'([^']+)'\s+then\s+(\d+)/gi)].map((m) => m[1]!),
          )
        })
      }

      const modules = [...new Set([...Object.keys(viewAsDeclarations), ...perModuleLadder.keys()])].sort()
      const positionsFor = (m: string) =>
        [
          ...new Set([
            ...Object.keys(viewAsDeclarations[m]?.positions ?? {}),
            ...(perModuleLadder.get(m) ?? []),
            ...genericFromLadder,
          ]),
        ].sort()
      const pairs: { module: string; position: string }[] = []
      for (const m of modules) {
        for (const p of positionsFor(m)) pairs.push({ module: m, position: p })
      }
      const rankRows = (await sql`
        select v.m as module, v.p as position, public.module_position_rank(v.m, v.p) as rank
        from (values ${sql(pairs.map((x) => [x.module, x.position]))}) as v(m, p)
      `) as unknown as { module: string; position: string; rank: number }[]
      const rankOf = new Map(rankRows.map((r) => [`${r.module}/${r.position}`, Number(r.rank)]))
      // Every pair must have come back BY KEY, not merely in the right count: a
      // key mismatch would otherwise be papered over by a default and quietly
      // shift what the map claims a gate admits.
      const missingRanks = pairs.filter((p) => !rankOf.has(`${p.module}/${p.position}`))
      expect(
        missingRanks.map((p) => `${p.module}/${p.position}`),
        'the database returned no rank for these positions',
      ).toEqual([])
      // Every module literal the parser resolved must be a module that exists.
      // A garbage literal — the shape concatenated dynamic SQL produces — is
      // non-null, so it matches no module and the per-module loop below would
      // silently drop that gate from EVERY admission table: a gate the file had
      // quietly decided admits nobody. Fail instead.
      const unknownModules = [
        ...new Set(
          usages
            .flatMap((u) => u.tests)
            .flatMap((t) => (t.kind === 'threshold' && t.module !== null ? [t.module] : []))
            .filter((m) => !modules.includes(m)),
        ),
      ].sort()
      expect(
        unknownModules,
        `A rank gate resolved to a module key that does not exist. It would be dropped from every\n` +
          `per-module table below and appear to gate nothing:\n  ${unknownModules.join('\n  ')}`,
      ).toEqual([])

      const rank = (m: string, p: string): number => {
        const r = rankOf.get(`${m}/${p}`)
        if (r === undefined) throw new Error(`no rank for ${m}/${p}`)
        return r
      }

      // CONTROL. A ladder collapsed to a single value (a stubbed or dropped
      // function returning 0 for everything) must not read as "nothing changed".
      const distinct = [...new Set(rankRows.map((r) => Number(r.rank)))].sort((a, b) => a - b)
      expect(distinct, 'the ladder is degenerate — every rank came back the same').toEqual([0, 1, 2, 3, 4])

      // ---- The gate closure: which tables a rank test can open. ---------
      // Anything whose body calls a rank reader inherits its rank tests, and so
      // on to a fixpoint. This is what turns "admits cashier" into "the cashier
      // reads sal_earnings_ledger", and it is docs/13's piece 1.
      const gateOf = new Map<string, { tests: RankTest[]; via: string[] }>()
      for (const f of readers) gateOf.set(f.name, { tests: [], via: [] })
      for (const u of usages) {
        const name = u.fn.replace(/\(.*$/, '')
        gateOf.get(name)!.tests.push(...u.tests)
      }
      // A real fixpoint: every function is re-examined on every pass, and its
      // inherited set is UNIONED rather than written once. The first draft
      // skipped anything already recorded (`if (gateOf.has(f.name)) continue`),
      // which froze a function on whichever gate happened to be known first — so
      // a wrapper calling gate A (known in pass 1) and gate B (promoted in pass
      // 2) kept only A's tests. Nothing was mis-attributed today, but only
      // because the catalog's `order by 1` happens to list callees before
      // callers; the closure must not depend on the database's collation.
      const rankTestKey = (t: RankTest) =>
        t.kind === 'relative' ? 'relative' : `${t.op}|${t.value}|${t.module ?? '*'}`
      for (let pass = 0; pass < 24; pass++) {
        let grew = false
        for (const f of all) {
          if (f.name === 'module_position_rank' || readers.some((r) => r.name === f.name)) continue
          const hits = [...gateOf.keys()].filter((g) => g !== f.name && new RegExp(`\\b"?${g}"?\\s*\\(`, 'i').test(f.src))
          if (hits.length === 0) continue
          // Inherit only the tests this caller actually instantiated, then clear
          // `via` so the next level down inherits them unconditionally.
          const inherited = hits.flatMap((h) =>
            gateOf
              .get(h)!
              .tests.filter((t) => t.kind !== 'threshold' || t.via === undefined || t.via === f.name)
              .map((t): RankTest => (t.kind === 'threshold' ? { ...t, via: undefined } : t)),
          )
          const prev = gateOf.get(f.name) ?? { tests: [], via: [] }
          const merged = [...prev.tests]
          for (const t of inherited) {
            if (!merged.some((x) => rankTestKey(x) === rankTestKey(t))) merged.push(t)
          }
          const mergedVia = [...new Set([...prev.via, ...hits])].sort()
          if (merged.length !== prev.tests.length || mergedVia.length !== prev.via.length) {
            gateOf.set(f.name, { tests: merged, via: mergedVia })
            grew = true
          }
        }
        if (!grew) break
      }

      // `cmd` is recorded, not just the table. Adding a rank-gated INSERT or
      // DELETE policy to a table already listed for SELECT is a real widening —
      // rank now decides writes where it decided reads — and a table-only key
      // renders that as no diff at all.
      const policyRows = (await sql`
        select schemaname, tablename, cmd,
               coalesce(qual, '') || ' ' || coalesce(with_check, '') as expr
        from pg_policies
        where schemaname in ('public', 'storage')
      `) as unknown as { schemaname: string; tablename: string; cmd: string; expr: string }[]
      expect(policyRows.length, 'no policies came back — the gated-tables section would be vacuous')
        .toBeGreaterThan(50)

      const gatedTables = new Map<string, Set<string>>()
      for (const g of gateOf.keys()) gatedTables.set(g, new Set())
      for (const row of policyRows) {
        for (const g of gateOf.keys()) {
          if (new RegExp(`\\b"?${g}"?\\s*\\(`, 'i').test(row.expr)) {
            const t = `${row.schemaname === 'storage' ? 'storage.' : ''}${row.tablename}`
            gatedTables.get(g)!.add(`${t} (${row.cmd.toLowerCase()})`)
          }
        }
      }

      // ---- Render the map. ----------------------------------------------
      const L: string[] = []
      L.push('# Rank admission map')
      L.push('')
      L.push('**GENERATED — do not edit by hand.** Written by `packages/db/src/rank-admission.test.ts`')
      L.push('from the live local database. Regenerate with')
      L.push('`pnpm --filter @platform/db exec vitest run src/rank-admission.test.ts -u`, and read the diff')
      L.push('as a security question: *did I mean to change who gets in?*')
      L.push('')
      L.push('One ladder, `module_position_rank()`, is read by the functions in the first table below.')
      L.push('Each turns a rank number into an authority decision, so moving any number in the ladder')
      L.push('moves every one of these answers at once. This file is the record of what those answers')
      L.push('currently are; the test fails when they change.')
      L.push('')
      L.push('Four conventions worth knowing before reading it:')
      L.push('')
      L.push('- **A gate whose module cannot be resolved from a call site is listed under EVERY')
      L.push('  module.** Such a gate really can be invoked with any `module_key`, so listing it')
      L.push('  narrowly would understate its reach. Where the module CAN be read off the call site')
      L.push('  (`module_caller_covers_rank` is instantiated with a literal by four wrappers) it is')
      L.push('  listed only under those modules — note that the function itself is still')
      L.push('  `EXECUTE`-granted to `authenticated`, so that narrowing describes the callers that')
      L.push('  exist today, not a restriction the database enforces.')

      L.push('- **`director` / `coordinator` / `lead` / `position` appear in every module.** They are the')
      L.push('  generic vocabulary the 2-arg ladder falls back to, so they carry ranks 4/3/2/1 even in')
      L.push('  modules whose own positions are all rank 0. `module_position_rank(\'sample\', \'lead\')` is 2.')
      L.push('- **"Satisfies" is not the same as "is granted something".** For most gates the two')
      L.push('  coincide. For `module_roles_guard_last_director` they are opposites: satisfying its')
      L.push('  `rank < 4` arm means the guard EXEMPTS you, and satisfying `rank >= 4` means you are one')
      L.push('  of the Directors it refuses to let a module run out of. Read the gate, not the verb.')
      L.push('- **A gate can have non-rank arms, and this map does not track them.**')
      L.push('  `sal_can_operate_location` also admits by the role NAME `cashier`, and')
      L.push('  `module_caller_covers_rank` short-circuits on `is_org_admin`. Those are deliberately out')
      L.push('  of scope: they do not move when the ladder moves, which is the only thing this file')
      L.push('  watches. So **nobody** in a rank column means "no rank opens this", never "nobody can')
      L.push('  get in".')
      L.push('')
      L.push('## The rules that read the ladder')
      L.push('')
      L.push('| function | comparison | resolves to | note |')
      L.push('| --- | --- | --- | --- |')
      for (const u of [...usages].sort((a, b) => byCodeUnit(a.fn, b.fn) || byCodeUnit(a.raw, b.raw))) {
        const resolved = [...new Set(u.tests.map((t) => `${describeTest(t)}${t.kind === 'threshold' && t.module ? ` (${t.module})` : ''}`))]
        L.push(`| \`${u.fn}\` | \`${u.raw.replace(/\|/g, '\\|')}\` | ${resolved.join('; ')} | ${u.note} |`)
      }
      L.push('')
      L.push('## What each gate guards')
      L.push('')
      L.push('Every function that reaches a rank test, directly or by calling something that does, with')
      L.push('the tables whose RLS policies name it, **one row per table and command**. A new row here')
      L.push('means a rank number now decides access it did not decide before — which is the whole')
      L.push('signal, so it gets its own line in the diff rather than one more word inside a long cell.')
      L.push('')
      L.push('Rows reading _no policy_ are reached from triggers or SECURITY DEFINER functions instead.')
      L.push('That is not the same as harmless: `cls_survey_results`, `sd_reveal_matches` and')
      L.push('`sal_guard_bill` RETURN or GATE data, they are not plumbing. GRANTs and column privileges')
      L.push('are out of scope here entirely.')
      L.push('')
      L.push('| gate | rank test(s) | reached via | guards |')
      L.push('| --- | --- | --- | --- |')
      for (const name of [...gateOf.keys()].sort()) {
        const g = gateOf.get(name)!
        const tables = [...gatedTables.get(name)!].sort()
        const tests = [...new Set(g.tests.map(describeTest))].sort()
        const viaCell = g.via.length ? g.via.map((v) => `\`${v}\``).join(', ') : 'direct'
        if (tables.length === 0) {
          if (g.via.length > 0) continue // an intermediate nothing names: not a gate anyone reaches
          L.push(`| \`${name}\` | ${tests.join('; ') || '—'} | ${viaCell} | _no policy — triggers/functions only_ |`)
          continue
        }
        for (const t of tables) L.push(`| \`${name}\` | ${tests.join('; ') || '—'} | ${viaCell} | ${t} |`)
      }
      L.push('')
      L.push('## Per module: the ladder, and who satisfies each rank test')

      const relativeGateNames = [
        ...new Set(usages.filter((u) => u.tests.some((t) => t.kind === 'relative')).map((u) => u.fn.replace(/\(.*$/, ''))),
      ].sort()

      // Keyed on the GATE CLOSURE, not on the raw usages, so each row names the
      // function policies actually reference and carries the tables behind it.
      // That is what makes a failure diff legible: "cashier now satisfies
      // sal_can_manage_location, which guards sal_earnings_ledger" rather than
      // "a number in module_caller_covers_rank moved".
      const thresholds = [...gateOf.entries()].flatMap(([name, g]) =>
        g.tests
          .filter((t): t is Extract<RankTest, { kind: 'threshold' }> => t.kind === 'threshold')
          .map((t) => ({
            name,
            t,
            // Table names only here, command suffixes stripped and deduped: this
            // cell exists to make the POSITION diff legible ("cashier now
            // satisfies the gate on sal_earnings_ledger"), while the per-command
            // detail lives one row per line in the section above.
            tables: [...new Set([...(gatedTables.get(name) ?? [])].map((x) => x.replace(/ \(\w+\)$/, '')))].sort(),
          })),
      )
      for (const m of modules) {
        const positions = positionsFor(m)
        const ranks = positions.map((p) => rank(m, p))
        L.push('')
        L.push(`### ${m}`)
        L.push('')
        const byRank = new Map<number, string[]>()
        for (const p of positions) {
          const r = rank(m, p)
          byRank.set(r, [...(byRank.get(r) ?? []), p])
        }
        L.push(
          'Ladder: ' +
            [...byRank.keys()]
              .sort((a, b) => b - a)
              .map((r) => `**${r}** ${byRank.get(r)!.sort().join(', ')}`)
              .join(' · '),
        )
        L.push('')
        L.push('| gate | rank test | positions satisfying it | which lets them at |')
        L.push('| --- | --- | --- | --- |')
        const seen = new Set<string>()
        for (const { name, t, tables } of [...thresholds].sort(
          (a, b) => byCodeUnit(a.name, b.name) || byCodeUnit(describeTest(a.t), describeTest(b.t)),
        )) {
          if (t.module !== null && t.module !== m) continue
          const key = `${name}|${describeTest(t)}`
          if (seen.has(key)) continue
          seen.add(key)
          const list = positions.filter((p) => admits(t, rank(m, p)))
          L.push(
            `| \`${name}\` | ${describeTest(t)} | ${list.length ? list.join(', ') : '**nobody**'} | ` +
              `${tables.length ? tables.join(', ') : '_no policy names it — reached through triggers/functions_'} |`,
          )
        }
        L.push('')
        // Derived, not hardcoded: a third relative gate would otherwise make this
        // sentence assert something false while the suite stayed green.
        L.push(
          `_Relative gates (${relativeGateNames.map((n) => `\`${n}\``).join(', ')}) read straight off the ` +
            'ladder above: a position outranks exactly those below it._',
        )
      }
      L.push('')

      await expect(L.join('\n') + '\n').toMatchFileSnapshot(SNAPSHOT)
    } finally {
      await sql.end()
    }
  })
})
