import { spawn } from 'child_process'
import { AUDIO_TIMELINE_FILTER, FFMPEG } from './ffmpeg'
import {
  SILERO_SAMPLE_RATE,
  SILERO_WINDOW,
  sileroSpeechMask,
  sileroSpeechProbs,
} from './silero-vad'
import type { TimedWord } from './timed-edit'

/**
 * Voice-activity map used to strip non-speech sounds (breaths, lip smacks,
 * "umm"s, coughs, room noise) out of talking keep-cuts.
 *
 * silencedetect only finds quiet — non-speech sounds are loud enough to pass
 * as "not silence", and Whisper stretches word timestamps across them. Here a
 * frame counts as speech only when it is loud relative to this clip's voice
 * level AND periodic (vocal-cord pitch) AND, when the model is available,
 * Silero VAD agrees it is human speech. Pitch rejects breaths, clicks and
 * noise; Silero rejects voiced non-speech (hums, "mmm", laughs).
 */

const SAMPLE_RATE = 8000
const HOP = 80 // 10 ms
const WIN = 320 // 40 ms
const MIN_LAG = 20 // 400 Hz
const MAX_LAG = 114 // ~70 Hz
const FRAME_SECONDS = HOP / SAMPLE_RATE

export type SpeechMap = {
  /** 1 = voice (with consonant fringe), 0 = not voice. */
  speech: Uint8Array
  /** 1 = frame has audible sound above the clip's noise floor. */
  sound: Uint8Array
  /** Which detectors produced `speech`. */
  engine: 'pitch' | 'pitch+silero'
}

function readPcm(inputPath: string): Promise<Int16Array> {
  return new Promise((resolve, reject) => {
    const proc = spawn(
      FFMPEG,
      [
        '-hide_banner',
        '-nostats',
        '-loglevel',
        'error',
        '-i',
        inputPath,
        '-vn',
        '-sn',
        '-map',
        '0:a:0',
        '-ac',
        '1',
        '-ar',
        String(SILERO_SAMPLE_RATE),
        '-af',
        `${AUDIO_TIMELINE_FILTER},highpass=f=60`,
        '-f',
        's16le',
        '-',
      ],
      { windowsHide: true },
    )
    const chunks: Buffer[] = []
    let stderr = ''
    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk))
    proc.stderr.on('data', (chunk) => {
      stderr += String(chunk)
    })
    proc.on('error', reject)
    proc.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(stderr.slice(-300) || `ffmpeg exited ${code}`))
        return
      }
      const buf = Buffer.concat(chunks)
      const out = new Int16Array(Math.floor(buf.length / 2))
      for (let i = 0; i < out.length; i++) out[i] = buf.readInt16LE(i * 2)
      resolve(out)
    })
  })
}

function percentile(sorted: Float64Array, p: number) {
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * p))]
}

/** Peak normalized autocorrelation across voice-pitch lags (0..1). */
function periodicity(frame: Float64Array) {
  let best = 0
  for (let lag = MIN_LAG; lag <= MAX_LAG; lag++) {
    let xy = 0
    let xx = 0
    let yy = 0
    for (let i = 0; i + lag < frame.length; i++) {
      const a = frame[i]
      const b = frame[i + lag]
      xy += a * b
      xx += a * a
      yy += b * b
    }
    const denom = Math.sqrt(xx * yy)
    if (denom > 0 && xy / denom > best) best = xy / denom
  }
  return best
}

function frameTime(frame: number) {
  return (frame * HOP + WIN / 2) / SAMPLE_RATE
}

function timeToFrame(seconds: number) {
  return Math.round((seconds * SAMPLE_RATE - WIN / 2) / HOP)
}

