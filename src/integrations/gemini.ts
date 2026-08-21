import { env } from '../config'

/** Alias that tracks Google’s current free Flash model for new keys. */
export const GEMINI_MODEL = 'gemini-flash-latest'

export async function geminiGenerateText(prompt: string): Promise<string> {
  if (!env.GEMINI_API_KEY) {
    throw new Error('GEMINI_API_KEY is not set')
  }

  const response = await fetch(
    `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent?key=${env.GEMINI_API_KEY}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
      }),
    },
  )

  if (!response.ok) {
    throw new Error(await response.text())
  }

  const data = (await response.json()) as {
    candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>
  }
  return data.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
}

export function extractJsonObject<T>(text: string): T {
  const jsonMatch = text.match(/\{[\s\S]*\}/)
  if (!jsonMatch) throw new Error('Gemini returned no JSON')
  return JSON.parse(jsonMatch[0]) as T
}
