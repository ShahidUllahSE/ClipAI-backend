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
} from './ffmpeg'
import {
  assignSegmentSpeeds,
  totalOutputDuration,
  type SpeedCut,
} from './timed-edit'

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

/**
 * ASMR / unboxing pipeline:
 * 1) Drop quiet waits via silence detect
 * 2) If almost nothing was cut (noisy WhatsApp audio), keep loudest sound peaks
 * 3) Optional Gemini title/summary only
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
}): Promise<AsmrResult> {
  const notes: string[] = [
    'ASMR/unboxing: keep product sounds & reveals, trim empty waiting',
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

  const level = asmrSilenceLevel(input.silenceSensitivity)
  const silenceRanges = await detectSilenceRanges(input.inputPath, level)
  notes.push(`Quiet waits detected: ${silenceRanges.length} (level ${level})`)

  let baseCuts = silenceToKeepCuts(silenceRanges, duration, 0.15)
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
  keep = totalKeep(baseCuts)

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

  notes.push(
    `Keeping ${baseCuts.length} segments via ${method} (${input.pacing} pacing)`,
  )

  let summary = 'ASMR/unboxing edit keeping product sound moments.'
  let category = 'product-unboxing'
  let provider: AsmrResult['provider'] = 'ffmpeg'

  try {
    const hint = await geminiProductHint({
      filename: input.originalFilename,
      durationSeconds: duration,
    })
    summary = hint.summary
    category = hint.category
    if (env.GEMINI_API_KEY) {
      provider = 'ffmpeg+gemini'
      notes.push('Title/summary hint from Gemini')
      if (hint.titleHint) notes.push(`Title hint: ${hint.titleHint}`)
    } else {
      notes.push('No GEMINI_API_KEY — FFmpeg-only ASMR edit (still real)')
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

  await renderJumpCutVideo({
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    cuts,
    keepAudio: input.keepAudio,
  })

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
