import type { ClipMotion } from './ffmpeg'

type TimelineFxJson = {
  timeline?: {
    applyClipEffects?: boolean
    clipEffects?: unknown
    zoomKeyframes?: unknown
    transition?: { type?: unknown } | null
  }
  output?: {
    applyClipEffects?: boolean
    clipEffects?: unknown
    zoomKeyframes?: unknown
    zoom?: number
    transition?: { type?: unknown } | null
  }
}

function asJson(raw: unknown): TimelineFxJson | null {
  if (!raw || typeof raw !== 'object') return null
  return raw as TimelineFxJson
}

function mapFx(value: unknown): ClipMotion | null {
  if (typeof value !== 'string') return null
  if (
    value === 'none' ||
    value === 'punch' ||
    value === 'zoom-in' ||
    value === 'zoom-out' ||
    value === 'ken-burns' ||
    value === 'fade' ||
    value === 'slide-left' ||
    value === 'slide-right' ||
    value === 'blur' ||
    value === 'flash'
  ) {
    return value
  }
  return null
}

export function isApplyClipEffects(timelineJson: unknown): boolean {
  const json = asJson(timelineJson)
  return Boolean(json?.timeline?.applyClipEffects || json?.output?.applyClipEffects)
}

export function hasZoomKeyframes(timelineJson: unknown): boolean {
  const json = asJson(timelineJson)
  const frames = json?.timeline?.zoomKeyframes ?? json?.output?.zoomKeyframes
  return Array.isArray(frames) && frames.length > 0
}

/** Same selected effect on every keep-segment. Off unless Apply to all clips was used. */
export function perCutMotionsFromTimeline(
  timelineJson: unknown,
  cutCount: number,
): ClipMotion[] | undefined {
  if (!isApplyClipEffects(timelineJson) || cutCount < 1) return undefined
  const json = asJson(timelineJson)
  const listed = json?.timeline?.clipEffects ?? json?.output?.clipEffects
  const mapped = Array.isArray(listed)
    ? listed.map(mapFx).filter((item): item is ClipMotion => Boolean(item))
    : []
  const chosen =
    mapped[0] ??
    mapFx(json?.timeline?.transition?.type) ??
    mapFx(json?.output?.transition?.type)
  if (!chosen || chosen === 'none') return undefined
  return Array.from({ length: cutCount }, () => chosen)
}

function interpolateZoom(
  frames: Array<{ time: number; zoom: number }>,
  time: number,
): number {
  const sorted = [...frames].sort((a, b) => a.time - b.time)
  if (time <= sorted[0].time) return sorted[0].zoom
  const last = sorted[sorted.length - 1]
  if (time >= last.time) return last.zoom
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i]
    const b = sorted[i + 1]
    if (time >= a.time && time <= b.time) {
      const t = (time - a.time) / Math.max(0.001, b.time - a.time)
      return a.zoom + (b.zoom - a.zoom) * t
    }
  }
  return 1
}

function readZoomKeyframes(timelineJson: unknown): Array<{ time: number; zoom: number }> {
  const json = asJson(timelineJson)
  const raw = json?.timeline?.zoomKeyframes ?? json?.output?.zoomKeyframes
  if (!Array.isArray(raw)) return []
  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = item as { time?: unknown; zoom?: unknown }
      const time = Number(row.time)
      const zoom = Number(row.zoom)
      if (!Number.isFinite(time) || !Number.isFinite(zoom)) return null
      return {
        time,
        zoom: Math.min(2.4, Math.max(0.8, zoom)),
      }
    })
    .filter((item): item is { time: number; zoom: number } => Boolean(item))
}

/** Per-keep-segment zoom from editor keyframes. Missing keyframes → undefined (no extra zoom). */
export function extraZoomByCutFromTimeline(
  timelineJson: unknown,
  cuts: Array<{ start: number }>,
): number[] | undefined {
  const frames = readZoomKeyframes(timelineJson)
  if (!frames.length || !cuts.length) return undefined
  return cuts.map((cut) => interpolateZoom(frames, cut.start))
}
