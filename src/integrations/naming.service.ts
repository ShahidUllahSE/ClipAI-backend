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
    .slice(0, 80)
}

export function filenameFromTitle(title: string) {
  const cleaned = String(title || '')
    .replace(/\.mp4$/i, '')
    .trim()
  return `${slugify(cleaned) || 'export'}.mp4`
}

function modeLabel(mode: EditingModeId) {
  if (mode === 'talking-head') return 'Talking Head'
  if (mode === 'rapid-cut') return 'Rapid Cut'
  if (mode === 'ai-combine') return 'AI Combine'
  return 'ASMR Unboxing'
}

function titleFromTranscript(transcript?: string, filename?: string) {
  const spoken = (transcript || '')
    .replace(/\s+/g, ' ')
    .trim()
    .split(' ')
    .filter(Boolean)
    .slice(0, 8)
    .join(' ')
  if (spoken.length >= 12) return spoken.slice(0, 70)
  const base = (filename || '')
    .replace(/\.[^.]+$/, '')
    .replace(/[-_]+/g, ' ')
    .trim()
  return (base || 'Untitled clip').slice(0, 70)
}

function mockNaming(
  filename: string,
  mode: EditingModeId,
  transcript?: string,
): NamingResult {
  const title = titleFromTranscript(transcript, filename)
  return {
    provider: 'mock',
    title,
    outputFilename: filenameFromTitle(title),
  }
}

export async function generateProjectName(input: {
  originalFilename: string
  mode: EditingModeId
  transcript?: string
  summary?: string
}): Promise<NamingResult> {
  if (!env.GEMINI_API_KEY) {
    return mockNaming(input.originalFilename, input.mode, input.transcript)
  }

  try {
    const prompt = [
      'Create a short catchy title for this edited social video.',
      'Do not copy the original file name. Use the transcript/summary.',
      '4 to 8 words. No quotes. No hashtags.',
      'Return JSON only: { "title": string }',
      `Mode: ${input.mode} (${modeLabel(input.mode)})`,
      input.summary ? `Summary: ${input.summary.slice(0, 400)}` : '',
      input.transcript ? `Transcript: ${input.transcript.slice(0, 800)}` : '',
      `Original file (do not reuse): ${input.originalFilename}`,
    ]
      .filter(Boolean)
      .join('\n')

    const text = await geminiGenerateText(prompt)
    let title = ''
    try {
      const parsed = extractJsonObject<{ title?: string }>(text)
      title = String(parsed.title || '').trim()
    } catch {
      title = text.replace(/["`]/g, ' ').replace(/\s+/g, ' ').trim()
    }
    title = title
      .replace(/^title\s*:\s*/i, '')
      .replace(/\.mp4$/i, '')
      .slice(0, 80)
      .trim()
    if (title.length < 3) {
      title = titleFromTranscript(input.transcript, input.originalFilename)
    }
    return { provider: 'gemini', title, outputFilename: filenameFromTitle(title) }
  } catch (error) {
    console.warn('[naming] Falling back:', error)
    return mockNaming(input.originalFilename, input.mode, input.transcript)
  }
}