/** Returns null when voice cannot be told apart from background. */
export async function detectSpeechActivity(
  inputPath: string,
): Promise<SpeechMap | null> {
  // One decode at 16 kHz: Silero reads it as-is, the pitch check reads a 2:1
  // downsample (8 kHz is plenty for voice pitch and 2x cheaper).
  const pcm16 = await readPcm(inputPath)
  const pcm = new Int16Array(Math.floor(pcm16.length / 2))
  for (let i = 0; i < pcm.length; i++) {
    pcm[i] = (pcm16[2 * i] + pcm16[2 * i + 1]) >> 1
  }
  const frames = Math.floor((pcm.length - WIN) / HOP) + 1
  if (frames < 20) return null

  const db = new Float64Array(frames)
  const frame = new Float64Array(WIN)
  for (let f = 0; f < frames; f++) {
    const offset = f * HOP
    let mean = 0
    for (let i = 0; i < WIN; i++) mean += pcm[offset + i]
    mean /= WIN
    let energy = 0
    for (let i = 0; i < WIN; i++) {
      const v = pcm[offset + i] - mean
      energy += v * v
    }
    db[f] = 10 * Math.log10(energy / WIN + 1e-9)
  }

  const sorted = Float64Array.from(db).sort()
  const noiseFloor = percentile(sorted, 0.1)
  const voiceRef = percentile(sorted, 0.97)
  if (voiceRef - noiseFloor < 12) return null
  const gate = Math.max(noiseFloor + 8, voiceRef - 32)
  const fringeGate = voiceRef - 26

  const sound = new Uint8Array(frames)
  const voiced = new Uint8Array(frames)
  for (let f = 0; f < frames; f++) {
    if (db[f] < gate) continue
    sound[f] = 1
    const offset = f * HOP
    let mean = 0
    for (let i = 0; i < WIN; i++) mean += pcm[offset + i]
    mean /= WIN
    for (let i = 0; i < WIN; i++) frame[i] = pcm[offset + i] - mean
    if (periodicity(frame) >= 0.5) voiced[f] = 1
  }

  // Close tiny dropouts inside a vowel run, then drop click-length blips.
  fillShortGaps(voiced, 6)
  removeShortRuns(voiced, 5)

  // Grow runs into loud neighbouring frames (unvoiced consonants: s, f, t, k)
  // plus a small fixed fringe, without swallowing quiet breaths.
  const speech = new Uint8Array(voiced)
  for (let f = 0; f < frames; f++) {
    if (!voiced[f]) continue
    const runStart = f
    while (f + 1 < frames && voiced[f + 1]) f++
    const runEnd = f
    let left = runStart
    while (left > 0 && runStart - left < 14 && db[left - 1] >= fringeGate) left--
    let right = runEnd
    while (right + 1 < frames && right - runEnd < 14 && db[right + 1] >= fringeGate) {
      right++
    }
    left = Math.max(0, left - 4)
    right = Math.min(frames - 1, right + 4)
    for (let i = left; i <= right; i++) speech[i] = 1
  }

  let engine: SpeechMap['engine'] = 'pitch'
  try {
    const silero = sileroSpeechMask(await sileroSpeechProbs(pcm16))
    const windowSeconds = SILERO_WINDOW / SILERO_SAMPLE_RATE
    for (let f = 0; f < frames; f++) {
      const w = Math.floor(frameTime(f) / windowSeconds)
      if (!speech[f]) continue
      if (w >= silero.length || !silero[w]) speech[f] = 0
    }
    engine = 'pitch+silero'
  } catch {
    /* model unavailable — pitch-only map */
  }

  return { speech, sound, engine }
}

function fillShortGaps(mask: Uint8Array, maxGap: number) {
  let lastOn = -1
  for (let f = 0; f < mask.length; f++) {
    if (!mask[f]) continue
    if (lastOn >= 0 && f - lastOn - 1 <= maxGap) {
      for (let i = lastOn + 1; i < f; i++) mask[i] = 1
    }
    lastOn = f
  }
}

