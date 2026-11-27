// Public marketing page — placeholder filling (docs/35). Pure string logic, no I/O.
//
// The page's copy lives OUTSIDE this repo (the Customers folder); `pnpm site:sync` copies
// `template.html` into apps/web/site-source/. This file is a TypeScript reimplementation of that
// folder's build.py, following its HANDOFF.md contract: six placeholders, everything else is final
// HTML. Never edit the copy here — wording changes are made in the source folder.
//
// An EMPTY contact value produces NOTHING (not even a label). All values are HTML-escaped.

export interface SiteValues {
  businessName?: string
  phone?: string
  whatsapp?: string
  email?: string
  linkedin?: string
}

export const SITE_PLACEHOLDERS = [
  '{{BUSINESS_NAME}}',
  '{{CONTACT_BLOCK}}',
  '{{PHONE_JSON}}',
  '{{FONTS_CSS}}',
  '{{SIGNIN_LINK}}',
  '{{PHOTO}}',
] as const

const DEFAULT_BUSINESS_NAME = 'Software Solutions'

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#x27;')
}

const LINKEDIN_SVG =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.45 20.45h-3.56v-5.57c0-1.33-.02-3.04-1.85-3.04' +
  '-1.85 0-2.14 1.45-2.14 2.94v5.67H9.35V9h3.41v1.56h.05c.48-.9 1.64-1.85 3.37-1.85 3.6 0 4.27 2.37 4.27 5.46' +
  'v6.28zM5.34 7.43a2.06 2.06 0 1 1 0-4.13 2.06 2.06 0 0 1 0 4.13zM7.12 20.45H3.56V9h3.56v11.45zM22.22 0H1.77' +
  'C.79 0 0 .77 0 1.73v20.54C0 23.23.79 24 1.77 24h20.45c.98 0 1.78-.77 1.78-1.73V1.73C24 .77 23.2 0 22.22 0z"/></svg>'

// Person icon shown instead of the words on narrow screens
const AVATAR_SVG =
  '<svg class="signin-icon" viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" ' +
  'stroke-width="1.8" stroke-linecap="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="10" r="3.2"/>' +
  '<path d="M6.2 18.6c1.3-2.3 3.4-3.4 5.8-3.4s4.5 1.1 5.8 3.4"/></svg>'

// Variable fonts, latin subset, served from our own /site-fonts/ (no Google Fonts request).
const FONTS: [family: string, file: string, weights: string][] = [
  ['Bricolage Grotesque', 'bricolage-grotesque.woff2', '200 800'],
  ['Public Sans', 'public-sans.woff2', '100 900'],
  ['JetBrains Mono', 'jetbrains-mono.woff2', '100 800'],
]

function fontsCss(): string {
  return FONTS.map(
    ([family, file, weights]) =>
      `@font-face{font-family:'${family}';font-style:normal;font-weight:${weights};font-display:swap;` +
      `src:url(/site-fonts/${file}) format('woff2')}`,
  ).join('\n')
}

// Only http(s) links are allowed for LinkedIn: an href of `javascript:` must never reach the page.
function safeHttpUrl(u: string): string {
  return /^https?:\/\//i.test(u) ? u : ''
}

export function contactBlock(v: SiteValues): string {
  const items: string[] = []
  const phone = (v.phone ?? '').trim()
  if (phone) {
    const digits = phone.replace(/[^\d+]/g, '')
    items.push(`<span class="addr"><a href="tel:${escapeHtml(digits)}">${escapeHtml(phone)}</a></span>`)
  }
  const wa = (v.whatsapp ?? '').trim()
  const waNum = wa.replace(/\D/g, '')
  if (waNum) {
    items.push(`<a class="btn" href="https://wa.me/${waNum}" target="_blank" rel="noopener">Message on WhatsApp</a>`)
  }
  const email = (v.email ?? '').trim()
  if (email) {
    items.push(`<span class="addr"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></span>`)
  }
  const li = safeHttpUrl((v.linkedin ?? '').trim())
  if (li) {
    items.push(
      `<a class="li" href="${escapeHtml(li)}" target="_blank" rel="noopener" aria-label="LinkedIn profile">${LINKEDIN_SVG}LinkedIn</a>`,
    )
  }
  return items.map((i) => '      ' + i).join('\n')
}

export function signinLink(url: string): string {
  if (!url) return ''
  return (
    `      <a class="signin" href="${escapeHtml(url)}" aria-label="Client sign in">${AVATAR_SVG}` +
    '<span class="signin-text">Client sign in</span></a>'
  )
}

export function fillSiteTemplate(template: string, v: SiteValues, opts: { signinUrl: string; photoHtml?: string }): string {
  const name = (v.businessName ?? '').trim() || DEFAULT_BUSINESS_NAME
  // Sits inside <script>: `</` must not be able to close it.
  const phoneJson = JSON.stringify((v.phone ?? '').trim()).replace(/<\//g, '<\\/')
  // split/join, never String.replace with a replacement STRING ($& etc. are patterns there).
  const rep = (s: string, key: string, val: string) => s.split(key).join(val)
  let page = template
  page = rep(page, '{{FONTS_CSS}}', fontsCss())
  page = rep(page, '{{PHONE_JSON}}', phoneJson)
  page = rep(page, '{{BUSINESS_NAME}}', escapeHtml(name))
  page = rep(page, '{{CONTACT_BLOCK}}', contactBlock(v))
  page = rep(page, '{{PHOTO}}', opts.photoHtml ?? '')
  page = rep(page, '{{SIGNIN_LINK}}', signinLink(opts.signinUrl))
  return page
}
