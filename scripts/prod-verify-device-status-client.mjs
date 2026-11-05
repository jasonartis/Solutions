// PRODUCTION check (2026-11-05) of the CLIENT half of host un-tick + camera/mic status (module-6 spec):
// charlie registers + ticks himself in with FAKE camera/mic; alice's Ready board shows his camera/mic and
// "last seen"; he closes his page and, after 75 s, his tile reads STALE; eve is given a temporary global HOST
// grant (the demo org has none; removed again in finally) and un-ticks charlie. Creates and deletes its own
// event in demo-dating (service-role DELETE for cleanup). Reads .env.deploy.
// Run: node scripts/prod-verify-device-status-client.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Device status test '+Date.now().toString().slice(-6)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']})
async function ctx(email,media=false){const c=await b.newContext(media?{permissions:['camera','microphone']}:{});const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return {c,p}}
let evId=null, hostRow=null
try {
  const alice=(await ctx('alice@demo.local')).p
  const charlie=await ctx('charlie@demo.local',true)
  await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME); await alice.getByLabel('Check-in').selectOption('self')
  await alice.getByRole('button',{name:'Create (draft)'}).click()
  await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//,{timeout:30000}); evId=alice.url().split('/events/')[1].split('?')[0]; const evUrl=alice.url().split('?')[0]
  await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor({timeout:30000})
  await charlie.p.goto(evUrl); await charlie.p.getByRole('button',{name:'Register for this event'}).click(); await charlie.p.getByTestId('not-checked-in').waitFor({timeout:30000})
  await alice.getByRole('button',{name:'Start event'}).click(); await alice.getByText('running',{exact:true}).waitFor({timeout:30000})
  await charlie.p.reload(); await charlie.p.getByRole('button',{name:"I'm here — check me in"}).click(); await charlie.p.getByTestId('checked-in').waitFor({timeout:30000})
  const tile=()=>alice.getByTestId('ready-tile-ready').filter({hasText:'Charlie'}).getByTestId('device-status')
  let txt=''
  for(let i=0;i<8;i++){await alice.goto(evUrl); if(await ok(tile(),4000)){txt=await tile().innerText(); if(/last seen/.test(txt))break}}
  console.log('  tile:',txt.replace(/\s+/g,' '))
  check('the organizer\'s tile shows camera ok, mic ok and "last seen"', /last seen/.test(txt) && /📷 ok/.test(txt) && /🎤 ok/.test(txt))
  await charlie.c.close()
  console.log('  waiting 85 s for the report to go stale…'); await new Promise(r=>setTimeout(r,85000))
  await alice.goto(evUrl); await ok(tile(),15000)
  check('after his page closes the tile reads STALE', (await tile().getAttribute('data-device-state'))==='stale')
  // a temporary global host grant for eve (the demo org has no host)
  const eve=(await (await fetch(`${rest}/profiles?select=user_id&display_name=ilike.Eve*`,{headers:H})).json())[0]
  const org=(await (await fetch(`${rest}/orgs?select=id&slug=eq.demo-dating`,{headers:H})).json())[0]
  const ins=await fetch(`${rest}/module_roles`,{method:'POST',headers:{...H,Prefer:'return=representation'},body:JSON.stringify({org_id:org.id,user_id:eve.user_id,module_key:'speed-dating',role:'host'})})
  hostRow=(await ins.json())[0]?.id; check('eve was given a temporary host grant', !!hostRow)
  const host=(await ctx('eve@demo.local')).p
  await host.goto(evUrl)
  await host.getByTestId('ready-tile-ready').filter({hasText:'Charlie'}).getByRole('button',{name:'Un-tick (not ready)'}).click()
  check('a HOST un-ticks charlie and the tile flips to "not ready"', await ok(host.getByTestId('ready-tile-waiting').filter({hasText:'Charlie'})))
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  if (hostRow) await fetch(`${rest}/module_roles?id=eq.${hostRow}`,{method:'DELETE',headers:H}).catch(()=>{})
  if (evId) await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H}).catch(()=>{})
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
