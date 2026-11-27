// The public marketing page (docs/35). Reached at `/` by signed-out visitors who have never
// signed in (proxy.ts rewrites to here); also directly at /site.
//
// A route handler, not a React page: the template is a whole HTML document, and this keeps the
// app's root layout (fonts, boot script) out of it entirely.
//
// The page must make NO outside requests (no analytics, no cookies, no forms, no third-party
// scripts or fonts — that is what keeps it free of a privacy-policy requirement). That is
// ENFORCED, not just promised: the response carries a CSP that allows only this page's own inline
// <style>/<script> blocks (by SHA-256 hash) and our own fonts; the browser refuses everything else.
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { fillSiteTemplate } from '@platform/core'

// Read at request time, so changing a Vercel env value needs no rebuild.
export const dynamic = 'force-dynamic'

function inlineHashes(html: string, tag: 'style' | 'script'): string[] {
  const out: string[] = []
  const re = new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>`, 'g')
  for (const m of html.matchAll(re)) {
    out.push(`'sha256-${createHash('sha256').update(m[1]!, 'utf8').digest('base64')}'`)
  }
  return out
}

export function GET() {
  const template = readFileSync(join(process.cwd(), 'site-source', 'template.html'), 'utf8')
  const html = fillSiteTemplate(
    template,
    {
      businessName: process.env.BUSINESS_NAME,
      phone: process.env.CONTACT_PHONE,
      whatsapp: process.env.CONTACT_WHATSAPP,
      email: process.env.CONTACT_EMAIL,
      linkedin: process.env.LINKEDIN_URL,
    },
    { signinUrl: '/login' },
  )

  const csp = [
    "default-src 'none'",
    `style-src ${inlineHashes(html, 'style').join(' ')}`,
    `script-src ${inlineHashes(html, 'script').join(' ')}`,
    "font-src 'self'",
    "img-src 'self' data:",
    "connect-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join('; ')

  return new Response(html, {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': csp,
      'cache-control': 'public, max-age=0, s-maxage=300, stale-while-revalidate=3600',
      'referrer-policy': 'strict-origin-when-cross-origin',
      'x-content-type-options': 'nosniff',
    },
  })
}
