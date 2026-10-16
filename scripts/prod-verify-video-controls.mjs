// PRODUCTION check of the video-room controls (2026-10-16): creates a live event in demo-dating,
// joins two fake-media browsers, and asserts the status line, mute/camera toggles (seen from the
// OTHER side), and Leave -> Rejoin. Fake devices, so it proves the UI + signalling, not hardware.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Controls test '+Date.now().toString().slice(-5)
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
for(const p of [charlie,dana]){await p.goto(`${MOD}/events/${evId}`);await p.getByRole('button',{name:'Join video'}).click()}
const st=p=>p.getByTestId('video-status')
for(const p of [charlie,dana]) await st(p).waitFor({timeout:45000})
await charlie.waitForTimeout(6000)
check('charlie sees partner mic+camera on', /Them: microphone on · camera on/.test(await st(charlie).innerText()))
check('dana sees partner mic+camera on', /Them: microphone on · camera on/.test(await st(dana).innerText()))
await charlie.getByRole('button',{name:'Mute microphone'}).click(); await dana.waitForTimeout(4000)
check('charlie sees own mic off', /You: microphone off/.test(await st(charlie).innerText()))
check("dana sees charlie's mic off", /Them: microphone off/.test(await st(dana).innerText()))
await charlie.getByRole('button',{name:'Turn camera off'}).click(); await dana.waitForTimeout(4000)
check("dana sees charlie's camera off", /camera off/.test((await st(dana).innerText()).split('Them:')[1]))
await charlie.getByRole('button',{name:'Unmute microphone'}).click(); await charlie.getByRole('button',{name:'Turn camera on'}).click(); await dana.waitForTimeout(4000)
check('both back on from dana\'s side', /Them: microphone on · camera on/.test(await st(dana).innerText()))
await charlie.getByRole('button',{name:'Leave'}).click()
check('charlie sees Rejoin after leaving', await charlie.getByRole('button',{name:'Rejoin video'}).waitFor({timeout:15000}).then(()=>true,()=>false))
await charlie.getByRole('button',{name:'Rejoin video'}).click(); await st(charlie).waitFor({timeout:45000}); await charlie.waitForTimeout(6000)
check('charlie is back in the call', /Them: microphone on/.test(await st(charlie).innerText()))
check('dana sees charlie again after rejoin', /Them: microphone on · camera on/.test(await st(dana).innerText()))
await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H})
await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
