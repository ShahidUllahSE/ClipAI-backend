import fs from 'fs'
import path from 'path'
import { env } from '../config'
import { extractJsonObject, geminiGenerateText } from './gemini'
import type { ClipMotion, SilenceSensitivity } from './ffmpeg'
import {
  detectLoudKeepCuts,
  detectSilenceInRange,
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
  remapWordsToOutput,
  snapCutsToCompleteWords,
  splitCutsBySilence,
  totalOutputDuration,
  wordsToCaptionCues,
  wordsToSentenceCues,
  writeSrtFile,
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
  captionsPath?: string
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
  /^(yeah|yep|yup|okay|ok|so|well|right|like|actually|basically|um|uh|let'?s|look|wait|sorry)\b/i

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
  if (tokens.length <= 3) return true
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

const TAKE_NOISE =
  /\b(um+|uh+|like|you know|so|yeah|okay|ok|actually|basically)\b/gi

function normalizeTakeText(text: string) {
  return text
    .toLowerCase()
    .replace(TAKE_NOISE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function takeTokens(text: string) {
  return normalizeTakeText(text)
    .split(' ')
    .filter((word) => word.length > 2)
}

function similarTakes(a: string, b: string) {
  const ta = takeTokens(a)
  const tb = takeTokens(b)
  if (ta.length < 4 || tb.length < 4) return false
  const sa = new Set(ta)
  const sb = new Set(tb)
  let inter = 0
  for (const word of sa) {
    if (sb.has(word)) inter += 1
  }
  const union = sa.size + sb.size - inter
  const jaccard = union > 0 ? inter / union : 0
  const na = normalizeTakeText(a)
  const nb = normalizeTakeText(b)
  const contained =
    Math.min(ta.length, tb.length) >= 5 &&
    (na.includes(nb) || nb.includes(na))
  return jaccard >= 0.55 || contained
}

/**
 * One keep-clip sometimes contains a flub + the redo. Keep the later half.
 */
function trimDoubledTakeCuts(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
) {
  return cuts.map((cut) => {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    if (inside.length < 10 || cut.end - cut.start < 6) return cut
    const midCount = Math.floor(inside.length / 2)
    const first = inside
      .slice(0, midCount)
      .map((word) => word.word)
      .join(' ')
    const second = inside
      .slice(midCount)
      .map((word) => word.word)
      .join(' ')
    if (!similarTakes(first, second)) return cut
    const later = inside.slice(midCount)
    const start = Math.max(0, later[0].start - 0.04)
    const end = Math.min(
      durationSeconds,
      later[later.length - 1].end + 0.06,
    )
    return end - start >= 0.8 ? { start, end } : cut
  })
}

/**
 * Creator retakes (same line / same CTA). Keep the later take, drop the earlier.
 */
function dropRepeatedTakes(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
) {
  if (cuts.length < 2) return cuts
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const keep = sorted.map(() => true)
  for (let later = sorted.length - 1; later >= 1; later -= 1) {
    if (!keep[later]) continue
    const laterText = cutText(sorted[later], words)
    if (takeTokens(laterText).length < 4) continue
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!keep[earlier]) continue
      if (similarTakes(cutText(sorted[earlier], words), laterText)) {
        keep[earlier] = false
      }
    }
  }
  const out = sorted.filter((_, index) => keep[index])
  return out.length >= 1 ? out : cuts
}

/**
 * A keep-clip often contains the good take + redo with ~0.5s pauses.
 * Whisper writes one sentence, so text matching misses it. Split on real
 * audio pauses and keep the first complete take only.
 */
function compactRapidCutWords(words: TimedWord[]): TimedWord[] {
  const base = compactWordTimings(words)
  return base.map((word, i) => {
    const next = base[i + 1]
    const letters = word.word.replace(/[^A-Za-z0-9]/g, '').length
    const expected = Math.min(0.65, Math.max(0.12, letters * 0.08 + 0.08))
    let { start, end } = word
    const dur = Math.max(0, end - start)
    if (dur > Math.max(0.8, expected * 2.6)) {
      end = start + expected + 0.22
    }
    if (next) {
      end = Math.min(end, Math.max(start + 0.08, next.start - 0.02))
    }
    return { ...word, start, end: Math.max(start + 0.08, end) }
  })
}

function pickFirstCompleteTake(
  cut: { start: number; end: number },
  parts: Array<{ start: number; end: number }>,
  words: TimedWord[],
) {
  if (parts.length <= 1) return { ...cut }
  const firstComplete = parts.find((part) => {
    const text = cutText(part, words)
    return takeTokens(text).length >= 6 && thoughtLooksComplete(text)
  })
  return firstComplete ?? parts[0]
}

function clampCutsToSpokenWords(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
) {
  return cuts.map((cut) => {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    if (inside.length < 2) return { ...cut }
    const start = Math.max(0, inside[0].start - 0.04)
    const end = Math.min(durationSeconds, inside[inside.length - 1].end + 0.08)
    if (end - start < 0.22) return { ...cut }
    return { start, end }
  })
}

function mergeOverlappingCuts(cuts: Array<{ start: number; end: number }>) {
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = []
  for (const cut of sorted) {
    const prev = out[out.length - 1]
    if (prev && cut.start <= prev.end + 0.12) {
      prev.end = Math.max(prev.end, cut.end)
      continue
    }
    out.push({ ...cut })
  }
  return out.length ? out : cuts
}

function clipCutsToHardEnd(
  cuts: Array<{ start: number; end: number }>,
  hardEnd: number,
) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    if (cut.start >= hardEnd - 0.05) continue
    const end = Math.min(cut.end, hardEnd)
    if (end - cut.start >= 0.22) out.push({ start: cut.start, end })
  }
  return out.length ? out : cuts
}

