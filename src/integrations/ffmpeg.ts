import { execFile } from 'child_process'
import fs from 'fs'
import path from 'path'
import { promisify } from 'util'
import ffmpegPath from 'ffmpeg-static'
import ffprobePath from 'ffprobe-static'
import { env } from '../config'

const execFileAsync = promisify(execFile)

function requireBin(bin: string | null, name: string) {
  if (!bin) throw new Error(`${name} binary not found.`)
  return bin
}

export const FFMPEG = requireBin(ffmpegPath, 'ffmpeg')
export const FFPROBE = requireBin(ffprobePath.path, 'ffprobe')

export async function probeDuration(filePath: string): Promise<number> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v',
    'error',
    '-show_entries',
    'format=duration',
    '-of',
    'default=noprint_wrappers=1:nokey=1',
    filePath,
  ])
  const duration = Number(stdout.trim())
  return Number.isFinite(duration) ? duration : 0
}

export async function probeHasAudio(filePath: string): Promise<boolean> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v',
    'error',
    '-select_streams',
    'a',
    '-show_entries',
    'stream=codec_type',
    '-of',
    'csv=p=0',
    filePath,
  ])
  return stdout.trim().length > 0
}

/** Display size after iPhone/Android rotation tags. */
export async function probeDisplaySize(
  filePath: string,
): Promise<{ w: number; h: number; portrait: boolean }> {
  const { stdout } = await execFileAsync(FFPROBE, [
    '-v',
    'error',
    '-select_streams',
    'v:0',
    '-show_entries',
    'stream=width,height:stream_tags=rotate',
    '-of',
    'json',
    filePath,
  ])
  const parsed = JSON.parse(stdout) as {
    streams?: Array<{
      width?: number
      height?: number
      tags?: { rotate?: string }
    }>
  }
  const stream = parsed.streams?.[0]
  let w = Number(stream?.width) || 1920
  let h = Number(stream?.height) || 1080
  const rotate = Math.abs(Number(stream?.tags?.rotate || 0))
  if (rotate === 90 || rotate === 270) {
    const swap = w
    w = h
    h = swap
  }
  return { w, h, portrait: h >= w }
}

export type SilenceSensitivity = 'light' | 'medium' | 'aggressive'

function silenceFilter(level: SilenceSensitivity) {
  switch (level) {
    case 'light':
      return 'silencedetect=noise=-40dB:d=0.85'
    case 'aggressive':
      return 'silencedetect=noise=-25dB:d=0.28'
    default:
      return 'silencedetect=noise=-30dB:d=0.45'
  }
}

async function runFfmpeg(args: string[], timeoutMs = 25 * 60 * 1000) {
  await execFileAsync(FFMPEG, args, {
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
  })
}

export async function detectSilenceRanges(
  filePath: string,
  level: SilenceSensitivity = 'medium',
): Promise<Array<{ start: number; end: number }>> {
  const args = [
    '-hide_banner',
    '-nostats',
    '-i',
    filePath,
    '-vn',
    '-sn',
    '-map',
    '0:a:0',
    '-af',
    silenceFilter(level),
    '-f',
    'null',
    '-',
  ]
  try {
    const { stderr } = await execFileAsync(FFMPEG, args, {
      maxBuffer: 32 * 1024 * 1024,
      timeout: 20 * 60 * 1000,
    })
    return parseSilenceLog(stderr)
  } catch (error) {
    // silencedetect logs often arrive via stderr with a non-zero exit
    const stderr =
      error && typeof error === 'object' && 'stderr' in error
        ? String((error as { stderr: string }).stderr)
        : ''
    return parseSilenceLog(stderr)
  }
}

function parseSilenceLog(log: string) {
  const ranges: Array<{ start: number; end: number }> = []
  let currentStart: number | null = null
  for (const line of log.split(/\r?\n/)) {
    const startMatch = line.match(/silence_start:\s*([0-9.]+)/)
    if (startMatch) {
      currentStart = Number(startMatch[1])
      continue
    }
    const endMatch = line.match(/silence_end:\s*([0-9.]+)/)
    if (endMatch && currentStart !== null) {
      ranges.push({ start: currentStart, end: Number(endMatch[1]) })
      currentStart = null
    }
  }
  return ranges
}

