// Drives PRODUCTION through the `closed` event state (20261027010000): back to draft while empty, close
// registration once someone is registered (back to draft no longer offered), a closed event is editable,
// a new dater sees "Registration is closed" with no Register button while a registered dater can still
// withdraw, reopen lets that dater register (control), and back to draft works again once everyone has
// withdrawn. Creates and deletes its own event in prod's demo-dating org (demo data only). Reads
// .env.deploy. Run: node scripts/prod-verify-closed-state.mjs
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1).replace(/\r$/,'')]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating'
const PREFIX='Closed state check ', NAME=PREFIX+Date.now()
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const ok=(p,t=20000)=>p.waitFor({timeout:t}).then(()=>true,()=>false)
const b=await chromium.launch()
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local'), dana=await ctx('dana@demo.local')
const stateIs=(p,s)=>ok(p.getByText(s,{exact:true}).first(),30000)
try {
  await alice.goto(MOD)
  await alice.locator('input[name="name"]').fill(NAME)
  await alice.getByRole('button',{name:'Create (draft)'}).click()
  await alice.getByRole('link',{name:NAME}).click(); await alice.waitForURL(/events\//,{timeout:30000}); const evUrl=alice.url().split('?')[0]
  await alice.getByRole('button',{name:'Open registration'}).click()
  check('open + empty: "Back to draft" is offered', await ok(alice.getByRole('button',{name:'Back to draft'}),30000))
  await alice.getByRole('button',{name:'Back to draft'}).click()
  check('back to draft works while empty', await stateIs(alice,'draft'))
  await alice.getByRole('button',{name:'Open registration'}).click()
  await alice.getByRole('button',{name:'Close registration'}).waitFor({timeout:30000})

  await charlie.goto(evUrl); await charlie.getByRole('button',{name:'Register for this event'}).click()
  check('charlie registers while open', await ok(charlie.getByText('You are registered'),30000))

  await alice.goto(evUrl)
  check('with a registration, "Back to draft" is NOT offered', (await alice.getByRole('button',{name:'Back to draft'}).count())===0)
  check('...and the hint says why', await ok(alice.getByText(/Back to draft is only available while nobody is registered/)))
  await alice.getByRole('button',{name:'Close registration'}).click()
  check('close -> state reads "registration closed"', await stateIs(alice,'registration closed'))
  check('closed: "Reopen registration" and "Start event" offered', await ok(alice.getByRole('button',{name:'Reopen registration'})) && await alice.getByRole('button',{name:'Start event'}).isVisible())
  await alice.goto(evUrl+'/edit'); await alice.waitForTimeout(2000)
  check('a closed event can be edited (stays on /edit)', /\/edit/.test(alice.url()) && await ok(alice.getByRole('button',{name:'Save changes'})))
  check('edit page says nobody is notified', await ok(alice.getByText(/Nobody is notified of changes/)))

  await dana.goto(evUrl)
  check('dana (no seat) sees "Registration is closed for this event."', await ok(dana.getByText('Registration is closed for this event.'),30000))
  check('dana has no Register button', (await dana.getByRole('button',{name:'Register for this event'}).count())===0)
  await charlie.goto(evUrl)
  check('charlie (registered) can still Withdraw while closed', await ok(charlie.getByRole('button',{name:'Withdraw'})))

  await alice.goto(evUrl); await alice.getByRole('button',{name:'Reopen registration'}).click()
  check('reopen -> "Close registration" offered again', await ok(alice.getByRole('button',{name:'Close registration'}),30000))
  await dana.goto(evUrl); await dana.getByRole('button',{name:'Register for this event'}).click()
  check('CONTROL: dana registers once reopened', await ok(dana.getByText('You are registered'),30000))

  for (const p of [charlie,dana]) { await p.goto(evUrl); await p.getByRole('button',{name:'Withdraw'}).click(); await p.getByText(/You withdrew/).waitFor({timeout:30000}) }
  await alice.goto(evUrl)
  check('everyone withdrew -> "Back to draft" offered again', await ok(alice.getByRole('button',{name:'Back to draft'})))
  await alice.getByRole('button',{name:'Back to draft'}).click()
  check('...and works (withdrawn seats do not block it)', await stateIs(alice,'draft'))
} catch (e) { console.log('ERROR', String(e).slice(0,500)); fails++
} finally {
  // sweep EVERY leftover from this script (earlier aborted runs included): withdraw both daters, then delete
  for (let guard=0; guard<6; guard++) {
    await alice.goto(MOD); const l=alice.getByRole('link',{name:new RegExp('^'+PREFIX)}); if(!(await l.count())) break
    await l.first().click(); await alice.waitForURL(/events\//,{timeout:30000}); const url=alice.url().split('?')[0]
    for (const p of [charlie,dana]) { await p.goto(url); const w=p.getByRole('button',{name:'Withdraw'}); if(await w.isVisible()){ await w.click(); await p.getByText(/You withdrew/).waitFor({timeout:30000}) } }
    await alice.goto(url); const d=alice.getByRole('button',{name:'Delete event'}); if(await d.isVisible()){ await d.click(); await alice.waitForURL(/speed-dating$/,{timeout:30000}) } else break
  }
  await alice.goto(MOD); check('cleanup: no test events left', (await alice.getByRole('link',{name:new RegExp('^'+PREFIX)}).count())===0)
  await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
}
