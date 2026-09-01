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
  maxWords = 5,
  maxSpan = 2.4,
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
    const gap = w.start - bucket[bucket.length - 1].end
    const span = w.end - bucket[0].start
    if (gap >= 0.35 || bucket.length >= maxWords || span >= maxSpan) flush()
    bucket.push(w)
  }
  flush()
  return cues.filter((c) => c.text.length > 0)
}

function spokenWordEnd(word: TimedWord) {
  const letters = word.word.replace(/[^A-Za-z]/g, '').length
  const minDur = Math.min(0.85, Math.max(0.14, letters * 0.07))
  return Math.max(word.end, word.start + minDur)
}

/** Group words into spoken thoughts (sentence / pause), not 5-word chunks. */
export function wordsToSentenceCues(words: TimedWord[]): CaptionCue[] {
  if (!words.length) return []
  const cues: CaptionCue[] = []
  let bucket: TimedWord[] = []

  const flush = () => {
    if (!bucket.length) return
    const last = bucket[bucket.length - 1]
    cues.push({
      start: bucket[0].start,
      end: Math.max(spokenWordEnd(last), bucket[0].start + 0.35),
      text: bucket
        .map((w) => w.word.trim())
        .filter(Boolean)
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim(),
    })
    bucket = []
  }

  for (const w of words) {
    if (bucket.length) {
      const gap = w.start - bucket[bucket.length - 1].end
      if (gap >= 0.28) flush()
    }
    bucket.push(w)
    if (endsSpokenSentence(w.word) && bucket.length >= 2) flush()
  }
  flush()
  return splitCuesOnSentences(cues.filter((c) => c.text.length > 0))
}

export function mergeSpokenPhrases(phrases: CaptionCue[]): CaptionCue[] {
  if (!phrases.length) return []
  const merged: CaptionCue[] = []
  for (const phrase of phrases) {
    const prev = merged[merged.length - 1]
    const gap = prev ? phrase.start - prev.end : 99
    const dur = phrase.end - phrase.start
    if (
      prev &&
      !endsSpokenSentence(prev.text) &&
      (gap < 0.14 || (dur < 0.4 && gap < 0.35))
    ) {
      prev.end = Math.max(prev.end, phrase.end)
      prev.text = `${prev.text} ${phrase.text}`.replace(/\s+/g, ' ').trim()
    } else {
      merged.push({ ...phrase })
    }
  }
  return merged
}

/**
 * Keep each spoken thought as one cut. Drop pauses between thoughts.
 */
export function cutsFromPhrases(
  phrases: CaptionCue[],
  durationSeconds: number,
): Array<{ start: number; end: number }> {
  const merged = mergeSpokenPhrases(phrases)
  return merged.map((phrase, i) => {
    const next = merged[i + 1]
    const start = Math.max(0, phrase.start - 0.04)
    let end = phrase.end + 0.2
    if (next && next.start > phrase.end) {
      end = Math.min(end, next.start - 0.03)
    }
    return {
      start,
      end: Math.min(durationSeconds, Math.max(start + 0.3, end)),
    }
  })
}

/** One caption per keep-cut, using the spoken thought that lives in that cut. */
export function alignCaptionsToCuts(
  phrases: CaptionCue[],
  cuts: SpeedCut[],
): CaptionCue[] {
  const out: CaptionCue[] = []
  let cursor = 0
  for (const cut of cuts) {
    const speed = cut.speed > 0 ? cut.speed : 1
    const cutDur = Math.max(0, cut.end - cut.start)
    const mid = (cut.start + cut.end) / 2
    const phrase =
      phrases.find((p) => mid >= p.start && mid <= p.end) ||
      phrases.find((p) => p.end > cut.start && p.start < cut.end)
    if (phrase?.text.trim()) {
      out.push({
        text: phrase.text.trim(),
        start: cursor,
        end: cursor + cutDur / speed,
      })
    }
    cursor += cutDur / speed
  }
  return out
}

export function remapCuesToOutput(
  cues: CaptionCue[],
  cuts: SpeedCut[],
): CaptionCue[] {
  const out: CaptionCue[] = []
  let cursor = 0
  for (const cut of cuts) {
    const speed = cut.speed > 0 ? cut.speed : 1
    const cutDur = Math.max(0, cut.end - cut.start)
    for (const cue of cues) {
      if (cue.end <= cut.start || cue.start >= cut.end) continue
      const srcStart = Math.max(cue.start, cut.start)
      const srcEnd = Math.min(cue.end, cut.end)
      out.push({
        text: cue.text,
        start: cursor + (srcStart - cut.start) / speed,
        end: cursor + (srcEnd - cut.start) / speed,
      })
    }
    cursor += cutDur / speed
  }
  return out
}