export function silenceToKeepCuts(
  silenceRanges: Array<{ start: number; end: number }>,
  durationSeconds: number,
  minKeep = 0.25,
): Array<{ start: number; end: number }> {
  if (!silenceRanges.length) {
    return [{ start: 0, end: durationSeconds }]
  }

  const cuts: Array<{ start: number; end: number }> = []
  let cursor = 0
  for (const silence of silenceRanges) {
    if (silence.start > cursor + minKeep) {
      cuts.push({ start: cursor, end: silence.start })
    }
    cursor = Math.max(cursor, silence.end)
  }
  if (durationSeconds > cursor + minKeep) {
    cuts.push({ start: cursor, end: durationSeconds })
  }

  return cuts.length ? cuts : [{ start: 0, end: durationSeconds }]
}

/**
 * Keep louder / more interesting audio windows (ASMR packaging peaks).
 * Works when the clip has continuous room noise and classic "silence" is rare.
 */
export async function detectLoudKeepCuts(
  filePath: string,
  durationSeconds: number,
  keepRatio = 0.55,
): Promise<Array<{ start: number; end: number }>> {
  const tmpWav = path.join(
    path.dirname(filePath),
    `._peaks-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`,
  )

  try {
    await extractAudioWav(filePath, tmpWav)
    const buf = fs.readFileSync(tmpWav)
    // Skip 44-byte WAV header from ffmpeg pcm_s16le mono 16k
    const dataOffset = 44
    const samples = Math.floor((buf.length - dataOffset) / 2)
    if (samples < 1600) {
      return [{ start: 0, end: durationSeconds }]
    }

    const windowSec = 0.25
    const sampleRate = 16000
    const windowSamples = Math.max(1, Math.floor(sampleRate * windowSec))
    const energies: number[] = []

    for (let i = 0; i + windowSamples <= samples; i += windowSamples) {
      let sum = 0
      for (let s = 0; s < windowSamples; s++) {
        const sample = buf.readInt16LE(dataOffset + (i + s) * 2)
        sum += sample * sample
      }
      energies.push(Math.sqrt(sum / windowSamples))
    }

    if (!energies.length) {
      return [{ start: 0, end: durationSeconds }]
    }

    const sorted = [...energies].sort((a, b) => a - b)
    const ratio = Math.min(0.85, Math.max(0.25, keepRatio))
    const cutoffIndex = Math.floor(sorted.length * (1 - ratio))
    const threshold = sorted[Math.min(sorted.length - 1, cutoffIndex)]

    const keepFlags = energies.map((e) => e >= threshold)
    // Always keep first and last short beat so openings/closings survive
    if (keepFlags.length) {
      keepFlags[0] = true
      keepFlags[keepFlags.length - 1] = true
    }

    const cuts: Array<{ start: number; end: number }> = []
    let runStart: number | null = null
    for (let i = 0; i < keepFlags.length; i++) {
      if (keepFlags[i] && runStart === null) runStart = i
      if ((!keepFlags[i] || i === keepFlags.length - 1) && runStart !== null) {
        const endIdx = keepFlags[i] && i === keepFlags.length - 1 ? i + 1 : i
        const start = Math.max(0, runStart * windowSec - 0.08)
        const end = Math.min(durationSeconds, endIdx * windowSec + 0.12)
        if (end - start >= 0.2) cuts.push({ start, end })
        runStart = null
      }
    }

    return cuts.length ? mergeCuts(cuts, 0.2) : [{ start: 0, end: durationSeconds }]
  } finally {
    try {
      fs.unlinkSync(tmpWav)
    } catch {
      /* ignore */
    }
  }
}

function mergeCuts(
  cuts: Array<{ start: number; end: number }>,
  gap = 0.2,
): Array<{ start: number; end: number }> {
  if (!cuts.length) return cuts
  const sorted = [...cuts].sort((a, b) => a.start - b.start)
  const out: Array<{ start: number; end: number }> = [sorted[0]]
  for (let i = 1; i < sorted.length; i++) {
    const prev = out[out.length - 1]
    const cur = sorted[i]
    if (cur.start <= prev.end + gap) {
      prev.end = Math.max(prev.end, cur.end)
    } else {
      out.push({ ...cur })
    }
  }
  return out
}

