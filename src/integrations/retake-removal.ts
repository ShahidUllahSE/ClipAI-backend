import { detectSilenceInRange } from './ffmpeg'
import {
  mergeSpokenPhrases,
  splitCutsBySilence,
  wordsToSentenceCues,
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
  const head = Math.min(6, short.length, long.length)
  let headHit = 0
  for (let i = 0; i < head; i++) {
    if (short[i] === long[i]) headHit += 1
  }
  return Math.max(best, headHit / Math.max(1, head))
}

/** Same opener (creators restart from the first few words). */
function samePrefix(a: string[], b: string[], n = 4) {
  if (a.length < n || b.length < n) return false
  for (let i = 0; i < n; i++) {
    if (a[i] !== b[i]) return false
  }
  return true
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
  // Lower thresholds + prefix match: flubs often share the first words only.
  return (
    jaccard >= 0.34 ||
    contained ||
    seq >= 0.62 ||
    samePrefix(ta, tb, 4) ||
    (samePrefix(ta, tb, 3) && Math.min(ta.length, tb.length) >= 5)
  )
}

function thoughtLooksComplete(text: string) {
  const tokens = takeTokens(text)
  if (tokens.length >= 8) return true
  return /[.!?]$/.test(text.trim()) || tokens.length >= 5
}

/**
 * Split keep-cuts on real word gaps so flub + redo become separate segments.
 * Uses raw STT timings (not compacted) — gaps must survive.
 */
export function expandCutsByWordGaps(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  minGap = 0.35,
) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    if (inside.length < 2) {
      out.push({ ...cut })
      continue
    }
    let start = Math.max(cut.start, inside[0].start - 0.04)
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].start - inside[i - 1].end
      if (gap >= minGap) {
        const end = Math.min(cut.end, inside[i - 1].end + 0.06)
        if (end - start >= 0.22) out.push({ start, end })
        start = Math.max(cut.start, inside[i].start - 0.04)
      }
    }
    const end = Math.min(cut.end, inside[inside.length - 1].end + 0.06)
    if (end - start >= 0.22) out.push({ start, end })
  }
  return out.length ? out : cuts
}

async function expandCutsBySilence(
  cuts: Array<{ start: number; end: number }>,
  inputPath: string,
) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    if (cut.end - cut.start < 2.2) {
      out.push({ ...cut })
      continue
    }
    try {
      const holes = await detectSilenceInRange(inputPath, cut.start, cut.end)
      const parts = splitCutsBySilence([cut], holes, 0.26)
      if (parts.length > 1) out.push(...parts)
      else out.push({ ...cut })
    } catch {
      out.push({ ...cut })
    }
  }
  return out.length ? out : cuts
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
 * One keep-clip sometimes contains a flub + the redo.
 * Split into consecutive word-gap parts; keep later of each similar pair.
 */
export function trimDoubledTakeCuts(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
  durationSeconds: number,
) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    const inside = [...wordsInCut(cut, words)].sort((a, b) => a.start - b.start)
    if (inside.length < 6 || cut.end - cut.start < 2.5) {
      out.push(cut)
      continue
    }

    // Build sub-segments on gaps ≥0.32s inside this cut
    const parts: Array<{ start: number; end: number }> = []
    let start = Math.max(0, inside[0].start - 0.04)
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].start - inside[i - 1].end
      if (gap >= 0.32) {
        const end = Math.min(durationSeconds, inside[i - 1].end + 0.06)
        if (end - start >= 0.35) parts.push({ start, end })
        start = Math.max(0, inside[i].start - 0.04)
      }
    }
    const lastEnd = Math.min(
      durationSeconds,
      inside[inside.length - 1].end + 0.06,
    )
    if (lastEnd - start >= 0.35) parts.push({ start, end: lastEnd })

    if (parts.length < 2) {
      // Fallback: midpoint compare (old heuristic, looser gates)
      const midCount = Math.floor(inside.length / 2)
      const first = inside
        .slice(0, midCount)
        .map((word) => word.word)
        .join(' ')
      const second = inside
        .slice(midCount)
        .map((word) => word.word)
        .join(' ')
      if (similarTakes(first, second)) {
        const later = inside.slice(midCount)
        const s = Math.max(0, later[0].start - 0.04)
        const e = Math.min(
          durationSeconds,
          later[later.length - 1].end + 0.06,
        )
        out.push(e - s >= 0.8 ? { start: s, end: e } : cut)
      } else {
        out.push(cut)
      }
      continue
    }

    const keep = parts.map(() => true)
    for (let later = parts.length - 1; later >= 1; later -= 1) {
      if (!keep[later]) continue
      const laterText = cutText(parts[later], words)
      if (takeTokens(laterText).length < 3) continue
      for (let earlier = 0; earlier < later; earlier += 1) {
        if (!keep[earlier]) continue
        // Prefer adjacent / nearby pairs (same retake burst)
        const gap = parts[later].start - parts[earlier].end
        if (gap > 8) continue
        if (similarTakes(cutText(parts[earlier], words), laterText)) {
          keep[earlier] = false
        }
      }
    }
    const kept = parts.filter((_, index) => keep[index])
    if (kept.length && kept.length < parts.length) {
      out.push(...kept)
    } else {
      out.push(cut)
    }
  }
  return out.length ? out : cuts
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
 * Drop earlier duplicate spoken phrases (sentence-level), keep later.
 * Rebuilds time ranges from kept phrase spans.
 */