/**
 * Closing CTA is often filmed twice. Keep the first complete closing
 * sentence in the last 25s of the source; drop the retake after it.
 */
async function dropClosingRetake(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
  inputPath: string,
) {
  if (!cuts.length || words.length < 6) return cuts
  const closeStart = Math.max(0, durationSeconds - 25)
  const sentences = mergeSpokenPhrases(wordsToSentenceCues(words)).filter(
    (sentence) =>
      sentence.start >= closeStart - 0.4 &&
      takeTokens(sentence.text).length >= 5 &&
      thoughtLooksComplete(sentence.text),
  )
  if (!sentences.length) return cuts

  const keep = sentences.map(() => true)
  for (let later = 1; later < sentences.length; later += 1) {
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!keep[earlier]) continue
      if (similarTakes(sentences[earlier].text, sentences[later].text)) {
        keep[later] = false
        break
      }
    }
  }

  const kept = sentences.filter((_, index) => keep[index])
  let hardEnd = Math.max(...kept.map((sentence) => sentence.end)) + 0.1
  const firstRepeated = sentences.find((sentence, index) =>
    sentences.some(
      (other, later) =>
        later > index &&
        !keep[later] &&
        similarTakes(sentence.text, other.text),
    ),
  )
  if (firstRepeated) hardEnd = Math.min(hardEnd, firstRepeated.end + 0.1)

  const longClose = kept[kept.length - 1]
  if (longClose && longClose.end - longClose.start >= 5.5) {
    try {
      const holes = await detectSilenceInRange(
        inputPath,
        longClose.start,
        longClose.end,
      )
      const parts = splitCutsBySilence(
        [{ start: longClose.start, end: longClose.end }],
        holes,
        0.28,
      )
      const first = pickFirstCompleteTake(
        { start: longClose.start, end: longClose.end },
        parts,
        words,
      )
      if (first.end <= longClose.end - 0.4) {
        hardEnd = Math.min(hardEnd, first.end + 0.08)
      }
    } catch {
      /* keep sentence end */
    }
  }

  return clipCutsToHardEnd(cuts, hardEnd)
}

function dedupeCaptionCues(cues: CaptionCue[]) {
  const out: CaptionCue[] = []
  for (const cue of cues) {
    const prev = out[out.length - 1]
    if (prev && similarTakes(prev.text, cue.text)) continue
    if (prev && normalizeTakeText(prev.text) === normalizeTakeText(cue.text)) {
      continue
    }
    out.push(cue)
  }
  return out
}