export async function extractAudioWav(
  inputPath: string,
  outputPath: string,
): Promise<string> {
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-nostats',
    '-i',
    inputPath,
    '-vn',
    '-sn',
    '-map',
    '0:a:0',
    '-ac',
    '1',
    '-ar',
    '16000',
    '-f',
    'wav',
    outputPath,
  ])
  return outputPath
}

/** Slice already-extracted audio without decoding the source video again. */
export async function extractAudioSlice(
  inputPath: string,
  outputPath: string,
  startSeconds: number,
  durationSeconds: number,
): Promise<string> {
  await runFfmpeg([
    '-y',
    '-hide_banner',
    '-nostats',
    '-ss',
    Math.max(0, startSeconds).toFixed(3),
    '-t',
    Math.max(0.2, durationSeconds).toFixed(3),
    '-i',
    inputPath,
    '-ac',
    '1',
    '-ar',
    '16000',
    '-c:a',
    'libmp3lame',
    '-b:a',
    '48k',
    outputPath,
  ])
  return outputPath
}

/** Compact mono audio for Gemini STT (stays under the inline-data size cap). */
export async function extractAudioForStt(
  inputPath: string,
  outputPathWithoutExt: string,
): Promise<{ path: string; mimeType: string }> {
  const mp3Path = `${outputPathWithoutExt}.mp3`
  try {
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-nostats',
      '-i',
      inputPath,
      '-vn',
      '-sn',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'libmp3lame',
      '-b:a',
      '48k',
      mp3Path,
    ])
    return { path: mp3Path, mimeType: 'audio/mpeg' }
  } catch {
    const m4aPath = `${outputPathWithoutExt}.m4a`
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-nostats',
      '-i',
      inputPath,
      '-vn',
      '-sn',
      '-map',
      '0:a:0',
      '-ac',
      '1',
      '-ar',
      '16000',
      '-c:a',
      'aac',
      '-b:a',
      '48k',
      m4aPath,
    ])
    return { path: m4aPath, mimeType: 'audio/mp4' }
  }
}

export type ClipMotion =
  | 'none'
  | 'punch'
  | 'zoom-in'
  | 'zoom-out'
  | 'ken-burns'
  | 'fade'

export type SubjectFocus = { x: number; y: number }

const FOCUS_W = 120
const FOCUS_H = 68

function isSkinTone(r: number, g: number, b: number) {
  return (
    r > 90 &&
    g > 35 &&
    b > 15 &&
    r > g &&
    r > b &&
    r - g > 12 &&
    Math.max(r, g, b) - Math.min(r, g, b) > 12
  )
}

function analyzeRgbFocus(buf: Buffer, width: number, height: number): SubjectFocus {
  let sumX = 0
  let sumY = 0
  let mass = 0
  for (let y = 0; y < height; y++) {
    const yBias = y < height * 0.62 ? 1.5 : 0.55
    for (let x = 0; x < width; x++) {
      const i = (y * width + x) * 3
      const r = buf[i]
      const g = buf[i + 1]
      const b = buf[i + 2]
      if (!isSkinTone(r, g, b)) continue
      const w = yBias
      sumX += x * w
      sumY += y * w
      mass += w
    }
  }
  if (mass < 28) return { x: 0.5, y: 0.45 }
  return {
    x: Math.min(0.88, Math.max(0.12, sumX / mass / width)),
    y: Math.min(0.7, Math.max(0.28, sumY / mass / height)),
  }
}

async function sampleFocusAt(
  inputPath: string,
  timeSeconds: number,
  tmpPath: string,
): Promise<SubjectFocus> {
  try {
    await runFfmpeg(
      [
        '-y',
        '-hide_banner',
        '-nostats',
        '-ss',
        Math.max(0, timeSeconds).toFixed(3),
        '-i',
        inputPath,
        '-frames:v',
        '1',
        '-vf',
        `scale=${FOCUS_W}:${FOCUS_H}:flags=fast_bilinear`,
        '-f',
        'rawvideo',
        '-pix_fmt',
        'rgb24',
        tmpPath,
      ],
      45_000,
    )
    const buf = fs.readFileSync(tmpPath)
    if (buf.length < FOCUS_W * FOCUS_H * 3) return { x: 0.5, y: 0.45 }
    return analyzeRgbFocus(buf, FOCUS_W, FOCUS_H)
  } catch {
    return { x: 0.5, y: 0.45 }
  }
}

