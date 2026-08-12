// ENGAGEMENT MONITORING, PHASE 2 — the activity vocabulary and the one write
// path that every module shares.
//
// Spec: docs/17-engagement-monitoring.md. Table: `public.activity_events`
// (`supabase/migrations/20260810010000_activity_events.sql`), whose header
// carries the security reasoning this file deliberately does not repeat.
//
// ---------------------------------------------------------------------------
// THIS FILE IS THE ANSWER TO "WHAT COUNTS AS ENGAGEMENT?" AND IT IS MEANT TO BE
// EDITED.
// ---------------------------------------------------------------------------
// Founder decision 1, 2026-08-10, had two halves and the second one shaped this
// file: "I am not sure. Maybe just looking at a page is okay. For now I will go
// with your suggestion but MAKE IT EASY TO CHANGE IT TO INCLUDE MORE MUNDANE
// ACTIVITY IN THE FUTURE."
//
// So the list below is DATA, not schema. `activity_events.action` is free text
// with no CHECK and no FK to a vocabulary table, which means:
//   * adding an action — including switching page views on — is one line here
//     plus one call site. NO MIGRATION.
//   * removing one is one line here, and history already recorded keeps its
//     meaning rather than becoming unreadable.
//   * a typo cannot invent a silent new category, because `ActivityAction` is a
//     union derived from this object and `pnpm typecheck` checks every call site.
//
// AND SUBTRACTING NOW WORKS BACKWARDS AS WELL AS FORWARDS — the founder's ask of
// 2026-08-11, which the first draft only half-delivered. Adding was always cheap;
// removing an action used to stop future recording while every occurrence already
// counted stayed baked into the permanent tally forever, because
// `activity_rollup` held one running total per (person, org, module) and did not
// remember what it was made of. `action` is now part of that table's primary key,
// so "this no longer counts as active" is a read-time decision — drop that row
// from the sum — applied over ALL history, with no migration and nothing
// destroyed. Reasoning in full: the rollup section of
// supabase/migrations/20260810010000_activity_events.sql.
//
// AND THE EXCLUSIONS ARE RECORDED BESIDE THE INCLUSIONS, ON PURPOSE. A list of
// what counts tells the next reader nothing about what was considered and
// rejected — so the same argument gets re-run, or worse, a previously-rejected
// action gets added because nobody knew it had been weighed. `ACTIVITY_EXCLUDED`
// below is that record, and it is the first thing to read before adding anything.
//
// ---------------------------------------------------------------------------
// KEPT FREE OF `@supabase/supabase-js`, deliberately.
// ---------------------------------------------------------------------------
// `packages/platform` has ZERO runtime dependencies so it stays importable from
// both `apps/web` and `apps/worker` (see `tenancy.ts`). The client is therefore
// structurally typed, exactly as `export.ts` types `ExportDb`.

/** The six real modules that can record activity. Matches `ModuleManifest.key`. */
export type ActivityModuleKey =
  | 'classroom'
  | 'nail-salon'
  | 'matchmaking'
  | 'speed-dating'
  | 'synagogue-schedules'
  | 'visual-messaging'

/**
 * THE CURATED LIST — founder-approved 2026-08-10.
 *
 * Naming convention is `<noun>.<past-tense-verb>`, so the action reads as a fact
 * about something that happened rather than as the name of the function that
 * happened to record it. Function names get refactored; a log's vocabulary must
 * not move underneath rows already written.
 */
