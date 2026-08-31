import fs from 'fs'
import path from 'path'
import { execFile } from 'child_process'
import { promisify } from 'util'
import { env } from '../config'
import {
  extractJsonObject,
  geminiGenerateText,
  geminiGenerateWithImages,
} from './gemini'
import { FFMPEG, probeDuration, probeHasAudio } from './ffmpeg'

const execFileAsync = promisify(execFile)

export type CombineTransition =
  | 'fade'
  | 'dissolve'
  | 'slideleft'
  | 'slideright'
  | 'wipeleft'
  | 'wiperight'
  | 'circlecrop'
  | 'smoothleft'
  | 'smoothright'
  | 'pixelize'
  | 'hblur'
  | 'fadeblack'
  | 'fadewhite'
  | 'distance'
  | 'diagtl'
  | 'radial'

export interface HighlightMoment {
  source: 'a' | 'b'
  start: number
  end: number
  label: string
  score: number
}

export interface HighlightClip extends HighlightMoment {
  transitionIn: CombineTransition
  transitionSeconds: number
}

export interface AiCombinePlan {
  provider: 'gemini' | 'mock'
  titleHint: string
  pacingNote: string
  reason: string
  clips: HighlightClip[]
}

const TRANSITION_SET = new Set<CombineTransition>([
  'fade',
  'dissolve',
  'slideleft',
  'slideright',
  'wipeleft',
  'wiperight',
  'circlecrop',
  'smoothleft',
  'smoothright',
  'pixelize',
  'hblur',
  'fadeblack',
  'fadewhite',
  'distance',
  'diagtl',
  'radial',
])

const SCALE_PAD =
  'scale=720:1280:force_original_aspect_ratio=decrease,pad=720:1280:(ow-iw)/2:(oh-ih)/2:black,setsar=1,fps=30,format=yuv420p'

function sanitizeTransition(value: string | undefined): CombineTransition {
  if (value && TRANSITION_SET.has(value as CombineTransition)) {
    return value as CombineTransition
  }
  return 'fade'
}

function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n))
}