async function detectCutFocuses(
  inputPath: string,
  cuts: Array<{ start: number; end: number }>,
): Promise<SubjectFocus[]> {
  const tmpDir = path.join(
    path.dirname(inputPath),
    `._focus-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`,
  )
  fs.mkdirSync(tmpDir, { recursive: true })
  const focuses: SubjectFocus[] = new Array(cuts.length)
  let cursor = 0

  async function worker() {
    while (cursor < cuts.length) {
      const i = cursor++
      const cut = cuts[i]
      const t = cut.start + Math.max(0.05, (cut.end - cut.start) * 0.4)
      const tmpPath = path.join(tmpDir, `${i}.rgb`)
      focuses[i] = await sampleFocusAt(inputPath, t, tmpPath)
      unlinkQuiet(tmpPath)
    }
  }

  try {
    const n = Math.min(3, Math.max(1, cuts.length))
    await Promise.all(Array.from({ length: n }, () => worker()))
    return focuses
  } finally {
    removeDirQuiet(tmpDir)
  }
}

function punchShotTypes(
  cuts: Array<{ start: number; end: number }>,
): Array<'wide' | 'close'> {
  return cuts.map((_, i) => (i % 2 === 0 ? 'wide' : 'close'))
}

function targetFrame(
  aspect: '9:16' | '1:1' | '16:9' | undefined,
  fast: boolean,
) {
  if (aspect === '1:1') return fast ? { w: 720, h: 720 } : { w: 1080, h: 1080 }
  if (aspect === '16:9') return fast ? { w: 1280, h: 720 } : { w: 1920, h: 1080 }
  return fast ? { w: 720, h: 1280 } : { w: 1080, h: 1920 }
}

function cropAround(fx: number, fy: number) {
  const x = fx.toFixed(3)
  const y = fy.toFixed(3)
  return `max(0\\,min(iw-ow\\,iw*${x}-ow/2)):max(0\\,min(ih-oh\\,ih*${y}-oh/2))`
}

/**
 * Cover-crop to the output frame.
 * Portrait phone clips already show the whole scene — keep them wide.
 * Close shots are a light punch (not a tight face crop).
 */
function motionScaleCrop(
  index: number,
  duration: number,
  motion: ClipMotion,
  w: number,
  h: number,
  focus: SubjectFocus,
  shot: 'wide' | 'close',
  portrait: boolean,
) {
  const cover = `scale=${w}:${h}:force_original_aspect_ratio=increase:flags=fast_bilinear`

  const apply = (zoom: number, fx: number, fy: number) => {
    const crop = `crop=${w}:${h}:${cropAround(fx, fy)}`
    if (zoom <= 1.01) return `${cover},${crop},setsar=1`
    return `${cover},scale=iw*${zoom}:ih*${zoom}:flags=fast_bilinear,${crop},setsar=1`
  }

  if (motion === 'none') return apply(1, 0.5, 0.5)

  // Portrait source: overall = the original 9:16 frame. Do not pan.
  if (portrait) {
    if (motion === 'zoom-in') return apply(1.12, 0.5, 0.5)
    if (motion === 'zoom-out') return apply(1, 0.5, 0.5)
    if (motion === 'ken-burns') return apply(1.08, 0.5, 0.5)
    if (motion === 'fade') {
      const fade = Math.min(0.28, Math.max(0.25, duration) * 0.25).toFixed(2)
      const base = apply(1, 0.5, 0.5)
      return index === 0 ? base : `${base},fade=t=in:st=0:d=${fade}`
    }
    return shot === 'wide' ? apply(1, 0.5, 0.5) : apply(1.04, 0.5, 0.46)
  }

  const speaker = {
    x: Math.min(0.78, Math.max(0.22, focus.x)),
    y: Math.min(0.55, Math.max(0.35, focus.y)),
  }
  const scene = {
    x: speaker.x * 0.35 + 0.5 * 0.65,
    y: 0.5,
  }

  if (motion === 'zoom-in') return apply(1.12, speaker.x, 0.5)
  if (motion === 'zoom-out') return apply(1, scene.x, 0.5)
  if (motion === 'punch') {
    return shot === 'wide' ? apply(1, scene.x, 0.5) : apply(1.12, speaker.x, 0.5)
  }
  if (motion === 'ken-burns') return apply(1.1, speaker.x, 0.5)
  if (motion === 'fade') {
    const fade = Math.min(0.28, Math.max(0.25, duration) * 0.25).toFixed(2)
    const base = apply(1, scene.x, 0.5)
    return index === 0 ? base : `${base},fade=t=in:st=0:d=${fade}`
  }
  return apply(1, scene.x, 0.5)
}

