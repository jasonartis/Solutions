// Shrinks a picture IN THE BROWSER before it is uploaded (founder walkthrough
// 2026-10-14: any picture over 1 MB failed, because a Server Action's request
// body is capped — and Vercel caps request bodies at ~4.5 MB regardless). A
// phone photo is routinely 3-8 MB, so the fix belongs here, not in a bigger
// limit: the longest side is capped, and the result is re-encoded until it fits.
//
//   * Photos become JPEG; a picture with real transparency (a sticker, a cut-out)
//     stays PNG, because JPEG would paint its see-through areas black.
//   * SVG and GIF are passed through untouched (re-encoding would rasterise one
//     and freeze the other) — they only fail if they are over the budget as-is.
//   * Nothing is changed when the picture is already small enough.
//
// Pure browser code (createImageBitmap + canvas); imported by client components only.

/** What a server action will accept. next.config.ts sets bodySizeLimit to 4mb;
 *  this leaves room for the multipart wrapper and the other form fields. */
export const MAX_UPLOAD_BYTES = 3_200_000
const MAX_SIDE = 2048

export type PreparedImage = { ok: true; file: File } | { ok: false; reason: string }

const PASS_THROUGH = ['image/svg+xml', 'image/gif']

function toBlob(canvas: HTMLCanvasElement, type: string, quality?: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
}

function hasTransparency(canvas: HTMLCanvasElement): boolean {
  const ctx = canvas.getContext('2d')
  if (!ctx) return false
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height)
  for (let i = 3; i < data.length; i += 4) if (data[i]! < 255) return true
  return false
}

function renamed(file: File, blob: Blob, ext: string): File {
  const base = file.name.replace(/\.[^.]+$/, '') || 'picture'
  return new File([blob], `${base}.${ext}`, { type: blob.type })
}

export async function prepareImage(file: File): Promise<PreparedImage> {
  const tooBig = {
    ok: false as const,
    reason: 'That picture is too large to send, even after shrinking it. Try a smaller one.',
  }
  if (PASS_THROUGH.includes(file.type)) {
    return file.size <= MAX_UPLOAD_BYTES ? { ok: true, file } : tooBig
  }

  let bitmap: ImageBitmap
  try {
    // 'from-image' applies the photo's EXIF rotation, so a portrait phone
    // photo is not uploaded sideways.
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' })
  } catch {
    return { ok: false, reason: 'Could not read that picture. Try a JPEG or PNG.' }
  }

  const longest = Math.max(bitmap.width, bitmap.height)
  if (longest <= MAX_SIDE && file.size <= MAX_UPLOAD_BYTES) {
    bitmap.close()
    return { ok: true, file }
  }

  let scale = Math.min(1, MAX_SIDE / longest)
  // Each pass shrinks a little more until it fits; five passes take a picture
  // to ~24% of the starting width, far below anything worth sending.
  for (let pass = 0; pass < 5; pass++) {
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(bitmap.width * scale))
    canvas.height = Math.max(1, Math.round(bitmap.height * scale))
    const ctx = canvas.getContext('2d')
    if (!ctx) break
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height)

    const transparent = file.type !== 'image/jpeg' && hasTransparency(canvas)
    const blob = transparent
      ? await toBlob(canvas, 'image/png')
      : await toBlob(canvas, 'image/jpeg', pass === 0 ? 0.85 : 0.7)
    if (blob && blob.size <= MAX_UPLOAD_BYTES) {
      bitmap.close()
      return { ok: true, file: renamed(file, blob, transparent ? 'png' : 'jpg') }
    }
    scale *= 0.75
  }
  bitmap.close()
  return tooBig
}
