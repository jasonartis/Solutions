// PRODUCTION check: can a dater CHANGE an interest mark — including when the other side has marked them back
// (a mutual, unrevealed match exists) and after the round's clock has run out? Creates/deletes a demo event.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Interest test '+Date.now().toString().slice(-5)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
const g=async p=>(await fetch(`${rest}/${p}`,{headers:H})).json()
let fails=0; const check=(n,ok,extra='')=>{console.log(ok?'PASS':'FAIL',n,extra); if(!ok)fails++}
const b=await chromium.launch()
async function ctx(email){const p=await (await b.newContext()).newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local')
await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME); await alice.getByRole('button',{name:'Create (draft)'}).click(); await alice.waitForTimeout(2500)
await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//); const evId=alice.url().split('/events/')[1].split('?')[0]
await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'PATCH',headers:H,body:JSON.stringify({round_duration_seconds:1200})})
await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor()
for(const p of [charlie,dana]){await p.goto(MOD);await p.getByRole('link',{name:NAME}).first().click();await p.getByRole('button',{name:'Register for this event'}).click();await p.getByText('You are registered').waitFor({timeout:30000})}
await alice.reload(); await alice.getByRole('button',{name:'Start event'}).click()
await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click(); await alice.getByText(/Rounds run: 1/).waitFor({timeout:30000})
const verdicts=async()=>{const rows=await g(`sd_interest?select=verdict,rater_participant_id&event_id=eq.${evId}`);return rows.map(r=>r.verdict).sort().join(',')}
const matches=async()=>(await g(`sd_matches?select=id&event_id=eq.${evId}`)).length
const sec=p=>p.locator('section').filter({hasText:'People you met'})
const click=async(p,label)=>{await sec(p).getByRole('button',{name:label,exact:true}).click(); await p.waitForTimeout(3500)}
for(const p of [charlie,dana]){await p.goto(`${MOD}/events/${evId}`);await sec(p).waitFor({timeout:20000})}
await click(charlie,'interested'); await click(dana,'interested')
check('both marked interested -> mutual (unrevealed) match exists', (await verdicts())==='interested,interested' && (await matches())===1, await verdicts())
await click(charlie,'not interested')
check('CHARLIE changes interested -> not interested (mutual existed)', (await verdicts())==='interested,not_interested', await verdicts())
check('  the unrevealed match was withdrawn', (await matches())===0)
check('  page shows his new choice highlighted', (await sec(charlie).locator('button.bg-blue-600').allInnerTexts()).join()==='not interested')
await click(charlie,'interested')
check('CHARLIE changes back to interested', (await verdicts())==='interested,interested' && (await matches())===1)
await click(dana,'no show')
check('DANA changes interested -> no show', (await verdicts())==='interested,no_show', await verdicts())
await click(dana,'interested')
// the round's clock runs out (the break / worker-less state the founder was in)
const rd=(await g(`sd_rounds?select=id&event_id=eq.${evId}`))[0].id
await fetch(`${rest}/sd_rounds?id=eq.${rd}`,{method:'PATCH',headers:H,body:JSON.stringify({ends_at:new Date(Date.now()-60000).toISOString()})})
await charlie.goto(`${MOD}/events/${evId}`); await sec(charlie).waitFor({timeout:20000})
await click(charlie,'not interested')
check('AFTER the round clock ran out, a change still works', (await verdicts())==='interested,not_interested', await verdicts())
await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H})
await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
