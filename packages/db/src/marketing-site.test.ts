// Public marketing page (docs/35): the placeholder-filling contract. Pure string tests, no database.
import { readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { SITE_PLACEHOLDERS, fillSiteTemplate } from '@platform/core'

const here = dirname(fileURLToPath(import.meta.url))
const template = readFileSync(resolve(here, '../../../apps/web/site-source/template.html'), 'utf8')
const fill = (v: Parameters<typeof fillSiteTemplate>[1]) => fillSiteTemplate(template, v, { signinUrl: '/login' })

describe('marketing site template contract', () => {
  it('the copied template still contains all six placeholders (contract changed? update HANDOFF + the fill)', () => {
    for (const p of SITE_PLACEHOLDERS) expect(template).toContain(p)
    // ...and no OTHER placeholder has appeared that the fill would leave unfilled.
    const found = new Set(template.match(/\{\{[A-Z_]+\}\}/g))
    expect([...found].sort()).toEqual([...SITE_PLACEHOLDERS].sort())
  })

  it('fills every placeholder', () => {
    expect(fill({})).not.toMatch(/\{\{[A-Z_]+\}\}/)
  })

  it('makes no outside request: no external URL in a src/href/url()/import that loads something', () => {
    const page = fill({ phone: '1', whatsapp: '1', email: 'a@b.c', linkedin: 'https://linkedin.com/in/x' })
    expect(page).not.toMatch(/<(?:script|img|link|iframe)\b[^>]*\b(?:src|href)=["']https?:/i)
    expect(page).not.toMatch(/url\(\s*["']?https?:/i)
    expect(page).not.toMatch(/@import/i)
    expect(page).not.toMatch(/<form\b/i)
    expect(page).not.toMatch(/\bfetch\(|XMLHttpRequest|sendBeacon|document\.cookie|localStorage/)
  })

  it('empty contact values render nothing — not even a label', () => {
    const page = fill({})
    for (const s of ['tel:', 'wa.me', 'mailto:', 'class="li"', 'Message on WhatsApp']) expect(page).not.toContain(s)
    expect(page).toContain('Software Solutions') // default business name
    expect(page).toContain('const PHONE = "";')
  })

  it('renders each value in order: phone, WhatsApp, email, LinkedIn', () => {
    const page = fill({ phone: '(212) 555-0100', whatsapp: '+1 212 555 0101', email: 'hi@example.com', linkedin: 'https://linkedin.com/in/x' })
    const i = ['tel:2125550100', 'https://wa.me/12125550101', 'mailto:hi@example.com', 'href="https://linkedin.com/in/x"'].map((s) => page.indexOf(s))
    expect(i.every((n) => n > 0)).toBe(true)
    expect([...i].sort((a, b) => a - b)).toEqual(i)
  })

  it('escapes values; refuses a non-http LinkedIn URL; `</` cannot close the script', () => {
    const page = fill({ businessName: '<b>"Co" & Sons</b>', phone: '1</script><img>', linkedin: 'javascript:alert(1)' })
    expect(page).not.toContain('<b>"Co"')
    expect(page).toContain('&lt;b&gt;&quot;Co&quot; &amp; Sons&lt;/b&gt;')
    expect(page).not.toContain('javascript:')
    expect(page).toContain('1<\\/script><img>')
  })

  it('sign-in link points at the platform /login', () => {
    expect(fill({})).toContain('class="signin" href="/login"')
  })

  it('a replacement containing $& or $\' is inserted literally (String.replace patterns)', () => {
    // After HTML-escaping, "$& $'" becomes "$&amp; $&#x27;" — it must appear exactly so, once per placeholder (3x).
    const page = fill({ businessName: "$& $'" })
    expect(page.split('$&amp; $&#x27;').length - 1).toBe(3)
  })
})
