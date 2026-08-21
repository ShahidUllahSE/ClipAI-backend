import { env } from '../config'
import type { EditingModeId } from '../constants/projects'
import { extractJsonObject, geminiGenerateText } from './gemini'

export interface NamingResult {
  provider: 'gemini' | 'mock'
  title: string
  outputFilename: string
}

function slugify(text: string) {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
}

function mockNaming(filename: string, mode: EditingModeId): NamingResult {
  const base = filename.replace(/\.[^.]+$/, '').replace(/[-_]+/g, ' ')
  const modeLabel =
    mode === 'talking-head'
      ? 'Talking Head'
      : mode === 'rapid-cut'
        ? 'Rapid Cut'
        : 'ASMR Unboxing'
  const title = `${base || 'Untitled'} — ${modeLabel}`.slice(0, 80)
  return {
    provider: 'mock',
    title,
    outputFilename: `${slugify(title) || 'export'}.mp4`,
  }
}

export async function generateProjectName(input: {
  originalFilename: string
  mode: EditingModeId
  transcript?: string
  summary?: string
}): Promise<NamingResult> {
  if (env.mockAi || env.fastExport || !env.GEMINI_API_KEY) {
    return mockNaming(input.originalFilename, input.mode)
  }

  try {
    const prompt = [
      'Generate a short social-video title and sanitized mp4 filename.',
      'Return JSON only: { "title": string, "outputFilename": string }',
      `Mode: ${input.mode}`,
      `Filename: ${input.originalFilename}`,
      input.summary ? `Summary: ${input.summary}` : '',
      input.transcript ? `Transcript: ${input.transcript.slice(0, 500)}` : '',
    ].join('\n')

    const text = await geminiGenerateText(prompt)
    const parsed = extractJsonObject<{
      title?: string
      outputFilename?: string
    }>(text)
    const title = (parsed.title || 'Untitled Clip').slice(0, 80)
    const outputFilename = (
      parsed.outputFilename || `${slugify(title)}.mp4`
    ).replace(/[^\w.\-]/g, '-')
    return { provider: 'gemini', title, outputFilename }
  } catch (error) {
    console.warn('[naming] Falling back to mock:', error)
    return mockNaming(input.originalFilename, input.mode)
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
