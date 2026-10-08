import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const PW=env.PROD_DEMO_PASSWORD, BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating'
const NAME='JaaS test '+new Date().toISOString().slice(0,16)
const browser=await chromium.launch({args:['--use-fake-ui-for-media-stream','--use-fake-device-for-media-stream']})
async function ctx(email){
  const c=await browser.newContext({permissions:['camera','microphone']}); const p=await c.newPage()
  p.on('pageerror',e=>console.log(`[${email}] pageerror`,e.message))
  p.on('console',m=>{if(m.type()==='error')console.log(`[${email}] console.error`,m.text().slice(0,300))})
  await p.goto(BASE+'/login'); await p.getByLabel('Email').fill(email); await p.getByLabel('Password').fill(PW)
  await p.getByRole('button',{name:'Sign in'}).click(); await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000})
  return p
}
const step=m=>console.log('STEP',m)
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local')
await alice.goto(MOD); await alice.locator('input[name="name"]').fill(NAME); await alice.getByRole('button',{name:'Create (draft)'}).click()
await alice.getByRole('link',{name:NAME}).first().click(); step('event created')
await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor({timeout:30000}); step('open')
for(const p of [charlie,dana]){ await p.goto(MOD); await p.getByRole('link',{name:NAME}).first().click(); await p.getByRole('button',{name:'Register for this event'}).click(); await p.getByText('You are registered').waitFor({timeout:30000}) }
step('registered')
await alice.reload(); await alice.getByText('Roster (2 registered)').waitFor(); await alice.getByRole('button',{name:'Start event'}).click()
await alice.getByRole('button',{name:'Run next round (pair everyone)'}).click(); await alice.getByText(/Rounds run: 1/).waitFor({timeout:30000}); step('round running')
for(const p of [charlie,dana]){ await p.reload(); await p.getByRole('button',{name:'Join video'}).click() }
step('both clicked Join video')
const result={}
for(const [n,p] of [['charlie',charlie],['dana',dana]]){
  const r=await Promise.race([
    p.getByRole('button',{name:'Leave'}).waitFor({timeout:45000}).then(()=> 'in_call'),
    p.getByRole('button',{name:'Try again'}).waitFor({timeout:45000}).then(()=> 'error')]).catch(()=> 'timeout')
  result[n]=r
  if(r==='error') console.log(n,'ERROR TEXT:',(await p.locator('p.text-red-700, [class*=red]').allInnerTexts()).join(' | ').slice(0,400))
}
console.log('status',result)
await charlie.waitForTimeout(8000)
for(const [n,p] of [['charlie',charlie],['dana',dana]]){
  const s=await p.evaluate(()=>{const v=document.querySelectorAll('video'),a=document.querySelector('audio')
    const info=e=>e?{hasStream:!!e.srcObject,tracks:e.srcObject?e.srcObject.getTracks().map(t=>t.kind+':'+t.readyState+(t.muted?':muted':'')):[],w:e.videoWidth,time:e.currentTime}:null
    return {local:info(v[0]),remoteVideo:info(v[1]),remoteAudio:a?{hasStream:!!a.srcObject,tracks:a.srcObject?a.srcObject.getTracks().map(t=>t.kind+':'+t.readyState):[]}:null}})
  console.log(n,JSON.stringify(s))
}
await charlie.screenshot({path:'jaas-charlie.png'}); await dana.screenshot({path:'jaas-dana.png'})
await browser.close()
