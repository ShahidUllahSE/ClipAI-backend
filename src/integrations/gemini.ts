import { env } from '../config'

/** Current Flash workhorse for new Google AI Studio keys. */
export const GEMINI_MODEL = 'gemini-3.6-flash'

/** Audio-capable Flash models, tried in order when one is busy or retired. */
const GEMINI_AUDIO_MODELS = [
  GEMINI_MODEL,
  'gemini-3.5-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-flash-lite',
  'gemini-flash-latest',
]

const GEMINI_TIMEOUT_MS = 8_000
const GEMINI_VISION_TIMEOUT_MS = 45_000
const GEMINI_AUDIO_TIMEOUT_MS = 120_000

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function isBusyGeminiError(error: unknown): boolean {
  const raw = error instanceof Error ? error.message : String(error)
  return /high demand|unavailable|no longer available|not found|resource.?exhausted|try again later|overloaded|deprecated|429|503|404/i.test(
    raw,
  )
}

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

async function geminiGenerateWithMediaOnce(
  prompt: string,
  media: { mimeType: string; base64: string },
  options: { json?: boolean; timeoutMs?: number; model: string },
): Promise<string> {
  const controller = new AbortController()
  const timer = setTimeout(
    () => controller.abort(),
    options.timeoutMs ?? GEMINI_AUDIO_TIMEOUT_MS,
  )

  try {
    const response = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/${options.model}:generateContent?key=${env.GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [
            {
              parts: [
                { text: prompt },
                {
                  inline_data: {
                    mime_type: media.mimeType,
                    data: media.base64,
                  },
                },
              ],
            },
          ],
          generationConfig: {
            temperature: 0.1,
            ...(options.json ? { responseMimeType: 'application/json' } : {}),
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

export async function geminiGenerateWithMedia(
  prompt: string,
  media: { mimeType: string; base64: string },
  options?: { json?: boolean; timeoutMs?: number },
): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  let lastError: unknown
  const models = [...new Set(GEMINI_AUDIO_MODELS)]

  for (let i = 0; i < models.length; i++) {
    try {
      return await geminiGenerateWithMediaOnce(prompt, media, {
        ...options,
        model: models[i],
      })
    } catch (error) {
      lastError = error
      if (!isBusyGeminiError(error) || i === models.length - 1) {
        throw error
      }
      await delay(700 * (i + 1))
    }
  }

  throw lastError instanceof Error
    ? lastError
    : new Error('Gemini caption request failed.')
}

export function extractJsonObject<T>(text: string): T {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Gemini returned no JSON')
  return JSON.parse(jsonMatch[0]) as T
}