export const ACTIVITY_ACTIONS = {
  classroom: [
    'submission.file_uploaded', // turned in homework — the clearest student signal
    'survey.answered',
    'peer_grade.submitted',
    'review.commented',
    'grade.submitted', // a GA grading a submission
    'grade.published',
    'exam.scores_saved',
    'exam.published',
    'exam_paper.uploaded',
    'homework.created',
    'exam.created',
    'survey.created',
    'announcement.posted',
  ],
  'nail-salon': [
    'appointment.booked_by_customer', // the module's flagship action
    'appointment.booked_by_staff',
    'walk_in.added',
    'bill.created',
    'bill.paid', // the founder's own "checking out a bill" example
    'expense.added',
    'shopping_item.purchased',
  ],
  matchmaking: [
    'interest.expressed', // strongest signal for a single
    'interest.withdrawn',
    'answer.saved', // debounced per question per day — see ACTIVITY_DEBOUNCED
    'question.created',
    'question.approved',
    'question.rejected',
    'scores.recomputed', // ADMIN-INVOKED PATH ONLY — see the note below
    'group.created',
    'group.member_added',
    'group.member_removed',
    'matchmaker.assigned',
    'matchmaker.unassigned',
  ],
  'speed-dating': [
    'event.registered', // strongest signal for a participant
    'round.interest_marked', // the core act the module exists for
    'event.created',
    'pairing_round.run',
    'matches.revealed',
    'report.reviewed',
  ],
  'synagogue-schedules': [
    'week.published', // the best single "did their job" signal for this module
    'line.created',
    'override.created',
  ],
  'visual-messaging': [
    'drawing.replied', // the core "posted content" action
    'conversation.created',
    // The five moderator actions, all INCLUDED — founder decision, 2026-08-11:
    // "even small actions still mean they are active". Moderating is the way a
    // moderator uses this module; excluding them would mean the only people who
    // ever look engaged in visual-messaging are the ones who draw.
    'flag.reviewed',
    'layer.tombstoned',
    'layer.restored',
    // `setBranchFrozen` takes a boolean, so it is TWO actions here rather than
    // one — same shape as tombstoned/restored above, and for the same reason:
    // freezing a runaway thread and releasing it are different decisions, and a
    // single `branch.freeze_toggled` would record neither. It was in NEITHER
    // list in this file's first draft — not included, not excluded — which is
    // exactly the silent omission ACTIVITY_EXCLUDED exists to make impossible.
    'branch.frozen',
    'branch.unfrozen',
  ],
} as const satisfies Record<ActivityModuleKey, readonly string[]>

/** Every action any module may record. */
export type ActivityAction =
  (typeof ACTIVITY_ACTIONS)[ActivityModuleKey][number]

/** The actions a given module may record — so a classroom key cannot take a salon action. */
export type ActivityActionFor<K extends ActivityModuleKey> =
  (typeof ACTIVITY_ACTIONS)[K][number]

/**
 * DELIBERATELY NOT RECORDED — read this before adding anything above.
 *
 * Three categories, and the middle one is the one that matters most: a write
 * caused by READING is not engagement, and logging it would silently redefine
 * "engaged" as "loaded a page". That is exactly the noise docs/17 §11 warned
 * about, and it is invisible once shipped, because the resulting dashboard looks
 * healthy rather than broken.
 */