function removeShortRuns(mask: Uint8Array, minRun: number) {
  for (let f = 0; f < mask.length; f++) {
    if (!mask[f]) continue
    const start = f
    while (f + 1 < mask.length && mask[f + 1]) f++
    if (f - start + 1 < minRun) {
      for (let i = start; i <= f; i++) mask[i] = 0
    }
  }
}

function speechRuns(map: SpeechMap, from: number, to: number) {
  const lo = Math.max(0, timeToFrame(from))
  const hi = Math.min(map.speech.length - 1, timeToFrame(to))
  const runs: Array<{ start: number; end: number }> = []
  for (let f = lo; f <= hi; f++) {
    if (!map.speech[f]) continue
    const start = f
    while (f + 1 <= hi && map.speech[f + 1]) f++
    runs.push({
      start: frameTime(start) - FRAME_SECONDS / 2,
      end: frameTime(f) + FRAME_SECONDS / 2,
    })
  }
  return runs
}

function soundSeconds(map: SpeechMap, from: number, to: number) {
  const lo = Math.max(0, timeToFrame(from))
  const hi = Math.min(map.sound.length - 1, timeToFrame(to))
  let count = 0
  for (let f = lo; f <= hi; f++) if (map.sound[f]) count++
  return count * FRAME_SECONDS
}

/** Nudges Whisper to write out "umm"/"uh" instead of hiding them inside words. */
export const WHISPER_FILLER_PROMPT =
  "Umm, let me think like, hmm... Okay, here's what I'm, like, thinking."

const FILLER_WORD = /^(u+m+|u+h+|h+m+|m+h*m+|mhm|e+r+m*|a+h+|e+h+)$/i

export function isFillerWord(word: string) {
  return FILLER_WORD.test(word.replace(/[^A-Za-z]/g, ''))
}

/**
 * Pass raw Whisper words (not compactWordTimings output — that assumes the
 * stretch is always at the word's tail and can cut the real word off).
 *
 * Pull each Whisper word onto the voice that actually lives inside it, so
 * breaths/noise Whisper parked on a word become gaps. Falls back to the
 * original words when voice detection does not line up with the transcript.
 */
