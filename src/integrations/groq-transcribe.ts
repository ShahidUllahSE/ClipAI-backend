import crypto from 'crypto'
import fs from 'fs'
import path from 'path'
import { env } from '../config'
import { extractAudioForStt, extractAudioSlice } from './ffmpeg'
import type { CaptionCue, TimedWord } from './timed-edit'
import { WHISPER_FILLER_PROMPT } from './speech-activity'

export const GROQ_CHUNK_SECONDS = 8 * 60

type GroqWord = { word?: string; start?: number; end?: number }
type GroqSegment = {
  text?: string
  start?: number
  end?: number
  words?: GroqWord[]
}

export type GroqTranscript = {
  transcript: string
  words: TimedWord[]
  phrases: CaptionCue[]
}

function mapGroqWords(raw: GroqWord[] | undefined, offsetSeconds: number) {
  return (raw ?? [])
    .filter(
      (w) =>
        typeof w.word === 'string' &&
        typeof w.start === 'number' &&
        typeof w.end === 'number',
    )
    .map((w) => ({
      word: String(w.word),
      start: Number(w.start) + offsetSeconds,
      end: Number(w.end) + offsetSeconds,
    }))
}

function parseGroqTranscript(
  data: {
    text?: string
    words?: GroqWord[]
    segments?: GroqSegment[]
  },
  offsetSeconds: number,
): GroqTranscript {
  let words = mapGroqWords(data.words, offsetSeconds)

  if (!words.length) {
    words = (data.segments ?? []).flatMap((segment) =>
      mapGroqWords(segment.words, offsetSeconds),
    )
  }

  const phrases: CaptionCue[] = (data.segments ?? [])
    .map((segment) => {
      const text = String(segment.text ?? '').replace(/\s+/g, ' ').trim()
      const start = Number(segment.start)
      const end = Number(segment.end)
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null
      return {
        text,
        start: start + offsetSeconds,
        end: end + offsetSeconds,
      }
    })
    .filter((row): row is CaptionCue => Boolean(row))

  return {
    transcript: (data.text ?? words.map((w) => w.word).join(' ')).trim(),
    words,
    phrases,
  }
}

async function transcribeWithGroqLegacy(
  audioPath: string,
  mimeType: string,
  offsetSeconds: number,
) {
  const bytes = fs.readFileSync(audioPath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    path.basename(audioPath),
  )
  form.append('model', 'whisper-large-v3')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  form.append('prompt', WHISPER_FILLER_PROMPT)

  const response = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: form,
    },
  )
  if (!response.ok) {
    throw new Error(`Groq STT failed: ${await response.text()}`)
  }
  return parseGroqTranscript(
    (await response.json()) as {
      text?: string
      words?: GroqWord[]
      segments?: GroqSegment[]
    },
    offsetSeconds,
  )
}

