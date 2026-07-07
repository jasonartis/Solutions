// `pnpm status` — shows what parts of the local platform are running.
import { execFileSync } from 'node:child_process'

// Note: no `shell: true` for docker calls — cmd.exe would interpret the `|`
// inside the --format string as a pipe. docker.exe resolves fine without it.
function dockerUp(): boolean {
  try {
    execFileSync('docker', ['info', '--format', '{{.ServerVersion}}'], { stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function supabaseContainers(): { name: string; status: string }[] {
  try {
    const out = execFileSync(
      'docker',
      ['ps', '-a', '--filter', 'name=Solutions_Platform', '--format', '{{.Names}}|{{.Status}}'],
      { encoding: 'utf8' },
    )
    return out
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => {
        const [name = '', status = ''] = line.split('|')
        return { name: name.replace('_Solutions_Platform', '').replace('supabase_', ''), status }
      })
  } catch {
    return []
  }
}

async function probe(url: string): Promise<string | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000), redirect: 'manual' })
    return `${res.status}`
  } catch {
    return null
  }
}

const OK = '  [UP]  '
const DOWN = ' [DOWN] '

async function main() {
  console.log('Solutions Platform — local status\n')

  const docker = dockerUp()
  console.log(`${docker ? OK : DOWN} Docker Desktop engine`)
  if (!docker) {
    console.log('\nDocker is not running — start Docker Desktop first, then `pnpm dev`.')
    process.exit(1)
  }

  const containers = supabaseContainers()
  if (containers.length === 0) {
    console.log(`${DOWN} Supabase stack (no containers — run \`pnpm dev\` or \`pnpm db:start\`)`)
  } else {
    for (const c of containers) {
      const healthy = /Up/.test(c.status)
      console.log(`${healthy ? OK : DOWN} db:${c.name.padEnd(10)} ${c.status}`)
    }
  }

  const web = await probe('http://localhost:3000/login')
  console.log(
    `${web ? OK : DOWN} web (Next.js)   ${web ? `http://localhost:3000 (HTTP ${web})` : 'not responding — run `pnpm dev`'}`,
  )

  const worker = await probe('http://localhost:8901/healthz')
  console.log(
    `${worker ? OK : DOWN} worker          ${worker ? 'http://localhost:8901/healthz' : 'not responding — run `pnpm dev`'}`,
  )

  if (containers.length > 0) {
    console.log('\nHandy URLs: app http://localhost:3000 · Studio http://127.0.0.1:54323 · Mailpit http://127.0.0.1:54324')
  }
}

main()
