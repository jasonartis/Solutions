// Per-person data browser (docs/13, founder decision 2026-08-02) — the
// declaration layer and its completeness check.
//
// THE QUESTION THIS ANSWERS, AND HOW IT DIFFERS FROM VIEW-AS. These are two
// tools answering two different questions, and neither is a weaker version of
// the other (founder, 2026-08-02):
//
//   view-as      — "what does THIS PERSON see?"  Curated by a surface
//                  declaration, deliberately NARROWER than the viewer's own
//                  reach (survey answers and reviewer identity are kept off it
//                  on purpose).
//   data browser — "what do I HOLD about this person?"  Everything the VIEWER
//                  may read, bounded by RLS and nothing else. A professor
//                  therefore WOULD see survey answers here — legitimately,
//                  because they can already read them.
//
// A consequence worth stating, because it inverts the sequencing worry in
// docs/13: the data browser needs NO surface declarations, so it works for
// every module on day one and never renders blank.
//
// THE KEYSTONE IS THE SAME AS VIEW-AS: there is no new database read path.
// Every query runs on the CALLER's ordinary RLS-enforced client, so a
// declaration can only ever decide WHERE TO LOOK — never widen what comes
// back. A table nobody may read simply returns nothing.
//
//   HARD RULE: no code on this path may call `.rpc()` or a service-role
//   client. The app-layer superadmin gate is a UI gate over data the caller
//   can already reach through PostgREST; that is what makes it safe for it not
//   to be a security boundary. One SECURITY DEFINER call turns it into one,
//   and the argument collapses. See docs/03 #19.
//
// ONE QUERY SHAPE ONLY: rows that REFERENCE the person (founder, 2026-08-02,
// answering an explicit over-engineering worry). "Rows they can SEE" is what
// view-as already does, curated — building it here would be duplicating
// view-as badly. Two tools, two questions, no overlap.
//
// THE FAILURE DIRECTION IS DELIBERATE. A missing declaration makes the browser
// report too LITTLE (annoying, and the completeness check below catches it); it
// can never make it report too much, because RLS is the ceiling either way.
// That is the same asymmetry docs/13 relies on when it argues against
// generating RLS from a declaration.

/**
 * A person named only through a CHILD row — `sd_pairings` names participants,
 * and a participant row names the user. Resolved in two steps, both on the
 * caller's own client, so the intermediate lookup is RLS-bounded too.
 *
 * These are exactly the rows a naive "scan the catalog for columns referencing
 * auth.users" pass MISSES: the tables below have no person column at all, and
 * they hold some of the most privacy-loaded rows on the platform.
 */
export type PersonVia = {
  /** Column on THIS table holding the child row's id. */
  column: string
  /** The child table one hop away. */
  lookupTable: string
  /** The child table's primary key. */
  lookupIdColumn: string
  /**
   * The child table's own person columns. Empty when the child does not name
   * the person either and the path continues through `then`.
   */
  lookupPersonColumns: readonly string[]
  /**
   * ONE MORE HOP, when the child table names the person no more directly than
   * this one does.
   *
   * Added after a review found a real gap that a single hop structurally
   * cannot express: `sal_bills` has no customer column at all — only
   * `appointment_id` — so the path to a paying customer is
   * `sal_bills.appointment_id -> sal_appointments.customer_id ->
   * sal_customers.user_id`. With one hop the browser showed a salon customer
   * their appointments and ZERO bills, which reads as "we hold no billing
   * record for you" rather than "we could not follow the link". Note this is
   * NOT the documented walk-in gap: it hit customers who DO have an account.
   */
  then?: PersonVia
}

/**
 * One table that can hold rows about — or naming — a person.
 *
 * "References the person" is read BROADLY and on purpose: a column saying the
 * person DID something (`graded_by`, `created_by`, `invited_by`) counts exactly
 * as much as one saying a row is ABOUT them (`student_id`, `about_user_id`).
 * Both are things the platform holds that name them, which is the question.
 */