function trimRepeatedWordStutter(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
) {
  return cuts.map((cut) => {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    for (let i = 1; i < inside.length; i++) {
      const prev = inside[i - 1].word.replace(/[^A-Za-z]/g, '').toLowerCase()
      const cur = inside[i].word.replace(/[^A-Za-z]/g, '').toLowerCase()
      if (prev.length < 5 || prev !== cur) continue
      const end = Math.min(durationSeconds, inside[i - 1].end + 0.08)
      if (end - cut.start >= 0.8) return { start: cut.start, end }
    }
    return cut
  })
}

/**
 * Rapid-cut transcript keeps: complete spoken thoughts minus leftover talk.
 */
function transcriptKeepCuts(
  words: TimedWord[],
  phrases: CaptionCue[],
  durationSeconds: number,
) {
  const compact = compactRapidCutWords(words)
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
      const compact = compactRapidCutWords(stt.words)
      const spokenSpan = compact.reduce(
        (sum, word) => sum + Math.max(0, word.end - word.start),
        0,
      )
      const speechHeavy =
        compact.length >= 12 && spokenSpan >= Math.min(8, duration * 0.12)
      if (speechHeavy) {
        let spokenCuts = transcriptKeepCuts(stt.words, stt.phrases, duration)
        if (spokenCuts.length >= 2) {
          let punchHoles = silenceRanges
          try {
            const tightHoles = await detectSilenceRanges(
              input.inputPath,
              'aggressive',
            )
            punchHoles = [...silenceRanges, ...tightHoles]
          } catch {
            punchHoles = silenceRanges
          }
          spokenCuts = punchSilentHolds(
            spokenCuts,
            compact,
            duration,
            punchHoles,
          )
          spokenCuts = mergeNearbyIncompleteCuts(spokenCuts, compact)
          spokenCuts = punchSilentHolds(
            spokenCuts,
            compact,
            duration,
            punchHoles,
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
            punchHoles,
          )
          if (spokenCuts.length >= 2) {
            const leftoverClean = spokenCuts
            spokenCuts = trimRepeatedWordStutter(
              spokenCuts,
              compact,
              duration,
            )
            spokenCuts = dropRepeatedTakes(spokenCuts, compact)
            if (spokenCuts.length < 2) spokenCuts = leftoverClean
            spokenCuts = clampCutsToSpokenWords(
              spokenCuts,
              compact,
              duration,
            )
            spokenCuts = await dropClosingRetake(
              spokenCuts,
              compact,
              duration,
              input.inputPath,
            )
            spokenCuts = mergeOverlappingCuts(spokenCuts)
            if (spokenCuts.length < 2) spokenCuts = leftoverClean
            baseCuts = spokenCuts
            keep = totalKeep(baseCuts)
            method = 'transcript-cuts'
            provider = 'ffmpeg+groq'
            usedTranscript = true
            transcriptWords = compact
            notes.push(
              `Cut leftover speech from transcript (${compact.length} words, ${beforeDrop} thoughts → ${spokenCuts.length} complete sentences)`,
            )
            notes.push(
              `Keep ${spokenCuts
                .map((cut) => `${cut.start.toFixed(1)}-${cut.end.toFixed(1)}`)
                .join(', ')}`,
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
      baseCuts = clampCutsToSpokenWords(
        baseCuts,
        transcriptWords,
        duration,
      )
      baseCuts = await dropClosingRetake(
        baseCuts,
        transcriptWords,
        duration,
        input.inputPath,
      )
      baseCuts = mergeOverlappingCuts(baseCuts)
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

  let captionsPath: string | undefined
  if (usedTranscript && transcriptWords.length) {
    const remapped = remapWordsToOutput(transcriptWords, cuts)
    const cues = dedupeCaptionCues(wordsToCaptionCues(remapped, 5, 2.4))
    if (cues.length) {
      captionsPath = input.outputPath.replace(/\.mp4$/i, '.captions.srt')
      writeSrtFile(cues, captionsPath)
      notes.push(
        `Captions from source transcript (${cues.length} cues, repeats removed)`,
      )
    }
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
    captionsPath,
  }
}
