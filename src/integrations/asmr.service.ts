import fs from 'fs'
import path from 'path'
import { env } from '../config'
import { extractJsonObject, geminiGenerateText } from './gemini'
import type { SilenceSensitivity } from './ffmpeg'
import {
  detectLoudKeepCuts,
  detectSilenceRanges,
  probeDuration,
  probeHasAudio,
  renderJumpCutVideo,
  silenceToKeepCuts,
  type ClipMotion,
} from './ffmpeg'
import {
  extraZoomByCutFromTimeline,
  perCutMotionsFromTimeline,
} from './timeline-fx'
import {
  assignSegmentSpeeds,
  totalOutputDuration,
  type SpeedCut,
  type TimedWord,
} from './timed-edit'
import {
  detectSpeechActivity,
  flagRuns,
  type SpeechMap,
} from './speech-activity'
import { transcribeSourceAudio } from './groq-transcribe'

export interface AsmrResult {
  provider: 'ffmpeg' | 'ffmpeg+gemini'
  durationSeconds: number
  outputDurationSeconds: number
  removedSeconds: number
  silenceRanges: Array<{ start: number; end: number }>
  cuts: SpeedCut[]
  segmentSpeedApplied: boolean
  summary: string
  category: string
  outputPath: string
  outputUrl: string
  notes: string[]
}

type Pacing = 'normal' | 'fast' | 'very-fast'

function asmrSilenceLevel(level: SilenceSensitivity): SilenceSensitivity {
  // ASMR needs stronger quiet detection than talking-head (WhatsApp noise floors)
  if (level === 'light') return 'medium'
  if (level === 'medium') return 'aggressive'
  return 'aggressive'
}

function pacingKeepRatio(pacing: Pacing): number {
  // Keep enough content so social edits don't collapse to a couple of seconds
  if (pacing === 'very-fast') return 0.55
  if (pacing === 'fast') return 0.65
  return 0.75
}

function minimumKeepSeconds(duration: number): number {
  return Math.min(duration * 0.9, Math.max(10, duration * 0.3))
}

function pacingTrim(
  cuts: Array<{ start: number; end: number }>,
  pacing: Pacing,
): Array<{ start: number; end: number }> {
  if (cuts.length <= 2) return cuts
  if (pacing === 'normal') return cuts
  if (pacing === 'fast') {
    const sorted = [...cuts].sort(
      (a, b) => b.end - b.start - (a.end - a.start),
    )
    return sorted.slice(0, Math.max(2, Math.ceil(cuts.length * 0.75))).sort(
      (a, b) => a.start - b.start,
    )
  }
  const sorted = [...cuts].sort((a, b) => b.end - b.start - (a.end - a.start))
  return sorted.slice(0, Math.max(2, Math.ceil(cuts.length * 0.55))).sort(
    (a, b) => a.start - b.start,
  )
}

function totalKeep(cuts: Array<{ start: number; end: number }>) {
  return cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
}

/** A keep-clip is included only if it contains at least this much real sound. */
const MIN_SOUND_SECONDS = 0.55

function overlapSeconds(
  cut: { start: number; end: number },
  range: { start: number; end: number },
) {
  const start = Math.max(cut.start, range.start)
  const end = Math.min(cut.end, range.end)
  return Math.max(0, end - start)
}

function soundSecondsInCut(
  cut: { start: number; end: number },
  silenceRanges: Array<{ start: number; end: number }>,
) {
  const silent = silenceRanges.reduce(
    (sum, range) => sum + overlapSeconds(cut, range),
    0,
  )
  return Math.max(0, cut.end - cut.start - silent)
}

function trimSilentEdges(
  cut: { start: number; end: number },
  silenceRanges: Array<{ start: number; end: number }>,
): { start: number; end: number } | null {
  let start = cut.start
  let end = cut.end
  for (const range of silenceRanges) {
    if (range.start <= start + 0.08 && range.end > start) {
      start = Math.max(start, range.end)
    }
    if (range.end >= end - 0.08 && range.start < end) {
      end = Math.min(end, range.start)
    }
  }
  if (end - start < 0.2) return null
  return { start, end }
}