export const ACTIVITY_EXCLUDED: ReadonlyArray<{
  module: ActivityModuleKey
  what: string
  why: string
}> = [
  // --- read-triggered writes: the category that must never be included -------
  {
    module: 'classroom',
    what: 'getOrCreateSubmission',
    why: 'Fires from OPENING a homework page, not from doing work. A page-view event in disguise.',
  },
  {
    module: 'matchmaking',
    what: 'mm_ensure_answer (RPC, called from page.tsx on every load)',
    why: 'A write caused purely by viewing the page, lazily seeding a default row.',
  },

  // --- system/worker-driven: no human intent behind them --------------------
  {
    module: 'matchmaking',
    what: 'recompute invoked by the matchmaking.rescore worker tick',
    why:
      'Same function as the admin action, but the worker path has no acting user. This is why the ' +
      'record call lives at the SERVER ACTION call site and never inside the shared function.',
  },
  {
    module: 'speed-dating',
    what: 'promoteNextWaitlisted',
    why: 'Capacity management, usually system-driven rather than a human decision.',
  },

  // --- config / housekeeping toggles: administration, not use ---------------
  {
    module: 'classroom',
    what: 'setSubmissionsHiddenFrom, setSurveyResultsVisible, setRevealUntil, unpublishMaterial, deletes',
    why: 'Visibility and retention toggles. Founder decision 1: toggles read as administration, not use.',
  },
  {
    module: 'nail-salon',
    what: 'setServiceActive, setPromotionActive, addShoppingItem, cancelShoppingItem, setWorkerSchedule, time-off edits',
    why: 'Catalog/promo toggles, list housekeeping and infrequent HR upkeep — not "used the platform today".',
  },
  {
    module: 'speed-dating',
    what: 'setEventState transitions, saveProfileCard, saveNote, blockUser/unblockUser',
    why:
      'Lifecycle transitions collapse into the event actions already recorded; profile edits and private ' +
      'notes are low-stakes self-edits that can fire on autosave.',
  },
  {
    module: 'synagogue-schedules',
    what: 'unpublishWeek, deletes, requestExport',
    why: 'Corrections and cleanup. Export is one click and trivially repeated (double-clicks, retries).',
  },
  {
    module: 'visual-messaging',
    what: 'toggleReaction',
    why:
      'THE CANONICAL NOISE CASE: high frequency, low value, trivially spammed by clicking. Explicitly ' +
      'what docs/17 §11 warned about.',
  },
  {
    module: 'visual-messaging',
    what: 'uploadImageStamp, setJoinPolicy',
    why: 'An intermediate plumbing step with no message-level result yet, and a settings toggle.',
  },

  // --- excluded for a privacy reason, not an engagement one ------------------
  {
    module: 'speed-dating',
    what: 'fileReport',
    why:
      'A SAFETY REPORT, excluded on privacy grounds rather than because it is noise (founder decision 1, ' +
      '2026-08-10; re-confirmed with a stronger reason 2026-08-11). It is a real, deliberate act — but ' +
      '"who filed a harassment report and when" has near-zero outreach value and real sensitivity, and it ' +
      'does not belong in a table browsed in bulk to decide who to email. ' +
      'THE DECIDING ARGUMENT IS A PLATFORM ONE, NOT A SPEED-DATING ONE (founder, 2026-08-11): this ' +
      'vocabulary has to generalise across all six modules and every module built after them, and safety ' +
      'reporting has NO parallel in the other five. Carving a per-module privacy exception into a shared ' +
      'engagement log means every future module must re-derive whether it has one too — so the rule is ' +
      'that this log records ordinary use, and anything needing a disclosure decision stays out of it. ' +
      'NOTE THE ASYMMETRY THIS CREATES, DELIBERATELY: the STAFF side, `reviewReport`, IS recorded as ' +
      'report.reviewed. Triaging a report is a job someone was assigned; filing one is something that ' +
      'happened TO them. ' +
      'AND NOTE WHAT IT COSTS, so the console author knows rather than discovers: somebody whose only act ' +
      'in a month was reporting harassment reads here as fully disengaged, so an ordinary ' +
      '"we miss you, come back" message would go to exactly the person who had a bad experience and told ' +
      'you. That blind spot belongs to whatever builds outreach on top of this table; it cannot be fixed ' +
      'by recording the report.',
  },
]

/**
 * Actions that collapse to one event per window, with the key each one uses.
 * Recorded here so the debounce is visible beside the vocabulary rather than
 * buried at a call site.
 */
export const ACTIVITY_DEBOUNCED: ReadonlyArray<{
  action: ActivityAction
  window: string
  why: string
}> = [
  {
    action: 'answer.saved',
    window: 'one per question per day (`<questionId>:<YYYY-MM-DD>`)',
    why:
      'Founder decision 1, 2026-08-10. A single dragging a slider must not out-count somebody who turned ' +
      'in an assignment; the questionnaire is answered over a sitting, not once.',
  },
]

/**
 * Minimal structural view of the Supabase client, so this package keeps its zero
 * runtime dependencies. Mirrors `ExportDb` in `export.ts`.
 */
export type ActivityDb = {
  from: (table: string) => any
}

export type ActivityEntry<K extends ActivityModuleKey> = {
  moduleKey: K
  action: ActivityActionFor<K>

  /**
   * The org the act happened in. Supply `orgId` when the call site already has
   * it; otherwise supply `orgSlug` and this helper resolves it in one indexed
   * query. Most module actions have only the slug — they take it as their first
   * argument and never resolve it, because their tables derive `org_id` from a
   * scope-sync trigger instead.
   *
   * NOTE THE PLACEHOLDER TRAP: do NOT pass `DERIVED_SCOPE_PLACEHOLDER` here the
   * way neighbouring inserts do. `activity_events` has no scope-sync trigger and
   * derives no tenancy; the guard raises a named error if it sees the
   * all-zeroes uuid, precisely because copying the idiom from an adjacent action
   * is the likely mistake.
   */
  orgId?: string
  orgSlug?: string

  /**
   * The `module_scope_nodes` id the act happened UNDER — the class, the salon
   * location, the event. Not the actor's grant scope: those are different
   * questions, and the row wants the former (a manager scoped to Downtown wants
   * acts that happened at Downtown, however broadly the actor is granted).
   * Null/omitted is ordinary and means "not scoped".
   */
  scopeRef?: string | null

  /**
   * Collapse repeats within a window — see `ACTIVITY_DEBOUNCED`. Unique per
   * (user, org, module, action), enforced by a partial unique index, so the
   * second write in the window is refused by the database and treated here as
   * success.
   */
  dedupeKey?: string | null
}

