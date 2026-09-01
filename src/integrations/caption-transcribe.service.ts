import fs from 'fs'
import os from 'os'
import path from 'path'
import { env } from '../config'
import { HTTP_STATUS } from '../constants/http'
import { AppError } from '../utils/AppError'
import {
  extractAudioForStt,
  extractAudioSlice,
  probeDuration,
  probeHasAudio,
} from './ffmpeg'
import { extractJsonObject, geminiGenerateWithMedia, isBusyGeminiError } from './gemini'
import { writeSrtFile, type CaptionCue } from './timed-edit'

export type { CaptionCue }

export interface CaptionTranscript {
  transcript: string
  cues: CaptionCue[]
}

const MAX_INLINE_BYTES = 18 * 1024 * 1024

const TRANSCRIBE_PROMPT = `Transcribe all spoken words in this audio.

Return JSON with this exact shape:
{
  "transcript": "full transcript as one string",
  "cues": [
    { "start": 0.0, "end": 2.1, "text": "short caption" }
  ]
}

Rules:
- start and end are seconds from the beginning of the audio
- each cue should be 3 to 8 words, readable as a burned-in social caption
- skip silence, music, and non-speech sounds
- if there is no speech, return {"transcript":"","cues":[]}
- do not add commentary or markdown`

function normalizeCues(raw: unknown, durationSeconds: number): CaptionCue[] {
  if (!Array.isArray(raw)) return []
  const cap = Math.max(0.4, durationSeconds || 0)

  return raw
    .map((item) => {
      if (!item || typeof item !== 'object') return null
      const row = item as { start?: unknown; end?: unknown; text?: unknown }
      const text = String(row.text ?? '').replace(/\s+/g, ' ').trim()
      const start = Number(row.start)
      const end = Number(row.end)
      if (!text || !Number.isFinite(start) || !Number.isFinite(end)) return null
      const safeStart = Math.max(0, Math.min(start, cap))
      const safeEnd = Math.max(safeStart + 0.2, Math.min(end, cap || end))
      return { start: Number(safeStart.toFixed(2)), end: Number(safeEnd.toFixed(2)), text }
    })
    .filter((cue): cue is CaptionCue => Boolean(cue))
    .sort((a, b) => a.start - b.start)
}

function geminiErrorMessage(error: unknown): string {
  if (error instanceof Error && error.name === 'AbortError') {
    return 'Caption transcription timed out. Try a shorter clip.'
  }

  const raw = error instanceof Error ? error.message : String(error)
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: string } }
    if (parsed.error?.message) {
      if (/high demand|unavailable|try again later|overloaded/i.test(parsed.error.message)) {
        return 'Gemini is busy right now. Wait a few seconds and click Generate from video again.'
      }
      if (/no longer available|deprecated/i.test(parsed.error.message)) {
        return 'This Gemini model is retired. Restart the backend and generate captions again.'
      }
      return parsed.error.message
    }
  } catch {
    // not JSON
  }

  if (/high demand|unavailable|try again later|overloaded/i.test(raw)) {
    return 'Gemini is busy right now. Wait a few seconds and click Generate from video again.'
  }

  if (raw.length > 240) return 'Gemini could not transcribe this clip.'
  return raw || 'Caption transcription failed.'
}

function unlinkQuiet(filePath?: string) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    // temp cleanup is best-effort
  }
}

const GEMINI_CHUNK_SECONDS = 5 * 60

async function transcribeAudioBuffer(
  bytes: Buffer,
  mimeType: string,
  durationSeconds: number,
): Promise<CaptionTranscript> {
  let text = ''
  try {
    text = await geminiGenerateWithMedia(
      TRANSCRIBE_PROMPT,
      { mimeType, base64: bytes.toString('base64') },
      { json: true },
    )
  } catch (error) {
    if (isBusyGeminiError(error)) throw error
    text = await geminiGenerateWithMedia(TRANSCRIBE_PROMPT, {
      mimeType,
      base64: bytes.toString('base64'),
    })
  }

  const parsed = extractJsonObject<{
    transcript?: unknown
    cues?: unknown
  }>(text)

  const transcript = String(parsed.transcript ?? '')
    .replace(/\s+/g, ' ')
    .trim()
  let cues = normalizeCues(parsed.cues, durationSeconds)

  if (transcript && !cues.length) {
    cues = [
      {
        start: 0,
        end: Number(Math.max(0.4, durationSeconds || 0.4).toFixed(2)),
        text: transcript.slice(0, 90),
      },
    ]
  }

  return { transcript, cues }
}