function keepClipsWithMinSound(
  cuts: Array<{ start: number; end: number }>,
  silenceRanges: Array<{ start: number; end: number }>,
  minSound: number,
) {
  const trimmed = cuts
    .map((cut) => trimSilentEdges(cut, silenceRanges))
    .filter((cut): cut is { start: number; end: number } => Boolean(cut))
  const withSound = trimmed.filter(
    (cut) => soundSecondsInCut(cut, silenceRanges) >= minSound,
  )
  if (withSound.length) return withSound
  if (trimmed.length) return trimmed
  return cuts
}

type Span = { start: number; end: number }

/** Speech runs closer than this count as one spoken phrase. */
const DIALOG_MERGE_GAP = 0.35
/** Air kept around each phrase so word onsets and tails are not clipped. */
const DIALOG_PRE = 0.06
const DIALOG_POST = 0.15
const DIALOG_MIN_SECONDS = 0.25
/** Less speech than this means the clip has no real dialog. */
const DIALOG_MIN_TOTAL = 1
/** ASMR sound bits: non-dialog moments, each between MIN and MAX seconds. */
const SOUND_BIT_MIN = 0.4
const SOUND_BIT_MAX = 2
/** Sound bits stay under this share of the finished edit. */
const SOUND_BIT_MAX_SHARE = 0.3

function mergeSpans(spans: Span[]): Span[] {
  const merged: Span[] = []
  for (const span of [...spans].sort((a, b) => a.start - b.start)) {
    const last = merged[merged.length - 1]
    if (last && span.start <= last.end) last.end = Math.max(last.end, span.end)
    else merged.push({ ...span })
  }
  return merged
}

/**
 * Voice runs become phrases. When a transcript exists, a phrase with no
 * spoken word is not dialog (beeps, clicks and handling noise often read as
 * voice to the pitch check), so it is dropped.
 */
function dialogSpans(voice: Span[], words: TimedWord[], duration: number): Span[] {
  const phrases: Span[] = []
  for (const run of voice) {
    const last = phrases[phrases.length - 1]
    if (last && run.start - last.end < DIALOG_MERGE_GAP) last.end = run.end
    else phrases.push({ ...run })
  }
  const spoken = words.length
    ? phrases.filter((phrase) =>
        words.some((w) => w.end > phrase.start - 0.1 && w.start < phrase.end + 0.1),
      )
    : phrases
  return mergeSpans(
    spoken
      .map((phrase) => ({
        start: Math.max(0, phrase.start - DIALOG_PRE),
        end: Math.min(duration, phrase.end + DIALOG_POST),
      }))
      .filter((phrase) => phrase.end - phrase.start >= DIALOG_MIN_SECONDS),
  )
}

/** Sound that is not speech: packaging, taps, rustles, product clicks. */
function soundBitCandidates(map: SpeechMap, duration: number): Span[] {
  const flags = new Uint8Array(map.sound.length)
  for (let f = 0; f < flags.length; f++) {
    flags[f] = map.sound[f] && !map.speech[f] ? 1 : 0
  }
  return flagRuns(flags, duration)
    .filter((run) => run.end - run.start >= SOUND_BIT_MIN)
    .map((run) => ({
      start: run.start,
      end: Math.min(run.end, run.start + SOUND_BIT_MAX),
    }))
}

/**
 * Each candidate gets a coin flip, until the share budget is used up. When
 * the flips skip everything, the first candidate that fits is still taken, so
 * the toggle never silently does nothing.
 */