export type PersonLookup = {
  table: string
  label: string
  /**
   * Columns on THIS table naming a person. A row matches if ANY of them equals
   * the subject. May be empty when every link is indirect (`via`).
   */
  personColumns: readonly string[]
  via?: readonly PersonVia[]
  /**
   * Tenant column, so a query can be bounded to one org. `null` for the
   * platform-wide identity table, which has none.
   */
  orgColumn: string | null
  orderBy?: { column: string; ascending?: boolean }
  limit?: number
  /** Shown with the section when the rows need interpreting. */
  note?: string
}

/**
 * A person-referencing table the browser deliberately never queries.
 *
 * Kept as a list rather than a silent absence for the same reason view-as keeps
 * `excluded`: an unexplained omission is indistinguishable from an
 * unconsidered one, and the completeness check needs somewhere to point.
 */
export type PersonRefOmission = {
  table: string
  /** The person columns this entry accounts for. */
  columns: readonly string[]
  why: string
}

/**
 * A table holding rows about the person that NO viewer may read — not staff,
 * not an org owner, not the platform superadmin.
 *
 * This exists because of an honesty problem specific to this feature. The
 * browser answers "what do you hold about me?"; a table that silently returns
 * zero rows reads as "we hold nothing", which for `sd_notes` would be false.
 * Declaring it lets the UI say "rows about this person exist here and nobody
 * but their author can read them" — the accurate answer.
 *
 * A SEPARATE claim from an omission, and separately falsifiable: the test suite
 * asserts a privileged reader really does get nothing, so the label cannot rot
 * into a hiding place for a table someone simply chose not to render.
 */
export type UnreadablePersonTable = {
  table: string
  columns: readonly string[]
  why: string
}

export type DataBrowserDeclaration = {
  lookups: readonly PersonLookup[]
  omitted: readonly PersonRefOmission[]
  neverReadable: readonly UnreadablePersonTable[]
}

/** Identity helper so a declaration is written the same way everywhere. */
export function declareDataBrowser(decl: DataBrowserDeclaration): DataBrowserDeclaration {
  return decl
}

// ---------------------------------------------------------------------------
// Completeness
// ---------------------------------------------------------------------------

export type DataBrowserProblem = { scope: string; problem: string }

/** Walk a via chain, checking each hop is well-formed and terminates. */
function checkVia(table: string, via: PersonVia, say: (p: string) => void, depth = 0) {
  const where = `lookup ${table} via ${via.column}`
  if (!via.column.trim()) say(`lookup ${table} has a via entry with no column`)
  if (!via.lookupTable.trim()) say(`${where} names no lookup table`)
  if (!via.lookupIdColumn.trim()) say(`${where} names no lookup id column`)
  // A hop must EITHER name a person or continue. A chain that does neither
  // resolves to nothing and makes its section permanently, silently empty.
  if (via.lookupPersonColumns.length === 0 && !via.then) {
    say(`${where} names no person columns on ${via.lookupTable} and does not continue via \`then\``)
  }
  // Bounded so a hand-written chain cannot become an unreadable query plan;
  // three hops covers the deepest real path (sal_bill_items -> bill ->
  // appointment -> customer) with room to spare.
  if (depth >= 3) {
    say(`${where} chains more than 3 hops — flatten it or denormalize the person column`)
    return
  }
  if (via.then) checkVia(table, via.then, say, depth + 1)
}

/**
 * Structural checks on one declaration. The REAL completeness check — that
 * every person-referencing column in the live database is accounted for — is
 * catalog-driven and lives in `packages/db/src/data-browser-coverage.test.ts`,
 * because the authority for "which columns name a person" is the schema, not
 * anything written in TypeScript. This function only catches the ways a
 * declaration can be internally malformed.
 */