function cleanTempDir(dir: string) {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

/** How long / how many highlights to keep based on source lengths. */
function highlightBudget(durationA: number, durationB: number) {
  const total = Math.max(1, durationA) + Math.max(1, durationB)
  const avg = total / 2

  // Substantial but render-friendly: fewer longer moments encode much faster.
  const targetOutputSeconds = clamp(Math.round(avg * 0.22), 40, 120)
  const minClips = clamp(Math.round(total / 120), 5, 7)
  const maxClips = clamp(Math.round(total / 70), 6, 8)
  const minMomentSeconds = 4
  const maxMomentSeconds = clamp(Math.round(8 + avg / 60), 10, 16)
  const maxFrames = env.fastExport ? 4 : clamp(Math.round(avg / 50), 5, 8)

  return {
    targetOutputSeconds,
    minClips,
    maxClips,
    minMomentSeconds,
    maxMomentSeconds,
    maxFrames,
  }
}

/** Pull evenly spaced JPEG stills so Gemini can “see” each clip. */
async function extractSampleFrames(
  videoPath: string,
  durationSeconds: number,
  maxFrames = 8,
): Promise<Array<{ time: number; base64: string; mimeType: string }>> {
  const safeDur = Math.max(1, durationSeconds)
  const count = clamp(Math.ceil(safeDur / 12), 4, maxFrames)
  const tmpDir = path.join(
    path.dirname(videoPath),
    `._frames-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  fs.mkdirSync(tmpDir, { recursive: true })

  try {
    const jobs = Array.from({ length: count }, async (_, i) => {
      const t = clamp(((i + 0.5) / count) * safeDur, 0.05, Math.max(0.1, safeDur - 0.05))
      const outFile = path.join(tmpDir, `f-${i}.jpg`)
      await execFileAsync(
        FFMPEG,
        [
          '-y',
          '-ss',
          t.toFixed(3),
          '-i',
          videoPath,
          '-frames:v',
          '1',
          '-q:v',
          '7',
          '-vf',
          'scale=384:-2',
          outFile,
        ],
        { maxBuffer: 8 * 1024 * 1024 },
      )
      if (!fs.existsSync(outFile)) return null
      return {
        time: Number(t.toFixed(2)),
        base64: fs.readFileSync(outFile).toString('base64'),
        mimeType: 'image/jpeg',
      }
    })

    const frames = (await Promise.all(jobs)).filter(
      (f): f is { time: number; base64: string; mimeType: string } => Boolean(f),
    )
    return frames.sort((a, b) => a.time - b.time)
  } finally {
    cleanTempDir(tmpDir)
  }
}

function mockHighlightPlan(
  durationA: number,
  durationB: number,
  nameA: string,
  nameB: string,
): AiCombinePlan {
  const budget = highlightBudget(durationA, durationB)
  const offsets = [0.08, 0.2, 0.35, 0.48, 0.62, 0.75, 0.88]
  const clips: HighlightClip[] = []
  const transitions: CombineTransition[] = [
    'fade',
    'dissolve',
    'smoothleft',
    'fadeblack',
    'slideleft',
    'radial',
    'wipeleft',
  ]

  let i = 0
  while (clips.length < budget.maxClips && i < offsets.length * 2) {
    const source: 'a' | 'b' = i % 2 === 0 ? 'a' : 'b'
    const dur = source === 'a' ? durationA : durationB
    const offset = offsets[Math.floor(i / 2) % offsets.length]
    const len = clamp(
      dur * 0.12,
      budget.minMomentSeconds,
      budget.maxMomentSeconds,
    )
    const start = clamp(dur * offset, 0, Math.max(0, dur - len))
    clips.push({
      source,
      start: Number(start.toFixed(2)),
      end: Number((start + len).toFixed(2)),
      label: source === 'a' ? `Highlight A ${Math.floor(i / 2) + 1}` : `Highlight B ${Math.floor(i / 2) + 1}`,
      score: 0.75 + (i % 5) * 0.04,
      transitionIn: transitions[i % transitions.length],
      transitionSeconds: 0.75,
    })
    i += 1
  }

  return {
    provider: 'mock',
    titleHint: `${nameA.replace(/\.[^.]+$/, '')} × ${nameB.replace(/\.[^.]+$/, '')}`,
    pacingNote: `Kept ~${budget.targetOutputSeconds}s of important moments from both clips.`,
    reason: 'Mock highlight plan (no Gemini vision).',
    clips,
  }
}

function normalizeClips(
  raw: Array<Partial<HighlightClip>> | undefined,
  durationA: number,
  durationB: number,
): HighlightClip[] {
  const budget = highlightBudget(durationA, durationB)

  const clips = (raw ?? [])
    .map((clip) => {
      const source = clip.source === 'b' ? 'b' : 'a'
      const maxDur = source === 'a' ? durationA : durationB
      let start = Number(clip.start)
      let end = Number(clip.end)
      if (!Number.isFinite(start) || !Number.isFinite(end)) return null
      start = clamp(start, 0, Math.max(0, maxDur - 0.5))
      end = clamp(end, start + budget.minMomentSeconds * 0.7, maxDur)
      if (end - start < 1.2) return null
      // Keep longer moments for longer sources
      if (end - start > budget.maxMomentSeconds) {
        end = start + budget.maxMomentSeconds
      }
      // Stretch very short AI picks toward the minimum when source allows
      if (end - start < budget.minMomentSeconds) {
        end = Math.min(maxDur, start + budget.minMomentSeconds)
      }
      return {
        source,
        start: Number(start.toFixed(2)),
        end: Number(end.toFixed(2)),
        label: String(clip.label || 'Highlight').slice(0, 80),
        score: clamp(Number(clip.score) || 0.7, 0, 1),
        transitionIn: sanitizeTransition(clip.transitionIn),
        transitionSeconds: clamp(Number(clip.transitionSeconds) || 0.75, 0.4, 1.2),
      } satisfies HighlightClip
    })
    .filter((c): c is HighlightClip => Boolean(c))

  const hasA = clips.some((c) => c.source === 'a')
  const hasB = clips.some((c) => c.source === 'b')
  if (!hasA || !hasB || clips.length < budget.minClips) {
    // Prefer Gemini clips when usable; otherwise rebuild a fuller mock reel
    if (hasA && hasB && clips.length >= 4) {
      return clips.slice(0, budget.maxClips)
    }
    return mockHighlightPlan(durationA, durationB, 'A', 'B').clips
  }

  return clips.slice(0, budget.maxClips)
}

/**
 * Gemini vision looks at sample frames from both videos and returns
 * the most beautiful / important moments + an aesthetic sequence.
 */
export async function planBeautifulCombine(input: {
  pathA: string
  pathB: string
  filenameA: string
  filenameB: string
  durationA: number
  durationB: number
}): Promise<AiCombinePlan> {
  if (env.mockAi || !env.GEMINI_API_KEY) {
    return mockHighlightPlan(
      input.durationA,
      input.durationB,
      input.filenameA,
      input.filenameB,
    )
  }

  try {
    const budget = highlightBudget(input.durationA, input.durationB)
    const [framesA, framesB] = await Promise.all([
      extractSampleFrames(input.pathA, input.durationA, budget.maxFrames),
      extractSampleFrames(input.pathB, input.durationB, budget.maxFrames),
    ])

    const frameNotesA = framesA
      .map((f, i) => `A-frame ${i + 1} at ${f.time.toFixed(1)}s`)
      .join(', ')
    const frameNotesB = framesB
      .map((f, i) => `B-frame ${i + 1} at ${f.time.toFixed(1)}s`)
      .join(', ')

    const prompt = [
      'You are an elite short-form video editor / cinematographer.',
      'You are given still frames sampled from TWO videos (A then B).',
      'Pick the MOST beautiful, emotional, or important moments from EACH video,',
      'then arrange them into one aesthetic highlight reel that still feels substantial.',
      '',
      'Rules:',
      `- Choose ${budget.minClips} to ${budget.maxClips} total clips alternating/sequencing A and B.`,
      `- Each moment length should be ${budget.minMomentSeconds}–${budget.maxMomentSeconds} seconds (prefer longer when the moment is strong).`,
      `- Final reel should land near ~${budget.targetOutputSeconds} seconds of content (before transitions).`,
      '- Cover different parts of each source (opening, middle, climax, ending) — do not only pick 1–2 tiny beats.',
      '- Prefer faces, product reveals, strong motion, color, emotion, clean composition.',
      '- Skip boring/static/awkward frames, but keep enough story that viewers understand the vibe.',
      '- Use cinematic transitions between clips.',
      '',
      'Return JSON ONLY with keys:',
      'titleHint (string max 60),',
      'pacingNote (string),',
      'reason (string),',
      'clips (array of { source: "a"|"b", start, end, label, score 0-1, transitionIn, transitionSeconds 0.4-1.2 }).',
      'transitionIn must be one of: fade, dissolve, slideleft, slideright, wipeleft, wiperight, circlecrop, smoothleft, smoothright, pixelize, hblur, fadeblack, fadewhite, distance, diagtl, radial.',
      '',
      `Video A file: ${input.filenameA} (duration ${input.durationA.toFixed(2)}s). Frames: ${frameNotesA}`,
      `Video B file: ${input.filenameB} (duration ${input.durationB.toFixed(2)}s). Frames: ${frameNotesB}`,
      'Images are attached in order: all A frames first, then all B frames.',
    ].join('\n')

    const images = [
      ...framesA.map((f) => ({ mimeType: f.mimeType, base64: f.base64 })),
      ...framesB.map((f) => ({ mimeType: f.mimeType, base64: f.base64 })),
    ]

    let text = ''
    try {
      text = await geminiGenerateWithImages(prompt, images)
    } catch (visionError) {
      console.warn('[ai-combine] Vision call failed, text-only fallback:', visionError)
      text = await geminiGenerateText(
        [
          prompt,
          'NOTE: frames could not be attached. Infer strong moments from durations',
          'and pick evenly spaced highlight windows with high visual variety.',
        ].join('\n'),
      )
    }

    const parsed = extractJsonObject<{
      titleHint?: string
      pacingNote?: string
      reason?: string
      clips?: Array<Partial<HighlightClip>>
    }>(text)

    const clips = normalizeClips(parsed.clips, input.durationA, input.durationB)

    return {
      provider: 'gemini',
      titleHint: parsed.titleHint?.slice(0, 60) || 'Beautiful Moments',
      pacingNote:
        parsed.pacingNote?.slice(0, 220) ||
        'Highlight moments selected for visual beauty and impact.',
      reason:
        parsed.reason?.slice(0, 280) ||
        'Gemini vision selected the strongest moments from both clips.',
      clips,
    }
  } catch (error) {
    console.warn('[ai-combine] Falling back to mock highlights:', error)
    return mockHighlightPlan(
      input.durationA,
      input.durationB,
      input.filenameA,
      input.filenameB,
    )
  }
}

/** @deprecated use planBeautifulCombine — kept for older imports */
export async function planAestheticCombine(input: {
  filenameA: string
  filenameB: string
  durationA: number
  durationB: number
}): Promise<AiCombinePlan> {
  return mockHighlightPlan(
    input.durationA,
    input.durationB,
    input.filenameA,
    input.filenameB,
  )
}

async function extractMomentClip(input: {
  sourcePath: string
  start: number
  end: number
  outputPath: string
  keepAudio: boolean
}): Promise<void> {
  const hasAudio = await probeHasAudio(input.sourcePath)
  const args = [
    '-y',
    '-ss',
    input.start.toFixed(3),
    '-to',
    input.end.toFixed(3),
    '-i',
    input.sourcePath,
    '-vf',
    SCALE_PAD,
    '-an',
  ]

  if (input.keepAudio && hasAudio) {
    args.splice(args.indexOf('-an'), 1, '-c:a', 'aac', '-b:a', '96k', '-ac', '2', '-ar', '44100')
  }

  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-movflags',
    '+faststart',
    input.outputPath,
  )

  await execFileAsync(FFMPEG, args, { maxBuffer: 30 * 1024 * 1024 })
}

/**
 * Cut highlight moments from A/B and blend them in a SINGLE ffmpeg pass.
 * (Old path re-encoded every merge step and was extremely slow.)
 */
export async function renderHighlightCombine(input: {
  pathA: string
  pathB: string
  outputPath: string
  plan: AiCombinePlan
  keepAudio: boolean
}): Promise<{ outputDurationSeconds: number; notes: string[] }> {
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })

  const clips = input.plan.clips.slice(0, 8)
  if (!clips.length) {
    throw new Error('No highlight moments to combine.')
  }

  const notes: string[] = [
    `Gemini highlights: ${clips.length} moments (fast single-pass render)`,
    input.plan.reason,
  ]

  for (const clip of clips) {
    notes.push(
      `${clip.source.toUpperCase()} ${clip.start.toFixed(1)}–${clip.end.toFixed(1)}s · ${clip.label}`,
    )
  }

  if (clips.length === 1) {
    const only = clips[0]
    const sourcePath = only.source === 'a' ? input.pathA : input.pathB
    await extractMomentClip({
      sourcePath,
      start: only.start,
      end: only.end,
      outputPath: input.outputPath,
      keepAudio: input.keepAudio,
    })
    const dur = await probeDuration(input.outputPath)
    return { outputDurationSeconds: dur, notes }
  }

  const [hasAudioA, hasAudioB] = await Promise.all([
    probeHasAudio(input.pathA),
    probeHasAudio(input.pathB),
  ])
  const useAudio =
    input.keepAudio &&
    clips.every((c) => (c.source === 'a' ? hasAudioA : hasAudioB))

  const lengths = clips.map((c) => Math.max(0.8, c.end - c.start))
  const transitions = clips.map((c, i) =>
    i === 0
      ? 0
      : clamp(Math.min(c.transitionSeconds || 0.6, lengths[i - 1] * 0.35, lengths[i] * 0.35), 0.35, 0.85),
  )

  const filters: string[] = []
  for (let i = 0; i < clips.length; i++) {
    const clip = clips[i]
    const inputIdx = clip.source === 'a' ? 0 : 1
    filters.push(
      `[${inputIdx}:v]trim=start=${clip.start.toFixed(3)}:end=${clip.end.toFixed(3)},setpts=PTS-STARTPTS,${SCALE_PAD}[v${i}]`,
    )
    if (useAudio) {
      filters.push(
        `[${inputIdx}:a]atrim=start=${clip.start.toFixed(3)}:end=${clip.end.toFixed(3)},asetpts=PTS-STARTPTS,aformat=sample_rates=44100:channel_layouts=stereo[a${i}]`,
      )
    }
  }

  // Video xfade chain
  let vLabel = 'v0'
  let cumulative = lengths[0]
  for (let i = 1; i < clips.length; i++) {
    const d = transitions[i]
    const offset = Math.max(0.05, cumulative - d)
    const outLabel = i === clips.length - 1 ? 'vout' : `vx${i}`
    const transition = sanitizeTransition(clips[i].transitionIn)
    filters.push(
      `[${vLabel}][v${i}]xfade=transition=${transition}:duration=${d.toFixed(3)}:offset=${offset.toFixed(3)}[${outLabel}]`,
    )
    notes.push(`Blend ${i}: ${transition} (${d.toFixed(2)}s)`)
    vLabel = outLabel
    cumulative = cumulative + lengths[i] - d
  }

  if (useAudio) {
    let aLabel = 'a0'
    for (let i = 1; i < clips.length; i++) {
      const d = transitions[i]
      const outLabel = i === clips.length - 1 ? 'aout' : `ax${i}`
      filters.push(`[${aLabel}][a${i}]acrossfade=d=${d.toFixed(3)}:c1=tri:c2=tri[${outLabel}]`)
      aLabel = outLabel
    }
  }

  const args = [
    '-y',
    '-i',
    input.pathA,
    '-i',
    input.pathB,
    '-filter_complex',
    filters.join(';'),
    '-map',
    '[vout]',
  ]

  if (useAudio) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '96k')
  } else {
    args.push('-an')
  }

  args.push(
    '-movflags',
    '+faststart',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    '28',
    '-threads',
    '0',
    '-pix_fmt',
    'yuv420p',
    input.outputPath,
  )

  try {
    await execFileAsync(FFMPEG, args, { maxBuffer: 60 * 1024 * 1024 })
  } catch (error) {
    // Fallback: simpler concat without fancy xfades if complex filter fails
    console.warn('[ai-combine] Single-pass xfade failed, using fast concat fallback:', error)
    return renderHighlightCombineFallback(input, clips, notes)
  }

  const outDur = await probeDuration(input.outputPath)
  return {
    outputDurationSeconds: outDur || Math.max(1, cumulative),
    notes,
  }
}

/** Fast concat fallback: cut segments in parallel, then concat demuxer (no re-xfade chain). */
async function renderHighlightCombineFallback(
  input: {
    pathA: string
    pathB: string
    outputPath: string
    keepAudio: boolean
  },
  clips: HighlightClip[],
  notes: string[],
): Promise<{ outputDurationSeconds: number; notes: string[] }> {
  const workDir = path.join(
    path.dirname(input.outputPath),
    `._combine-fast-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  )
  fs.mkdirSync(workDir, { recursive: true })

  try {
    const segmentPaths = await Promise.all(
      clips.map(async (clip, i) => {
        const segPath = path.join(workDir, `seg-${i}.mp4`)
        await extractMomentClip({
          sourcePath: clip.source === 'a' ? input.pathA : input.pathB,
          start: clip.start,
          end: clip.end,
          outputPath: segPath,
          keepAudio: input.keepAudio,
        })
        return segPath
      }),
    )

    const listFile = path.join(workDir, 'list.txt')
    fs.writeFileSync(
      listFile,
      segmentPaths.map((p) => `file '${p.replace(/\\/g, '/')}'`).join('\n'),
    )

    await execFileAsync(
      FFMPEG,
      [
        '-y',
        '-f',
        'concat',
        '-safe',
        '0',
        '-i',
        listFile,
        '-c',
        'copy',
        '-movflags',
        '+faststart',
        input.outputPath,
      ],
      { maxBuffer: 20 * 1024 * 1024 },
    )

    notes.push('Used fast concat fallback')
    const outDur = await probeDuration(input.outputPath)
    return { outputDurationSeconds: outDur || 1, notes }
  } finally {
    cleanTempDir(workDir)
  }
}

/** Back-compat wrapper used by older job code. */
export async function renderAestheticCombine(input: {
  pathA: string
  pathB: string
  outputPath: string
  order: 'ab' | 'ba'
  transition: CombineTransition
  transitionSeconds: number
  keepAudio: boolean
}): Promise<{ outputDurationSeconds: number; notes: string[] }> {
  const [durA, durB] = await Promise.all([
    probeDuration(input.pathA),
    probeDuration(input.pathB),
  ])
  const plan = mockHighlightPlan(durA || 5, durB || 5, 'A', 'B')
  if (input.order === 'ba') {
    plan.clips = plan.clips.map((c) => ({
      ...c,
      source: c.source === 'a' ? 'b' : 'a',
      transitionIn: input.transition,
      transitionSeconds: input.transitionSeconds,
    }))
  } else {
    plan.clips = plan.clips.map((c, i) =>
      i === 0
        ? c
        : {
            ...c,
            transitionIn: input.transition,
            transitionSeconds: input.transitionSeconds,
          },
    )
  }
  return renderHighlightCombine({
    pathA: input.pathA,
    pathB: input.pathB,
    outputPath: input.outputPath,
    plan,
    keepAudio: input.keepAudio,
  })
}
