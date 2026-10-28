import path from 'path'
import { detectSilenceInRange } from './ffmpeg'
import { refineStretchedWords } from './groq-transcribe'
import { measureLoudness, type Loudness } from './speech-activity'
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

/** Keep short words too — needed for 2-word redos like "this towel this towel". */
function takeTokensLoose(text: string) {
  return normalizeTakeText(text)
    .split(' ')
    .filter(Boolean)
}

function sequenceOverlap(a: string[], b: string[], minLen = 3) {
  const short = a.length <= b.length ? a : b
  const long = a.length <= b.length ? b : a
  if (short.length < minLen) return 0
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

export function similarTakes(
  a: string,
  b: string,
  opts?: { nearby?: boolean },
) {
  const ta = takeTokens(a)
  const tb = takeTokens(b)
  const la = takeTokensLoose(a)
  const lb = takeTokensLoose(b)
  const na = normalizeTakeText(a)
  const nb = normalizeTakeText(b)

  // Nearby short redos: exact / near-exact 2+ word phrases.
  if (opts?.nearby && la.length >= 2 && lb.length >= 2) {
    if (na === nb) return true
    if (la.length <= 6 && lb.length <= 6 && (na.includes(nb) || nb.includes(na))) {
      return true
    }
    if (
      la[0] === lb[0] &&
      la[1] === lb[1] &&
      Math.min(la.length, lb.length) <= 5
    ) {
      return true
    }
    if (sequenceOverlap(la, lb, 2) >= 0.85) return true
  }

  if (ta.length < 3 || tb.length < 3) return false
  const sa = new Set(ta)
  const sb = new Set(tb)
  let inter = 0
  for (const word of sa) {
    if (sb.has(word)) inter += 1
  }
  const union = sa.size + sb.size - inter
  const jaccard = union > 0 ? inter / union : 0
  const contained =
    Math.min(ta.length, tb.length) >= 4 &&
    (na.includes(nb) || nb.includes(na))
  const seq = sequenceOverlap(ta, tb)
  // Nearby retakes (same burst, e.g. 20–25s redo) need looser gates —
  // creators often restart after 3–4 words with a short pause.
  if (opts?.nearby) {
    return (
      jaccard >= 0.32 ||
      contained ||
      seq >= 0.55 ||
      samePrefix(ta, tb, 4) ||
      (samePrefix(ta, tb, 3) && Math.min(ta.length, tb.length) >= 4) ||
      (samePrefix(ta, tb, 2) && Math.min(ta.length, tb.length) >= 3)
    )
  }
  // Distant pairs stay stricter so unique lines across the video aren't wiped.
  return (
    jaccard >= 0.42 ||
    contained ||
    seq >= 0.68 ||
    (samePrefix(ta, tb, 4) && Math.min(ta.length, tb.length) >= 5)
  )
}

function isNearbyPair(
  earlierEnd: number,
  laterStart: number,
  maxGap = 12,
) {
  const gap = laterStart - earlierEnd
  return gap >= -0.15 && gap <= maxGap
}

/** Whisper writes a line the speaker trailed off on as "someone..." — not an ending. */
function trailsOff(text: string) {
  return /(\.\.\.|…)["')\]]*$/.test(text.trim())
}

function endsSentence(text: string) {
  return /[.!?]["')\]]*$/.test(text.trim()) && !trailsOff(text)
}

function thoughtLooksComplete(text: string) {
  if (trailsOff(text)) return false
  const tokens = takeTokens(text)
  if (tokens.length >= 8) return true
  return endsSentence(text) || tokens.length >= 5
}

/**
 * Split keep-cuts on real word gaps so flub + redo become separate segments.
 * Uses raw STT timings (not compacted) — gaps must survive.
 */
/**
 * Make split parts cover the whole cut: first starts at cut.start, last ends
 * at cut.end, neighbours meet at the middle of their gap. Splitting is only
 * for finding takes — it must never remove time by itself.
 */
function fillCut(parts: Array<{ start: number; end: number }>, cut: { start: number; end: number }) {
  if (parts.length < 2) return [{ ...cut }]
  const out = [...parts].sort((a, b) => a.start - b.start).map((p) => ({ ...p }))
  out[0].start = cut.start
  out[out.length - 1].end = cut.end
  for (let i = 1; i < out.length; i++) {
    const mid = (out[i - 1].end + out[i].start) / 2
    out[i - 1].end = mid
    out[i].start = mid
  }
  return out
}

function mergeTouchingCuts(cuts: Array<{ start: number; end: number }>) {
  const out: Array<{ start: number; end: number }> = []
  for (const cut of cuts) {
    const last = out[out.length - 1]
    if (last && cut.start <= last.end + 0.02) last.end = Math.max(last.end, cut.end)
    else out.push({ ...cut })
  }
  return out
}

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
    const parts: Array<{ start: number; end: number }> = []
    let start = Math.max(cut.start, inside[0].start - 0.04)
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].start - inside[i - 1].end
      if (gap >= minGap) {
        const end = Math.min(cut.end, inside[i - 1].end + 0.06)
        if (end - start >= 0.22) parts.push({ start, end })
        start = Math.max(cut.start, inside[i].start - 0.04)
      }
    }
    const end = Math.min(cut.end, inside[inside.length - 1].end + 0.06)
    if (end - start >= 0.22) parts.push({ start, end })
    out.push(...fillCut(parts, cut))
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
      out.push(...fillCut(parts, cut))
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
    const laterLoose = takeTokensLoose(laterText).length
    // Nearby cuts can be short 2-word redos; distant still need 3 content tokens.
    if (laterLoose < 2) continue
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!keep[earlier]) continue
      const nearby = isNearbyPair(sorted[earlier].end, sorted[later].start)
      if (!nearby && takeTokens(laterText).length < 3) continue
      if (
        similarTakes(cutText(sorted[earlier], words), laterText, { nearby })
      ) {
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

    // Build sub-segments on short pauses inside this cut (flub → redo)
    const parts: Array<{ start: number; end: number }> = []
    let start = Math.max(0, inside[0].start - 0.04)
    for (let i = 1; i < inside.length; i++) {
      const gap = inside[i].start - inside[i - 1].end
      if (gap >= 0.28) {
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
      if (similarTakes(first, second, { nearby: true })) {
        const later = inside.slice(midCount)
        const s = Math.max(cut.start, later[0].start - 0.04)
        out.push(cut.end - s >= 0.8 ? { start: s, end: cut.end } : cut)
      } else {
        out.push(cut)
      }
      continue
    }

    const keep = parts.map(() => true)
    for (let later = parts.length - 1; later >= 1; later -= 1) {
      if (!keep[later]) continue
      const laterText = cutText(parts[later], words)
      if (takeTokensLoose(laterText).length < 2) continue
      for (let earlier = 0; earlier < later; earlier += 1) {
        if (!keep[earlier]) continue
        // Prefer adjacent / nearby pairs (same retake burst)
        if (!isNearbyPair(parts[earlier].end, parts[later].start, 14)) continue
        if (
          similarTakes(cutText(parts[earlier], words), laterText, {
            nearby: true,
          })
        ) {
          keep[earlier] = false
        }
      }
    }
    const spans = fillCut(parts, cut)
    const kept = spans.filter((_, index) => keep[index])
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
      const nearby = isNearbyPair(
        sentences[earlier].end,
        sentences[later].start,
      )
      if (
        similarTakes(sentences[earlier].text, sentences[later].text, {
          nearby,
        })
      ) {
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
 * Where to end the video once a later closing redo is dropped: right after
 * the last kept line said before that redo. (Ending after the first kept line
 * in the window cut every line between it and the redo.)
 */
function closingHardEnd(items: TimeRange[], keep: boolean[]) {
  const firstDropped = keep.findIndex((ok, index) => index > 0 && !ok)
  if (firstDropped < 0) return null
  const keptEnds = items.filter((_, i) => keep[i]).map((item) => item.end)
  if (!keptEnds.length) return null
  let hardEnd = Math.max(...keptEnds) + 0.1
  if (!keep[keep.length - 1]) {
    const before = items.filter((_, i) => i < firstDropped && keep[i])
    if (before.length) hardEnd = Math.min(hardEnd, before[before.length - 1].end + 0.12)
  }
  return hardEnd
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
        if (
          similarTakes(sentences[earlier].text, sentences[later].text, {
            nearby: true,
          })
        ) {
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
    const hardEnd = closingHardEnd(sentences, keep)
    if (hardEnd !== null) return clipCutsToHardEnd(cuts, hardEnd)
  }

  // Fallback: cut-level + silence split on last long cut
  const closeCuts = cuts.filter((cut) => cut.end >= closeStart)
  const group = closeCuts.length
    ? closeCuts
    : cuts.slice(-Math.min(4, cuts.length))
  const texts = group.map((cut) => cutText(cut, words))
  // Short clips ("I'll link it") are too short to compare — but they stay.
  const comparable = texts.map((text) => takeTokens(text).length >= 3)
  const keep = group.map(() => true)
  for (let later = 1; later < group.length; later += 1) {
    if (!comparable[later] || !keep[later]) continue
    for (let earlier = 0; earlier < later; earlier += 1) {
      if (!comparable[earlier] || !keep[earlier]) continue
      if (similarTakes(texts[earlier], texts[later], { nearby: true })) {
        if (thoughtLooksComplete(texts[earlier])) keep[later] = false
        else keep[earlier] = false
        break
      }
    }
  }
  const hardEnd = closingHardEnd(group, keep)
  if (hardEnd !== null) return clipCutsToHardEnd(cuts, hardEnd)

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
      similarTakes(cutText(first, words), cutText(second, words), {
        nearby: true,
      })
    ) {
      return clipCutsToHardEnd(cuts, first.end + 0.08)
    }
  } catch {
    /* keep as-is */
  }
  return cuts
}

type TimeRange = { start: number; end: number }

/** Lowercase word without punctuation — keeps short words (I, a, to). */
function flubToken(word: string) {
  return word.toLowerCase().replace(/[^a-z0-9']/g, '')
}

/** Function-word stutters always drop. Content doubles ("soft soft") also drop when adjacent. */
const STUTTER_WORDS = new Set([
  'i', 'a', 'an', 'the', 'and', 'to', 'so', 'but', 'we', 'you', 'it',
  'in', 'of', 'my', 'this', 'if', 'or', 'for', 'on', 'be', "i'm",
  "it's", "we're", "you're", "that's", 'he', 'she', 'they', 'our', 'your',
])

/** Intentional emphasis pairs we leave alone ("no no", "bye bye"). */
const KEEP_DOUBLE_WORDS = new Set([
  'no', 'yes', 'bye', 'hey', 'hi', 'ha', 'oh', 'wow', 'yay',
])

/** Explicit "I messed up" cues spoken mid-take. Each is a token sequence. */
const CORRECTION_CUES: string[][] = [
  ['let', 'me', 'start', 'again'],
  ['let', 'me', 'start', 'over'],
  ['let', 'me', 'try', 'again'],
  ['let', 'me', 'try', 'that', 'again'],
  ['let', 'me', 'say', 'that', 'again'],
  ['let', 'me', 'do', 'that', 'again'],
  ['let', 'me', 'redo', 'that'],
  ['let', 'me', 'redo'],
  ['start', 'over'],
  ['one', 'more', 'time'],
  ['take', 'two'],
  ['scratch', 'that'],
  ['cut', 'that'],
  ['my', 'bad'],
  ['oops'],
  ['sorry'],
]

/** Cues that correct the words right before them ("… I mean, …"). */
const SELF_CORRECTION_CUES: string[][] = [
  ['i', 'mean'],
  ['i', 'meant'],
  ['or', 'rather'],
  ['no', 'wait'],
]

/** Words people say to restart a line ("…freetur- And this thing…"). */
const RESTART_JOINERS = new Set(['and', 'so', 'okay', 'ok', 'sorry', 'again'])

const FILLER_TOKENS = new Set(['um', 'umm', 'uh', 'uhh', 'er', 'ah', 'hmm', 'like'])

/** "sorry for / about / to …" is real speech, not a flub cue. */
const SORRY_CONTINUES = new Set(['for', 'about', 'to', 'that', 'if', 'but', 'guys'])

function matchAt(tokens: string[], at: number, seq: string[]) {
  if (at + seq.length > tokens.length) return false
  for (let k = 0; k < seq.length; k++) {
    if (tokens[at + k] !== seq[k]) return false
  }
  return true
}

/** Index of the first word of the current utterance (after a pause or sentence end). */
function utteranceStart(words: TimedWord[], from: number, minPause = 0.45) {
  let i = from
  while (i > 0) {
    const prev = words[i - 1]
    if (words[i].start - prev.end >= minPause) break
    if (/[.!?]$/.test(prev.word.trim())) break
    i -= 1
  }
  return i
}

function subtractRanges(cuts: TimeRange[], drops: TimeRange[], minPiece = 0.12) {
  if (!drops.length) return cuts
  const sortedDrops = [...drops].sort((a, b) => a.start - b.start)
  const out: TimeRange[] = []
  for (const cut of cuts) {
    let pieces: TimeRange[] = [{ ...cut }]
    for (const drop of sortedDrops) {
      const next: TimeRange[] = []
      for (const piece of pieces) {
        if (drop.end <= piece.start || drop.start >= piece.end) {
          next.push(piece)
          continue
        }
        if (drop.start - piece.start >= minPiece) {
          next.push({ start: piece.start, end: drop.start })
        }
        if (piece.end - drop.end >= minPiece) {
          next.push({ start: drop.end, end: piece.end })
        }
      }
      pieces = next
    }
    out.push(...pieces)
  }
  return out
}

function frameAt(l: Loudness, t: number) {
  return Math.max(0, Math.min(l.db.length - 1, Math.round(t / l.hop)))
}

/** Pauses (≥ 60 ms below the gate) inside [from, to], clipped to the window. */
function quietRuns(l: Loudness, from: number, to: number) {
  const lo = frameAt(l, from)
  const hi = frameAt(l, to)
  const runs: TimeRange[] = []
  for (let f = lo; f <= hi; f++) {
    if (l.db[f] >= l.gate) continue
    const s = f
    // Ride over 1–2 frame blips (breath, click) inside a pause.
    while (f + 1 <= hi) {
      if (l.db[f + 1] < l.gate) f += 1
      else if (f + 2 <= hi && l.db[f + 2] < l.gate) f += 2
      else if (f + 3 <= hi && l.db[f + 3] < l.gate) f += 3
      else break
    }
    if ((f - s + 1) * l.hop >= 0.06) runs.push({ start: s * l.hop, end: (f + 1) * l.hop })
  }
  return runs
}

function loudSeconds(l: Loudness, from: number, to: number) {
  let count = 0
  for (let f = frameAt(l, from); f <= frameAt(l, to); f++) if (l.db[f] >= l.gate) count++
  return count * l.hop
}

/** Quietest frame in the window, mildly pulled toward `near`. */
function quietestPoint(l: Loudness, from: number, to: number, near: number) {
  let best = -1
  let bestScore = Infinity
  for (let f = frameAt(l, from); f <= frameAt(l, to); f++) {
    const score = l.db[f] + 10 * Math.abs(f * l.hop - near)
    if (score < bestScore) {
      bestScore = score
      best = f
    }
  }
  return best < 0 ? null : best * l.hop
}

function expectedSpeechSeconds(words: TimedWord[]) {
  return words.reduce(
    (sum, word) => sum + word.word.replace(/[^A-Za-z0-9]/g, '').length * 0.075 + 0.05,
    0,
  )
}

/**
 * Whisper times repeated words badly — it squeezes the flub into a sliver
 * ("because," 2.76–2.86) and gives the rest to the redo, which is really
 * 2.66–3.50 + 3.64–4.0. Cutting on those times slices words in half. Move the
 * cut onto the pauses that actually surround the dropped words.
 */
function snapDropToPauses(
  words: TimedWord[],
  first: number,
  last: number,
  l: Loudness,
): TimeRange | null {
  const prevKept = words[first - 1]
  const nextKept = words[last + 1]
  const flubStart = words[first].start
  const flubEnd = words[last].end

  // Start: never take more than 40% of the kept word before the flub.
  const startLo = Math.max(
    flubStart - 0.4,
    prevKept ? prevKept.start + 0.6 * (prevKept.end - prevKept.start) : 0,
  )
  const startHi = Math.min(flubStart + 0.35, words[first].end + 0.05)
  if (startHi <= startLo) return null
  const startRuns = quietRuns(l, startLo, startHi)
  let start: number | null
  if (startRuns.length) {
    const run = startRuns.reduce((a, b) =>
      Math.abs((a.start + a.end) / 2 - flubStart) <= Math.abs((b.start + b.end) / 2 - flubStart) ? a : b,
    )
    start = Math.min(run.start + 0.08, (run.start + run.end) / 2)
  } else {
    start = quietestPoint(l, startLo, startHi, flubStart)
  }
  if (start === null) return null

  // End: the pause before the redo. Whisper's redo word can be stretched far
  // past the real pause, so look up to its end.
  const endLo = Math.max(start + 0.1, words[last].start)
  const endHi = nextKept ? Math.min(flubEnd + 0.8, nextKept.end + 0.1) : flubEnd + 0.4
  let end: number | null = null
  if (endHi > endLo) {
    const endRuns = quietRuns(l, endLo, endHi)
    if (endRuns.length) {
      const run = endRuns.reduce((a, b) =>
        Math.abs((a.start + a.end) / 2 - flubEnd) <= Math.abs((b.start + b.end) / 2 - flubEnd) ? a : b,
      )
      end = Math.max(run.end - 0.08, (run.start + run.end) / 2)
    }
  }
  // A pause past the redo would take the kept word with it — only accept
  // spans whose speech fits the dropped words.
  const maxLoud = expectedSpeechSeconds(words.slice(first, last + 1)) * 1.6 + 0.2
  if (end === null || loudSeconds(l, start, end) > maxLoud) {
    end = quietestPoint(l, flubEnd - 0.12, flubEnd + 0.12, flubEnd)
  }
  if (end === null || end - start < 0.08) return null
  return { start, end }
}

/**
 * Word-level mistakes the take-matching passes miss:
 * - stutters ("I I think", "the the", "soft soft")
 * - 2-word immediate redos ("hand towels hand towels")
 * - restarts ("we went to the — we went to the store")
 * - short false starts before a pause that the next phrase restarts
 * - spoken correction cues ("sorry", "let me start again") + the flub before them
 * Always keeps the later attempt.
 */
export function dropFlubs(
  cuts: TimeRange[],
  allWords: TimedWord[],
  loudness?: Loudness | null,
) {
  const counts = { stutters: 0, restarts: 0, falseStarts: 0, cues: 0 }
  const inCuts = allWords
    .filter((word) => cuts.some((cut) => word.end > cut.start && word.start < cut.end))
    .sort((a, b) => a.start - b.start)
  const words = inCuts.filter((word) => flubToken(word.word))
  const tokens = words.map((word) => flubToken(word.word))
  if (words.length < 3) return { cuts, removedSeconds: 0, counts }

  const drop = words.map(() => false)
  const markRange = (from: number, to: number) => {
    for (let k = from; k < to; k++) drop[k] = true
  }

  // 1) Correction cues — drop the flubbed utterance and the cue itself.
  for (let i = 0; i < tokens.length; i++) {
    const cue = CORRECTION_CUES.find((seq) => matchAt(tokens, i, seq))
    if (!cue) continue
    const cueEnd = i + cue.length
    if (cue[0] === 'sorry' && cue.length === 1) {
      const next = tokens[cueEnd]
      const pauseAround =
        (i > 0 && words[i].start - words[i - 1].end >= 0.2) ||
        (cueEnd < words.length && words[cueEnd].start - words[cueEnd - 1].end >= 0.2)
      if ((next && SORRY_CONTINUES.has(next)) || !pauseAround) continue
    }
    let from = utteranceStart(words, i)
    // Cue said on its own ("… camera. | Sorry. | This phone …") — the flub is
    // the utterance before it.
    if (from === i && i > 0) from = utteranceStart(words, i - 1)
    // Guard: never wipe a long stretch on one cue.
    if (i - from > 14 || words[i].start - words[from].start > 7) {
      markRange(i, cueEnd)
    } else {
      markRange(from, cueEnd)
    }
    counts.cues += 1
    i = cueEnd - 1
  }

  // 1b) Self-correction — "this is nice. I mean, this is pretty nice."
  // Only when the words after the cue restart words said just before it.
  for (let i = 1; i < tokens.length; i++) {
    const cue = SELF_CORRECTION_CUES.find((seq) => matchAt(tokens, i, seq))
    if (!cue || drop[i]) continue
    let after = i + cue.length
    while (after < tokens.length && FILLER_TOKENS.has(tokens[after])) after += 1
    if (after + 1 >= tokens.length) continue
    for (let from = i - 2; from >= Math.max(0, i - 10); from--) {
      if (tokens[from] === tokens[after] && tokens[from + 1] === tokens[after + 1]) {
        markRange(from, after)
        counts.cues += 1
        break
      }
    }
  }

  // 2a) Adjacent doubles — "because because", "knowing knowing", "soft soft".
  // Whisper often keeps punctuation on the first token ("because,"); flubToken
  // already strips that so these compare equal.
  for (let i = 0; i < tokens.length - 1; i++) {
    if (drop[i] || drop[i + 1]) continue
    if (tokens[i] !== tokens[i + 1]) continue
    if (KEEP_DOUBLE_WORDS.has(tokens[i])) continue
    if (!(STUTTER_WORDS.has(tokens[i]) || tokens[i].length >= 2)) continue
    // Only treat as a stutter when the two starts are close (same burst).
    if (words[i + 1].start - words[i].start > 1.8) continue
    markRange(i, i + 1)
    counts.stutters += 1
  }

  // 2b) N-gram redos with optional junk in between —
  // "this thing has, this has" / "hand towels hand towels".
  for (let i = 0; i < tokens.length; i++) {
    if (drop[i]) continue
    for (let n = 4; n >= 1; n -= 1) {
      if (i + n > tokens.length) continue
      const maxJ = Math.min(tokens.length - n, i + n + 5)
      for (let j = i + n; j <= maxJ; j++) {
        if (drop[j]) continue
        if (words[j].start - words[i].start > 5) break
        let same = true
        for (let t = 0; t < n; t++) {
          if (tokens[i + t] !== tokens[j + t]) {
            same = false
            break
          }
        }
        if (!same) continue
        // Single-word distant repeats are often real speech ("that … that").
        // Require adjacent-ish for n=1, or a content word + short gap.
        const intervening = j - (i + n)
        if (n === 1) {
          if (KEEP_DOUBLE_WORDS.has(tokens[i])) continue
          if (intervening > 3) continue
          if (
            intervening > 0 &&
            tokens[i].length < 3 &&
            !STUTTER_WORDS.has(tokens[i])
          ) {
            continue
          }
          // "this thing has, this has" — first "this" repeats after 2 words.
          // Allow when the span is short.
          if (intervening >= 1 && words[j].start - words[i].end > 2.2) continue
          // A redo carries on with words from the abandoned try ("has"). Plain
          // speech doesn't: "I think, if I went" must stay.
          if (intervening >= 1 && !tokens.slice(i + 1, j).includes(tokens[j + 1])) {
            continue
          }
        } else if (intervening > 4) {
          continue
        }
        markRange(i, j)
        if (n === 1 && intervening === 0) counts.stutters += 1
        else counts.restarts += 1
        i = j - 1
        n = 0
        break
      }
    }
  }

  // 2c) Classic restart with fillers / cut-offs between attempts.
  for (let i = 0; i < tokens.length; i++) {
    if (drop[i]) continue
    for (let j = i + 1; j <= Math.min(tokens.length - 1, i + 8); j++) {
      if (words[j].start - words[i].start > 6) break
      let k = 0
      while (j + k < tokens.length && i + k < j && tokens[i + k] === tokens[j + k]) {
        k += 1
      }
      const extra = j - i - k
      const redoWord = tokens[j + k] ?? ''
      let extraIsFlub = extra <= 3
      for (let e = i + k; e < j && extraIsFlub; e++) {
        const tok = tokens[e]
        const cutOff =
          /-$/.test(words[e].word.trim()) ||
          (tok.length < redoWord.length && redoWord.startsWith(tok))
        extraIsFlub = FILLER_TOKENS.has(tok) || RESTART_JOINERS.has(tok) || cutOff
      }
      if (
        extra > 1 &&
        !words.slice(i + k, j).some((w) => /-$/.test(w.word.trim()))
      ) {
        extraIsFlub = false
      }
      const brokeOff =
        words[j].start - words[j - 1].end >= 0.12 || extra === 1 || extra === 0
      const restart =
        extraIsFlub &&
        (k >= 3 || (k >= 2 && brokeOff) || (k === 2 && extra === 0))
      if (!restart) continue
      markRange(i, j)
      counts.restarts += 1
      i = j - 1
      break
    }
  }

  // 3) False start — short unfinished phrase, pause, then the same opener.
  for (let i = 0; i < words.length; i++) {
    if (drop[i]) continue
    let end = i
    while (end + 1 < words.length && words[end + 1].start - words[end].end < 0.35) end += 1
    const next = end + 1
    const size = end - i + 1
    if (
      next < words.length &&
      size <= 5 &&
      !endsSentence(words[end].word) &&
      words[next].start - words[end].end <= 2.5
    ) {
      let k = 0
      while (k < size && next + k < tokens.length && tokens[i + k] === tokens[next + k]) k += 1
      // Catch 2-word false starts ("this towel … this towel …") and full short redos.
      if (k >= 2 || (k >= 1 && k === size) || (k >= 1 && size <= 2)) {
        markRange(i, next)
        counts.falseStarts += 1
      } else {
        // Redo picks up partway through: "Because this thing has… This has
        // reverse…" → drop "this thing has", keep "Because".
        for (let o = i + 1; o <= end; o++) {
          if (
            tokens[o] === tokens[next] &&
            next + 1 < tokens.length &&
            tokens.slice(o + 1, end + 1).includes(tokens[next + 1])
          ) {
            markRange(o, next)
            counts.falseStarts += 1
            break
          }
        }
      }
    }
    i = end
  }

  const ranges: TimeRange[] = []
  for (let i = 0; i < words.length; i++) {
    if (!drop[i]) continue
    let j = i
    while (j + 1 < words.length && drop[j + 1]) j += 1
    // Whisper often packs a stutter flush against the redo
    // ("because," end === next "because" start). Ending at next.start-0.04
    // only shaved ~0.05–0.1s and left both words audible.
    let start = Math.max(0, words[i].start - 0.06)
    let end: number
    if (j + 1 < words.length) {
      const nextStart = words[j + 1].start
      const droppedEnd = words[j].end
      // Cut through the full dropped word(s), up to the kept word's start.
      end = Math.max(droppedEnd, Math.min(nextStart, droppedEnd + 0.1))
      end = Math.min(end, nextStart)
      // Tiny / zero-duration Whisper spans — still remove up to the redo.
      if (end - start < 0.08) end = nextStart
    } else {
      end = words[j].end + 0.08
    }
    if (loudness) {
      const snapped = snapDropToPauses(words, i, j, loudness)
      if (snapped) ({ start, end } = snapped)
    }
    const prev = ranges[ranges.length - 1]
    if (prev) start = Math.max(start, prev.end)
    if (end > start + 0.04) ranges.push({ start, end })
    i = j
  }
  if (!ranges.length) return { cuts, removedSeconds: 0, counts }

  const next = subtractRanges(cuts, ranges, 0.08)
  if (!next.length) return { cuts, removedSeconds: 0, counts }
  const length = (list: TimeRange[]) =>
    list.reduce((sum, cut) => sum + Math.max(0, cut.end - cut.start), 0)
  return { cuts: next, removedSeconds: Math.max(0, length(cuts) - length(next)), counts }
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

  // Re-listen to spots where Whisper smoothed over a flub (one word stretched
  // across a hidden restart) so the passes below can see it.
  let words = input.words
  try {
    const refine = await refineStretchedWords(
      input.inputPath,
      input.words,
      path.join(path.dirname(input.inputPath), '.cache', 'refine'),
    )
    words = refine.words
    if (refine.refined) {
      notes.push(`Re-checked ${refine.refined} unclear spot${refine.refined === 1 ? '' : 's'} in the transcript`)
    }
  } catch {
    /* keep the original transcript */
  }

  // 0) Word-level flubs: stutters, restarts, false starts, "sorry / let me redo"
  let loudness: Loudness | null = null
  try {
    loudness = await measureLoudness(input.inputPath)
  } catch {
    /* fall back to Whisper word times */
  }
  const flubs = dropFlubs(input.cuts, words, loudness)
  const flubParts = [
    flubs.counts.restarts && `${flubs.counts.restarts} restart${flubs.counts.restarts === 1 ? '' : 's'}`,
    flubs.counts.falseStarts && `${flubs.counts.falseStarts} false start${flubs.counts.falseStarts === 1 ? '' : 's'}`,
    flubs.counts.stutters && `${flubs.counts.stutters} stutter${flubs.counts.stutters === 1 ? '' : 's'}`,
    flubs.counts.cues && `${flubs.counts.cues} spoken correction${flubs.counts.cues === 1 ? '' : 's'}`,
  ].filter(Boolean)
  if (flubParts.length) {
    notes.push(
      `Removed mistakes: ${flubParts.join(', ')} (−${flubs.removedSeconds.toFixed(1)}s)`,
    )
  }

  // 1) Expand merged flub+redo into separate segments
  let cuts = expandCutsByWordGaps(flubs.cuts, words, 0.35)
  cuts = await expandCutsBySilence(cuts, input.inputPath)

  // 2) In-cut consecutive similar parts → keep later
  cuts = trimDoubledTakeCuts(cuts, words, input.durationSeconds)

  // 3) Sentence-level duplicate phrases (across the whole timeline)
  cuts = dropRepeatedPhrases(cuts, words)

  // 4) Whole-cut duplicate takes → keep later
  cuts = dropRepeatedTakes(cuts, words)

  // 5) Closing CTA filmed twice → keep first complete
  cuts = await dropClosingRetake(
    cuts,
    words,
    input.durationSeconds,
    input.inputPath,
  )

  if (!cuts.length) {
    notes.push('Retake pass: no change (guard kept original cuts)')
    return { cuts: input.cuts, dropped: 0, notes }
  }

  cuts = [...cuts].sort((a, b) => a.start - b.start)
  const keptParts = cuts.length
  // Splits above are only for comparing takes — join pieces that still touch
  // (and any overlapping input cuts) so nothing plays twice or jumps mid-line.
  cuts = mergeTouchingCuts(cuts)

  const afterSeconds = cuts.reduce(
    (sum, cut) => sum + Math.max(0, cut.end - cut.start),
    0,
  )
  const dropped = Math.max(0, beforeCount - keptParts)
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
