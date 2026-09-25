import fs from 'fs'
import path from 'path'
import { env } from '../config'
import type { ProjectOptionsDto } from '../modules/project/project.types'
import {
  detectSilenceRanges,
  detectTalkingHeadPauses,
  extractAudioForStt,
  extractAudioSlice,
  probeDisplaySize,
  probeDuration,
  probeHasAudio,
  renderJumpCutVideo,
  silenceToKeepCuts,
  type ClipMotion,
  type SilenceSensitivity,
} from './ffmpeg'
import {
  extraZoomByCutFromTimeline,
  perCutMotionsFromTimeline,
} from './timeline-fx'
import {
  assFontSizeFromUi,
  assignSegmentSpeeds,
  compactWordTimings,
  cutsFromPhrases,
  mergeSpokenPhrases,
  remapCuesToOutput,
  remapWordsToOutput,
  mergeCutsSharingWords,
  mergeIncompleteThoughtCuts,
  snapCutsToCompleteWords,
  splitCutsBySilence,
  splitLongCaptionCues,
  totalOutputDuration,
  wordsToCaptionCues,
  wordsToSentenceCues,
  writeAssFile,
  type CaptionCue,
  type SpeedCut,
} from './timed-edit'
import { burnTimedCaptions } from './export-polish.service'
import { GROQ_CHUNK_SECONDS, transcribeSourceAudio } from './groq-transcribe'
import {
  detectSpeechActivity,
  isFillerWord,
  tightenWordsToSpeech,
  trimNonSpeechFromCuts,
} from './speech-activity'

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
  /** Final frame size after landscape talking-head is kept 16:9. */
  aspectRatio: '9:16' | '1:1' | '16:9'
}

function gapThreshold(level: SilenceSensitivity) {
  switch (level) {
    case 'light':
      return 0.42
    case 'aggressive':
      return 0.22
    default:
      return 0.28
  }
}

function pauseMin(level: SilenceSensitivity) {
  switch (level) {
    case 'light':
      return 1.05
    case 'aggressive':
      return 0.7
    default:
      return 0.85
  }
}

/** Landscape talking-head stays 16:9 so the speaker is not chopped into 9:16. */
export function talkingHeadOutputAspect(
  requested: '9:16' | '1:1' | '16:9' | undefined,
  portrait: boolean,
): '9:16' | '1:1' | '16:9' {
  if (!portrait && requested === '9:16') return '16:9'
  if (requested) return requested
  return portrait ? '9:16' : '16:9'
}

function wordCoverage(
  cuts: Array<{ start: number; end: number }>,
  words: Array<{ word: string; start: number; end: number }>,
) {
  if (!words.length) return 0
  return words.filter((word) =>
    cuts.some((cut) => word.end > cut.start && word.start < cut.end),
  ).length
}

