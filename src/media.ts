/** Media detection/extraction. Clef takes media in top-level images/audio/videos arrays, never inside state. */
export type MediaItem = string | { content_type: string; base64: string }

export interface Media {
  images: MediaItem[]
  audio: MediaItem[]
  videos: MediaItem[]
}

export const MEDIA_LIMITS = { images: 4, audio: 4, videos: 2 } as const

const DATA_URL = /^data:(image|audio|video)\/[a-z0-9.+-]+;base64,/i

export function emptyMedia(): Media {
  return { images: [], audio: [], videos: [] }
}

export function hasMedia(m: Media): boolean {
  return m.images.length + m.audio.length + m.videos.length > 0
}

export function overLimit(m: Media): boolean {
  return m.images.length > MEDIA_LIMITS.images || m.audio.length > MEDIA_LIMITS.audio || m.videos.length > MEDIA_LIMITS.videos
}

function bucket(m: Media, kind: string): MediaItem[] | null {
  const k = kind.toLowerCase()
  return k === 'image' ? m.images : k === 'audio' ? m.audio : k === 'video' ? m.videos : null
}

/**
 * Pulls embedded base64 media (data URLs or {content_type, base64} objects) out of `state`,
 * replacing each with a short placeholder. Also adopts caller-supplied top-level arrays.
 * Remote URLs are never treated as media.
 */
export function extractMedia(state: unknown, extra: { images?: unknown; audio?: unknown; videos?: unknown } = {}): { state: unknown; media: Media } {
  const media = emptyMedia()
  const adopt = (arr: unknown, target: MediaItem[]) => {
    if (Array.isArray(arr)) for (const x of arr) if (typeof x === 'string' || (x && typeof x === 'object')) target.push(x as MediaItem)
  }
  adopt(extra.images, media.images)
  adopt(extra.audio, media.audio)
  adopt(extra.videos, media.videos)

  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const m = DATA_URL.exec(v)
      if (m) {
        const target = bucket(media, m[1])!
        target.push(v)
        return `[${m[1].toLowerCase()} ${target.length}]`
      }
      return v
    }
    if (Array.isArray(v)) return v.map(walk)
    if (v && typeof v === 'object') {
      const o = v as Record<string, unknown>
      if (typeof o.content_type === 'string' && typeof o.base64 === 'string') {
        const target = bucket(media, o.content_type.split('/')[0])
        if (target) {
          target.push({ content_type: o.content_type, base64: o.base64 })
          return `[${o.content_type.split('/')[0]} ${target.length}]`
        }
      }
      return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, walk(x)]))
    }
    return v
  }
  return { state: walk(state), media }
}