export function dataBrowserCompleteness(
  scope: string,
  decl: DataBrowserDeclaration,
): DataBrowserProblem[] {
  const problems: DataBrowserProblem[] = []
  const say = (problem: string) => problems.push({ scope, problem })

  // A table belongs to exactly one list, or "is this queried?" is ambiguous.
  const seen = new Map<string, string>()
  const claim = (table: string, list: string) => {
    const prior = seen.get(table)
    if (prior) say(`table ${table} appears in both ${prior} and ${list}`)
    else seen.set(table, list)
  }
  for (const l of decl.lookups) claim(l.table, 'lookups')
  for (const o of decl.omitted) claim(o.table, 'omitted')
  for (const u of decl.neverReadable) claim(u.table, 'neverReadable')

  for (const l of decl.lookups) {
    if (l.personColumns.length === 0 && (l.via ?? []).length === 0) {
      say(`lookup ${l.table} names no person columns and no via path — it can never match`)
    }
    for (const v of l.via ?? []) checkVia(l.table, v, say)
    if (l.limit !== undefined && l.limit <= 0) say(`lookup ${l.table} declares a non-positive limit`)
  }

  for (const o of decl.omitted) {
    if (o.columns.length === 0) say(`omission ${o.table} accounts for no columns`)
    if (!o.why.trim()) say(`omission ${o.table} carries no reason`)
  }
  for (const u of decl.neverReadable) {
    if (u.columns.length === 0) say(`neverReadable ${u.table} accounts for no columns`)
    if (!u.why.trim()) say(`neverReadable ${u.table} carries no reason`)
  }

  return problems
}

/**
 * Every `table.column` pair this declaration accounts for, in ANY of the three
 * lists. The catalog test subtracts this from the live schema's real set of
 * person-referencing columns; whatever is left is undeclared and fails.
 */
export function dataBrowserCoverage(decl: DataBrowserDeclaration): Set<string> {
  const covered = new Set<string>()
  for (const l of decl.lookups) {
    for (const c of l.personColumns) covered.add(`${l.table}.${c}`)
  }
  for (const o of decl.omitted) {
    for (const c of o.columns) covered.add(`${o.table}.${c}`)
  }
  for (const u of decl.neverReadable) {
    for (const c of u.columns) covered.add(`${u.table}.${c}`)
  }
  return covered
}

/**
 * Every `table.column` pair reached INDIRECTLY, as `table.column -> child`.
 * Not part of coverage (these columns are not person references themselves);
 * reported by the catalog test's second tier so a newly-added child link can be
 * triaged rather than silently missed.
 */
export function dataBrowserViaLinks(decl: DataBrowserDeclaration): Set<string> {
  const links = new Set<string>()
  const walk = (table: string, via: PersonVia) => {
    links.add(`${table}.${via.column}`)
    if (via.then) walk(via.lookupTable, via.then)
  }
  for (const l of decl.lookups) {
    for (const v of l.via ?? []) walk(l.table, v)
  }
  return links
}

/**
 * Every declared hop as `fromTable.column -> lookupTable`, so a test can check
 * the hop points where the schema's foreign key actually points.
 *
 * `dataBrowserViaLinks` only proves the column IS some FK to some
 * person-bearing table; it discards the target. A hop naming the WRONG target
 * table (both `sal_bills` and `sal_customers` have an `id`) would pass that
 * check and then silently return zero rows forever — the exact
 * indistinguishable-from-"we hold nothing" failure this feature exists to
 * prevent. Gap found by adversarial review, 2026-08-03.
 */
export function dataBrowserViaTargets(decl: DataBrowserDeclaration): Map<string, string> {
  const targets = new Map<string, string>()
  const walk = (table: string, via: PersonVia) => {
    targets.set(`${table}.${via.column}`, via.lookupTable)
    if (via.then) walk(via.lookupTable, via.then)
  }
  for (const l of decl.lookups) {
    for (const v of l.via ?? []) walk(l.table, v)
  }
  return targets
}
