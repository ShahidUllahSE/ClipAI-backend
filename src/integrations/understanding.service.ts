import { env } from '../config'
import type { EditingModeId } from '../constants/projects'
import { extractJsonObject, geminiGenerateText } from './gemini'

export interface UnderstandingResult {
  provider: 'gemini' | 'mock'
  summary: string
  moments: Array<{ start: number; end: number; label: string; score: number }>
  category: string
}

function mockUnderstanding(
  mode: EditingModeId,
  durationSeconds: number,
): UnderstandingResult {
  const slice = Math.max(2, durationSeconds / 5)
  const moments = [0, 1, 2, 3]
    .map((i) => {
      const start = Math.min(durationSeconds - 1, i * slice)
      const end = Math.min(durationSeconds, start + slice * 0.6)
      return {
        start,
        end,
        label:
          mode === 'asmr'
            ? `ASMR moment ${i + 1}`
            : mode === 'rapid-cut'
              ? `Action beat ${i + 1}`
              : `Scene ${i + 1}`,
        score: 0.7 + i * 0.05,
      }
    })
    .filter((m) => m.end > m.start)

  return {
    provider: 'mock',
    summary: `Mock ${mode} analysis for a ${durationSeconds.toFixed(0)}s clip.`,
    moments,
    category:
      mode === 'asmr'
        ? 'product-unboxing'
        : mode === 'rapid-cut'
          ? 'short-form-energy'
          : 'talking-head',
  }
}

export async function analyzeVideoUnderstanding(input: {
  mode: EditingModeId
  originalFilename: string
  durationSeconds: number
  transcript?: string
}): Promise<UnderstandingResult> {
  if (env.mockAi || !env.GEMINI_API_KEY) {
    await delay(400)
    return mockUnderstanding(input.mode, input.durationSeconds)
  }

  try {
    const prompt = [
      'Analyze this social video project and return JSON only with keys:',
      'summary (string), category (string), moments (array of {start,end,label,score}).',
      `Mode: ${input.mode}`,
      `Filename: ${input.originalFilename}`,
      `DurationSeconds: ${input.durationSeconds}`,
      input.transcript ? `Transcript: ${input.transcript}` : 'No transcript',
    ].join('\n')

    const text = await geminiGenerateText(prompt)
    const parsed = extractJsonObject<Omit<UnderstandingResult, 'provider'>>(text)
    return { ...parsed, provider: 'gemini' }
  } catch (error) {
    console.warn('[understanding] Falling back to mock:', error)
    return mockUnderstanding(input.mode, input.durationSeconds)
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
