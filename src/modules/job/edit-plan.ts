import type { SpeechResult } from '../../integrations/speech.service'
import type { UnderstandingResult } from '../../integrations/understanding.service'
import type { EditPlan } from '../../integrations/render.service'
import type { EditingModeId } from '../../constants/projects'
import type { ProjectOptionsDto } from '../project/project.types'

export function buildEditPlan(input: {
  mode: EditingModeId
  options: ProjectOptionsDto
  durationSeconds: number
  speech?: SpeechResult | null
  understanding?: UnderstandingResult | null
}): EditPlan {
  const notes: string[] = [`Mode: ${input.mode}`]
  let cuts: Array<{ start: number; end: number }> = []

  if (input.mode === 'talking-head' && input.speech) {
    notes.push(`Speech provider: ${input.speech.provider}`)
    const silences = input.speech.silenceRanges
    if (!silences.length) {
      cuts = [{ start: 0, end: input.durationSeconds }]
    } else {
      let cursor = 0
      for (const silence of silences) {
        if (silence.start > cursor + 0.2) {
          cuts.push({ start: cursor, end: silence.start })
        }
        cursor = silence.end
      }
      if (cursor < input.durationSeconds - 0.2) {
        cuts.push({ start: cursor, end: input.durationSeconds })
      }
    }
  } else if (input.understanding?.moments?.length) {
    notes.push(`Understanding provider: ${input.understanding.provider}`)
    cuts = input.understanding.moments.map((m) => ({
      start: m.start,
      end: m.end,
    }))
  } else {
    cuts = [{ start: 0, end: Math.max(1, input.durationSeconds * 0.8) }]
  }

  if (input.options.pacing === 'very-fast' && cuts.length > 2) {
    cuts = cuts.slice(0, Math.ceil(cuts.length * 0.7))
    notes.push('Applied very-fast pacing trim')
  }

  return {
    cuts,
    captions: input.options.captions && input.mode === 'talking-head',
    aspectRatio: input.options.aspectRatio,
    keepAudio: input.options.keepAudio,
    notes,
  }
}
