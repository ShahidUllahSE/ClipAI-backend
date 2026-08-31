import { env } from '../config'

/** Alias that tracks Google’s current free Flash model for new keys. */
export const GEMINI_MODEL = 'gemini-flash-latest'

const GEMINI_TIMEOUT_MS = 8_000
const GEMINI_VISION_TIMEOUT_MS = 45_000

export async function geminiGenerateText(prompt: string): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEMINI_TIMEOUT_MS)

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
        }),
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(await response.text())
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  } finally {
    clearTimeout(timer)
  }
}

export async function geminiGenerateWithImages(
  prompt: string,
  images: Array<{ mimeType: string; base64: string }>,
): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), GEMINI_VISION_TIMEOUT_MS)

  const parts: Array<Record<string, unknown>> = [{ text: prompt }]
  for (const image of images.slice(0, 24)) {
    parts.push({
      inline_data: {
        mime_type: image.mimeType,
        data: image.base64,
      },
    })
  }

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts }],
          generationConfig: {
            temperature: 0.4,
          },
        }),
        signal: controller.signal,
      },
    )

    if (!response.ok) {
      throw new Error(await response.text())
    }

    const data = (await response.json()) as {
      candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
    }
    return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
  } finally {
    clearTimeout(timer)
  }
}

export function extractJsonObject<T>(text: string): T {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Gemini returned no JSON')
  return JSON.parse(jsonMatch[0]) as T
}