function writeConcatList(listPath: string, files: string[]) {
  const body = files
    .map((file) => {
      const escaped = file.replace(/\\/g, '/').replace(/'/g, "'\\''")
      return `file '${escaped}'`
    })
    .join('\n')
  fs.writeFileSync(listPath, `${body}\n`, 'utf8')
}

function unlinkQuiet(filePath?: string) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

function removeDirQuiet(dirPath: string) {
  try {
    fs.rmSync(dirPath, { recursive: true, force: true })
  } catch {
    /* ignore */
  }
}

async function concatCopy(files: string[], outputPath: string) {
  const listPath = `${outputPath}.concat.txt`
  writeConcatList(listPath, files)
  try {
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-nostats',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c',
      'copy',
      '-movflags',
      '+faststart',
      outputPath,
    ])
  } catch {
    await runFfmpeg([
      '-y',
      '-hide_banner',
      '-nostats',
      '-f',
      'concat',
      '-safe',
      '0',
      '-i',
      listPath,
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      '28',
      '-pix_fmt',
      'yuv420p',
      '-c:a',
      'aac',
      '-b:a',
      '96k',
      '-movflags',
      '+faststart',
      '-threads',
      '0',
      outputPath,
    ])
  } finally {
    unlinkQuiet(listPath)
  }
}

/**
 * Seek each keep-segment independently, then concat.
 * `-ss` before `-i` skips unused footage instead of decoding the whole file.
 */
async function renderSeekedBatch(input: {
  inputPath: string
  outputPath: string
  cuts: Array<{ start: number; end: number; speed: number }>
  motion: ClipMotion
  indexOffset: number
  w: number
  h: number
  fps: number | null
  useAudio: boolean
  crf: string
  focuses: SubjectFocus[]
  shots: Array<'wide' | 'close'>
  portrait: boolean
}) {
  const args = ['-y', '-hide_banner', '-nostats']
  for (const cut of input.cuts) {
    args.push(
      '-noaccurate_seek',
      '-ss',
      cut.start.toFixed(3),
      '-t',
      Math.max(0.05, cut.end - cut.start).toFixed(3),
      '-i',
      input.inputPath,
    )
  }

  const filters: string[] = []
  const concatInputs: string[] = []
  const fpsPrefix = input.fps ? `fps=${input.fps},` : ''

  input.cuts.forEach((cut, i) => {
    const spd = cut.speed
    const dur = Math.max(0.2, (cut.end - cut.start) / spd)
    const globalIndex = input.indexOffset + i
    const focus = input.focuses[globalIndex] ?? { x: 0.5, y: 0.45 }
    const shot = input.shots[globalIndex] ?? (globalIndex % 2 === 0 ? 'wide' : 'close')
    const pts = spd === 1 ? 'setpts=PTS-STARTPTS' : `setpts=(PTS-STARTPTS)/${spd}`
    filters.push(
      `[${i}:v]${pts},${fpsPrefix}${motionScaleCrop(globalIndex, dur, input.motion, input.w, input.h, focus, shot, input.portrait)}[v${i}]`,
    )
    if (input.useAudio) {
      const audio =
        spd === 1
          ? `[${i}:a]asetpts=PTS-STARTPTS,aresample=44100:async=1[a${i}]`
          : `[${i}:a]asetpts=PTS-STARTPTS,atempo=${spd.toFixed(3)},aresample=44100:async=1[a${i}]`
      filters.push(audio)
      concatInputs.push(`[v${i}][a${i}]`)
    } else {
      concatInputs.push(`[v${i}]`)
    }
  })

  const n = input.cuts.length
  const filterComplex = input.useAudio
    ? `${filters.join(';')};${concatInputs.join('')}concat=n=${n}:v=1:a=1[vout][aout]`
    : `${filters.join(';')};${concatInputs.join('')}concat=n=${n}:v=1:a=0[vout]`

  args.push('-filter_complex', filterComplex, '-map', '[vout]')
  if (input.useAudio) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-ar', '44100', '-ac', '1', '-b:a', '96k')
  } else {
    args.push('-an')
  }
  args.push(
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    input.crf,
    '-pix_fmt',
    'yuv420p',
    '-movflags',
    '+faststart',
    '-threads',
    '0',
    input.outputPath,
  )

  await runFfmpeg(args)
}

