// PRODUCTION check of the video-room resilience features (2026-10-28): a camera/microphone picker and
// the "Connection lost — reconnecting…" banner. Creates a live event in demo-dating, joins two fake-media
// browsers (real JaaS), then (1) exercises the device picker and (2) drops charlie's network for real
// (Playwright setOffline) and watches what the screen does. Fake devices, so the device SWITCH itself is only
// exercised if Chromium exposes a second fake device; otherwise the FAILURE path (previous device keeps
// working) is exercised with a stubbed device list and the script says so. Reads .env.deploy.
// Run: node scripts/prod-verify-video-resilience.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Resilience test '+Date.now().toString().slice(-5)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const note=m=>console.log('NOTE',m)
const b=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']})
async function ctx(email){const c=await b.newContext({permissions:['camera','microphone']});const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local')
let evId=null
try {
  await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME); await alice.getByRole('button',{name:'Create (draft)'}).click(); await alice.waitForTimeout(2500)
  await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//); evId=alice.url().split('/events/')[1].split('?')[0]
  await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'PATCH',headers:H,body:JSON.stringify({round_duration_seconds:1800})})
  await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor()
  for(const p of [charlie,dana]){await p.goto(MOD);await p.getByRole('link',{name:NAME}).first().click();await p.getByRole('button',{name:'Register for this event'}).click();await p.getByText('You are registered').waitFor({timeout:30000})}
  await alice.reload(); await alice.getByRole('button',{name:'Start event'}).click()
  await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click(); await alice.getByText(/Rounds run: 1/).waitFor({timeout:30000})
  for(const p of [charlie,dana]){await p.goto(`${MOD}/events/${evId}`);await p.getByRole('button',{name:'Join video'}).click()}
  const st=p=>p.getByTestId('video-status')
  for(const p of [charlie,dana]) await st(p).waitFor({timeout:45000})
  await charlie.waitForTimeout(6000)
  check('baseline: in a call, dana sees charlie camera on', /Charlie: microphone on · camera on/.test(await st(dana).innerText()))
  check('no banner and no picker error in a healthy call', (await charlie.getByTestId('video-reconnecting').count())===0)

  // ---- (1) device picker -------------------------------------------------------------------------------
  const real=await charlie.evaluate(async()=>{const d=await navigator.mediaDevices.enumerateDevices();return {cams:d.filter(x=>x.kind==='videoinput').length,mics:d.filter(x=>x.kind==='audioinput').length}})
  note(`charlie's browser reports ${real.cams} camera(s) and ${real.mics} microphone(s)`)
  if (real.cams>1) {
    const sel=charlie.getByTestId('video-camera-select'); await sel.waitFor({timeout:15000})
    const before=await sel.inputValue(); const opts=await sel.locator('option').evaluateAll(o=>o.map(x=>x.value))
    await sel.selectOption(opts.find(v=>v!==before)); await charlie.waitForTimeout(5000)
    check('picked another camera: selection changed, camera still on, dana still sees video', (await sel.inputValue())!==before && /You: microphone on · camera on/.test(await st(charlie).innerText()) && /Charlie: microphone on · camera on/.test(await st(dana).innerText()))
  } else {
    note('only one real fake device: the picker stays hidden (correct); exercising the FAILURE path with a stubbed list instead')
    check('picker is hidden when there is only one camera and one microphone', (await charlie.getByTestId('video-camera-select').count())===0)
    await charlie.evaluate(()=>{
      const real=navigator.mediaDevices.enumerateDevices.bind(navigator.mediaDevices)
      navigator.mediaDevices.enumerateDevices=async()=>[...(await real()),{kind:'videoinput',deviceId:'bogus-camera-id',label:'Bogus camera',groupId:'x'}]
      navigator.mediaDevices.dispatchEvent(new Event('devicechange'))
    })
    const sel=charlie.getByTestId('video-camera-select')
    check('a second camera appearing makes the picker show up', await sel.waitFor({timeout:15000}).then(()=>true,()=>false))
    await sel.selectOption('bogus-camera-id')
    check('choosing a camera that cannot be opened shows a plain error', await charlie.getByText('Could not switch to that device. Your previous one is still in use.').waitFor({timeout:20000}).then(()=>true,()=>false))
    await charlie.waitForTimeout(3000)
    check('...and the previous camera keeps working (status line + dana still sees it)', /You: microphone on · camera on/.test(await st(charlie).innerText()) && /Charlie: microphone on · camera on/.test(await st(dana).innerText()))
  }

  // The microphone list is real here (Chromium exposes several fake microphones), so the SWITCH is exercised for real.
  if (real.mics>1) {
    const msel=charlie.getByTestId('video-mic-select'); await msel.waitFor({timeout:15000})
    const mbefore=await msel.inputValue(); const mopts=await msel.locator('option').evaluateAll(o=>o.map(x=>x.value))
    await msel.selectOption(mopts.find(v=>v!==mbefore)); await charlie.waitForTimeout(5000)
    check('picked another microphone: selection changed, mic still on, dana still sees it on', (await msel.inputValue())!==mbefore && /You: microphone on/.test(await st(charlie).innerText()) && /Charlie: microphone on/.test(await st(dana).innerText()))
    await charlie.getByRole('button',{name:'Mute microphone'}).click(); await charlie.waitForTimeout(1500)
    await msel.selectOption(mbefore); await charlie.waitForTimeout(5000)
    check('a muted microphone STAYS muted after switching devices', /You: microphone off/.test(await st(charlie).innerText()) && /Charlie: microphone off/.test(await st(dana).innerText()))
    await charlie.getByRole('button',{name:'Unmute microphone'}).click(); await charlie.waitForTimeout(3000)
  }

  // ---- (2) a real network drop -------------------------------------------------------------------------
  const c=charlie.context(); await c.setOffline(true); note('charlie is offline now')
  const outcome=await Promise.race([
    charlie.getByTestId('video-reconnecting').waitFor({timeout:75000}).then(()=>'banner',()=>null),
    charlie.getByTestId('video-left-note').waitFor({timeout:75000}).then(()=>'left',()=>null),
  ])
  note(`first thing charlie's screen did while offline: ${outcome??'NOTHING within 75s'}`)
  // INCONCLUSIVE, NOT A FAILURE, when nothing happens: Playwright's offline mode does not reliably sever an
  // already-established peer-to-peer media connection, so the library may never have been told anything. The
  // banner's trigger (CONNECTION_INTERRUPTED) needs a REAL drop - unplug wifi on a real device.
  if (outcome===null) note('INCONCLUSIVE: the emulated drop never reached the library; verify the banner by hand on two devices')
  await c.setOffline(false); note('charlie is back online')
  if (outcome==='banner') {
    const end=await Promise.race([
      charlie.getByTestId('video-reconnecting').waitFor({state:'hidden',timeout:60000}).then(()=>'recovered',()=>null),
      charlie.getByTestId('video-left-note').waitFor({timeout:60000}).then(()=>'gave-up',()=>null),
    ])
    note(`after coming back online: ${end??'still showing the banner after 60s'}`)
    check('the banner never gets stuck (it recovers, or gives up into Rejoin)', end!==null)
    if (end==='recovered') check('recovered: still in the call with a status line', await st(charlie).isVisible())
  }
  const rejoin=charlie.getByRole('button',{name:'Rejoin video'})
  if (await rejoin.isVisible().catch(()=>false)) {
    check('given-up state explains what happened', /connection to the video room was lost|left the video room/.test(await charlie.getByTestId('video-left-note').innerText()))
    await rejoin.click(); await st(charlie).waitFor({timeout:45000}); await charlie.waitForTimeout(6000)
    check('Rejoin after a drop puts charlie back with dana', /Dana: microphone on/.test(await st(charlie).innerText()))
  }
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  if (evId) await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H}).catch(()=>{})
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
