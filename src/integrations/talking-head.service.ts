import fs from 'fs'
import path from 'path'
import { env } from '../config'
import type { ProjectOptionsDto } from '../modules/project/project.types'
import {
  detectSilenceRanges,
  extractAudioForStt,
  extractAudioSlice,
  probeDuration,
  probeHasAudio,
  renderJumpCutVideo,
  silenceToKeepCuts,
  type ClipMotion,
  type SilenceSensitivity,
} from './ffmpeg'
import {
  assFontSizeFromUi,
  assignSegmentSpeeds,
  cutsFromPhrases,
  mergeSpokenPhrases,
  remapCuesToOutput,
  remapWordsToOutput,
  splitLongCaptionCues,
  totalOutputDuration,
  wordsToCaptionCues,
  wordsToSentenceCues,
  writeAssFile,
  type CaptionCue,
  type SpeedCut,
} from './timed-edit'
import { burnTimedCaptions } from './export-polish.service'

export interface TalkingHeadResult {
  provider: 'ffmpeg' | 'ffmpeg+groq'
  durationSeconds: number
  outputDurationSeconds: number
  transcript: string
  words: Array<{ word: string; start: number; end: number }>
  silenceRanges: Array<{ start: number; end: number }>
  cuts: SpeedCut[]
  captionsPath?: string
  captionsBurned: boolean
  segmentSpeedApplied: boolean
  outputPath: string
  outputUrl: string
  notes: string[]
  removedSeconds: number
}

function gapThreshold(level: SilenceSensitivity) {
  switch (level) {
    case 'light':
      return 0.72
    case 'aggressive':
      return 0.28
    default:
      return 0.38
  }
}

/** Build keep-cuts from word timestamps (true talking-head jump cuts). */
export function cutsFromWords(
  words: Array<{ word: string; start: number; end: number }>,
  durationSeconds: number,
  level: SilenceSensitivity,
): Array<{ start: number; end: number }> {
  if (!words.length) return []
  const minGap = gapThreshold(level)
  const silenceRanges: Array<{ start: number; end: number }> = []

  if (words[0].start > 0.25) {
    silenceRanges.push({ start: 0, end: words[0].start })
  }
  for (let i = 1; i < words.length; i++) {
    const gap = words[i].start - words[i - 1].end
    if (gap >= minGap) {
      silenceRanges.push({ start: words[i - 1].end, end: words[i].start })
    }
  }
  const last = words[words.length - 1]
  if (durationSeconds - last.end > 0.25) {
    silenceRanges.push({ start: last.end, end: durationSeconds })
  }

  return silenceToKeepCuts(silenceRanges, durationSeconds, 0.12).map((cut) => ({
    start: cut.start,
    end: Math.max(cut.start + 0.16, cut.end - 0.04),
  }))
}

function totalKeepSeconds(cuts: Array<{ start: number; end: number }>) {
  return cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
}

/**
 * Without speech timestamps, preserve spoken-thought pacing by removing only
 * clearly long pauses. Short quiet gaps often occur inside a sentence and
 * produced the overly aggressive fallback edit.
 */
export function fallbackCutsFromSilence(
  silenceRanges: Array<{ start: number; end: number }>,
  durationSeconds: number,
) {
  const merged: Array<{ start: number; end: number }> = []
  for (const range of [...silenceRanges].sort((a, b) => a.start - b.start)) {
    const previous = merged[merged.length - 1]
    if (previous && range.start - previous.end <= 0.2) {
      previous.end = Math.max(previous.end, range.end)
    } else {
      merged.push({ ...range })
    }
  }

  const longPauses = merged.filter((range) => range.end - range.start >= 3)
  return silenceToKeepCuts(longPauses, durationSeconds, 0.3).map((cut) => ({
    start: Math.max(0, cut.start - 0.12),
    end: Math.min(durationSeconds, cut.end + 0.24),
  }))
}

const GROQ_CHUNK_SECONDS = 8 * 60