function pickSoundBits(candidates: Span[], dialogSeconds: number): Span[] {
  const shuffled = [...candidates]
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1))
    const swap = shuffled[i]
    shuffled[i] = shuffled[j]
    shuffled[j] = swap
  }
  const budget =
    (dialogSeconds * SOUND_BIT_MAX_SHARE) / (1 - SOUND_BIT_MAX_SHARE)
  const picked: Span[] = []
  let used = 0
  const fits = (span: Span) => used + span.end - span.start <= budget
  for (const candidate of shuffled) {
    if (Math.random() < 0.5 || !fits(candidate)) continue
    picked.push(candidate)
    used += candidate.end - candidate.start
  }
  if (!picked.length) {
    const first = shuffled.find(fits)
    if (first) picked.push(first)
  }
  return picked
}

/**
 * Dialog-first cut plan. Returns null when the clip has too little speech to
 * build a dialog edit, so the caller can fall back to sound moments.
 */
async function planDialogCuts(input: {
  inputPath: string
  tempDir: string
  duration: number
  soundBits: boolean
}): Promise<{ cuts: Span[] | null; notes: string[] }> {
  const notes: string[] = []
  const map = await detectSpeechActivity(input.inputPath)

  let words: TimedWord[] = []
  if (env.GROQ_API_KEY) {
    try {
      const stt = await transcribeSourceAudio(
        input.inputPath,
        input.duration,
        input.tempDir,
      )
      words = stt.words
    } catch (error) {
      notes.push(
        `Transcript skipped: ${
          error instanceof Error ? error.message.slice(0, 120) : 'unknown'
        }`,
      )
    }
  }

  const voice = map
    ? flagRuns(map.speech, input.duration)
    : words.map((w) => ({ start: w.start, end: w.end }))
  let cuts = dialogSpans(voice, words, input.duration)
  const dialogSeconds = totalKeep(cuts)
  if (dialogSeconds < DIALOG_MIN_TOTAL) {
    notes.push('No dialog found — keeping sound moments instead')
    return { cuts: null, notes }
  }

  const engine = map ? map.engine : 'transcript'
  const checked = map && words.length ? ' + transcript check' : ''
  notes.push(
    `Dialog only: ${cuts.length} speech segments (${dialogSeconds.toFixed(1)}s) via ${engine}${checked}`,
  )

  if (input.soundBits && map) {
    const candidates = soundBitCandidates(map, input.duration)
    const bits = pickSoundBits(candidates, dialogSeconds)
    cuts = mergeSpans([...cuts, ...bits])
    notes.push(
      `ASMR sound bits on: added ${bits.length} of ${candidates.length} non-dialog moments (${totalKeep(bits).toFixed(1)}s)`,
    )
  }
  return { cuts, notes }
}

/** Loudness-based fallback for clips with no detectable dialog. */
async function soundPeakCuts(
  input: {
    inputPath: string
    silenceSensitivity: SilenceSensitivity
    pacing: Pacing
  },
  duration: number,
  notes: string[],
): Promise<{
  cuts: Span[]
  method: string
  silenceRanges: Span[]
}> {
  const level = asmrSilenceLevel(input.silenceSensitivity)
  const silenceRanges = await detectSilenceRanges(input.inputPath, level)
  notes.push(`Quiet waits detected: ${silenceRanges.length} (level ${level})`)

  let baseCuts = silenceToKeepCuts(silenceRanges, duration, MIN_SOUND_SECONDS)
  let keep = totalKeep(baseCuts)
  let method = 'silence-cuts'

  if (duration > 2 && keep / duration > 0.88) {
    const peakCuts = await detectLoudKeepCuts(
      input.inputPath,
      duration,
      pacingKeepRatio(input.pacing),
    )
    const peakKeep = totalKeep(peakCuts)
    if (peakKeep < keep) {
      baseCuts = peakCuts
      keep = peakKeep
      method = 'sound-peak-cuts'
      notes.push(
        'Little true silence found — kept louder packaging/product peaks instead',
      )
    }
  }

  baseCuts = pacingTrim(baseCuts, input.pacing)
  const beforeSoundGate = baseCuts.length
  baseCuts = keepClipsWithMinSound(
    baseCuts,
    silenceRanges,
    MIN_SOUND_SECONDS,
  )
  keep = totalKeep(baseCuts)
  if (baseCuts.length !== beforeSoundGate) {
    notes.push(
      `Kept clips with at least ${MIN_SOUND_SECONDS}s of sound (${baseCuts.length} clips)`,
    )
  }

  const minKeep = minimumKeepSeconds(duration)
  if (duration >= 15 && keep < minKeep) {
    const softerPeaks = await detectLoudKeepCuts(input.inputPath, duration, 0.82)
    const softerKeep = totalKeep(softerPeaks)
    if (softerKeep > keep) {
      baseCuts = softerPeaks
      keep = softerKeep
      method = 'sound-peak-cuts-soft'
      notes.push(
        `Edit was too short — kept more speech/product audio (~${keep.toFixed(1)}s)`,
      )
    }
  }

  if (duration >= 15 && keep < minKeep) {
    baseCuts = [{ start: 0, end: duration }]
    keep = duration
    method = 'full-clip-fallback'
    notes.push(
      'Could not safely trim waits without over-cutting — returned fuller clip',
    )
  }

  baseCuts = keepClipsWithMinSound(
    baseCuts,
    silenceRanges,
    MIN_SOUND_SECONDS,
  )
  return { cuts: baseCuts, method, silenceRanges }
}