async function transcribeWithGroq(
  audioPath: string,
  mimeType: string,
  offsetSeconds = 0,
): Promise<GroqTranscript> {
  if (!env.GROQ_API_KEY) {
    return { transcript: '', words: [], phrases: [] }
  }

  const bytes = fs.readFileSync(audioPath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: mimeType }),
    path.basename(audioPath),
  )
  form.append('model', 'whisper-large-v3-turbo')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')
  form.append('timestamp_granularities[]', 'segment')
  form.append('prompt', WHISPER_FILLER_PROMPT)

  const response = await fetch(
    'https://api.groq.com/openai/v1/audio/transcriptions',
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${env.GROQ_API_KEY}`,
      },
      body: form,
    },
  )

  if (!response.ok) {
    const detail = await response.text()
    if (/whisper-large-v3-turbo/i.test(detail)) {
      return transcribeWithGroqLegacy(audioPath, mimeType, offsetSeconds)
    }
    throw new Error(`Groq STT failed: ${detail}`)
  }

  return parseGroqTranscript(
    (await response.json()) as {
      text?: string
      words?: GroqWord[]
      segments?: GroqSegment[]
    },
    offsetSeconds,
  )
}

/** Bump when the Groq request changes (model, prompt) so old cache entries miss. */
const CACHE_VERSION = 'v2-container-clock'

function hashFile(filePath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha1')
    fs.createReadStream(filePath)
      .on('data', (chunk) => hash.update(chunk))
      .on('error', reject)
      .on('end', () => resolve(hash.digest('hex')))
  })
}

function cachePathFor(inputPath: string, digest: string) {
  return path.join(
    path.dirname(inputPath),
    '.cache',
    'transcripts',
    `${digest}-${CACHE_VERSION}.json`,
  )
}

/**
 * Groq Whisper transcript of the source (Talking-head + Rapid-cut). Cached
 * by file content, so re-editing the same upload with new settings does not
 * pay for (or wait on) transcription again.
 */
export async function transcribeSourceAudio(
  inputPath: string,
  durationSeconds: number,
  tempDir: string,
): Promise<GroqTranscript> {
  let cachePath: string | null = null
  try {
    cachePath = cachePathFor(inputPath, await hashFile(inputPath))
    if (fs.existsSync(cachePath)) {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8')) as GroqTranscript
      if (Array.isArray(cached.words) && Array.isArray(cached.phrases)) return cached
    }
  } catch {
    cachePath = null
  }

  const result = await transcribeUncached(inputPath, durationSeconds, tempDir)
  if (cachePath && env.GROQ_API_KEY && result.words.length) {
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      fs.writeFileSync(cachePath, JSON.stringify(result))
    } catch {
      /* cache is best-effort */
    }
  }
  return result
}

/**
 * Whisper on a whole video often "cleans up" a flub into one smooth sentence
 * and stretches a single word over the hidden part ("features" 26.9→30.3s
 * covering "freetur- And this thing has a ton of"). Re-transcribe just those
 * spots on their own — short clips come back verbatim — and splice the words in.
 */
export async function refineStretchedWords(
  inputPath: string,
  words: TimedWord[],
  tempDir: string,
  opts: { maxWindows?: number; minWordSeconds?: number } = {},
): Promise<{ words: TimedWord[]; refined: number }> {
  if (!env.GROQ_API_KEY || words.length < 3) return { words, refined: 0 }
  const sorted = [...words].sort((a, b) => a.start - b.start)
  const minWord = opts.minWordSeconds ?? 1.0

  // Window = the utterance around each stretched word (bounded by ≥0.5s gaps).
  const windows: Array<{ start: number; end: number }> = []
  for (let i = 0; i < sorted.length; i++) {
    if (sorted[i].end - sorted[i].start < minWord) continue
    let a = i
    while (a > 0 && sorted[a].start - sorted[a - 1].end < 0.5 && sorted[i].start - sorted[a - 1].start < 8) a -= 1
    let b = i
    while (b + 1 < sorted.length && sorted[b + 1].start - sorted[b].end < 0.5 && sorted[b + 1].end - sorted[i].end < 4) b += 1
    const start = Math.max(0, sorted[a].start - 0.2)
    const end = sorted[b].end + 0.2
    const last = windows[windows.length - 1]
    if (last && start <= last.end) last.end = Math.max(last.end, end)
    else windows.push({ start, end })
  }
  if (!windows.length) return { words, refined: 0 }

  let out = sorted
  let refined = 0
  for (const win of windows.slice(0, opts.maxWindows ?? 6)) {
    const slicePath = path.join(tempDir, `refine-${Date.now()}-${refined}.mp3`)
    try {
      fs.mkdirSync(tempDir, { recursive: true })
      await extractAudioSlice(inputPath, slicePath, win.start, win.end - win.start)
      const part = await transcribeWithGroq(slicePath, 'audio/mpeg', win.start)
      const inside = out.filter((w) => w.start >= win.start && w.end <= win.end + 0.3)
      // Only trust the re-take when it heard at least as much as before.
      if (part.words.length < inside.length || !part.words.length) continue
      const fresh = part.words.filter((w) => w.start < win.end + 0.3)
      out = [
        ...out.filter((w) => !inside.includes(w)),
        ...fresh,
      ].sort((a, b) => a.start - b.start)
      refined += 1
    } catch {
      /* keep the original words for this window */
    } finally {
      if (fs.existsSync(slicePath)) fs.unlinkSync(slicePath)
    }
  }
  return { words: out, refined }
}

async function transcribeUncached(
  inputPath: string,
  durationSeconds: number,
  tempDir: string,
): Promise<GroqTranscript> {
  const extracted = await extractAudioForStt(
    inputPath,
    path.join(tempDir, `audio-${Date.now()}`),
  )

  try {
    if (durationSeconds <= GROQ_CHUNK_SECONDS + 30) {
      return transcribeWithGroq(extracted.path, extracted.mimeType)
    }

    const transcriptParts: string[] = []
    const words: TimedWord[] = []
    const phrases: CaptionCue[] = []

    for (let start = 0; start < durationSeconds; start += GROQ_CHUNK_SECONDS) {
      const chunkDur = Math.min(GROQ_CHUNK_SECONDS, durationSeconds - start)
      const chunkPath = path.join(tempDir, `chunk-${start}.mp3`)
      await extractAudioSlice(extracted.path, chunkPath, start, chunkDur)
      try {
        const part = await transcribeWithGroq(chunkPath, 'audio/mpeg', start)
        if (part.transcript.trim()) transcriptParts.push(part.transcript.trim())
        words.push(...part.words)
        phrases.push(...part.phrases)
      } finally {
        if (fs.existsSync(chunkPath)) fs.unlinkSync(chunkPath)
      }
    }

    return { transcript: transcriptParts.join(' '), words, phrases }
  } finally {
    if (fs.existsSync(extracted.path)) fs.unlinkSync(extracted.path)
  }
}
