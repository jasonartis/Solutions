// pnpm site:sync [path-to-website-folder]
//
// Picks up the latest public-website copy (docs/35). The MASTER, editable copy lives in the private
// Customers folder; this repo only holds a copy. Copies an ALLOWLIST of exactly:
//   website/template.html                 -> apps/web/site-source/template.html
//   website/fonts/*.woff2, README.txt     -> apps/web/public/site-fonts/
// Nothing else is ever listed, opened or copied (this repo is PUBLIC: no .env, no built index.html,
// no personal/ photo, no .md files). The source folder is read-only here — never written to.
// Prints what changed; commit the result yourself.
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const repo = resolve(here, '..')
const src = resolve(process.argv[2] ?? process.env.SITE_SOURCE_DIR ?? 'D:/Solutions Platform - Customers/website')

if (!existsSync(join(src, 'template.html'))) {
  console.error(`No template.html in ${src}. Pass the website folder: pnpm site:sync "<path>"`)
  process.exit(1)
}

const jobs: { from: string; to: string }[] = [
  { from: join(src, 'template.html'), to: join(repo, 'apps/web/site-source/template.html') },
]
// Fonts: list ONLY the fonts folder, and take only .woff2 files plus README.txt.
const fontsDir = join(src, 'fonts')
for (const f of readdirSync(fontsDir)) {
  if (f.endsWith('.woff2') || f === 'README.txt') {
    jobs.push({ from: join(fontsDir, f), to: join(repo, 'apps/web/public/site-fonts', f) })
  }
}

let changed = 0
for (const j of jobs) {
  const before = existsSync(j.to) ? readFileSync(j.to) : null
  const after = readFileSync(j.from)
  const same = before !== null && before.equals(after)
  if (!same) {
    mkdirSync(dirname(j.to), { recursive: true })
    copyFileSync(j.from, j.to)
    changed++
  }
  console.log(`${same ? 'unchanged' : before ? 'UPDATED  ' : 'NEW      '} ${j.to.replace(repo, '').replace(/\\/g, '/')}`)
}
console.log(changed ? `\n${changed} file(s) changed. Review with git diff, then commit.` : '\nAlready up to date.')
