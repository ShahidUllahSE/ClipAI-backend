import fs from 'fs'
import path from 'path'
import { env } from '../config'
import type { SilenceSensitivity } from './ffmpeg'
import {
  detectSilenceRanges,
  extractAudioWav,
  probeDuration,
  probeFrameRate,
  probeHasAudio,
  renderJumpCutVideo,
  silenceToKeepCuts,
} from './ffmpeg'
import {
  assignSegmentSpeeds,
  remapWordsToOutput,
  snapCutsToFrames,
  totalOutputDuration,
  wordsToCaptionCues,
  writeSrtFile,
  type SpeedCut,
} from './timed-edit'

export interface TalkingHeadResult {
  provider: 'ffmpeg' | 'ffmpeg+groq'
  durationSeconds: number
  outputDurationSeconds: number
  transcript: string
  words: Array<{ word: string; start: number; end: number }>
  silenceRanges: Array<{ start: number; end: number }>
  cuts: SpeedCut[]
  captionsPath?: string
  segmentSpeedApplied: boolean
  outputPath: string
  outputUrl: string
  notes: string[]
  removedSeconds: number
}

function gapThreshold(level: SilenceSensitivity) {
  switch (level) {
    case 'light':
      return 0.9
    case 'aggressive':
      return 0.35
    default:
      return 0.55
  }
}

// Groq/Whisper word timestamps are more often early-ending than
// late-starting (trailing sounds — S, vowels, soft consonants — fade out
// past where the model marks the word "done"). Padding the tail more than
// the head reduces the chance of a cut landing inside real speech.
const WORD_PADDING_LEAD_SECONDS = 0.12
const WORD_PADDING_TRAIL_SECONDS = 0.22

export function silenceRangesFromWords(
  words: Array<{ word: string; start: number; end: number }>,
  durationSeconds: number,
  level: SilenceSensitivity,
): Array<{ start: number; end: number }> {
  if (!words.length) return []

  const minGap = gapThreshold(level)
  const silenceRanges: Array<{ start: number; end: number }> = []
  const firstStart = Math.max(0, words[0].start - WORD_PADDING_LEAD_SECONDS)

  if (firstStart > 0.25) {
    silenceRanges.push({ start: 0, end: firstStart })
  }

  for (let i = 1; i < words.length; i += 1) {
    const previousEnd = Math.min(
      durationSeconds,
      words[i - 1].end + WORD_PADDING_TRAIL_SECONDS,
    )
    const nextStart = Math.max(0, words[i].start - WORD_PADDING_LEAD_SECONDS)
    if (nextStart - previousEnd >= minGap) {
      silenceRanges.push({ start: previousEnd, end: nextStart })
    }
  }

  const lastEnd = Math.min(
    durationSeconds,
    words[words.length - 1].end + WORD_PADDING_TRAIL_SECONDS,
  )
  if (durationSeconds - lastEnd > 0.25) {
    silenceRanges.push({ start: lastEnd, end: durationSeconds })
  }

  return silenceRanges
}

/** Build keep-cuts from word timestamps (true talking-head jump cuts). */
export function cutsFromWords(
  words: Array<{ word: string; start: number; end: number }>,
  durationSeconds: number,
  level: SilenceSensitivity,
): Array<{ start: number; end: number }> {
  if (!words.length) return []
  const silenceRanges = silenceRangesFromWords(words, durationSeconds, level)
  return silenceToKeepCuts(silenceRanges, durationSeconds, 0.15)
}

function totalKeepSeconds(cuts: Array<{ start: number; end: number }>) {
  return cuts.reduce((sum, c) => sum + Math.max(0, c.end - c.start), 0)
}