function dropRepeatedPhrases(
  cuts: Array<{ start: number; end: number }>,
  words: TimedWord[],
) {
  if (words.length < 6 || cuts.length < 1) return cuts
  // Use uncompacted gaps so flub/redo pauses still split.
  const sentences = mergeSpokenPhrases(
    wordsToSentenceCues(words, { minPause: 0.32 }),
  ).filter((s) => takeTokens(s.text).length >= 3)
  if (sentences.length < 2) return cuts

  const keep = sentences.map(() => true)
  for (let later = sentences.length - 1; later >= 1; later -= 1) {
    if (!keep[later]) continue
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!keep[earlier]) continue
      if (similarTakes(sentences[earlier].text, sentences[later].text)) {
        keep[earlier] = false
      }
    }
  }

  const dropped = keep.filter((ok) => !ok).length
  if (!dropped) return cuts

  // Remove cut time that overlaps dropped phrase spans
  const dropRanges = sentences
    .filter((_, index) => !keep[index])
    .map((s) => ({ start: s.start, end: s.end }))

  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    let pieces = [{ ...cut }]
    for (const drop of dropRanges) {
      const next: Array<{ start: number; end: number }> = []
      for (const piece of pieces) {
        if (drop.end <= piece.start + 0.05 || drop.start >= piece.end - 0.05) {
          next.push(piece)
          continue
        }
        if (drop.start > piece.start + 0.2) {
          next.push({ start: piece.start, end: Math.min(piece.end, drop.start) })
        }
        if (drop.end < piece.end - 0.2) {
          next.push({ start: Math.max(piece.start, drop.end), end: piece.end })
        }
      }
      pieces = next
    }
    for (const piece of pieces) {
      if (piece.end - piece.start >= 0.22) out.push(piece)
    }
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

  const sentences = mergeSpokenPhrases(
    wordsToSentenceCues(words, { minPause: 0.32 }),
  ).filter(
    (sentence) =>
      sentence.start >= closeStart - 0.4 &&
      takeTokens(sentence.text).length >= 4,
  )

  if (sentences.length >= 2) {
    const keep = sentences.map(() => true)
    for (let later = 1; later < sentences.length; later += 1) {
      if (!keep[later]) continue
      for (let earlier = 0; earlier < later; earlier += 1) {
        if (!keep[earlier]) continue
        if (similarTakes(sentences[earlier].text, sentences[later].text)) {
          // Closing CTA: keep the first complete take, drop the later redo.
          if (thoughtLooksComplete(sentences[earlier].text)) {
            keep[later] = false
          } else {
            keep[earlier] = false
          }
          break
        }
      }
    }
    const droppedLater = keep.some((ok, index) => index > 0 && !ok)
    if (droppedLater) {
      const firstKept = sentences.find((_, index) => keep[index])
      const keptEnds = sentences
        .filter((_, index) => keep[index])
        .map((s) => s.end)
      if (firstKept && keptEnds.length) {
        let hardEnd = Math.max(...keptEnds) + 0.1
        if (!keep[keep.length - 1]) {
          hardEnd = Math.min(hardEnd, firstKept.end + 0.12)
        }
        return clipCutsToHardEnd(cuts, hardEnd)
      }
    }
  }

  // Fallback: cut-level + silence split on last long cut
  const closeCuts = cuts.filter((cut) => cut.end >= closeStart)
  const group = closeCuts.length
    ? closeCuts
    : cuts.slice(-Math.min(4, cuts.length))
  const texts = group.map((cut) => cutText(cut, words))
  const keep = texts.map((text) => takeTokens(text).length >= 3)
  for (let later = 1; later < group.length; later += 1) {
    if (!keep[later]) continue
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!keep[earlier]) continue
      if (similarTakes(texts[earlier], texts[later])) {
        if (thoughtLooksComplete(texts[earlier])) keep[later] = false
        else keep[earlier] = false
        break
      }
    }
  }
  if (keep.some((ok, index) => index > 0 && !ok)) {
    const keptEnds = group.filter((_, i) => keep[i]).map((c) => c.end)
    const firstKept = group.find((_, i) => keep[i])
    if (firstKept && keptEnds.length) {
      let hardEnd = Math.max(...keptEnds) + 0.1
      if (!keep[keep.length - 1]) hardEnd = Math.min(hardEnd, firstKept.end + 0.12)
      return clipCutsToHardEnd(cuts, hardEnd)
    }
  }

  const last = cuts[cuts.length - 1]
  if (!last || last.end - last.start < 4.5) return cuts
  try {
    const holes = await detectSilenceInRange(inputPath, last.start, last.end)
    const parts = splitCutsBySilence(
      [{ start: last.start, end: last.end }],
      holes,
      0.26,
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
    notes.push('Retake pass: skipped (need transcript words)')
    return { cuts: input.cuts, dropped: 0, notes }
  }

  const beforeSeconds = input.cuts.reduce(
    (sum, cut) => sum + Math.max(0, cut.end - cut.start),
    0,
  )
  const beforeCount = input.cuts.length

  // 1) Expand merged flub+redo into separate segments
  let cuts = expandCutsByWordGaps(input.cuts, input.words, 0.35)
  cuts = await expandCutsBySilence(cuts, input.inputPath)

  // 2) In-cut consecutive similar parts → keep later
  cuts = trimDoubledTakeCuts(cuts, input.words, input.durationSeconds)

  // 3) Sentence-level duplicate phrases (across the whole timeline)
  cuts = dropRepeatedPhrases(cuts, input.words)

  // 4) Whole-cut duplicate takes → keep later
  cuts = dropRepeatedTakes(cuts, input.words)

  // 5) Closing CTA filmed twice → keep first complete
  cuts = await dropClosingRetake(
    cuts,
    input.words,
    input.durationSeconds,
    input.inputPath,
  )

  if (!cuts.length) {
    notes.push('Retake pass: no change (guard kept original cuts)')
    return { cuts: input.cuts, dropped: 0, notes }
  }

  // Merge tiny adjacent leftovers that aren't retakes
  cuts = [...cuts].sort((a, b) => a.start - b.start)

  const afterSeconds = cuts.reduce(
    (sum, cut) => sum + Math.max(0, cut.end - cut.start),
    0,
  )
  const dropped = Math.max(0, beforeCount - cuts.length)
  // Also count expansions that then dropped (beforeCount may grow then shrink)
  const removedSeconds = Math.max(0, beforeSeconds - afterSeconds)

  if (dropped > 0 || removedSeconds > 0.25) {
    notes.push(
      `Removed retakes: kept later take${
        dropped ? ` (−${dropped} repeat segment${dropped === 1 ? '' : 's'})` : ''
      }${removedSeconds > 0.25 ? `, −${removedSeconds.toFixed(1)}s` : ''}`,
    )
  } else {
    notes.push('Retake pass: no duplicate takes detected')
  }

  return { cuts, dropped, notes }
}
