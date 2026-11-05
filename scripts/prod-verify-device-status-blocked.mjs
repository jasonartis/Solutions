// PRODUCTION check (2026-11-05), the two walkthrough steps the main client check does not cover: a dater whose
// camera permission is DENIED shows "📷 blocked" (red) on the organizer's tile, and after a host un-ticks
// him he sees the amber "You are NOT checked in yet" box again. Own event in demo-dating, temporary host grant
// for eve, both removed in finally. Reads .env.deploy. Run: node scripts/prod-verify-device-status-blocked.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Device blocked test '+Date.now().toString().slice(-6)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch({args:['--use-fake-device-for-media-stream']})
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return {c,p}}
let evId=null, hostRow=null
try {
  const charlie=await ctx('charlie@demo.local')   // first, so it is the only page when its context id is read below
  // Deny camera + microphone for the site at the browser level (what the address-bar "Block" does).
  const cdp=await b.newBrowserCDPSession()
  const { targetInfos } = await cdp.send('Target.getTargets')
  const browserContextId = targetInfos.find(t=>t.type==='page'&&t.url.startsWith(BASE)).browserContextId
  for (const name of ['camera','microphone']) await cdp.send('Browser.setPermission',{origin:BASE,permission:{name},setting:'denied',browserContextId})
  const alice=(await ctx('alice@demo.local')).p
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
  check('a denied camera reads "blocked" on the organizer\'s tile', /📷 blocked/.test(txt) && /🎤 blocked/.test(txt))
  check('...and the tile is marked as a problem (red)', (await tile().getAttribute('data-device-state'))==='problem')
  const eve=(await (await fetch(`${rest}/profiles?select=user_id&display_name=ilike.Eve*`,{headers:H})).json())[0]
  const org=(await (await fetch(`${rest}/orgs?select=id&slug=eq.demo-dating`,{headers:H})).json())[0]
  hostRow=(await (await fetch(`${rest}/module_roles`,{method:'POST',headers:{...H,Prefer:'return=representation'},body:JSON.stringify({org_id:org.id,user_id:eve.user_id,module_key:'speed-dating',role:'host'})})).json())[0]?.id
  const host=(await ctx('eve@demo.local')).p
  await host.goto(evUrl)
  await host.getByTestId('ready-tile-ready').filter({hasText:'Charlie'}).getByRole('button',{name:'Un-tick (not ready)'}).click()
  await ok(host.getByTestId('ready-tile-waiting').filter({hasText:'Charlie'}))
  await charlie.p.reload()
  check('after the host un-tick charlie sees the amber "NOT checked in yet" box', await ok(charlie.p.getByTestId('not-checked-in')))
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  if (hostRow) await fetch(`${rest}/module_roles?id=eq.${hostRow}`,{method:'DELETE',headers:H}).catch(()=>{})
  if (evId) await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H}).catch(()=>{})
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
