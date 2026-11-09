// Minimal Backblaze B2 client for the encrypted prod backups (docs/12
// "Backups"). Native B2 API v2 over fetch — no SDK, so every call the backup
// makes is readable right here.
//
// Used by:
//   scripts/backup-to-b2.mts           (GitHub Actions, WRITE-ONLY key)
//   scripts/backup-restore-from-b2.mts (founder's PC, READ-ONLY key)
import { createHash } from 'node:crypto'

export type B2Auth = {
  accountId: string
  authorizationToken: string
  apiUrl: string
  downloadUrl: string
  capabilities: string[]
  restrictedBucketId: string | null
  restrictedBucketName: string | null
}

// B2 answers errors as { status, code, message }. We keep the HTTP status and
// the code so callers can tell "this key lacks the capability" (401
// unauthorized) apart from anything else.
export type B2Result = { ok: boolean; status: number; code?: string; message?: string; body: any }

export async function authorize(keyId: string, appKey: string): Promise<B2Auth> {
  const res = await fetch('https://api.backblazeb2.com/b2api/v2/b2_authorize_account', {
    headers: { Authorization: 'Basic ' + Buffer.from(keyId + ':' + appKey).toString('base64') },
  })
  const body: any = await res.json()
  if (!res.ok) throw new Error(`b2_authorize_account failed: ${res.status} ${body.code} ${body.message}`)
  return {
    accountId: body.accountId,
    authorizationToken: body.authorizationToken,
    apiUrl: body.apiUrl,
    downloadUrl: body.downloadUrl,
    capabilities: body.allowed?.capabilities ?? [],
    restrictedBucketId: body.allowed?.bucketId ?? null,
    restrictedBucketName: body.allowed?.bucketName ?? null,
  }
}

// POST {apiUrl}/b2api/v2/<op> with a JSON body. Never throws on an API error —
// the negative probes NEED the error to inspect it.
export async function call(auth: B2Auth, op: string, payload: object): Promise<B2Result> {
  const res = await fetch(`${auth.apiUrl}/b2api/v2/${op}`, {
    method: 'POST',
    headers: { Authorization: auth.authorizationToken, 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const text = await res.text()
  let body: any = null
  try { body = JSON.parse(text) } catch { body = text }
  return { ok: res.ok, status: res.status, code: body?.code, message: body?.message, body }
}

export async function callOrThrow(auth: B2Auth, op: string, payload: object): Promise<any> {
  const r = await call(auth, op, payload)
  if (!r.ok) throw new Error(`${op} failed: ${r.status} ${r.code} ${r.message}`)
  return r.body
}

// B2_BUCKET may hold the bucket's NAME or its ID; accept either. A key that is
// restricted to one bucket says which in its authorize response; otherwise ask
// b2_list_buckets (needs the listBuckets capability).
export async function resolveBucketId(auth: B2Auth, bucket: string): Promise<string> {
  if (auth.restrictedBucketId) {
    if (bucket === auth.restrictedBucketId || bucket === auth.restrictedBucketName) return auth.restrictedBucketId
    throw new Error('This B2 key is restricted to a different bucket than B2_BUCKET names.')
  }
  for (const filter of [{ bucketName: bucket }, { bucketId: bucket }]) {
    const r = await call(auth, 'b2_list_buckets', { accountId: auth.accountId, ...filter })
    if (r.ok && r.body.buckets?.length === 1) return r.body.buckets[0].bucketId
  }
  throw new Error('Bucket named by B2_BUCKET was not found with this key.')
}

export function sha1Hex(bytes: Uint8Array): string {
  return createHash('sha1').update(bytes).digest('hex')
}

// b2_upload_file wants the name percent-encoded, with '/' left as-is.
function encodeFileName(name: string): string {
  return encodeURIComponent(name).replace(/%2F/g, '/')
}

// Upload one file with a COMPLIANCE-mode Object Lock retention. Compliance
// means nobody — not the account owner, not B2 support — can delete or
// shorten it before retainUntil. Needs the writeFileRetentions capability;
// without it B2 refuses the whole upload, which is what we want (a backup
// that silently landed unlocked would break the founder's rule).
export async function uploadLocked(
  auth: B2Auth,
  bucketId: string,
  fileName: string,
  bytes: Uint8Array,
  retainUntilMs: number,
): Promise<any> {
  const target = await callOrThrow(auth, 'b2_get_upload_url', { bucketId })
  const res = await fetch(target.uploadUrl, {
    method: 'POST',
    headers: {
      Authorization: target.authorizationToken,
      'X-Bz-File-Name': encodeFileName(fileName),
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(bytes.byteLength),
      'X-Bz-Content-Sha1': sha1Hex(bytes),
      'X-Bz-File-Retention-Mode': 'compliance',
      'X-Bz-File-Retention-Retain-Until-Timestamp': String(retainUntilMs),
    },
    body: bytes,
  })
  const body: any = await res.json()
  if (!res.ok) throw new Error(`upload of ${fileName} failed: ${res.status} ${body.code} ${body.message}`)
  return body
}

// Download a file by id. Returns the raw HTTP response so callers can both
// read the bytes (restore) and assert a refusal (the write-only key probe).
export async function downloadById(auth: B2Auth, fileId: string): Promise<Response> {
  return fetch(`${auth.downloadUrl}/b2api/v2/b2_download_file_by_id?fileId=${encodeURIComponent(fileId)}`, {
    headers: { Authorization: auth.authorizationToken },
  })
}
