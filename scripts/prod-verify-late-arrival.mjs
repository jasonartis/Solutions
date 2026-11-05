// PRODUCTION check (2026-11-05): a person who checks in AFTER round 1 has run is paired in round 2.
// alice creates an event with self check-in and a cap of 3 rounds; charlie, dana and eve register; the event
// starts; only charlie and dana check in; round 1 pairs them while eve is told she is not in a round; eve
// then checks in; round 2 pairs eve with one of them. Before f6fe128 the first round shrank the cap to the
// CHECKED-IN count (2 -> 1 round), so the second press was refused and eve could never be paired.
// Creates and deletes its own event in demo-dating (service-role DELETE for cleanup: an event with rounds
// cannot be deleted in the UI). Reads .env.deploy. Run: node scripts/prod-verify-late-arrival.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Late arrival test '+Date.now().toString().slice(-6)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch()
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local'), eve=await ctx('eve@demo.local')
let evId=null
try {
  await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME)
  await alice.getByLabel('Check-in').selectOption('self')
  // re-fill until it sticks (a fill before hydration is reset by React's defaults)
  let capped=false
  for (let i=0;i<8&&!capped;i++){
    await alice.getByLabel('Number of rounds (at most)').fill('3')
    capped=await alice.getByText(/3 rounds/).first().waitFor({timeout:1500}).then(()=>true,()=>false)
  }
  check('create form takes a cap of 3 rounds', capped)
  await alice.getByRole('button',{name:'Create (draft)'}).click()
  await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//,{timeout:30000}); evId=alice.url().split('/events/')[1].split('?')[0]; const evUrl=alice.url().split('?')[0]
  await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor({timeout:30000})
  for(const p of [charlie,dana,eve]){await p.goto(evUrl);await p.getByRole('button',{name:'Register for this event'}).click();await p.getByText('You are registered').waitFor({timeout:30000})}
  await alice.goto(evUrl); await alice.getByRole('button',{name:'Start event'}).click(); await alice.getByText('running',{exact:true}).waitFor({timeout:30000})
  for(const p of [charlie,dana]){await p.goto(evUrl);await p.getByRole('button',{name:"I'm here — check me in"}).click();await p.getByTestId('checked-in').waitFor({timeout:30000})}
  await alice.goto(evUrl); check('the ready board shows 2 of 3 ready', await ok(alice.getByText('Ready (2 of 3)')))
  await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click()
  check('round 1 starts with the two who arrived', await ok(alice.getByText(/Rounds run: 1/)))
  const [ev1]=await (await fetch(`${rest}/sd_events?id=eq.${evId}&select=rounds_planned`,{headers:H})).json()
  check(`the cap was NOT shrunk to the two arrivals (rounds_planned = ${ev1?.rounds_planned}, must be > 1)`, (ev1?.rounds_planned ?? 0) > 1)
  await eve.goto(evUrl)
  check('eve (registered, not checked in) is told she is not in any round', await ok(eve.getByText(/not checked in.*not in any round/)))
  await eve.getByRole('button',{name:"I'm here — check me in"}).click(); await eve.getByTestId('checked-in').waitFor({timeout:30000})
  await alice.goto(evUrl); await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click()
  check('round 2 starts (not refused by the cap)', await ok(alice.getByText(/Rounds run: 2/)))
  check('...and no cap-reached notice', (await alice.getByText(/planned rounds have run/).count())===0)
  await eve.goto(evUrl)
  check("eve, the late arrival, is paired in round 2", await ok(eve.getByText(/Round 2 — you.re with/)))
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  if (evId) await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H}).catch(()=>{})
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
