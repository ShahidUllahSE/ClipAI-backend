import fs from 'fs'
import path from 'path'

export type TimedWord = { word: string; start: number; end: number }
export type SpeedCut = { start: number; end: number; speed: number }
export type CaptionCue = { start: number; end: number; text: string }

function rampInactiveSpeed(level: 'off' | 'light' | 'medium' | 'aggressive') {
  switch (level) {
    case 'light':
      return 1.25
    case 'medium':
      return 1.5
    case 'aggressive':
      return 1.85
    default:
      return 1
  }
}

/**
 * Assign per-segment playback speed:
 * - Important / denser / louder moments stay near 1×
 * - Softer / longer / less dense segments accelerate (SOW §10.2)
 */
export function assignSegmentSpeeds(
  cuts: Array<{ start: number; end: number }>,
  level: 'off' | 'light' | 'medium' | 'aggressive',
  opts?: {
    words?: TimedWord[]
    /** Higher score = more important (keep slower) */
    importance?: number[]
  },
): SpeedCut[] {
  if (!cuts.length) return []
  if (level === 'off') {
    return cuts.map((c) => ({ ...c, speed: 1 }))
  }

  const inactive = rampInactiveSpeed(level)
  const durations = cuts.map((c) => Math.max(0.05, c.end - c.start))
  const median =
    [...durations].sort((a, b) => a - b)[Math.floor(durations.length / 2)] || 1

  return cuts.map((cut, i) => {
    const dur = durations[i]
    let importance = opts?.importance?.[i]

    if (importance === undefined && opts?.words?.length) {
      const wordsIn = opts.words.filter(
        (w) => w.start < cut.end && w.end > cut.start,
      )
      const spoken = wordsIn.reduce(
        (s, w) => s + Math.max(0, w.end - w.start),
        0,
      )
      importance = spoken / dur // speech density 0..1+
    }

    if (importance === undefined) {
      // Prefer shorter punchy moments at normal speed; long sections ramp
      importance = dur <= median * 0.85 ? 1 : 0.35
    }

    if (importance >= 0.55) return { ...cut, speed: 1 }
    if (importance >= 0.3) {
      return { ...cut, speed: Math.min(inactive, 1 + (inactive - 1) * 0.5) }
    }
    return { ...cut, speed: inactive }
  })
}

/** Map source-timeline words onto the edited output timeline (with speed). */
export function remapWordsToOutput(
  words: TimedWord[],
  cuts: SpeedCut[],
): TimedWord[] {
  const out: TimedWord[] = []
  let cursor = 0

  for (const cut of cuts) {
    const speed = cut.speed > 0 ? cut.speed : 1
    const cutDur = Math.max(0, cut.end - cut.start)
    for (const w of words) {
      if (w.end <= cut.start || w.start >= cut.end) continue
      const srcStart = Math.max(w.start, cut.start)
      const srcEnd = Math.min(w.end, cut.end)
      out.push({
        word: w.word,
        start: cursor + (srcStart - cut.start) / speed,
        end: cursor + (srcEnd - cut.start) / speed,
      })
    }
    cursor += cutDur / speed
  }

  return out
}

/** Group words into readable timed caption cues (SOW §10.4). */
export function wordsToCaptionCues(
  words: TimedWord[],
  maxWords = 6,
  maxSpan = 2.8,
): CaptionCue[] {
  if (!words.length) return []
  const cues: CaptionCue[] = []
  let bucket: TimedWord[] = []

  const flush = () => {
    if (!bucket.length) return
    cues.push({
      start: bucket[0].start,
      end: Math.max(bucket[bucket.length - 1].end, bucket[0].start + 0.4),
      text: bucket
        .map((w) => w.word.trim())
        .filter(Boolean)
        .join(' '),
    })
    bucket = []
  }

  for (const w of words) {
    if (!bucket.length) {
      bucket.push(w)
      continue
    }
    const span = w.end - bucket[0].start
    if (bucket.length >= maxWords || span >= maxSpan) flush()
    bucket.push(w)
  }
  flush()
  return cues.filter((c) => c.text.length > 0)
}

function srtStamp(seconds: number) {
  const msTotal = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(msTotal / 3_600_000)
  const m = Math.floor((msTotal % 3_600_000) / 60_000)
  const s = Math.floor((msTotal % 60_000) / 1000)
  const ms = msTotal % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

export function writeSrtFile(cues: CaptionCue[], filePath: string) {
  const body = cues
    .map(
      (c, i) =>
        `${i + 1}\n${srtStamp(c.start)} --> ${srtStamp(c.end)}\n${c.text}\n`,
    )
    .join('\n')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body, 'utf8')
  return filePath
}

export function totalOutputDuration(cuts: SpeedCut[]) {
  return cuts.reduce(
    (sum, c) => sum + Math.max(0, c.end - c.start) / (c.speed || 1),
    0,
  )
}
