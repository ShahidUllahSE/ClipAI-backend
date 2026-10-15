import {
  detectSilenceInRange,
} from './ffmpeg'
import {
  splitCutsBySilence,
  type TimedWord,
} from './timed-edit'

const TAKE_NOISE =
  /\b(um+|uh+|like|you know|so|yeah|okay|ok|actually|basically|alright|well)\b/gi

function wordsInCut(
  cut: { start: number; end: number },
  words: TimedWord[],
) {
  return words.filter((word) => word.end > cut.start && word.start < cut.end)
}

function cutText(cut: { start: number; end: number }, words: TimedWord[]) {
  return wordsInCut(cut, words)
    .map((word) => word.word)
    .join(' ')
    .trim()
}

function normalizeTakeText(text: string) {
  return text
    .toLowerCase()
    .replace(TAKE_NOISE, ' ')
    .replace(/[^a-z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

export function takeTokens(text: string) {
  return normalizeTakeText(text)
    .split(' ')
    .filter((word) => word.length > 2)
}

function sequenceOverlap(a: string[], b: string[]) {
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (short.length < 3) return 0
  let best = 0
  for (let i = 0; i <= long.length - short.length; i++) {
    let hit = 0
    for (let j = 0; j < short.length; j++) {
      if (long[i + j] === short[j]) hit += 1
    }
    best = Math.max(best, hit / short.length)
  }
  // Also compare heads (common for restarting the same CTA)
  const head = Math.min(6, short.length, long.length)
  let headHit = 0
  for (let i = 0; i < head; i++) {
    if (short[i] === long[i]) headHit += 1
  }
  return Math.max(best, headHit / Math.max(1, head))
}

export function similarTakes(a: string, b: string) {
  const ta = takeTokens(a)
  const tb = takeTokens(b)
  if (ta.length < 3 || tb.length < 3) return false
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
    Math.min(ta.length, tb.length) >= 4 &&
    (na.includes(nb) || nb.includes(na))
  const seq = sequenceOverlap(ta, tb)
  return jaccard >= 0.42 || contained || seq >= 0.72
}

function thoughtLooksComplete(text: string) {
  const tokens = takeTokens(text)
  if (tokens.length >= 8) return true
  return /[.!?]$/.test(text.trim()) || tokens.length >= 5
}

/**
 * Creator retakes (same line / same CTA). Keep the later take, drop the earlier.
 */
export function dropRepeatedTakes(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
) {
  if (cuts.length < 2 || words.length < 4) return cuts
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const keep = sorted.map(() => true)
  for (let later = sorted.length - 1; later >= 1; later -= 1) {
    if (!keep[later]) continue
    const laterText = cutText(sorted[later], words)
    if (takeTokens(laterText).length < 3) continue
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
 * One keep-clip sometimes contains a flub + the redo. Keep the later half.
 */
export function trimDoubledTakeCuts(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
) {
  return cuts.map((cut) => {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    if (inside.length < 10 || cut.end - cut.start < 5) return cut
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

function pickFirstCompleteTake(
  cut: { start: number; end: number },
  parts: Array<{ start: number; end: number }>,
  words: TimedWord[],
) {
  if (parts.length <= 1) return { ...cut }
  const firstComplete = parts.find((part) => {
    const text = cutText(part, words)
    return takeTokens(text).length >= 5 && thoughtLooksComplete(text)
  })
  return firstComplete ?? parts[0]
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
 * Closing CTA filmed twice. Keep the first complete closing line; drop the redo.
 */
export async function dropClosingRetake(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
  inputPath: string,
) {
  if (!cuts.length || words.length < 6) return cuts
  const closeStart = Math.max(0, durationSeconds - 30)
  const closeCuts = cuts.filter((cut) => cut.end >= closeStart)
  const sentences = closeCuts.length
    ? closeCuts
    : cuts.slice(-Math.min(4, cuts.length))

  const texts = sentences.map((cut) => cutText(cut, words))
  const keep = texts.map((text) => takeTokens(text).length >= 3)
  for (let later = 1; later < sentences.length; later += 1) {
    if (!keep[later]) continue
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!keep[earlier]) continue
      if (similarTakes(texts[earlier], texts[later])) {
        keep[later] = false
        break
      }
    }
  }

  const droppedLater = keep.some((ok, index) => index > 0 && !ok)
  if (!droppedLater) {
    // Also handle flub+redo inside the last long cut via silence holes.
    const last = cuts[cuts.length - 1]
    if (!last || last.end - last.start < 5.5) return cuts
    try {
      const holes = await detectSilenceInRange(
        inputPath,
        last.start,
        last.end,
      )
      const parts = splitCutsBySilence(
        [{ start: last.start, end: last.end }],
        holes,
        0.28,
      )
      if (parts.length < 2) return cuts
      const first = pickFirstCompleteTake(last, parts, words)
      const second = parts[parts.length - 1]
      if (
        first.end < last.end - 0.35 &&
        similarTakes(cutText(first, words), cutText(second, words))
      ) {
        return clipCutsToHardEnd(cuts, first.end + 0.08)
      }
    } catch {
      /* keep as-is */
    }
    return cuts
  }

  const keptEnds = sentences
    .filter((_, index) => keep[index])
    .map((cut) => cut.end)
  if (!keptEnds.length) return cuts
  let hardEnd = Math.max(...keptEnds) + 0.1
  const firstKept = sentences.find((_, index) => keep[index])
  if (firstKept && !keep[keep.length - 1]) {
    hardEnd = Math.min(hardEnd, firstKept.end + 0.12)
  }
  return clipCutsToHardEnd(cuts, hardEnd)
}

/**
 * Full retake cleanup pass used by talking-head and rapid-cut.
 */
export async function removeRetakes(input: {
  cuts: Array<{ start: number; end: number }>
  words: TimedWord[]
  durationSeconds: number
  inputPath: string
}): Promise<{
  cuts: Array<{ start: number; end: number }>
  dropped: number
  notes: string[]
}> {
  const notes: string[] = []
  if (!input.cuts.length || input.words.length < 4) {
    return { cuts: input.cuts, dropped: 0, notes }
  }

  const beforeSeconds = input.cuts.reduce(
    (sum, cut) => sum + Math.max(0, cut.end - cut.start),
    0,
  )
  const beforeCount = input.cuts.length

  let cuts = trimDoubledTakeCuts(
    input.cuts,
    input.words,
    input.durationSeconds,
  )
  cuts = dropRepeatedTakes(cuts, input.words)
  cuts = await dropClosingRetake(
    cuts,
    input.words,
    input.durationSeconds,
    input.inputPath,
  )

  if (!cuts.length) {
    return { cuts: input.cuts, dropped: 0, notes }
  }

  const afterSeconds = cuts.reduce(
    (sum, cut) => sum + Math.max(0, cut.end - cut.start),
    0,
  )
  const dropped = Math.max(0, beforeCount - cuts.length)
  const removedSeconds = Math.max(0, beforeSeconds - afterSeconds)
  if (dropped > 0 || removedSeconds > 0.4) {
    notes.push(
      `Removed retakes: kept later take${dropped ? ` (−${dropped} repeat segment${dropped === 1 ? '' : 's'})` : ''}${
        removedSeconds > 0.4 ? `, −${removedSeconds.toFixed(1)}s` : ''
      }`,
    )
  }
  return { cuts, dropped, notes }
}