async function transcribeWithGroq(wavPath: string): Promise<{
  transcript: string
  words: Array<{ word: string; start: number; end: number }>
}> {
  if (!env.GROQ_API_KEY) {
    return { transcript: '', words: [] }
  }

  const bytes = fs.readFileSync(wavPath)
  const form = new FormData()
  form.append(
    'file',
    new Blob([new Uint8Array(bytes)], { type: 'audio/wav' }),
    path.basename(wavPath),
  )
  form.append('model', 'whisper-large-v3')
  form.append('response_format', 'verbose_json')
  form.append('timestamp_granularities[]', 'word')

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

  const data = (await response.json()) as {
    text?: string
    words?: Array<{ word?: string; start?: number; end?: number }>
  }

  const words = (data.words ?? [])
    .filter(
      (w) =>
        typeof w.word === 'string' &&
        typeof w.start === 'number' &&
        typeof w.end === 'number',
    )
    .map((w) => ({
      word: String(w.word),
      start: Number(w.start),
      end: Number(w.end),
    }))

  return {
    transcript: data.text ?? '',
    words,
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
  durationSeconds?: number
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
  const fps = await probeFrameRate(input.inputPath).catch(() => 30)

  let transcript = ''
  let words: TalkingHeadResult['words'] = []
  let provider: TalkingHeadResult['provider'] = 'ffmpeg'
  let silenceRanges: Array<{ start: number; end: number }> = []
  let baseCuts: Array<{ start: number; end: number }> = []
  let transcriptAttempted = false

  const tempDir = path.join(path.dirname(input.outputPath), '.tmp')
  fs.mkdirSync(tempDir, { recursive: true })
  const wavPath = path.join(tempDir, `audio-${Date.now()}.wav`)

  try {
    if (env.GROQ_API_KEY) {
      transcriptAttempted = true
      await extractAudioWav(input.inputPath, wavPath)
      const stt = await transcribeWithGroq(wavPath)
      transcript = stt.transcript
      words = stt.words
      provider = 'ffmpeg+groq'
      notes.push('Transcript + word timings from Groq Whisper')

      if (words.length > 0) {
        silenceRanges = silenceRangesFromWords(
          words,
          duration,
          input.silenceSensitivity,
        )
        baseCuts = cutsFromWords(words, duration, input.silenceSensitivity)
        notes.push(
          `Jump cuts from speech gaps (${input.silenceSensitivity}): ${baseCuts.length} keep-segments`,
        )
      } else {
        notes.push('Groq returned no word timestamps — keeping the full video')
        baseCuts = [{ start: 0, end: duration }]
      }
    } else {
      notes.push('No GROQ_API_KEY — using FFmpeg silence detection only')
    }
  } catch (error) {
    notes.push(
      `STT skipped: ${error instanceof Error ? error.message : 'unknown error'}`,
    )
  } finally {
    if (fs.existsSync(wavPath)) fs.unlinkSync(wavPath)
  }

  if (!baseCuts.length && !transcriptAttempted) {
    const level =
      input.silenceSensitivity === 'light' ? 'medium' : input.silenceSensitivity
    silenceRanges = await detectSilenceRanges(input.inputPath, level)
    notes.push(`FFmpeg silence ranges: ${silenceRanges.length}`)
    baseCuts = silenceToKeepCuts(silenceRanges, duration, 0.15)
    notes.push(`Keep-segments from silence: ${baseCuts.length}`)
  } else if (!baseCuts.length && transcriptAttempted) {
    notes.push('Transcript unavailable — keeping the full video instead of guessing cuts')
    baseCuts = [{ start: 0, end: duration }]
  }

  const keepSeconds = totalKeepSeconds(baseCuts)
  const removedSeconds = Math.max(0, duration - keepSeconds)

  baseCuts = snapCutsToFrames(baseCuts, fps)

  const speedLevel = input.speedRamp ?? 'off'
  const cuts = assignSegmentSpeeds(baseCuts, speedLevel, { words })
  const sped = cuts.some((c) => c.speed !== 1)
  if (sped) {
    notes.push(`Segment speed ramp: ${speedLevel} (important speech @1×)`)
  }

  await renderJumpCutVideo({
    inputPath: input.inputPath,
    outputPath: input.outputPath,
    cuts,
    keepAudio: input.keepAudio,
  })

  const outputDurationSeconds = totalOutputDuration(cuts)
  notes.push(
    `Output ~${outputDurationSeconds.toFixed(1)}s (removed ~${removedSeconds.toFixed(1)}s of pauses)`,
  )

  let captionsPath: string | undefined
  if (input.captions && words.length) {
    const remapped = remapWordsToOutput(words, cuts)
    const cues = wordsToCaptionCues(remapped)
    if (cues.length) {
      captionsPath = path.join(
        path.dirname(input.outputPath),
        `${path.basename(input.outputPath, '.mp4')}.captions.srt`,
      )
      writeSrtFile(cues, captionsPath)
      notes.push(`Timed captions: ${cues.length} cues from speech`)
    }
  } else if (input.captions && !words.length) {
    notes.push('Captions requested but no word timings — polish may use title text')
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
    segmentSpeedApplied: sped,
    outputPath: input.outputPath,
    outputUrl: input.outputUrl,
    notes,
    removedSeconds,
  }
}
