import { env } from '../config'
import { extractJsonObject, geminiGenerateText } from './gemini'
import type { ClipMotion, SilenceSensitivity } from './ffmpeg'
import {
  detectLoudKeepCuts,
  detectSilenceRanges,
  probeDuration,
  probeHasAudio,
  renderJumpCutVideo,
  silenceToKeepCuts,
} from './ffmpeg'
import {
  extraZoomByCutFromTimeline,
  perCutMotionsFromTimeline,
} from './timeline-fx'
import {
  assignSegmentSpeeds,
  totalOutputDuration,
  type SpeedCut,
} from './timed-edit'

export interface RapidCutResult {
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

function totalKeep(cuts: Array<{ start: number; end: number }>) {
  return cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
}

function pacingKeepRatio(pacing: Pacing): number {
  if (pacing === 'very-fast') return 0.38
  if (pacing === 'fast') return 0.48
  return 0.58
}

function maxClipSeconds(pacing: Pacing): number {
  if (pacing === 'very-fast') return 1.8
  if (pacing === 'fast') return 2.4
  return 3.2
}

function splitLongCuts(
  cuts: Array<{ start: number; end: number }>,
  maxSeconds: number,
): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    const span = cut.end - cut.start
    if (span <= maxSeconds + 0.15) {
      out.push(cut)
      continue
    }
    const parts = Math.ceil(span / maxSeconds)
    const slice = span / parts
    for (let i = 0; i < parts; i++) {
      const start = cut.start + i * slice
      const end = i === parts - 1 ? cut.end : start + slice
      if (end - start >= 0.22) out.push({ start, end })
    }
  }
  return out.length ? out : cuts
}

function dropTinyCuts(cuts: Array<{ start: number; end: number }>) {
  const kept = cuts.filter((c) => c.end - c.start >= 0.22)
  return kept.length ? kept : cuts
}

function keepBusiest(
  cuts: Array<{ start: number; end: number }>,
  pacing: Pacing,
): Array<{ start: number; end: number }> {
  if (cuts.length <= 3) return cuts
  const keepCount =
    pacing === 'very-fast'
      ? Math.max(3, Math.ceil(cuts.length * 0.55))
      : pacing === 'fast'
        ? Math.max(4, Math.ceil(cuts.length * 0.7))
        : cuts.length
  if (keepCount >= cuts.length) return cuts
  const ranked = [...cuts].sort((a, b) => b.end - b.start - (a.end - a.start))
  return ranked.slice(0, keepCount).sort((a, b) => a.start - b.start)
}

async function geminiEnergyHint(input: {
  filename: string
  durationSeconds: number
}): Promise<{ summary: string; category: string; titleHint?: string }> {
  if (!env.GEMINI_API_KEY) {
    return {
      summary: 'Rapid-cut edit keeping the most energetic moments.',
      category: 'rapid-cut',
    }
  }

  const prompt = [
    'You help edit high-energy social videos (Reels / Shorts).',
    'Return JSON only: { "summary": string, "category": string, "titleHint": string }',
    `Filename: ${input.filename}`,
    `DurationSeconds: ${input.durationSeconds}`,
    'Assume fast pacing, motion, and audio peaks. Keep the title short.',
  ].join('\n')

  const text = await geminiGenerateText(prompt)
  const parsed = extractJsonObject<{
    summary?: string
    category?: string
    titleHint?: string
  }>(text)

  return {
    summary: parsed.summary || 'Rapid-cut edit keeping the most energetic moments.',
    category: parsed.category || 'rapid-cut',
    titleHint: parsed.titleHint,
  }
}

/**
 * Rapid-cut: keep audio peaks and drop slow sections, then FFmpeg jump-cut.
 * Independent of talking-head / ASMR cut logic.
 */