/**
 * Record one meaningful action. **Never throws, and never blocks the real work.**
 *
 * Founder decision 3, 2026-08-10: a failed activity write must not break the
 * action it is attached to, and must surface NOTHING to the actor. Somebody
 * booking a nail appointment has no "did this get logged" moment, and telling
 * them about a system they do not know exists is meaningless noise. So this
 * swallows every failure and logs server-side.
 *
 * THE COST OF THAT IS REAL AND IS PAID ELSEWHERE, exactly as phase 1's capture
 * trigger paid it: a capture failure is SILENT. The compensating control is the
 * "newest recorded activity" honesty badge on `/console/engagement`, with a test
 * that asserts a real timestamp — because a badge is a claim to the operator,
 * and a test that keeps passing after the claim goes false is worse than no test.
 *
 * Call it AFTER the real action has succeeded, and `await` it. Fire-and-forget
 * would be tempting and is wrong: in a serverless request the function can be
 * frozen the moment the response is returned, so an un-awaited insert is lost
 * non-deterministically — which looks exactly like a capture bug.
 */
export async function recordActivity<K extends ActivityModuleKey>(
  db: ActivityDb,
  entry: ActivityEntry<K>,
): Promise<void> {
  try {
    let orgId = entry.orgId

    if (!orgId) {
      if (!entry.orgSlug) {
        console.warn(`[activity] ${entry.moduleKey}/${entry.action}: neither orgId nor orgSlug supplied`)
        return
      }
      const { data, error } = await db
        .from('orgs')
        .select('id')
        .eq('slug', entry.orgSlug)
        .maybeSingle()
      if (error || !data) {
        console.warn(
          `[activity] ${entry.moduleKey}/${entry.action}: could not resolve org "${entry.orgSlug}"` +
            (error ? ` — ${error.message}` : ''),
        )
        return
      }
      orgId = data.id as string
    }

    // `user_id`, `occurred_at`, `actor_grants` and `actor_org_role` are
    // deliberately NOT sent. The guard trigger stamps identity and time from the
    // server and derives the actor's authority from `module_roles`/`org_members`
    // at this instant, discarding anything a client supplied. Sending them would
    // suggest the app is trusted for them, and it is not (docs/03 #18).
    const { error } = await db.from('activity_events').insert({
      org_id: orgId,
      module_key: entry.moduleKey,
      action: entry.action,
      scope_ref: entry.scopeRef ?? null,
      dedupe_key: entry.dedupeKey ?? null,
    })

    if (!error) return

    // 23505 is the de-duplication index doing its job — "already recorded for
    // this window" — which is success, not a failure worth a log line. Any other
    // code is a real problem and gets one.
    if (error.code === '23505') return

    console.warn(
      `[activity] ${entry.moduleKey}/${entry.action} was NOT recorded — ${error.message} (${error.code ?? 'no code'})`,
    )
  } catch (err) {
    // Belt and braces. Nothing in the block above should throw — supabase-js
    // returns errors rather than raising — but this function's whole contract is
    // that it cannot take a booking down, so a surprise must not escape either.
    console.warn(`[activity] ${entry.moduleKey}/${entry.action} threw while recording —`, err)
  }
}

/**
 * `YYYY-MM-DD` in UTC, for building a per-day `dedupeKey`.
 *
 * UTC AND NOT LOCAL TIME, deliberately: the boundary must not move with the
 * server's timezone or with daylight saving, or the same action on the same day
 * could produce two keys (double-counting) or two days could produce one
 * (silently dropping the second day's activity). The window being a few hours
 * out of step with a user's own midnight is irrelevant to an outreach signal.
 */
export function activityDayKey(now: Date = new Date()): string {
  return now.toISOString().slice(0, 10)
}