/**
 * Cut keep-segments from a video and concatenate into one MP4.
 * Optional per-segment `speed` (>1 = faster) for SOW speed-ramp.
 * Optional punch/zoom motion so jump cuts match social-style transitions.
 */
export async function renderJumpCutVideo(input: {
  inputPath: string
  outputPath: string
  cuts: Array<{ start: number; end: number; speed?: number }>
  keepAudio: boolean
  motion?: ClipMotion
  aspectRatio?: '9:16' | '1:1' | '16:9'
}): Promise<void> {
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })

  const hasAudio = await probeHasAudio(input.inputPath)
  const useAudio = input.keepAudio && hasAudio
  const motion = input.motion ?? 'none'

  const cuts = input.cuts
    .map((c) => ({
      start: Math.max(0, c.start),
      end: Math.max(c.start + 0.05, c.end),
      speed: Math.min(2, Math.max(0.5, c.speed && c.speed > 0 ? c.speed : 1)),
    }))
    .filter((c) => c.end > c.start)

  if (!cuts.length) {
    await runFfmpeg(['-y', '-i', input.inputPath, '-c', 'copy', input.outputPath])
    return
  }

  const sourceEnd = cuts[cuts.length - 1].end
  const keepSeconds = cuts.reduce((sum, c) => sum + (c.end - c.start) / c.speed, 0)
  const longForm = sourceEnd > 90 || keepSeconds > 75
  const { w, h } = targetFrame(input.aspectRatio, env.fastExport || longForm)
  const fps = longForm ? 30 : null
  const crf = env.fastExport || longForm ? '28' : '26'
  const batchSize = 8
  const applyMotion = motion !== 'none'
  const display = await probeDisplaySize(input.inputPath)
  const portrait = display.portrait
  const focuses =
    applyMotion && !portrait
      ? await detectCutFocuses(input.inputPath, cuts)
      : cuts.map(() => ({ x: 0.5, y: 0.45 }))
  const shots = punchShotTypes(cuts)

  const batchInput = {
    inputPath: input.inputPath,
    motion,
    w,
    h,
    fps,
    useAudio,
    crf,
    focuses,
    shots,
    portrait,
  }

  if (cuts.length <= batchSize) {
    await renderSeekedBatch({
      ...batchInput,
      outputPath: input.outputPath,
      cuts,
      indexOffset: 0,
    })
    return
  }

  const tmpDir = path.join(
    path.dirname(input.outputPath),
    `._jump-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  )
  fs.mkdirSync(tmpDir, { recursive: true })
  const parts: string[] = []

  try {
    for (let i = 0; i < cuts.length; i += batchSize) {
      const slice = cuts.slice(i, i + batchSize)
      const partPath = path.join(tmpDir, `b${String(i).padStart(4, '0')}.mp4`)
      await renderSeekedBatch({
        ...batchInput,
        outputPath: partPath,
        cuts: slice,
        indexOffset: i,
      })
      parts.push(partPath)
    }
    await concatCopy(parts, input.outputPath)
  } finally {
    removeDirQuiet(tmpDir)
  }
}