async function transcribeWithGroq(
  audioPath: string,
  mimeType: string,
  offsetSeconds = 0,
): Promise<{
  transcript: string
  words: Array<{ word: string; start: number; end: number }>
  phrases: CaptionCue[]
}> {
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

type GroqWord = { word?: string; start?: number; end?: number }
type GroqSegment = {
  text?: string
  start?: number
  end?: number
  words?: GroqWord[]
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
) {
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

async function transcribeSourceAudio(
  inputPath: string,
  durationSeconds: number,
  tempDir: string,
): Promise<{
  transcript: string
  words: Array<{ word: string; start: number; end: number }>
  phrases: CaptionCue[]
}> {
  const extracted = await extractAudioForStt(
    inputPath,
    path.join(tempDir, `audio-${Date.now()}`),
  )

  try {
    if (durationSeconds <= GROQ_CHUNK_SECONDS + 30) {
      return transcribeWithGroq(extracted.path, extracted.mimeType)
    }

    const transcriptParts: string[] = []
    const words: Array<{ word: string; start: number; end: number }> = []
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

/**
 * Talking-head edit:
 * silence/speech jump cuts + optional segment speed ramp + timed captions SRT
 */
export async function processTalkingHead(input: {
  inputPath: string
  outputPath: string
  outputUrl: string
  silenceSensitivity: SilenceSensitivity
  keepAudio: boolean
  speedRamp?: 'off' | 'light' | 'medium' | 'aggressive'
  captions?: boolean
  captionOptions?: ProjectOptionsDto
  durationSeconds?: number
  motion?: ClipMotion
  aspectRatio?: '9:16' | '1:1' | '16:9'
}): Promise<TalkingHeadResult> {
  const notes: string[] = ['Talking-head: remove pauses / dead air between speech']
  const hasAudio = await probeHasAudio(input.inputPath)
  if (!hasAudio) {
    throw new Error(
      'This video has no audio track. Talking-head needs speech/sound — upload a clip with audio.',
    )
  }

  const duration =
    input.durationSeconds && input.durationSeconds > 0
      ? input.durationSeconds
      : await probeDuration(input.inputPath)

  let transcript = ''
  let words: TalkingHeadResult['words'] = []
  let phrases: CaptionCue[] = []
  let provider: TalkingHeadResult['provider'] = 'ffmpeg'
  let silenceRanges: Array<{ start: number; end: number }> = []
  let baseCuts: Array<{ start: number; end: number }> = []

  const tempDir = path.join(path.dirname(input.outputPath), '.tmp')
  fs.mkdirSync(tempDir, { recursive: true })

  try {
    if (env.GROQ_API_KEY) {
      const stt = await transcribeSourceAudio(input.inputPath, duration, tempDir)
      transcript = stt.transcript
      words = stt.words
      phrases = words.length
        ? mergeSpokenPhrases(wordsToSentenceCues(words))
        : mergeSpokenPhrases(stt.phrases)
      provider = 'ffmpeg+groq'
      notes.push(
        duration > GROQ_CHUNK_SECONDS + 30
          ? 'Transcript + phrase timings from Groq Whisper (chunked)'
          : 'Transcript + phrase timings from Groq Whisper',
      )

      baseCuts = cutsFromPhrases(phrases, duration)
      if (baseCuts.length) {
        notes.push(
          `Jump cuts on spoken thoughts: ${baseCuts.length} keep-segments`,
        )
      }
      if (
        !baseCuts.length ||
        totalKeepSeconds(baseCuts) > duration * 0.92
      ) {
        const gapCuts = cutsFromWords(words, duration, input.silenceSensitivity)
        if (
          gapCuts.length &&
          (!baseCuts.length || totalKeepSeconds(gapCuts) < totalKeepSeconds(baseCuts))
        ) {
          baseCuts = gapCuts
          notes.push(
            `Speech-gap fallback (${input.silenceSensitivity}): ${baseCuts.length} keep-segments`,
          )
        }
      }
    } else {
      notes.push('No GROQ_API_KEY — using FFmpeg silence detection only')
    }
  } catch (error) {
    notes.push(
      `STT skipped: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  }

  if (!baseCuts.length) {
    const level =
      input.silenceSensitivity === 'light' ? 'medium' : input.silenceSensitivity
    silenceRanges = await detectSilenceRanges(input.inputPath, level)
    notes.push(`FFmpeg silence ranges: ${silenceRanges.length}`)
    baseCuts = fallbackCutsFromSilence(silenceRanges, duration)
    notes.push(
      `Fallback spoken-thought cuts (pauses ≥3s): ${baseCuts.length} keep-segments`,
    )
  }

  let keepSeconds = totalKeepSeconds(baseCuts)
  let removedSeconds = Math.max(0, duration - keepSeconds)

  if (removedSeconds < Math.min(1, duration * 0.05) && words.length > 2) {
    const aggressiveCuts = cutsFromWords(words, duration, 'aggressive')
    if (totalKeepSeconds(aggressiveCuts) < keepSeconds) {
      baseCuts = aggressiveCuts
      keepSeconds = totalKeepSeconds(baseCuts)
      removedSeconds = Math.max(0, duration - keepSeconds)
      notes.push('Applied aggressive speech-gap pass for a clearer edit')
    }
  }

  const speedLevel = input.speedRamp ?? 'off'
  const cuts = words.length
    ? assignSegmentSpeeds(baseCuts, speedLevel, { words })
    : baseCuts.map((cut) => ({ ...cut, speed: 1 }))
  const sped = cuts.some((c) => c.speed !== 1)
  if (sped) {
    notes.push(`Segment speed ramp: ${speedLevel} (important speech @1×)`)
  }

  await renderJumpCutVideo({
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    cuts,
    keepAudio: input.keepAudio,
    motion: input.motion ?? 'punch',
    aspectRatio: input.aspectRatio ?? '9:16',
  })
  if ((input.motion ?? 'punch') !== 'none') {
    notes.push(
      `Jump-cut motion: ${input.motion ?? 'punch'} (full-body overall, light punch-in)`,
    )
  }

  const outputDurationSeconds = totalOutputDuration(cuts)
  notes.push(
    `Output ~${outputDurationSeconds.toFixed(1)}s (removed ~${Math.max(0, duration - keepSeconds).toFixed(1)}s of pauses)`,
  )

  let captionsPath: string | undefined
  let captionsBurned = false
  const wantCaptions = Boolean(input.captions)
  if (wantCaptions) {
    const cues = words.length
      ? wordsToCaptionCues(remapWordsToOutput(words, cuts))
      : remapCuesToOutput(splitLongCaptionCues(phrases), cuts)
    if (cues.length) {
      captionsPath = path.join(
        path.dirname(input.outputPath),
        `${path.basename(input.outputPath, '.mp4')}.captions.ass`,
      )
      const captionOptions = input.captionOptions
      writeAssFile(cues, captionsPath, {
        fontName:
          captionOptions?.captionFontFamily === 'impact'
            ? 'Impact'
            : captionOptions?.captionFontFamily === 'georgia'
              ? 'Georgia'
              : captionOptions?.captionFontFamily === 'verdana'
                ? 'Verdana'
                : captionOptions?.captionFontFamily === 'comic-sans'
                  ? 'Comic Sans MS'
                  : captionOptions?.captionFontFamily === 'courier'
                    ? 'Courier New'
                    : captionOptions?.captionFontFamily === 'segoe'
                      ? 'Segoe UI'
                      : 'Arial',
        fontSize: assFontSizeFromUi(captionOptions?.captionFontSize ?? 22),
        primaryColour:
          captionOptions?.captionColor === 'yellow'
            ? '&H0000FFFF'
            : captionOptions?.captionColor === 'black'
              ? '&H00000000'
              : captionOptions?.captionColor === 'cyan'
                ? '&H00FFFF00'
                : '&H00FFFFFF',
        alignment: captionOptions?.captionPosition === 'top' ? 8 : 2,
        marginV: captionOptions?.captionPosition === 'top' ? 90 : 80,
      })
      notes.push(`Timed captions: ${cues.length} cues from speech`)

      const burnedPath = path.join(
        path.dirname(input.outputPath),
        `${path.basename(input.outputPath, '.mp4')}.captioned.mp4`,
      )
      const burnOptions = input.captionOptions ?? {
        captions: true,
        captionPosition: 'bottom' as const,
        captionFontFamily: 'arial' as const,
        captionFontSize: 22 as const,
        captionColor: 'white' as const,
        aspectRatio: input.aspectRatio ?? '9:16',
        silenceSensitivity: input.silenceSensitivity,
        pacing: 'fast' as const,
        speedRamp: 'off' as const,
        keyframing: false,
        keyframePreset: 'speaker-punch-in' as const,
        keepAudio: true,
        audioNormalize: false,
        cropPreset: 'none' as const,
        colorGrade: 'none' as const,
        fadeInOut: false,
        mirrorHorizontal: false,
        introTitleCard: false,
      }
      try {
        await burnTimedCaptions({
          inputPath: input.outputPath,
          outputPath: burnedPath,
          captionsPath,
          options: burnOptions,
        })
        fs.copyFileSync(burnedPath, input.outputPath)
        captionsBurned = true
        notes.push('Captions burned into the cut')
      } catch (error) {
        notes.push(
          `Caption burn failed: ${
            error instanceof Error ? error.message.slice(0, 140) : 'ffmpeg error'
          }`,
        )
      } finally {
        try {
          if (fs.existsSync(burnedPath)) fs.unlinkSync(burnedPath)
        } catch {
          /* ignore */
        }
      }
    } else {
      notes.push('Captions requested but no speech phrases were found')
    }
  }

  return {
    provider,
    durationSeconds: duration,
    outputDurationSeconds,
    transcript,
    words,
    silenceRanges,
    cuts,
    captionsPath,
    captionsBurned,
    segmentSpeedApplied: sped,
    outputPath: input.outputPath,
    outputUrl: input.outputUrl,
    notes,
    removedSeconds: Math.max(0, duration - keepSeconds),
  }
}
