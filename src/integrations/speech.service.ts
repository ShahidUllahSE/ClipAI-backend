import { env } from '../config'

export interface SpeechWord {
  word: string
  start: number
  end: number
}

export interface SpeechResult {
  provider: 'deepgram' | 'groq' | 'mock'
  transcript: string
  words: SpeechWord[]
  silenceRanges: Array<{ start: number; end: number }>
}

function mockSpeech(durationSeconds: number): SpeechResult {
  const words: SpeechWord[] = []
  const phrases = [
    'Welcome',
    'to',
    'ClipAI',
    'this',
    'is',
    'a',
    'sample',
    'talking',
    'head',
    'transcript',
  ]
  let t = 0.4
  for (const word of phrases) {
    words.push({ word, start: t, end: t + 0.35 })
    t += 0.45
  }
  const silenceRanges = [
    { start: Math.min(2.2, durationSeconds * 0.2), end: Math.min(3.4, durationSeconds * 0.35) },
  ]
  return {
    provider: 'mock',
    transcript: phrases.join(' '),
    words,
    silenceRanges,
  }
}

export async function analyzeSpeech(input: {
  sourceUrl: string
  durationSeconds: number
}): Promise<SpeechResult> {
  if (env.mockAi) {
    await delay(400)
    return mockSpeech(input.durationSeconds)
  }

  try {
    const mediaRes = await fetch(input.sourceUrl)
    if (!mediaRes.ok) throw new Error('Could not fetch source video for STT.')
    const buffer = Buffer.from(await mediaRes.arrayBuffer())

    if (env.GROQ_API_KEY) {
      const form = new FormData()
      form.append(
        'file',
        new Blob([new Uint8Array(buffer)], {
          type: mediaRes.headers.get('content-type') || 'audio/mp4',
        }),
        'source.mp4',
      )
      form.append('model', 'whisper-large-v3')
      form.append('response_format', 'verbose_json')
      form.append('timestamp_granularities[]', 'word')

      const groqResponse = await fetch(
        'https://api.groq.com/openai/v1/audio/transcriptions',
        {
          method: 'POST',
          headers: { Authorization: `Bearer ${env.GROQ_API_KEY}` },
          body: form,
        },
      )
      if (!groqResponse.ok) {
        throw new Error(`Groq STT error: ${await groqResponse.text()}`)
      }

      const groqData = (await groqResponse.json()) as {
        text?: string
        words?: SpeechWord[]
      }
      const words = (groqData.words ?? []).filter(
        (word) =>
          typeof word.word === 'string' &&
          typeof word.start === 'number' &&
          typeof word.end === 'number',
      )
      const silenceRanges: SpeechResult['silenceRanges'] = []
      for (let i = 1; i < words.length; i += 1) {
        const gap = words[i].start - words[i - 1].end
        if (gap >= 0.7) {
          silenceRanges.push({ start: words[i - 1].end, end: words[i].start })
        }
      }
      if (words.length) {
        if (words[0].start >= 0.7) {
          silenceRanges.unshift({ start: 0, end: words[0].start })
        }
        const last = words[words.length - 1]
        if (input.durationSeconds - last.end >= 0.7) {
          silenceRanges.push({ start: last.end, end: input.durationSeconds })
        }
      }

      return {
        provider: 'groq',
        transcript: groqData.text ?? '',
        words,
        silenceRanges,
      }
    }

    if (!env.DEEPGRAM_API_KEY) {
      throw new Error('No speech transcription provider is configured')
    }

    const response = await fetch(
      'https://api.deepgram.com/v1/listen?model=nova-2&smart_format=true&utterances=true',
      {
        method: 'POST',
        headers: {
          Authorization: `Token ${env.DEEPGRAM_API_KEY}`,
          'Content-Type': 'audio/mp4',
        },
        body: buffer,
      },
    )

    if (!response.ok) {
      const text = await response.text()
      throw new Error(`Deepgram error: ${text}`)
    }

    const data = (await response.json()) as {
      results?: {
        channels?: Array<{
          alternatives?: Array<{
            transcript?: string
            words?: Array<{ word: string; start: number; end: number }>
          }>
        }>
      }
    }

    const alt = data.results?.channels?.[0]?.alternatives?.[0]
    const words = alt?.words ?? []
    const silenceRanges: SpeechResult['silenceRanges'] = []
    for (let i = 1; i < words.length; i++) {
      const gap = words[i].start - words[i - 1].end
      if (gap >= 0.7) {
        silenceRanges.push({ start: words[i - 1].end, end: words[i].start })
      }
    }

    return {
      provider: 'deepgram',
      transcript: alt?.transcript ?? '',
      words,
      silenceRanges,
    }
  } catch (error) {
    console.warn('[speech] Falling back to mock:', error)
    return mockSpeech(input.durationSeconds)
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