export function tightenWordsToSpeech(
  words: TimedWord[],
  map: SpeechMap,
): { words: TimedWord[]; reliable: boolean } {
  if (!words.length) return { words, reliable: false }
  const withVoice = words.filter(
    (word) => speechRuns(map, word.start, word.end).length > 0,
  ).length
  if (withVoice < words.length * 0.6) return { words, reliable: false }

  const out: TimedWord[] = []
  let prevTightEnd = -Infinity
  for (let index = 0; index < words.length; index++) {
    const word = words[index]
    const prev = words[index - 1]
    // Never reuse voice the previous word already claimed.
    const lo = Math.max(word.start - 0.06, prevTightEnd)
    const hi = word.end + 0.06
    const letters = word.word.replace(/[^A-Za-z0-9]/g, '').length
    const expected = Math.max(0.12, letters * 0.075 + 0.05)
    // Normal-length words keep Whisper's full span: voice detection misses
    // soft endings ("s", "ts") and splits words on stop consonants, so
    // trimming them clips real speech. Only words Whisper clearly stretched
    // across a pause get pulled onto their voice.
    if (word.end - word.start <= expected * 2.5 + 0.25) {
      out.push({ ...word })
      prevTightEnd = Math.max(prevTightEnd, word.end)
      continue
    }
    const afterBreak = !prev || /[.!?]["')\]]*$/.test(prev.word.trim())
    // No usable voice: keep Whisper's span, but never a multi-second stretch
    // (that would carry the whole pause back into the edit).
    const fallback = () => {
      const maxDur = expected + 0.3
      const clipped =
        word.end - word.start <= maxDur
          ? { ...word }
          : afterBreak
            ? { ...word, start: word.end - maxDur }
            : { ...word, end: word.start + maxDur }
      out.push(clipped)
      prevTightEnd = Math.max(prevTightEnd, clipped.end)
    }
    const runs = lo < hi ? speechRuns(map, lo, hi) : []
    if (!runs.length) {
      fallback()
      continue
    }

    // 0.2 s bridges unvoiced consonant clusters ("sk", "st") inside a word.
    const clusters: Array<{ start: number; end: number }> = []
    for (const run of runs) {
      const last = clusters[clusters.length - 1]
      if (last && run.start - last.end < 0.2) last.end = run.end
      else clusters.push({ ...run })
    }
    const usable = clusters.filter((c) => Math.min(hi, c.end) - Math.max(lo, c.start) >= 0.06)
    if (!usable.length) {
      fallback()
      continue
    }

    // Whisper stretches a word across the pause beside it. After a sentence
    // break the pause precedes the word ("I", "Now,") → real voice is last.
    // Otherwise, punctuation means the pause follows it ("skull.") → first.
    const endsPunct = /[.,!?;:]["')\]]*$/.test(word.word.trim())
    const pick = afterBreak
      ? usable[usable.length - 1]
      : endsPunct
        ? usable[0]
        : usable.reduce((best, cluster) =>
            Math.abs(cluster.end - cluster.start - expected) <
            Math.abs(best.end - best.start - expected)
              ? cluster
              : best,
          )
    // Generous margin so soft onsets / tails of the real word stay in.
    const start = Math.max(lo, pick.start - 0.05)
    const end = Math.min(hi, pick.end + 0.12)
    if (end - start < 0.06) {
      fallback()
      continue
    }
    out.push({ ...word, start, end })
    prevTightEnd = end
  }
  return { words: out, reliable: true }
}

/**
 * Re-cut each keep-segment on its spoken words: drop leading/trailing sound
 * and any between-word gap of 0.3 s+ that holds non-speech sound (or is a
 * long pause). Every word keeps a margin (60 ms before, 150 ms after) so
 * speech is never clipped; shorter gaps stay so speech keeps its rhythm.
 */
export function trimNonSpeechFromCuts(
  cuts: Array<{ start: number; end: number }>,
  speechWords: TimedWord[],
  map: SpeechMap,
  durationSeconds: number,
  opts: { pauseSeconds: number; minNoiseGap?: number },
): Array<{ start: number; end: number }> {
  const minNoiseGap = opts.minNoiseGap ?? 0.3
  const PRE = 0.06
  const POST = 0.15
  const out: Array<{ start: number; end: number }> = []

  for (const cut of cuts) {
    // Overlap, not midpoint: upstream cuts were built on Whisper's raw timing,
    // so a corrected word can sit just outside the cut it belongs to.
    const inside = speechWords
      .filter((word) => word.end > cut.start && word.start < cut.end)
      .sort((a, b) => a.start - b.start)
    if (!inside.length) continue

    const pieces: Array<{ first: TimedWord; last: TimedWord }> = []
    let first = inside[0]
    for (let i = 1; i < inside.length; i++) {
      const a = inside[i - 1]
      const b = inside[i]
      const gap = b.start - a.end
      // Measure only outside the word margins, so a word's own tail never
      // counts as "noise between words".
      const noisy =
        gap >= minNoiseGap &&
        soundSeconds(map, a.end + POST, b.start - PRE) >= 0.1
      if (noisy || gap >= opts.pauseSeconds) {
        pieces.push({ first, last: a })
        first = b
      }
    }
    pieces.push({ first, last: inside[inside.length - 1] })

    for (const piece of pieces) {
      const start = Math.max(0, piece.first.start - PRE)
      const end = Math.min(durationSeconds, piece.last.end + POST)
      if (end - start >= 0.12) out.push({ start, end })
    }
  }

  out.sort((a, b) => a.start - b.start)
  const merged: Array<{ start: number; end: number }> = []
  for (const cut of out) {
    const prev = merged[merged.length - 1]
    if (prev && cut.start <= prev.end + 0.02) prev.end = Math.max(prev.end, cut.end)
    else merged.push({ ...cut })
  }
  return merged
}
