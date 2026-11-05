// PRODUCTION browser check (2026-11-05) of the feedback tool's screens (docs/27): charlie opens Feedback from
// a module page, the preview names that page, he sends a ticket and lands on it; dana gets a 404 for the same
// ticket; the ticket shows on charlie's My feedback. The ticket is then DELETED through the owner (pooler)
// connection — the API roles hold no DELETE on feedback tables by design. Reads .env.deploy.
// Run: node scripts/prod-verify-feedback-ui.mjs
import { chromium } from 'playwright-core'
import postgres from 'postgres'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', TITLE='Prod feedback check '+Date.now().toString().slice(-6)
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch()
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const sql=postgres(`postgresql://postgres.${env.SUPABASE_PROJECT_REF}:${encodeURIComponent(env.SUPABASE_DB_PASSWORD)}@aws-1-us-west-2.pooler.supabase.com:5432/postgres`,{ssl:'require',max:1})
try {
  const charlie=await ctx('charlie@demo.local')
  await charlie.goto(BASE+'/o/demo-dating/m/speed-dating')
  const link=charlie.getByTestId('feedback-link')
  check('the top bar has Feedback carrying the current page', await ok(link) && /from=%2Fo%2Fdemo-dating%2Fm%2Fspeed-dating/.test(await link.getAttribute('href').catch(()=>'')??''))
  await link.click()
  check('the preview names the page and module', await ok(charlie.getByTestId('feedback-preview').getByText('Page: /o/demo-dating/m/speed-dating')) && await ok(charlie.getByText('Module: speed-dating')))
  await charlie.getByLabel('Short title').fill(TITLE)
  await charlie.getByLabel('What happened, or what would you like?').fill('Automated production check; deleted right after.')
  await charlie.getByRole('button',{name:'Send'}).click()
  check('sending lands on the ticket with a thank-you', await ok(charlie.getByText('Thank you — your feedback was sent.'),30000))
  const path=new URL(charlie.url()).pathname
  await charlie.goto(BASE+'/feedback')
  check('it is listed on My feedback', await ok(charlie.getByRole('link',{name:TITLE})))
  const dana=await ctx('dana@demo.local')
  const r=await dana.goto(BASE+path)
  check(`dana gets a 404 for charlie's ticket (got ${r?.status()})`, r?.status()===404)
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  const del=await sql`delete from public.feedback_tickets where title = ${TITLE} returning id`
  console.log(`cleanup: deleted ${del.length} ticket(s)`)
  await sql.end(); await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
