import { env } from '../config'

export interface EditPlan {
  cuts: Array<{ start: number; end: number }>
  captions: boolean
  aspectRatio: string
  keepAudio: boolean
  notes: string[]
}

export interface RenderResult {
  provider: 'shotstack' | 'mock'
  outputUrl: string
  renderId?: string
  status: 'done' | 'failed'
  message?: string
}

export async function renderEditedVideo(input: {
  sourceUrl: string
  outputFilename: string
  editPlan: EditPlan
}): Promise<RenderResult> {
  if (env.mockAi || !env.SHOTSTACK_API_KEY) {
    await delay(600)
    return {
      provider: 'mock',
      outputUrl: input.sourceUrl,
      status: 'done',
      message: 'Mock render used source video as output preview.',
    }
  }

  try {
    const clips = (input.editPlan.cuts.length
      ? input.editPlan.cuts
      : [{ start: 0, end: 10 }]
    ).map((cut, index) => ({
      asset: {
        type: 'video',
        src: input.sourceUrl,
        trim: cut.start,
        volume: input.editPlan.keepAudio ? 1 : 0,
      },
      start: index === 0 ? 0 : undefined,
      length: Math.max(0.5, cut.end - cut.start),
    }))

    // Sequential timeline lengths — Shotstack needs explicit start times
    let cursor = 0
    const timelineClips = clips.map((clip) => {
      const start = cursor
      cursor += Number(clip.length)
      return { ...clip, start }
    })

    const response = await fetch(
      `https://api.shotstack.io/${env.SHOTSTACK_ENV}/render`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': env.SHOTSTACK_API_KEY,
        },
        body: JSON.stringify({
          timeline: {
            tracks: [{ clips: timelineClips }],
          },
          output: {
            format: 'mp4',
            resolution: 'hd',
            aspectRatio: input.editPlan.aspectRatio.replace(':', '-'),
          },
        }),
      },
    )

    if (!response.ok) throw new Error(await response.text())
    const data = (await response.json()) as {
      response?: { id?: string }
    }
    const renderId = data.response?.id
    if (!renderId) throw new Error('Shotstack did not return render id')

    const outputUrl = await pollShotstack(renderId)
    return {
      provider: 'shotstack',
      outputUrl: outputUrl || input.sourceUrl,
      renderId,
      status: 'done',
    }
  } catch (error) {
    console.warn('[render] Falling back to mock:', error)
    return {
      provider: 'mock',
      outputUrl: input.sourceUrl,
      status: 'done',
      message: 'Shotstack failed; mock output used.',
    }
  }
}

async function pollShotstack(renderId: string): Promise<string> {
  for (let i = 0; i < 30; i++) {
    await delay(2000)
    const response = await fetch(
      `https://api.shotstack.io/${env.SHOTSTACK_ENV}/render/${renderId}`,
      { headers: { 'x-api-key': env.SHOTSTACK_API_KEY } },
    )
    if (!response.ok) continue
    const data = (await response.json()) as {
      response?: { status?: string; url?: string }
    }
    if (data.response?.status === 'done' && data.response.url) {
      return data.response.url
    }
    if (data.response?.status === 'failed') {
      throw new Error('Shotstack render failed')
    }
  }
  throw new Error('Shotstack render timed out')
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
