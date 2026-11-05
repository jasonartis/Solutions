import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createClient } from '@supabase/supabase-js'
import postgres from 'postgres'

// ---------------------------------------------------------------------------
// FEEDBACK AND TICKETS v1 (20261106010000, docs/27).
//
// Every probe runs AS a signed-in user (`set local role authenticated` +
// `request.jwt.claims`), inside a transaction that is ALWAYS rolled back;
// throwaway accounts are hard-deleted afterwards. Every refusal has a positive
// control beside it (docs/03 vacuity rule).
//
//   u = the person who writes in      a = an ADMIN of u's org (no read path!)
//   s = the superadmin                x = a stranger in no org
// ---------------------------------------------------------------------------

const url = process.env.SUPABASE_URL ?? 'http://127.0.0.1:54321'
const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? ''
const ownerDbUrl = process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@127.0.0.1:54322/postgres'

const sql = postgres(ownerDbUrl, { prepare: false, max: 1 })
const admin = () => createClient(url, serviceKey, { auth: { persistSession: false } })

const who = ['u', 'a', 's', 'x'] as const
type Who = (typeof who)[number]
const ids = Object.fromEntries(who.map((k) => [k, ''])) as Record<Who, string>

beforeAll(async () => {
  if (!serviceKey) throw new Error('SUPABASE_SERVICE_ROLE_KEY is required for this suite')
  const tag = `${Date.now()}-${Math.random().toString(36).slice(2, 6)}`
  for (const k of who) {
    const { data, error } = await admin().auth.admin.createUser({
      email: `feedback-${k}-${tag}@demo.local`, password: 'password123', email_confirm: true,
    })
    if (error) throw new Error(`createUser ${k}: ${error.message}`)
    ids[k] = data.user!.id
  }
})

afterAll(async () => {
  try {
    for (const id of Object.values(ids).filter(Boolean)) {
      const { error } = await admin().auth.admin.deleteUser(id)
      expect(error, 'could not hard-delete a probe account').toBeNull()
    }
  } finally {
    await sql.end()
  }
})

type Tx = postgres.TransactionSql
type Outcome = { error: string | null; rows: number; data: postgres.Row[] }

async function rolledBack<T>(body: (tx: Tx) => Promise<T>): Promise<T> {
  let result!: T
  await sql
    .begin(async (tx) => {
      result = await body(tx)
      throw new Error('__rollback__')
    })
    .catch((e: unknown) => {
      if ((e as Error)?.message !== '__rollback__') throw e
    })
  return result
}

async function as(tx: Tx, user: Who, stmt: () => Promise<postgres.RowList<postgres.Row[]>>): Promise<Outcome> {
  await tx.unsafe('savepoint sp')
  let out: Outcome
  try {
    await tx`select set_config('request.jwt.claims', ${JSON.stringify({ sub: ids[user], role: 'authenticated' })}, true)`
    await tx.unsafe('set local role authenticated')
    const r = await stmt()
    await tx.unsafe('release savepoint sp')
    out = { error: null, rows: r.count, data: [...r] }
  } catch (e: unknown) {
    await tx.unsafe('rollback to savepoint sp')
    out = { error: String((e as Error).message), rows: 0, data: [] }
  }
  await tx.unsafe('reset role')
  await tx`select set_config('request.jwt.claims', '', true)`
  return out
}

/** u is a member and a is an ADMIN of one org; s is made superadmin; x belongs nowhere. */
async function setup(tx: Tx): Promise<string> {
  const [o] = await tx<{ id: string }[]>`
    insert into orgs (name, slug) values ('Feedback probe', ${`fb-${Math.random().toString(36).slice(2, 10)}`}) returning id`
  await tx`insert into org_members (org_id, user_id, role, status, accepted_at) values
           (${o!.id}, ${ids.u}, 'member', 'active', now()), (${o!.id}, ${ids.a}, 'admin', 'active', now())`
  await tx`insert into user_private (user_id, is_superadmin) values (${ids.s}, true)
           on conflict (user_id) do update set is_superadmin = true`
  return o!.id
}

const open = (tx: Tx, org: string | null, title = 'Camera picker shows nothing') => () =>
  tx`select public.feedback_open('bug', ${title}, 'It is empty on my laptop', ${org}, 'speed-dating',
       ${tx.json({ path: '/o/x/m/speed-dating', viewport: '1280x720' })}) as id`

