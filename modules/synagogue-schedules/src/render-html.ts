import { formatMinutes } from './evaluator'
import type { GeneratedDocument } from './generator'

// Renders generated schedule documents as a self-contained HTML page.
// The same HTML serves every export profile (docs/modules/module-3): the
// worker screenshots it at different widths for JPGs and prints it for PDF.
// Grayscale is applied via CSS filter when the profile asks for it.

export type Branding = {
  orgName: string
  logoUrl?: string | null
  accentColor?: string | null
  fontFamily?: string | null
}

export type RenderOptions = {
  grayscale?: boolean
  /** Subtitle under the org name, e.g. "Week of Jul 5, 2026". */
  subtitle?: string
}

function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

export function renderScheduleHtml(
  documents: GeneratedDocument[],
  branding: Branding,
  options: RenderOptions = {},
): string {
  const accent = branding.accentColor ?? '#1d4ed8'
  const font = branding.fontFamily ?? 'Georgia, "Times New Roman", serif'

  const docsHtml = documents
    .map((doc) => {
      const sectionsHtml = doc.sections
        .map((section) => {
          const linesHtml = section.lines
            .map((line) => {
              const time = line.text
                ? `<em class="fallback">${esc(line.text)}</em>`
                : line.uniform
                ? line.timeMinutes !== null
                  ? esc(formatMinutes(line.timeMinutes))
                  : ''
                : line.perDay
                    .map(
                      (p) =>
                        `<span class="perday"><span class="dow">${esc(
                          new Date(`${p.date}T12:00:00`).toLocaleDateString('en-US', {
                            weekday: 'short',
                          }),
                        )}</span> ${p.timeMinutes !== null ? esc(formatMinutes(p.timeMinutes)) : ''}</span>`,
                    )
                    .join(' ')
              const hebrew = line.nameHebrew ? `<span class="hebrew">${esc(line.nameHebrew)}</span>` : ''
              return `<tr><td class="line-name">${esc(line.name)} ${hebrew}</td><td class="line-time">${time}</td></tr>`
            })
            .join('')
          const overridesHtml = section.overrides
            .map((o) => {
              const heb = o.textHebrew ? ` <span class="hebrew">${esc(o.textHebrew)}</span>` : ''
              return `<tr><td colspan="2" class="override">${esc(o.text ?? '')}${heb}</td></tr>`
            })
            .join('')
          const hebName = section.nameHebrew
            ? ` <span class="hebrew">${esc(section.nameHebrew)}</span>`
            : ''
          return `<h3 class="section-name">${esc(section.name)}${hebName}</h3>
<table class="lines">${linesHtml}${overridesHtml}</table>`
        })
        .join('')

      const dateLabel =
        doc.dates.length === 1
          ? new Date(`${doc.dates[0]}T12:00:00`).toLocaleDateString('en-US', {
              weekday: 'long',
              month: 'long',
              day: 'numeric',
            })
          : `${new Date(`${doc.dates[0]}T12:00:00`).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })} – ${new Date(
              `${doc.dates[doc.dates.length - 1]}T12:00:00`,
            ).toLocaleDateString('en-US', { month: 'short', day: 'numeric' })}`

      return `<div class="doc">
  <h2 class="doc-title">${esc(doc.title)}</h2>
  <p class="doc-dates">${esc(dateLabel)}</p>
  ${sectionsHtml}
</div>`
    })
    .join('')

  const logo = branding.logoUrl ? `<img class="logo" src="${esc(branding.logoUrl)}" alt="" />` : ''
  const subtitle = options.subtitle ? `<p class="subtitle">${esc(options.subtitle)}</p>` : ''

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    font-family: ${font};
    color: #1a1a1a;
    padding: 32px;
    ${options.grayscale ? 'filter: grayscale(1);' : ''}
  }
  .header { text-align: center; margin-bottom: 24px; border-bottom: 3px double ${accent}; padding-bottom: 12px; }
  .logo { max-height: 64px; margin-bottom: 8px; }
  .org-name { font-size: 26px; color: ${accent}; }
  .subtitle { font-size: 14px; color: #555; margin-top: 4px; }
  .docs { display: flex; flex-wrap: wrap; gap: 32px; justify-content: center; }
  .doc { flex: 1 1 340px; max-width: 480px; }
  .doc-title { font-size: 19px; color: ${accent}; border-bottom: 1px solid #ccc; padding-bottom: 4px; }
  .doc-dates { font-size: 12px; color: #777; margin: 2px 0 10px; }
  .section-name { font-size: 13px; text-transform: uppercase; letter-spacing: 0.06em; color: #555; margin: 12px 0 4px; }
  table.lines { width: 100%; border-collapse: collapse; font-size: 15px; }
  table.lines td { padding: 3px 0; vertical-align: top; }
  td.line-name { text-align: left; }
  td.line-time { text-align: right; font-weight: 600; white-space: normal; }
  .perday { white-space: nowrap; margin-left: 8px; font-size: 12px; font-weight: 500; }
  .perday .dow { color: #999; font-weight: 400; }
  td.override { font-style: italic; color: #444; padding-top: 6px; }
  .hebrew { direction: rtl; unicode-bidi: isolate; }
  @media print { body { padding: 0; } }
</style>
</head>
<body>
  <div class="header">
    ${logo}
    <h1 class="org-name">${esc(branding.orgName)}</h1>
    ${subtitle}
  </div>
  <div class="docs">${docsHtml}</div>
</body>
</html>`
}