export async function processRapidCut(input: {
  inputPath: string
  outputPath: string
  outputUrl: string
  originalFilename: string
  silenceSensitivity: SilenceSensitivity
  pacing: Pacing
  keepAudio: boolean
  speedRamp?: 'off' | 'light' | 'medium' | 'aggressive'
  durationSeconds?: number
  motion?: ClipMotion
  timelineJson?: unknown
  aspectRatio?: '9:16' | '1:1' | '16:9'
  onProgress?: (percent: number, note?: string) => void
}): Promise<RapidCutResult> {
  const notes: string[] = [
    'Rapid-cut: keep energetic peaks, drop slow sections',
  ]
  const report = (percent: number, note?: string) => input.onProgress?.(percent, note)

  const hasAudio = await probeHasAudio(input.inputPath)
  if (!hasAudio) {
    throw new Error(
      'This video has no audio track. Rapid-cut needs sound peaks — upload a clip with audio.',
    )
  }

  const duration =
    input.durationSeconds && input.durationSeconds > 0
      ? input.durationSeconds
      : await probeDuration(input.inputPath)

  report(64, 'Finding energy peaks')
  const silenceRanges = await detectSilenceRanges(
    input.inputPath,
    input.silenceSensitivity,
  )
  notes.push(`Quiet gaps detected: ${silenceRanges.length}`)

  let baseCuts = silenceToKeepCuts(silenceRanges, duration, 0.18)
  let keep = totalKeep(baseCuts)
  let method = 'silence-cuts'

  const targetRatio = pacingKeepRatio(input.pacing)
  if (duration > 2 && keep / duration > targetRatio + 0.12) {
    const peakCuts = await detectLoudKeepCuts(
      input.inputPath,
      duration,
      targetRatio,
    )
    const peakKeep = totalKeep(peakCuts)
    if (peakKeep < keep) {
      baseCuts = peakCuts
      keep = peakKeep
      method = 'energy-peak-cuts'
      notes.push('Kept louder / more active moments for faster pacing')
    }
  }

  baseCuts = dropTinyCuts(baseCuts)
  baseCuts = splitLongCuts(baseCuts, maxClipSeconds(input.pacing))
  baseCuts = keepBusiest(baseCuts, input.pacing)
  keep = totalKeep(baseCuts)

  const minKeep = Math.min(duration * 0.7, Math.max(5, duration * 0.22))
  if (duration >= 12 && keep < minKeep) {
    const fuller = await detectLoudKeepCuts(input.inputPath, duration, 0.72)
    if (totalKeep(fuller) > keep) {
      baseCuts = splitLongCuts(dropTinyCuts(fuller), maxClipSeconds(input.pacing))
      keep = totalKeep(baseCuts)
      method = 'energy-peak-cuts-soft'
      notes.push(`Edit was too short — kept more active audio (~${keep.toFixed(1)}s)`)
    }
  }

  notes.push(
    `Keeping ${baseCuts.length} clips via ${method} (${input.pacing} pacing)`,
  )

  let summary = 'Rapid-cut edit keeping the most energetic moments.'
  let category = 'rapid-cut'
  let provider: RapidCutResult['provider'] = 'ffmpeg'

  try {
    if (env.fastExport || !env.GEMINI_API_KEY) {
      notes.push(
        env.fastExport
          ? 'FAST_EXPORT: skipped Gemini hint'
          : 'No GEMINI_API_KEY — FFmpeg-only rapid-cut (still real)',
      )
    } else {
      const hint = await geminiEnergyHint({
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

  const durations = baseCuts.map((c) => c.end - c.start)
  const maxDur = Math.max(...durations, 0.01)
  const importance = durations.map((d) => 1 - d / maxDur)
  const speedLevel = input.speedRamp && input.speedRamp !== 'off' ? input.speedRamp : 'light'
  const cuts = assignSegmentSpeeds(baseCuts, speedLevel, { importance })
  const sped = cuts.some((c) => c.speed !== 1)
  if (sped) {
    notes.push(`Segment speed ramp: ${speedLevel} (peaks @1×, slower bits faster)`)
  }

  report(76, 'Cutting and exporting')
  const perCutMotions = perCutMotionsFromTimeline(input.timelineJson, cuts.length)
  const extraZoomByCut = extraZoomByCutFromTimeline(input.timelineJson, cuts)
  await renderJumpCutVideo({
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    cuts,
    keepAudio: input.keepAudio,
    motion: input.motion ?? 'punch',
    perCutMotions,
    extraZoomByCut,
    aspectRatio: input.aspectRatio,
    onProgress: (ratio) => report(76 + ratio * 18, 'Cutting and exporting'),
  })
  report(94, 'Finishing export')
  if (perCutMotions?.length) {
    notes.push(`Applied ${perCutMotions[0]} to every keep-segment`)
  } else if ((input.motion ?? 'punch') !== 'none') {
    notes.push(`Jump-cut motion: ${input.motion ?? 'punch'}`)
  }
  if (extraZoomByCut?.length) {
    notes.push('Manual zoom keyframes baked into keep-segments')
  }

  const outputDurationSeconds = totalOutputDuration(cuts)
  const removedSeconds = Math.max(0, duration - keep)
  notes.push(
    `Output ~${outputDurationSeconds.toFixed(1)}s (removed ~${removedSeconds.toFixed(1)}s)`,
  )

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