describe('feedback: who can read a ticket', () => {
  it('the author and the superadmin read it; an admin of the same org and a stranger read nothing', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const made = await as(tx, 'u', open(tx, org))
      const id = made.data[0]!.id as string
      const read = (w: Who) => as(tx, w, () => tx`select id from feedback_tickets where id = ${id}`)
      const msgs = (w: Who) => as(tx, w, () => tx`select id from feedback_messages where ticket_id = ${id}`)
      return {
        made, author: await read('u'), authorMsgs: await msgs('u'), superadmin: await read('s'),
        orgAdmin: await read('a'), orgAdminMsgs: await msgs('a'), stranger: await read('x'),
      }
    })
    expect(r.made.error).toBeNull()
    expect(r.author.rows, 'CONTROL: the author reads it').toBe(1)
    expect(r.authorMsgs.rows, 'CONTROL: the first message is the body').toBe(1)
    expect(r.superadmin.rows, 'CONTROL: the superadmin reads it').toBe(1)
    expect(r.orgAdmin.rows, 'org_id is context, never authority').toBe(0)
    expect(r.orgAdminMsgs.rows).toBe(0)
    expect(r.stranger.rows).toBe(0)
  })

  it('an internal note is read by the superadmin only, never by the author', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 'u', open(tx, org))).data[0]!.id as string
      await as(tx, 's', () => tx`select public.feedback_reply(${id}, 'Looks like a driver issue', true)`)
      await as(tx, 's', () => tx`select public.feedback_reply(${id}, 'Which browser are you using?', false)`)
      const mine = await as(tx, 'u', () => tx`select body, internal, author_kind from feedback_messages where ticket_id = ${id} order by created_at`)
      const staff = await as(tx, 's', () => tx`select body, internal from feedback_messages where ticket_id = ${id}`)
      return { mine: mine.data, staff: staff.rows }
    })
    expect(r.staff, 'CONTROL: all three messages exist').toBe(3)
    expect(r.mine.map((m) => m.internal)).toEqual([false, false])
    expect(r.mine.map((m) => m.author_kind)).toEqual(['user', 'staff'])
  })
})

describe('feedback: writes go only through the functions', () => {
  it('direct INSERT / UPDATE / DELETE are refused for a signed-in user; the function works (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const fn = await as(tx, 'u', open(tx, org))
      const id = fn.data[0]!.id as string
      return {
        fn,
        insert: await as(tx, 'u', () => tx`insert into feedback_tickets (created_by, kind, title) values (${ids.u}, 'bug', 't')`),
        update: await as(tx, 'u', () => tx`update feedback_tickets set status = 'resolved' where id = ${id}`),
        del: await as(tx, 'u', () => tx`delete from feedback_messages where ticket_id = ${id}`),
        superInsert: await as(tx, 's', () => tx`insert into feedback_messages (ticket_id, author_id, author_kind, body) values (${id}, ${ids.s}, 'staff', 'x')`),
      }
    })
    expect(r.fn.error, 'CONTROL').toBeNull()
    for (const k of ['insert', 'update', 'del', 'superInsert'] as const) {
      expect(r[k].error, k).toMatch(/permission denied/)
    }
  })

  it("someone else's ticket and a nonexistent id get the same answer, for reply, status and read", async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 'u', open(tx, org))).data[0]!.id as string
      const missing = '00000000-0000-4000-8000-0000000000fe'
      return {
        replyOther: await as(tx, 'a', () => tx`select public.feedback_reply(${id}, 'hi', false)`),
        replyMissing: await as(tx, 'a', () => tx`select public.feedback_reply(${missing}, 'hi', false)`),
        statusOther: await as(tx, 'x', () => tx`select public.feedback_set_status(${id}, 'closed')`),
        readOther: await as(tx, 'x', () => tx`select public.feedback_mark_read(${id})`),
        own: await as(tx, 'u', () => tx`select public.feedback_reply(${id}, 'more detail', false)`),
      }
    })
    expect(r.replyOther.error).toMatch(/Ticket not found/)
    expect(r.replyMissing.error).toBe(r.replyOther.error)
    expect(r.statusOther.error).toBe(r.replyOther.error)
    expect(r.readOther.error).toBe(r.replyOther.error)
    expect(r.own.error, 'CONTROL: the author can reply').toBeNull()
  })

  it('the author cannot write an internal note (same answer as not found); the superadmin can (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 'u', open(tx, org))).data[0]!.id as string
      return {
        author: await as(tx, 'u', () => tx`select public.feedback_reply(${id}, 'sneaky', true)`),
        staff: await as(tx, 's', () => tx`select public.feedback_reply(${id}, 'note', true)`),
      }
    })
    expect(r.author.error).toMatch(/Ticket not found/)
    expect(r.staff.error, 'CONTROL').toBeNull()
  })

  it('a ticket can only name an org the author belongs to', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      return {
        stranger: await as(tx, 'x', open(tx, org)),
        noOrg: await as(tx, 'x', open(tx, null)),
        member: await as(tx, 'u', open(tx, org)),
      }
    })
    expect(r.stranger.error).toMatch(/Unknown organization/)
    expect(r.noOrg.error, 'CONTROL: a platform-level ticket needs no org').toBeNull()
    expect(r.member.error, 'CONTROL: a member names their org').toBeNull()
  })

  it('the server stamps author and status: created_by is the caller, status starts new', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 'u', open(tx, org))).data[0]!.id as string
      const [t] = await tx<{ created_by: string; status: string; routed_to: string | null }[]>`
        select created_by, status, routed_to from feedback_tickets where id = ${id}`
      const [m] = await tx<{ author_id: string; author_kind: string }[]>`
        select author_id, author_kind from feedback_messages where ticket_id = ${id}`
      return { t: t!, m: m! }
    })
    expect(r.t).toEqual({ created_by: ids.u, status: 'new', routed_to: null })
    expect(r.m).toEqual({ author_id: ids.u, author_kind: 'user' })
  })
})

