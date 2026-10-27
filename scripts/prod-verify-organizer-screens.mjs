// Drives PRODUCTION through the organizer screens of 2026-10-26 (291f316): round/break length with the
// live plan preview at creation, the "you organize" label, Edit details on a draft, an edit refused on a
// cancelled event, and a sides-locked refusal once someone has registered. Creates and deletes its own
// event in prod's demo-dating org (demo data only). Reads .env.deploy. Run: node scripts/prod-verify-organizer-screens.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating'
const NAME='Organizer screens '+Date.now()
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch()
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local')
try {
  await alice.goto(MOD)
  await alice.locator('input[name="name"]').fill(NAME)
  // re-fill until it sticks: a fill before hydration is reset by React's defaults
  let preview=false
  for (let i=0;i<8&&!preview;i++){
    await alice.getByLabel('Round length').fill('5'); await alice.getByLabel('Break between rounds').fill('60'); await alice.getByLabel('People you expect').fill('8')
    preview=await alice.getByText('8 people, up to 7 rounds, about 41 minutes').waitFor({timeout:1500}).then(()=>true,()=>false)
  }
  check('create form: live preview reads "8 people, up to 7 rounds, about 41 minutes"', preview)
  await alice.getByRole('button',{name:'Create (draft)'}).click()
  check('events list: organizer sees "you organize" on the new event', await ok(alice.getByRole('link',{name:NAME})) && await alice.getByText('you organize').first().isVisible())
  await alice.getByRole('link',{name:NAME}).click(); await alice.waitForURL(/events\//,{timeout:30000}); const evUrl=alice.url().split('?')[0]
  check('console shows "Rounds of 5 min with 60s breaks"', await ok(alice.getByText('Rounds of 5 min with 60s breaks')))
  await alice.getByRole('link',{name:'Edit details'}).click()
  check('edit form is prefilled with 5 / 60', await ok(alice.getByLabel('Round length')) && (await alice.getByLabel('Round length').inputValue())==='5' && (await alice.getByLabel('Break between rounds').inputValue())==='60')
  const renamed=NAME+' (edited)'
  await alice.getByPlaceholder('Event name').fill(renamed); await alice.getByLabel('Round length').fill('4')
  await alice.getByRole('button',{name:'Save changes'}).click()
  check('save -> "Event updated." and new name shown', await ok(alice.getByText('Event updated.')) && await alice.getByRole('heading',{name:renamed}).isVisible())
  check('new timing shown: "Rounds of 4 min"', await ok(alice.getByText('Rounds of 4 min with 60s breaks')))
  // open, charlie registers, then enabling sides must be refused (sides lock)
  await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor({timeout:30000})
  await charlie.goto(evUrl); await charlie.getByRole('button',{name:'Register for this event'}).click(); await charlie.getByText('You are registered').waitFor({timeout:30000})
  await alice.goto(evUrl+'/edit'); await alice.getByText('Two sides (e.g. Men/Women)').waitFor({timeout:20000})
  await alice.getByText('Two sides (e.g. Men/Women)').click()
  await alice.getByLabel('Enable two sides').check(); await alice.getByPlaceholder('Side A label (e.g. Men)').fill('Men'); await alice.getByPlaceholder('Side B label (e.g. Women)').fill('Women')
  await alice.getByRole('button',{name:'Save changes'}).click()
  check('sides change refused once someone is registered', await ok(alice.getByText(/people have already registered on a side/)))
  // cleanup: charlie withdraws, organizer cancels; edit is then refused; delete the empty event
  await charlie.getByRole('button',{name:'Withdraw'}).click(); await charlie.getByText(/You withdrew/).waitFor({timeout:30000})
  await alice.goto(evUrl); await alice.getByRole('button',{name:'Cancel event'}).click(); await alice.getByText('cancelled',{exact:true}).first().waitFor({timeout:30000})
  await alice.goto(evUrl+'/edit'); await alice.waitForTimeout(3000)
  check('a cancelled event cannot be edited (redirected off /edit)', !/\/edit/.test(alice.url()))
} catch (e) { console.log('ERROR', String(e).slice(0,500)); fails++
} finally {
  await alice.goto(MOD).catch(()=>{})
  // sweep EVERY leftover from this script (earlier aborted runs included): withdraw charlie, then delete
  for (let guard=0; guard<6; guard++) {
    await alice.goto(MOD); const l=alice.getByRole('link',{name:/^Organizer screens /}); if(!(await l.count())) break
    await l.first().click(); await alice.waitForURL(/events\//,{timeout:30000}); const url=alice.url().split('?')[0]
    await charlie.goto(url); const w=charlie.getByRole('button',{name:'Withdraw'}); if(await w.isVisible()){ await w.click(); await charlie.getByText(/You withdrew/).waitFor({timeout:30000}) }
    await alice.goto(url); const d=alice.getByRole('button',{name:'Delete event'}); if(await d.isVisible()){ await d.click(); await alice.waitForURL(/speed-dating$/,{timeout:30000}) } else break
  }
  await alice.goto(MOD); check('cleanup: no test events left', (await alice.getByRole('link',{name:/^Organizer screens /}).count())===0)
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
