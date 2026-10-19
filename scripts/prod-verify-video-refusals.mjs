// PRODUCTION check (2026-10-19 security sweep): a seat an organizer REMOVED mid-round must be refused a
// video join token, while the partner (still registered) can join. Creates and deletes a demo-dating event.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Refusal test '+Date.now().toString().slice(-5)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const b=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']})
async function ctx(email){const c=await b.newContext({permissions:['camera','microphone']});const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local')
await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME); await alice.getByRole('button',{name:'Create (draft)'}).click(); await alice.waitForTimeout(2500)
await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//); const evId=alice.url().split('/events/')[1].split('?')[0]
await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'PATCH',headers:H,body:JSON.stringify({round_duration_seconds:1200})})
await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor()
for(const p of [charlie,dana]){await p.goto(MOD);await p.getByRole('link',{name:NAME}).first().click();await p.getByRole('button',{name:'Register for this event'}).click();await p.getByText('You are registered').waitFor({timeout:30000})}
await alice.reload(); await alice.getByRole('button',{name:'Start event'}).click()
await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click(); await alice.getByText(/Rounds run: 1/).waitFor({timeout:30000})
// load charlie's page while he is still registered so the Join button exists, THEN remove him server-side
await charlie.goto(`${MOD}/events/${evId}`); await charlie.getByRole('button',{name:'Join video'}).waitFor({timeout:20000})
const seat=(await (await fetch(`${rest}/sd_participants?select=id,user_id&event_id=eq.${evId}`,{headers:H})).json())
const charlieId=(await (await fetch(`${rest.replace('/rest/v1','')}/auth/v1/admin/users?per_page=100`,{headers:H})).json()).users.find(u=>u.email==='charlie@demo.local').id
const cs=seat.find(s=>s.user_id===charlieId)
const r=await fetch(`${rest}/sd_participants?id=eq.${cs.id}`,{method:'PATCH',headers:H,body:JSON.stringify({status:'removed'})}); check('organizer-side removal applied (setup)', r.status===204)
await charlie.getByRole('button',{name:'Join video'}).click()
check('REMOVED seat is refused a video token', await charlie.getByText('You are not registered for this event').waitFor({timeout:30000}).then(()=>true,()=>false))
await dana.goto(`${MOD}/events/${evId}`); await dana.getByRole('button',{name:'Join video'}).waitFor({timeout:20000}); await dana.getByRole('button',{name:'Join video'}).click()
check('the still-registered partner CAN join (control)', await dana.getByTestId('video-status').waitFor({timeout:45000}).then(()=>true,()=>false))
await charlie.reload()
check('removed person sees no Withdraw / Register again button', (await charlie.getByRole('button',{name:'Withdraw'}).count())===0 && (await charlie.getByRole('button',{name:'Register again'}).count())===0)
await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H})
await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
