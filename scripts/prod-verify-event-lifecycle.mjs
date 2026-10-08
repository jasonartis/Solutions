// Drives PRODUCTION through the organizer/participant event lifecycle fixes of 2026-10-08:
// delete an empty event, refuse-by-absence of Delete when it has a registrant, withdraw ->
// organizer Reinstate, per-user status badges on the events list, duplicate names allowed
// but dated. Creates (and cleans up) events in prod's demo-dating org. Reads .env.deploy.
import { chromium } from 'playwright-core'
import { readFileSync } from 'node:fs'
const env=Object.fromEntries(readFileSync('.env.deploy','utf8').split('\n').filter(l=>/^[A-Z_]+=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]))
const BASE='https://solutions-platform.vercel.app', MOD=BASE+'/o/demo-dating/m/speed-dating'
const NAME='Lifecycle '+Date.now()
let fails=0; const check=(n,ok)=>{console.log(ok?'PASS':'FAIL',n); if(!ok)fails++}
const b=await chromium.launch()
async function ctx(email){const c=await b.newContext();const p=await c.newPage();await p.goto(BASE+'/login');await p.getByLabel('Email').fill(email);await p.getByLabel('Password').fill(env.PROD_DEMO_PASSWORD);await p.getByRole('button',{name:'Sign in'}).click();await p.getByRole('heading',{name:'Dashboard'}).waitFor({timeout:30000});return p}
const alice=await ctx('alice@demo.local'), charlie=await ctx('charlie@demo.local')
const create=async()=>{await alice.goto(MOD);await alice.locator('input[name="name"]').fill(NAME);await alice.getByRole('button',{name:'Create (draft)'}).click();await alice.waitForTimeout(2500)}
// duplicates allowed + dated
await create(); await create(); await alice.goto(MOD)
check('two events with the same name both exist, each dated', (await alice.getByRole('link',{name:NAME}).count())===2 && (await alice.getByText(/created /).count())>=2)
// delete an empty event
await alice.getByRole('link',{name:NAME}).first().click()
await alice.waitForURL(/events\//,{timeout:30000}); check('empty draft shows Delete event', await alice.getByRole('button',{name:'Delete event'}).waitFor({timeout:15000}).then(()=>true,()=>false))
await alice.getByRole('button',{name:'Delete event'}).click(); await alice.waitForURL(/speed-dating$/,{timeout:30000})
check('after delete exactly one remains', (await alice.getByRole('link',{name:NAME}).count())===1)
// open it, charlie registers, Delete disappears
await alice.getByRole('link',{name:NAME}).first().click(); await alice.waitForURL(/events\//,{timeout:30000}); const evUrl=alice.url()
await alice.getByRole('button',{name:'Open registration'}).click(); await alice.getByRole('button',{name:'Start event'}).waitFor()
await charlie.goto(MOD)
check('charlie sees it under Open for registration', await charlie.getByRole('heading',{name:'Open for registration'}).waitFor({timeout:15000}).then(()=>true,()=>false))
await charlie.getByRole('link',{name:NAME}).first().click(); await charlie.getByRole('button',{name:'Register for this event'}).click(); await charlie.getByText('You are registered').waitFor({timeout:30000})
await alice.reload()
check('Delete hidden once someone is registered', !(await alice.getByRole('button',{name:'Delete event'}).isVisible()))
await charlie.goto(MOD)
check('charlie list: "Your events" section with registered badge', await charlie.getByRole('heading',{name:'Your events'}).waitFor({timeout:15000}).then(()=>true,()=>false) && await charlie.getByText('registered',{exact:true}).first().isVisible())
// withdraw -> badge + message + organizer reinstate
await charlie.getByRole('link',{name:NAME}).first().click(); await charlie.getByRole('button',{name:'Withdraw'}).click(); await charlie.getByText(/You withdrew from this event/).waitFor({timeout:30000})
check('withdrawn person is told how to get back in', await charlie.getByText(/ask the organizer to reinstate/).isVisible())
await charlie.goto(MOD); check('list badge shows withdrawn', await charlie.getByText('withdrawn',{exact:true}).first().waitFor({timeout:15000}).then(()=>true,()=>false))
await alice.reload(); await alice.getByRole('button',{name:'Reinstate'}).click(); await alice.getByText('Roster (1 registered)').waitFor({timeout:30000})
check('organizer reinstated charlie (roster 1 registered)', await alice.getByText('Roster (1 registered)').isVisible())
await charlie.goto(evUrl); check('charlie is registered again and can Withdraw', await charlie.getByRole('button',{name:'Withdraw'}).waitFor({timeout:15000}).then(()=>true,()=>false))
// cancel, then Delete should remain hidden while he is registered; clean up: withdraw then delete
await charlie.getByRole('button',{name:'Withdraw'}).click(); await charlie.getByText(/You withdrew/).waitFor({timeout:30000})
await alice.reload(); await alice.getByRole('button',{name:'Delete event'}).click(); await alice.waitForURL(/speed-dating$/,{timeout:30000})
check('cleanup: no test events left', (await alice.getByRole('link',{name:NAME}).count())===0)
await b.close(); console.log(fails?`${fails} FAILED`:'ALL PASSED'); process.exit(fails?1:0)