async function geminiProductHint(input: {
  filename: string
  durationSeconds: number
}): Promise<{ summary: string; category: string; titleHint?: string }> {
  if (!env.GEMINI_API_KEY) {
    return {
      summary: 'ASMR/unboxing edit keeping product sound moments.',
      category: 'product-unboxing',
    }
  }

  const prompt = [
    'You help edit ASMR / product unboxing social videos.',
    'Return JSON only: { "summary": string, "category": string, "titleHint": string }',
    `Filename: ${input.filename}`,
    `DurationSeconds: ${input.durationSeconds}`,
    'Assume soft packaging/hand sounds and product reveals. Keep title short and social.',
  ].join('\n')

  const text = await geminiGenerateText(prompt)
  const parsed = extractJsonObject<{
    summary?: string
    category?: string
    titleHint?: string
  }>(text)

  return {
    summary: parsed.summary || 'ASMR/unboxing highlight edit',
    category: parsed.category || 'product-unboxing',
    titleHint: parsed.titleHint,
  }
}

function ensureTempDir(outputPath: string) {
  const tempDir = path.join(path.dirname(outputPath), '.tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  return tempDir
}

/**
 * ASMR / unboxing pipeline:
 * 1) Dialog only: keep speech phrases (voice detect + transcript check)
 * 2) Optional ASMR sound bits: randomly add non-dialog sound moments
 * 3) No dialog at all: fall back to loudness-based sound moments
 * 4) Optional Gemini title/summary only
 */
export async function processAsmrUnboxing(input: {
  inputPath: string
  outputPath: string
  outputUrl: string
  originalFilename: string
  silenceSensitivity: SilenceSensitivity
  pacing: Pacing
  keepAudio: boolean
  speedRamp?: 'off' | 'light' | 'medium' | 'aggressive'
  durationSeconds?: number
  timelineJson?: unknown
  /** Effects mixed by Randomize */
  randomPool?: readonly ClipMotion[]
  motion?: ClipMotion
  /** Randomly add non-dialog ASMR sound bits between the dialog */
  soundBits?: boolean
  onProgress?: (percent: number, note?: string) => void
}): Promise<AsmrResult> {
  const notes: string[] = [
    'ASMR/unboxing: dialog only, trim empty waiting',
  ]

  const hasAudio = await probeHasAudio(input.inputPath)
  if (!hasAudio) {
    throw new Error(
      'This video has no audio. ASMR/unboxing needs packaging or product sounds.',
    )
  }

  const duration =
    input.durationSeconds && input.durationSeconds > 0
      ? input.durationSeconds
      : await probeDuration(input.inputPath)

  const plan = await planDialogCuts({
    inputPath: input.inputPath,
    tempDir: ensureTempDir(input.outputPath),
    duration,
    soundBits: input.soundBits ?? false,
  })
  notes.push(...plan.notes)

  let baseCuts: Span[]
  let method: string
  let silenceRanges: Span[] = []
  if (plan.cuts) {
    baseCuts = plan.cuts
    method = 'dialog-cuts'
  } else {
    const fallback = await soundPeakCuts(input, duration, notes)
    baseCuts = fallback.cuts
    method = fallback.method
    silenceRanges = fallback.silenceRanges
  }
  const keep = totalKeep(baseCuts)

  notes.push(`Keeping ${baseCuts.length} segments via ${method}`)

  let summary = 'ASMR/unboxing edit keeping product sound moments.'
  let category = 'product-unboxing'
  let provider: AsmrResult['provider'] = 'ffmpeg'

  try {
    if (env.fastExport || !env.GEMINI_API_KEY) {
      notes.push(
        env.fastExport
          ? 'FAST_EXPORT: skipped Gemini hint'
          : 'No GEMINI_API_KEY — FFmpeg-only ASMR edit (still real)',
      )
    } else {
      const hint = await geminiProductHint({
        filename: input.originalFilename,
        durationSeconds: duration,
      })
      summary = hint.summary
      category = hint.category
      provider = 'ffmpeg+gemini'
      notes.push('Title/summary hint from Gemini')
      if (hint.titleHint) notes.push(`Title hint: ${hint.titleHint}`)
    }
  } catch (error) {
    notes.push(
      `Gemini skipped: ${error instanceof Error ? error.message : 'unknown'}`,
    )
  }

  // Shorter peak moments = important @1×; longer softer segments accelerate
  const durations = baseCuts.map((c) => c.end - c.start)
  const maxDur = Math.max(...durations, 0.01)
  const importance = durations.map((d) => 1 - d / maxDur)
  const cuts = assignSegmentSpeeds(baseCuts, input.speedRamp ?? 'off', {
    importance,
  })
  const sped = cuts.some((c) => c.speed !== 1)
  if (sped) {
    notes.push(
      `Segment speed ramp: ${input.speedRamp} (product peaks @1×, softer parts faster)`,
    )
  }

  input.onProgress?.(76, 'Cutting and exporting')
  const perCutMotions = perCutMotionsFromTimeline(input.timelineJson, cuts.length, input.randomPool)
  const extraZoomByCut = extraZoomByCutFromTimeline(input.timelineJson, cuts)
  await renderJumpCutVideo({
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    cuts,
    keepAudio: input.keepAudio,
    motion: input.motion ?? 'none',
    perCutMotions,
    randomPool: input.randomPool,
    extraZoomByCut,
    onProgress: (ratio) =>
      input.onProgress?.(76 + ratio * 18, 'Cutting and exporting'),
  })
  input.onProgress?.(94, 'Finishing export')
  if (perCutMotions?.length) {
    notes.push(`Applied ${perCutMotions[0]} to every keep-segment`)
  } else if (input.motion && input.motion !== 'none') {
    notes.push(`Zoom/motion on each kept moment: ${input.motion}`)
  }
  if (extraZoomByCut?.length) {
    notes.push('Manual zoom keyframes baked into keep-segments')
  }

  const outputDurationSeconds = totalOutputDuration(cuts)
  const removedSeconds = Math.max(0, duration - keep)
  notes.push(
    `Output ~${outputDurationSeconds.toFixed(1)}s (removed ~${removedSeconds.toFixed(1)}s)`,
  )
  if (removedSeconds < 0.8) {
    notes.push(
      'Almost no waiting removed — try a clip with quieter gaps, or Fast / Very Fast pacing',
    )
  }

  return {
    provider,
    durationSeconds: duration,
    outputDurationSeconds,
    removedSeconds,
    silenceRanges,
    cuts,
    segmentSpeedApplied: sped,
    summary,
    category,
    outputPath: input.outputPath,
    outputUrl: input.outputUrl,
    notes,
  }
}
