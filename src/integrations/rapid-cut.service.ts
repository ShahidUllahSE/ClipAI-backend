import fs from 'fs'
import path from 'path'
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
import { transcribeSourceAudio } from './groq-transcribe'
import {
  extraZoomByCutFromTimeline,
  perCutMotionsFromTimeline,
} from './timeline-fx'
import {
  assignSegmentSpeeds,
  compactWordTimings,
  cutsFromPhrases,
  mergeSpokenPhrases,
  snapCutsToCompleteWords,
  splitCutsBySilence,
  totalOutputDuration,
  wordsToSentenceCues,
  type CaptionCue,
  type SpeedCut,
  type TimedWord,
} from './timed-edit'

export interface RapidCutResult {
  provider: 'ffmpeg' | 'ffmpeg+gemini' | 'ffmpeg+groq' | 'ffmpeg+groq+gemini'
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

const FILLER_TOKENS = new Set([
  'um',
  'uh',
  'uhh',
  'umm',
  'ah',
  'er',
  'like',
  'yeah',
  'yep',
  'yup',
  'okay',
  'ok',
  'so',
  'well',
  'right',
  'actually',
  'basically',
  'literally',
])

function isFillerPhrase(text: string) {
  const tokens = text
    .toLowerCase()
    .replace(/[^a-z'\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
  if (!tokens.length) return true
  const content = tokens.filter((token) => !FILLER_TOKENS.has(token))
  return content.length === 0
}

const HANGING_LAST = new Set([
  'and',
  'but',
  'or',
  'so',
  'because',
  'that',
  'the',
  'a',
  'an',
  'to',
  'of',
  'for',
  'their',
  'your',
  'our',
  'with',
  'about',
  'is',
  'are',
  'was',
  'were',
])

const LEFTOVER_OPEN =
  /^(yeah|yep|yup|okay|ok|so|well|right|like|actually|basically|um|uh)\b/i

function wordsInCut(
  cut: { start: number; end: number },
  words: TimedWord[],
) {
  return words.filter((word) => word.end > cut.start && word.start < cut.end)
}

function cutText(cut: { start: number; end: number }, words: TimedWord[]) {
  return wordsInCut(cut, words)
    .map((word) => word.word.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/** Same complete-thought rule talking-head uses — local copy so TH is untouched. */
function thoughtLooksComplete(text: string) {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (!trimmed) return false
  if (/[.?!]["')\]]*$/.test(trimmed)) return true
  const tokens = trimmed.split(/\s+/).filter(Boolean)
  if (tokens.length < 4) return false
  const last = (tokens[tokens.length - 1] ?? '')
    .replace(/[^A-Za-z0-9']/g, '')
    .toLowerCase()
  return Boolean(last) && !HANGING_LAST.has(last)
}

function trimCutsToWordEdges(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    const inside = wordsInCut(cut, words)
    if (inside.length < 2) continue
    const start = Math.max(0, inside[0].start - 0.04)
    const end = Math.min(durationSeconds, inside[inside.length - 1].end + 0.06)
    if (end - start >= 0.22) out.push({ start, end })
  }
  return out
}

/** Drop caption-less holds between words inside a keep-cut. */
function splitCutsOnWordGaps(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  minGap = 0.45,
) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    if (inside.length < 2) {
      if (inside.length) out.push({ ...cut })
      continue
    }
    let start = Math.max(cut.start, inside[0].start)
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].start - inside[i - 1].end
      if (gap >= minGap) {
        const end = Math.min(cut.end, inside[i - 1].end)
        if (end - start >= 0.22) out.push({ start, end })
        start = inside[i].start
      }
    }
    const end = Math.min(cut.end, inside[inside.length - 1].end)
    if (end - start >= 0.22) out.push({ start, end })
  }
  return out.length ? out : cuts
}

/**
 * Complete a hanging clause with the next clip only when they are the same
 * sentence (tiny gap). Never merge across a silent hold.
 */
function mergeNearbyIncompleteCuts(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  maxGap = 0.38,
) {
  if (cuts.length < 2) return cuts
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const out = [{ ...sorted[0] }]
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]
    const cur = { ...sorted[i] }
    const gap = cur.start - prev.end
    const prevText = cutText(prev, words)
    const curText = cutText(cur, words)
    const curStartsCont =
      /^(and|but|or|so|because|that|which|who|if|when|while|then)\b/i.test(
        curText,
      )
    if (
      gap <= maxGap &&
      gap >= -0.05 &&
      (!thoughtLooksComplete(prevText) || curStartsCont)
    ) {
      prev.end = Math.max(prev.end, cur.end)
      continue
    }
    out.push(cur)
  }
  return out
}

function punchSilentHolds(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
  silenceRanges: Array<{ start: number; end: number }>,
) {
  if (!cuts.length || !words.length) return cuts
  let out = splitCutsBySilence(cuts, silenceRanges, 0.4)
  out = splitCutsOnWordGaps(out, words, 0.45)
  out = trimCutsToWordEdges(out, words, durationSeconds)
  return out.length ? out : cuts
}

function leftoverSentenceScore(
  cut: { start: number; end: number },
  words: TimedWord[],
) {
  const text = cutText(cut, words)
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length || isFillerPhrase(text)) return -20
  let score = Math.min(tokens.length, 14) * 0.35
  if (thoughtLooksComplete(text)) score += 3
  else score -= 2.5
  if (LEFTOVER_OPEN.test(text)) score -= 4
  if (tokens.length < 4) score -= 2
  return score
}

function isLeftoverAside(
  cut: { start: number; end: number },
  words: TimedWord[],
) {
  const text = cutText(cut, words)
  const tokens = text.split(/\s+/).filter(Boolean)
  if (!tokens.length || isFillerPhrase(text)) return true
  return LEFTOVER_OPEN.test(text) && tokens.length <= 12
}

/**
 * Drop leftover asides as whole sentences. Never chop a kept sentence.
 */
function dropLeftoverSentences(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  pacing: Pacing,
) {
  const cleaned = cuts.filter((cut) => !isLeftoverAside(cut, words))
  const pool = cleaned.length >= 2 ? cleaned : cuts
  if (pool.length <= 3) return pool
  const scored = pool.map((cut) => ({
    cut,
    score: leftoverSentenceScore(cut, words),
    complete: thoughtLooksComplete(cutText(cut, words)),
  }))
  const ratio =
    pacing === 'very-fast' ? 0.42 : pacing === 'fast' ? 0.52 : 0.68
  const keepCount = Math.max(
    3,
    Math.min(scored.length, Math.ceil(scored.length * ratio)),
  )
  const ranked = [...scored].sort((a, b) => {
    if (b.complete !== a.complete) return a.complete ? -1 : 1
    return b.score - a.score
  })
  return ranked
    .slice(0, keepCount)
    .sort((a, b) => a.cut.start - b.cut.start)
    .map((row) => row.cut)
}

function dropIncompleteOrphans(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
) {
  const kept = cuts.filter((cut) =>
    thoughtLooksComplete(cutText(cut, words)),
  )
  return kept.length >= 2 ? kept : cuts
}

/**
 * Rapid-cut transcript keeps: complete spoken thoughts minus leftover talk.
 */
function transcriptKeepCuts(
  words: TimedWord[],
  phrases: CaptionCue[],
  durationSeconds: number,
) {
  const compact = compactWordTimings(words)
  const spoken = compact.length
    ? mergeSpokenPhrases(wordsToSentenceCues(compact))
    : mergeSpokenPhrases(phrases)
  const content = spoken.filter((phrase) => !isFillerPhrase(phrase.text))
  const use = content.length >= 3 ? content : spoken
  if (!use.length) return []
  let cuts = cutsFromPhrases(use, durationSeconds)
  if (compact.length) {
    cuts = snapCutsToCompleteWords(cuts, compact, durationSeconds)
    cuts = mergeNearbyIncompleteCuts(cuts, compact)
    cuts = trimCutsToWordEdges(cuts, compact, durationSeconds)
  }
  return cuts
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
    'Rapid-cut: drop leftover speech using the transcript, keep complete sentences',
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
  let provider: RapidCutResult['provider'] = 'ffmpeg'

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

  // Speech-heavy clips: complete sentences from the transcript, drop leftover
  // talk and caption-less holds. Music-only clips stay on the energy path.
  let usedTranscript = false
  let transcriptWords: TimedWord[] = []
  if (env.GROQ_API_KEY) {
    const tempDir = path.join(path.dirname(input.outputPath), '.tmp')
    fs.mkdirSync(tempDir, { recursive: true })
    try {
      report(68, 'Reading transcript for leftover speech')
      const stt = await transcribeSourceAudio(
        input.inputPath,
        duration,
        tempDir,
      )
      const compact = compactWordTimings(stt.words)
      const spokenSpan = compact.reduce(
        (sum, word) => sum + Math.max(0, word.end - word.start),
        0,
      )
      const speechHeavy =
        compact.length >= 12 && spokenSpan >= Math.min(8, duration * 0.12)
      if (speechHeavy) {
        let spokenCuts = transcriptKeepCuts(stt.words, stt.phrases, duration)
        if (spokenCuts.length >= 2) {
          spokenCuts = punchSilentHolds(
            spokenCuts,
            compact,
            duration,
            silenceRanges,
          )
          spokenCuts = mergeNearbyIncompleteCuts(spokenCuts, compact)
          spokenCuts = punchSilentHolds(
            spokenCuts,
            compact,
            duration,
            silenceRanges,
          )
          const beforeDrop = spokenCuts.length
          spokenCuts = dropLeftoverSentences(
            spokenCuts,
            compact,
            input.pacing,
          )
          spokenCuts = dropIncompleteOrphans(spokenCuts, compact)
          spokenCuts = punchSilentHolds(
            spokenCuts,
            compact,
            duration,
            silenceRanges,
          )
          if (spokenCuts.length >= 2) {
            baseCuts = spokenCuts
            keep = totalKeep(baseCuts)
            method = 'transcript-cuts'
            provider = 'ffmpeg+groq'
            usedTranscript = true
            transcriptWords = compact
            notes.push(
              `Cut leftover speech from transcript (${compact.length} words, ${beforeDrop} thoughts → ${spokenCuts.length} complete sentences)`,
            )
          }
        }
      } else {
        notes.push('Little speech on the transcript — kept energy-peak cuts')
      }
    } catch (error) {
      notes.push(
        `Transcript skip: ${error instanceof Error ? error.message : 'unknown'}`,
      )
    }
  }

  if (usedTranscript) {
    baseCuts = dropTinyCuts(baseCuts)
    if (transcriptWords.length) {
      const trimmed = trimCutsToWordEdges(
        baseCuts,
        transcriptWords,
        duration,
      )
      if (trimmed.length >= 2) baseCuts = trimmed
    }
  } else {
    baseCuts = dropTinyCuts(baseCuts)
    baseCuts = splitLongCuts(baseCuts, maxClipSeconds(input.pacing))
    baseCuts = keepBusiest(baseCuts, input.pacing)
    keep = totalKeep(baseCuts)

    const minKeep = Math.min(duration * 0.7, Math.max(5, duration * 0.22))
    if (duration >= 12 && keep < minKeep) {
      const fuller = await detectLoudKeepCuts(input.inputPath, duration, 0.72)
      if (totalKeep(fuller) > keep) {
        baseCuts = splitLongCuts(
          dropTinyCuts(fuller),
          maxClipSeconds(input.pacing),
        )
        keep = totalKeep(baseCuts)
        method = 'energy-peak-cuts-soft'
        notes.push(
          `Edit was too short — kept more active audio (~${keep.toFixed(1)}s)`,
        )
      }
    }
  }
  keep = totalKeep(baseCuts)

  notes.push(
    `Keeping ${baseCuts.length} clips via ${method} (${input.pacing} pacing)`,
  )

  let summary = 'Rapid-cut edit keeping the most energetic moments.'
  let category = 'rapid-cut'

  try {
    if (env.fastExport || !env.GEMINI_API_KEY) {
      notes.push(
        env.fastExport
          ? 'FAST_EXPORT: skipped Gemini hint'
          : 'No GEMINI_API_KEY — FFmpeg rapid-cut (still real)',
      )
    } else {
      const hint = await geminiEnergyHint({
        filename: input.originalFilename,
        durationSeconds: duration,
      })
      summary = hint.summary
      category = hint.category
      provider =
        provider === 'ffmpeg+groq' ? 'ffmpeg+groq+gemini' : 'ffmpeg+gemini'
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
  const cuts =
    usedTranscript && transcriptWords.length
      ? assignSegmentSpeeds(baseCuts, speedLevel, { words: transcriptWords })
      : assignSegmentSpeeds(baseCuts, speedLevel, { importance })
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