/** Build keep-cuts from word timestamps (true talking-head jump cuts). */
export function cutsFromWords(
  words: Array<{ word: string; start: number; end: number }>,
  durationSeconds: number,
  level: SilenceSensitivity,
): Array<{ start: number; end: number }> {
  if (!words.length) return []
  const compact = compactWordTimings(words)
  const minGap = gapThreshold(level)
  const silenceRanges: Array<{ start: number; end: number }> = []

  if (compact[0].start > 0.2) {
    silenceRanges.push({ start: 0, end: compact[0].start })
  }
  for (let i = 1; i < compact.length; i++) {
    const gap = compact[i].start - compact[i - 1].end
    if (gap >= minGap) {
      silenceRanges.push({ start: compact[i - 1].end, end: compact[i].start })
    }
  }
  const last = compact[compact.length - 1]
  if (durationSeconds - last.end > 0.2) {
    silenceRanges.push({ start: last.end, end: durationSeconds })
  }

  return snapCutsToCompleteWords(
    silenceToKeepCuts(silenceRanges, durationSeconds, 0.16),
    compact,
    durationSeconds,
  )
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
  timelineJson?: unknown
  aspectRatio?: '9:16' | '1:1' | '16:9'
  onProgress?: (percent: number, note?: string) => void
}): Promise<TalkingHeadResult> {
  const notes: string[] = ['Talking-head: remove pauses / dead air between speech']
  const report = (percent: number, note?: string) => input.onProgress?.(percent, note)
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
      report(64, 'Transcribing speech')
      const stt = await transcribeSourceAudio(input.inputPath, duration, tempDir)
      transcript = stt.transcript
      words = stt.words
      const compactWords = compactWordTimings(words)
      phrases = compactWords.length
        ? mergeSpokenPhrases(wordsToSentenceCues(compactWords))
        : mergeSpokenPhrases(stt.phrases)
      provider = 'ffmpeg+groq'
      notes.push(
        duration > GROQ_CHUNK_SECONDS + 30
          ? 'Transcript + phrase timings from Groq Whisper (chunked)'
          : 'Transcript + phrase timings from Groq Whisper',
      )
      report(74, 'Building keep-segments')

      baseCuts = cutsFromPhrases(phrases, duration)
      if (baseCuts.length) {
        notes.push(
          `Jump cuts on spoken thoughts: ${baseCuts.length} keep-segments`,
        )
      }

      if (compactWords.length) {
        baseCuts = mergeIncompleteThoughtCuts(
          snapCutsToCompleteWords(baseCuts, compactWords, duration),
          compactWords,
        )

        try {
          silenceRanges = await detectTalkingHeadPauses(input.inputPath)
          const minSilence = pauseMin(input.silenceSensitivity)
          let splitCount = 0

          // Evaluate each phrase's internal-pause split on its own merits
          // instead of one video-wide accept/reject gate. A single sentence
          // needing several splits used to veto pause-trimming for every
          // other phrase in the video, leaving real dead air baked into cuts
          // that had nothing wrong with them.
          const refinedCuts = baseCuts.flatMap((cut) => {
            const wordsInCut = compactWords.filter(
              (w) => w.end > cut.start && w.start < cut.end,
            )
            const split = splitCutsBySilence([cut], silenceRanges, minSilence)
            if (split.length < 2) return [cut]

            const snapped = mergeIncompleteThoughtCuts(
              snapCutsToCompleteWords(split, wordsInCut, duration),
              wordsInCut,
            )
            const coverageOk =
              wordCoverage(snapped, wordsInCut) >= wordsInCut.length * 0.98
            const savedEnough =
              totalKeepSeconds([cut]) - totalKeepSeconds(snapped) > 0.15

            if (snapped.length > 1 && coverageOk && savedEnough) {
              splitCount += snapped.length - 1
              return snapped
            }
            return [cut]
          })

          if (splitCount > 0) {
            baseCuts = mergeCutsSharingWords(refinedCuts, compactWords)
            notes.push(
              `Dropped ${splitCount} internal pause${splitCount === 1 ? '' : 's'} inside spoken thoughts (${baseCuts.length} keep-segments)`,
            )
          } else {
            baseCuts = mergeCutsSharingWords(baseCuts, compactWords)
          }
        } catch (error) {
          notes.push(
            `Pause refine skipped: ${
              error instanceof Error ? error.message.slice(0, 120) : 'ffmpeg error'
            }`,
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
    const compactRetry = compactWordTimings(words)
    const tighterCuts = mergeIncompleteThoughtCuts(
      snapCutsToCompleteWords(
        cutsFromPhrases(
          mergeSpokenPhrases(
            wordsToSentenceCues(compactRetry, { minPause: 0.45 }),
          ),
          duration,
        ),
        compactRetry,
        duration,
      ),
      compactRetry,
    )
    if (tighterCuts.length && totalKeepSeconds(tighterCuts) < keepSeconds) {
      baseCuts = tighterCuts
      keepSeconds = totalKeepSeconds(baseCuts)
      removedSeconds = Math.max(0, duration - keepSeconds)
      notes.push('Applied tighter thought-pause pass for a clearer edit')
    }
  }

  // Strip non-speech sounds (breaths, lip smacks, umms, coughs, room noise).
  // silencedetect never removes these because they are not quiet.
  let speechWords = words
  if (words.length && baseCuts.length) {
    try {
      report(75, 'Removing non-speech sounds')
      const map = await detectSpeechActivity(input.inputPath)
      const tight = map
        ? tightenWordsToSpeech(words, map)
        : null
      if (map && tight?.reliable) {
        const spoken = tight.words.filter((word) => !isFillerWord(word.word))
        const spokenInCuts = wordCoverage(baseCuts, spoken)
        const trimmed = trimNonSpeechFromCuts(baseCuts, spoken, map, duration, {
          pauseSeconds: pauseMin(input.silenceSensitivity),
        })
        if (
          trimmed.length &&
          wordCoverage(trimmed, spoken) >= spokenInCuts * 0.98
        ) {
          const before = totalKeepSeconds(baseCuts)
          baseCuts = trimmed
          speechWords = spoken
          keepSeconds = totalKeepSeconds(baseCuts)
          removedSeconds = Math.max(0, duration - keepSeconds)
          notes.push(
            `Removed ~${Math.max(0, before - keepSeconds).toFixed(1)}s of non-speech sound (breaths, fillers, noise) via ${map.engine} — ${baseCuts.length} keep-segments`,
          )
        }
      } else {
        notes.push('Non-speech pass skipped: voice not separable from background')
      }
    } catch (error) {
      notes.push(
        `Non-speech pass skipped: ${
          error instanceof Error ? error.message.slice(0, 120) : 'ffmpeg error'
        }`,
      )
    }
  }

  const speedLevel = input.speedRamp ?? 'off'
  const cuts = speechWords.length
    ? assignSegmentSpeeds(baseCuts, speedLevel, { words: speechWords })
    : baseCuts.map((cut) => ({ ...cut, speed: 1 }))
  const sped = cuts.some((c) => c.speed !== 1)
  if (sped) {
    notes.push(`Segment speed ramp: ${speedLevel} (important speech @1×)`)
  }

  const display = await probeDisplaySize(input.inputPath)
  const aspectRatio = talkingHeadOutputAspect(input.aspectRatio, display.portrait)
  if (aspectRatio !== (input.aspectRatio ?? '9:16')) {
    notes.push(
      `Kept ${aspectRatio} so the speaker stays fully in frame (source is landscape)`,
    )
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
    aspectRatio,
    onProgress: (ratio) => report(76 + ratio * 18, 'Cutting and exporting'),
  })
  report(94, 'Finishing export')
  if (perCutMotions?.length) {
    notes.push(`Applied ${perCutMotions[0]} to every keep-segment`)
  } else if ((input.motion ?? 'punch') !== 'none') {
    notes.push(
      `Jump-cut motion: ${input.motion ?? 'punch'} (full-body overall, light punch-in)`,
    )
  }
  if (extraZoomByCut?.length) {
    notes.push('Manual zoom keyframes baked into keep-segments')
  }

  const outputDurationSeconds = totalOutputDuration(cuts)
  notes.push(
    `Output ~${outputDurationSeconds.toFixed(1)}s (removed ~${Math.max(0, duration - keepSeconds).toFixed(1)}s of pauses)`,
  )

  let captionsPath: string | undefined
  let captionsBurned = false
  const wantCaptions = Boolean(input.captions)
  if (wantCaptions) {
    const cues = speechWords.length
      ? wordsToCaptionCues(remapWordsToOutput(speechWords, cuts))
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
      const burnOptions = {
        ...(input.captionOptions ?? {
          captions: true,
          captionPosition: 'bottom' as const,
          captionFontFamily: 'arial' as const,
          captionFontSize: 22 as const,
          captionColor: 'white' as const,
          silenceSensitivity: input.silenceSensitivity,
          pacing: 'fast' as const,
          speedRamp: 'off' as const,
          keepAudio: true,
          audioNormalize: false,
          cropPreset: 'none' as const,
          colorGrade: 'none' as const,
          fadeInOut: false,
          mirrorHorizontal: false,
          introTitleCard: false,
        }),
        aspectRatio,
        cropPreset: 'none' as const,
        keyframing: false,
        keyframePreset: 'speaker-punch-in' as const,
      }
      report(95, 'Adding captions')
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
    aspectRatio,
  }
}
