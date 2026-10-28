// PRODUCTION check (2026-10-28) of the round cap and staff check-in: alice creates an event with
// check-in = staff and a cap of 1 round, charlie and dana register and are TOLD they are not checked in,
// the first round is refused until two people have arrived, then runs, shows "round 1 of 1 · about N min
// left" to a dater, and a second press is refused by the cap. Creates and deletes its own event in
// demo-dating (service-role DELETE for the cleanup, because an event with rounds cannot be deleted in the UI).
// Reads .env.deploy. Run: node scripts/prod-verify-checkin-and-cap.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Checkin cap test '+Date.now().toString().slice(-6)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch()
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local')
let evId=null
try {
  await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME)
  await alice.getByLabel('Check-in').selectOption('staff')
  // re-fill until it sticks (a fill before hydration is reset by React's defaults)
  let capped=false
  for (let i=0;i<8&&!capped;i++){
    await alice.getByLabel('Number of rounds (at most)').fill('1')
    capped=await alice.getByText(/, 1 round, about \d+ minutes\./).waitFor({timeout:1500}).then(()=>true,()=>false)
  }
  check('create form: a cap of 1 round reads as an exact plan ("…, 1 round, about N minutes.")', capped)
  await alice.getByRole('button',{name:'Create (draft)'}).click()
  await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//,{timeout:30000}); evId=alice.url().split('/events/')[1].split('?')[0]; const evUrl=alice.url().split('?')[0]
  check('console shows "1 round planned"', await ok(alice.getByText('1 round planned')))
  await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor({timeout:30000})
  for(const p of [charlie,dana]){await p.goto(evUrl);await p.getByRole('button',{name:'Register for this event'}).click();await p.getByText('You are registered').waitFor({timeout:30000})}
  check('charlie is told loudly he is NOT checked in', await ok(charlie.getByTestId('not-checked-in')) && /You are NOT checked in yet/.test(await charlie.getByTestId('not-checked-in').innerText()))
  check('...and told to tell the organizer (staff mode)', /tell the organizer/.test(await charlie.getByTestId('not-checked-in').innerText()))
  await charlie.goto(MOD)
  check('the events list badge says he will not be paired', await ok(charlie.getByText('NOT checked in — you will not be paired').first()))
  await alice.goto(evUrl); await alice.getByRole('button',{name:'Start event'}).click(); await alice.getByText('running',{exact:true}).waitFor({timeout:30000})
  await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click()
  check('the round is refused while nobody has arrived', await ok(alice.getByText('fewer than two people are checked in')))
  await alice.locator('li',{hasText:'Charlie C'}).getByRole('button',{name:'Mark arrived'}).click(); await alice.getByText('Roster (2 registered, 1 arrived)').waitFor({timeout:30000})
  await alice.locator('li',{hasText:'Dana D'}).getByRole('button',{name:'Mark arrived'}).click(); await alice.getByText('Roster (2 registered, 2 arrived)').waitFor({timeout:30000})
  await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click()
  check('with two arrived the round starts', await ok(alice.getByText(/Rounds run: 1/)))
  await charlie.goto(evUrl)
  check('charlie now sees he is checked in, and no alarm', await ok(charlie.getByTestId('checked-in')) && (await charlie.getByTestId('not-checked-in').count())===0)
  const roundOf=await ok(charlie.getByTestId('round-of-planned')) ? await charlie.getByTestId('round-of-planned').innerText() : ''
  check(`charlie sees an exact position: "${roundOf.replace(/\s+/g,' ').trim()}"`, /round 1 of 1 · about \d+ min left/.test(roundOf))
  await alice.goto(evUrl); await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click()
  check('a second press is refused by the cap', await ok(alice.getByText('all 1 planned rounds have run')))
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  if (evId) await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H}).catch(()=>{})
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
