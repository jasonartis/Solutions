// PRODUCTION check (2026-10-29) of the video room's reconnect banner, driven through the REAL lib-jitsi-meet
// against real JaaS. Why not a real network drop: Playwright's offline mode does not sever an established
// peer-to-peer media connection, so the library never hears about it (scripts/prod-verify-video-resilience.mjs
// found exactly that). Instead the browser's RTCPeerConnection objects are hooked BEFORE the page loads, and
// the test makes them REPORT iceConnectionState = 'disconnected' (then 'connected') and fires the real
// 'iceconnectionstatechange' event — so the library's own code decides whether that is an interruption and
// emits CONNECTION_INTERRUPTED / CONNECTION_RESTORED itself. What this proves: our banner, the 20 s give-up,
// the Rejoin path and the library's wiring. What it does NOT prove: that a physical Wi-Fi drop produces the
// same browser state (that is the browser's job, not ours). Creates and deletes its own demo-dating event.
// Reads .env.deploy. Run: node scripts/prod-verify-video-reconnect.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating', NAME='Reconnect test '+Date.now().toString().slice(-5)
const rest=`https://${env.SUPABASE_PROJECT_REF}.supabase.co/rest/v1`, H={apikey:env.SUPABASE_SERVICE_ROLE_KEY,Authorization:'Bearer '+env.SUPABASE_SERVICE_ROLE_KEY,'Content-Type':'application/json'}
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const note=m=>console.log('NOTE',m)
const b=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']})
const HOOK=()=>{
  for (const key of ['RTCPeerConnection','webkitRTCPeerConnection']) {
    const Orig=window[key]; if(!Orig) continue
    window[key]=new Proxy(Orig,{construct(t,args,nt){const pc=Reflect.construct(t,args,nt);(window.__pcs=window.__pcs||[]).push(pc);return pc}})
  }
}
async function ctx(email,hook){const c=await b.newContext({permissions:['camera','microphone']}); if(hook) await c.addInitScript(HOOK); const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local',true), dana=await ctx('dana@demo.local')
// Make every hooked connection report a state, and tell the library about it the way the browser would.
const setIce=(state)=>charlie.evaluate((s)=>{
  const real=Object.getOwnPropertyDescriptor(RTCPeerConnection.prototype,'iceConnectionState').get
  for (const pc of (window.__pcs||[])) {
    Object.defineProperty(pc,'iceConnectionState',{configurable:true,get:()=> s ?? real.call(pc)})
    pc.dispatchEvent(new Event('iceconnectionstatechange'))
  }
  return (window.__pcs||[]).length
}, state)
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
  const n=await setIce(null)
  note(`hooked ${n} RTCPeerConnection object(s) in charlie's browser`)
  check('the peer-connection hook caught the call (at least one connection)', n>=1)
  check('baseline: healthy call shows no banner', (await charlie.getByTestId('video-reconnecting').count())===0)

  // ---- 1. a short interruption that RECOVERS --------------------------------------------------------------
  await setIce('disconnected')
  const sawBanner=await charlie.getByTestId('video-reconnecting').waitFor({timeout:30000}).then(()=>true,()=>false)
  check('a reported ICE "disconnected" makes the library fire its interrupted event and the banner appears', sawBanner)
  if (sawBanner) {
    check('banner explains it plainly', /Connection lost — reconnecting/.test(await charlie.getByTestId('video-reconnecting').innerText()))
    await setIce(null) // back to the REAL state, which is connected
    const cleared=await charlie.getByTestId('video-reconnecting').waitFor({state:'hidden',timeout:30000}).then(()=>true,()=>false)
    check('when the state recovers the banner goes away by itself (library fired RESTORED)', cleared)
    check('...and charlie is still in the call, with his status line', await st(charlie).isVisible())
    check('...and dana still sees charlie', /Charlie: microphone on/.test(await st(dana).innerText()))

    // ---- 2. an interruption that does NOT recover: give up into Rejoin after ~20 s ----------------------
    await setIce('disconnected')
    const again=await charlie.getByTestId('video-reconnecting').waitFor({timeout:30000}).then(()=>true,()=>false)
    check('a second interruption shows the banner again', again)
    const t0=Date.now()
    const gaveUp=await charlie.getByTestId('video-left-note').waitFor({timeout:45000}).then(()=>true,()=>false)
    const secs=Math.round((Date.now()-t0)/1000)
    check(`still down: the room gives up into the Rejoin state (after ~20 s; took ${secs}s)`, gaveUp && secs>=15 && secs<=40)
    check('the note says the connection was lost', /connection to the video room was lost/.test(await charlie.getByTestId('video-left-note').innerText().catch(()=>'')))
    await setIce(null)
    await charlie.getByRole('button',{name:'Rejoin video'}).click(); await st(charlie).waitFor({timeout:45000}); await charlie.waitForTimeout(6000)
    check('Rejoin puts charlie back in the call with dana', /Dana: microphone on/.test(await st(charlie).innerText()))
  } else {
    note('the library did NOT treat a faked ICE "disconnected" as an interruption — the banner trigger remains unproven; see the module-6 spec')
  }
} catch (e) { console.log('ERROR', String(e).slice(0,600)); fails++ }
finally {
  if (evId) await fetch(`${rest}/sd_events?id=eq.${evId}`,{method:'DELETE',headers:H}).catch(()=>{})
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