function srtStamp(seconds: number) {
  const msTotal = Math.max(0, Math.round(seconds * 1000))
  const h = Math.floor(msTotal / 3_600_000)
  const m = Math.floor((msTotal % 3_600_000) / 60_000)
  const s = Math.floor((msTotal % 60_000) / 1000)
  const ms = msTotal % 1000
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},${String(ms).padStart(3, '0')}`
}

function wrapCaptionLine(text: string, maxChars = 26) {
  const words = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean)
  if (!words.length) return ''
  const lines: string[] = []
  let current = ''
  for (const word of words) {
    const next = current ? `${current} ${word}` : word
    if (next.length > maxChars && current) {
      lines.push(current)
      current = word
    } else {
      current = next
    }
  }
  if (current) lines.push(current)
  if (lines.length <= 2) return lines.join('\\N')
  return `${lines[0]}\\N${lines.slice(1).join(' ')}`
}

function maxCaptionChars(fontSize: number, playResX = 1080, margin = 72) {
  const usable = Math.max(360, playResX - margin * 2)
  return Math.max(18, Math.min(28, Math.floor(usable / (fontSize * 0.58))))
}

function endsSpokenSentence(text: string) {
  return /[.?!]["')\]]*$/.test(text.trim())
}

function splitCuesOnSentences(cues: CaptionCue[]): CaptionCue[] {
  const out: CaptionCue[] = []
  for (const cue of cues) {
    const parts = cue.text
      .split(/(?<=[.?!])["')\]]*\s+/)
      .map((part) => part.trim())
      .filter(Boolean)
    if (parts.length <= 1) {
      out.push(cue)
      continue
    }
    const totalChars = parts.reduce((sum, part) => sum + part.length, 0) || 1
    const span = Math.max(0.2, cue.end - cue.start)
    let t = cue.start
    for (let i = 0; i < parts.length; i++) {
      const dur =
        i === parts.length - 1
          ? Math.max(0.2, cue.end - t)
          : Math.max(0.2, span * (parts[i].length / totalChars))
      out.push({
        text: parts[i],
        start: t,
        end: Math.min(cue.end, t + dur),
      })
      t += dur
    }
  }
  return out
}

/** Map editor sizes onto a 1080×1920 canvas at movie-subtitle scale. */
export function assFontSizeFromUi(size?: number) {
  switch (size) {
    case 18:
      return 50
    case 22:
      return 58
    case 28:
      return 68
    case 36:
      return 78
    case 48:
      return 90
    default:
      return 58
  }
}

export function parseSrtFile(filePath: string): CaptionCue[] {
  const raw = fs.readFileSync(filePath, 'utf8').replace(/\r\n/g, '\n')
  const cues: CaptionCue[] = []
  for (const block of raw.split(/\n\n+/)) {
    const lines = block.trim().split('\n')
    if (lines.length < 2) continue
    const timeLine = lines.find((line) => line.includes('-->'))
    if (!timeLine) continue
    const [startRaw, endRaw] = timeLine.split('-->').map((part) => part.trim())
    const text = lines
      .filter((line) => line !== timeLine && !/^\d+$/.test(line.trim()))
      .join(' ')
      .replace(/<[^>]+>/g, '')
      .trim()
    if (!text) continue
    cues.push({
      start: parseSrtStamp(startRaw),
      end: parseSrtStamp(endRaw),
      text,
    })
  }
  return cues
}

function parseSrtStamp(stamp: string) {
  const match = stamp.match(/(\d+):(\d+):(\d+)[,.](\d+)/)
  if (!match) return 0
  const hours = Number(match[1])
  const minutes = Number(match[2])
  const seconds = Number(match[3])
  const fraction = Number(match[4].padEnd(3, '0').slice(0, 3))
  return hours * 3600 + minutes * 60 + seconds + fraction / 1000
}

export function writeSrtFile(cues: CaptionCue[], filePath: string) {
  const body = cues
    .filter((cue) => cue.text.trim())
    .map((cue, index) => {
      return `${index + 1}\n${srtStamp(cue.start)} --> ${srtStamp(cue.end)}\n${cue.text.trim()}\n`
    })
    .join('\n')
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, body, 'utf8')
  return filePath
}

function assStamp(seconds: number) {
  const csTotal = Math.max(0, Math.round(seconds * 100))
  const h = Math.floor(csTotal / 360_000)
  const m = Math.floor((csTotal % 360_000) / 6_000)
  const s = Math.floor((csTotal % 6_000) / 100)
  const cs = csTotal % 100
  return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`
}

export function writeAssFile(
  cues: CaptionCue[],
  filePath: string,
  style?: {
    fontName?: string
    fontSize?: number
    primaryColour?: string
    alignment?: number
    marginV?: number
  },
) {
  const fontName = style?.fontName ?? 'Arial'
  const fontSize = style?.fontSize ?? 58
  const primary = style?.primaryColour ?? '&H00FFFFFF'
  const alignment = style?.alignment ?? 2
  const marginV = style?.marginV ?? 80
  const marginH = 72
  const events = cues
    .filter((c) => c.text.trim())
    .map((c) => {
      const text = wrapCaptionLine(c.text, maxCaptionChars(fontSize, 1080, marginH))
      return `Dialogue: 0,${assStamp(c.start)},${assStamp(c.end)},Default,,0,0,0,,${text}`
    })
    .join('\n')

  const body = `[Script Info]
ScriptType: v4.00+
PlayResX: 1080
PlayResY: 1920
WrapStyle: 1
ScaledBorderAndShadow: yes

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,${fontName},${fontSize},${primary},&H000000FF,&H00000000,&H80000000,0,0,0,0,100,100,0,0,1,3,1,${alignment},${marginH},${marginH},${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
${events}
`
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