export async function transcribeVideoCaptions(
  inputPath: string,
): Promise<CaptionTranscript> {
  if (!env.GEMINI_API_KEY) {
    throw new AppError(
      'Gemini is not configured. Set GEMINI_API_KEY to generate captions from video audio.',
      HTTP_STATUS.BAD_REQUEST,
    )
  }

  const hasAudio = await probeHasAudio(inputPath)
  if (!hasAudio) {
    throw new AppError(
      'This video has no audio track to caption.',
      HTTP_STATUS.BAD_REQUEST,
    )
  }

  const durationSeconds = await probeDuration(inputPath)
  const tmpBase = path.join(os.tmpdir(), `clipai-caption-${Date.now()}`)
  const chunkPaths: string[] = []
  let audioPath = ''

  try {
    const extracted = await extractAudioForStt(inputPath, tmpBase)
    audioPath = extracted.path
    const needsChunks =
      durationSeconds > GEMINI_CHUNK_SECONDS + 20 ||
      fs.statSync(audioPath).size > MAX_INLINE_BYTES

    if (!needsChunks) {
      const bytes = fs.readFileSync(audioPath)
      if (bytes.byteLength > MAX_INLINE_BYTES) {
        throw new AppError(
          'Extracted audio is too large to transcribe. Try a shorter clip.',
          HTTP_STATUS.BAD_REQUEST,
        )
      }
      return transcribeAudioBuffer(bytes, extracted.mimeType, durationSeconds)
    }

    const transcriptParts: string[] = []
    const cues: CaptionCue[] = []

    for (let start = 0; start < durationSeconds; start += GEMINI_CHUNK_SECONDS) {
      const chunkDur = Math.min(GEMINI_CHUNK_SECONDS, durationSeconds - start)
      const chunkPath = `${tmpBase}-chunk-${start}.mp3`
      chunkPaths.push(chunkPath)
      await extractAudioSlice(audioPath, chunkPath, start, chunkDur)
      const part = await transcribeAudioBuffer(
        fs.readFileSync(chunkPath),
        'audio/mpeg',
        chunkDur,
      )
      if (part.transcript.trim()) transcriptParts.push(part.transcript.trim())
      for (const cue of part.cues) {
        cues.push({
          ...cue,
          start: Number((cue.start + start).toFixed(2)),
          end: Number((cue.end + start).toFixed(2)),
        })
      }
    }

    return {
      transcript: transcriptParts.join(' '),
      cues: normalizeCues(cues, durationSeconds),
    }
  } catch (error) {
    if (error instanceof AppError) throw error
    throw new AppError(geminiErrorMessage(error), HTTP_STATUS.BAD_GATEWAY)
  } finally {
    unlinkQuiet(audioPath)
    unlinkQuiet(`${tmpBase}.mp3`)
    unlinkQuiet(`${tmpBase}.m4a`)
    for (const chunkPath of chunkPaths) unlinkQuiet(chunkPath)
  }
}

/** Build an SRT for the finished cut. Prefers an existing file, else Gemini. */
export async function prepareExportCaptionsSrt(input: {
  enabled: boolean
  videoPath: string
  srtPath: string
  existingPath?: string
}): Promise<string | undefined> {
  if (!input.enabled) return undefined
  if (input.existingPath && fs.existsSync(input.existingPath)) {
    return input.existingPath
  }

  try {
    const result = await transcribeVideoCaptions(input.videoPath)
    if (!result.cues.length) return undefined
    writeSrtFile(result.cues, input.srtPath)
    return input.srtPath
  } catch {
    return undefined
  }
}