describe('feedback: status and unread', () => {
  it('a staff reply waits on the user; the user replying reopens it; the user may only close', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 'u', open(tx, org))).data[0]!.id as string
      const status = async () => (await tx<{ status: string }[]>`select status from feedback_tickets where id = ${id}`)[0]!.status
      await as(tx, 's', () => tx`select public.feedback_reply(${id}, 'Which browser?', false)`)
      const afterStaff = await status()
      await as(tx, 'u', () => tx`select public.feedback_reply(${id}, 'Firefox', false)`)
      const afterUser = await status()
      const userResolves = await as(tx, 'u', () => tx`select public.feedback_set_status(${id}, 'resolved')`)
      const userCloses = await as(tx, 'u', () => tx`select public.feedback_set_status(${id}, 'closed')`)
      const afterClose = await status()
      const staffResolves = await as(tx, 's', () => tx`select public.feedback_set_status(${id}, 'resolved')`)
      return { afterStaff, afterUser, userResolves, userCloses, afterClose, staffResolves, final: await status() }
    })
    expect(r.afterStaff).toBe('waiting_on_user')
    expect(r.afterUser).toBe('open')
    expect(r.userResolves.error).toMatch(/Only the platform team/)
    expect(r.userCloses.error, 'CONTROL: the author can close').toBeNull()
    expect(r.afterClose).toBe('closed')
    expect(r.staffResolves.error, 'CONTROL').toBeNull()
    expect(r.final).toBe('resolved')
  })

  it('unread: a staff reply is newer than the user read time until the user marks it read', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const id = (await as(tx, 'u', open(tx, org))).data[0]!.id as string
      const unread = async () => (await tx<{ u: boolean }[]>`
        select coalesce(last_staff_message_at > user_read_at, false) as u from feedback_tickets where id = ${id}`)[0]!.u
      const before = await unread()
      await tx`select pg_sleep(0.01)`
      await as(tx, 's', () => tx`select public.feedback_reply(${id}, 'Fixed, please retry', false)`)
      const afterReply = await unread()
      await as(tx, 'u', () => tx`select public.feedback_mark_read(${id})`)
      return { before, afterReply, afterRead: await unread() }
    })
    expect(r.before).toBe(false)
    expect(r.afterReply).toBe(true)
    expect(r.afterRead).toBe(false)
  })
})

describe('feedback: abuse limits', () => {
  it('ten tickets a day per person; the eleventh is refused; the superadmin is exempt (control)', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      const outs: Outcome[] = []
      for (let i = 0; i < 11; i++) outs.push(await as(tx, 'u', open(tx, org, `t${i}`)))
      const superOuts: Outcome[] = []
      for (let i = 0; i < 11; i++) superOuts.push(await as(tx, 's', open(tx, null, `s${i}`)))
      return { ok: outs.slice(0, 10).every((o) => o.error === null), eleventh: outs[10]!, superOk: superOuts.every((o) => o.error === null) }
    })
    expect(r.ok, 'CONTROL: the first ten succeed').toBe(true)
    expect(r.eleventh.error).toMatch(/Too many feedback tickets today/)
    expect(r.superOk).toBe(true)
  })

  it('sizes are capped: an empty title and an oversized context are refused', async () => {
    const r = await rolledBack(async (tx) => {
      const org = await setup(tx)
      return {
        empty: await as(tx, 'u', open(tx, org, '   ')),
        huge: await as(tx, 'u', () => tx`select public.feedback_open('bug', 't', 'b', ${org}, null, ${tx.json({ blob: 'x'.repeat(9000) })})`),
      }
    })
    expect(r.empty.error).toMatch(/check constraint/)
    expect(r.huge.error).toMatch(/check constraint/)
  })
})
