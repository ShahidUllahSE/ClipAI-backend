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

export async function detectSilenceRanges(
  filePath: string,
  level: SilenceSensitivity = 'medium',
): Promise<Array<{ start: number; end: number }>> {
  try {
    const { stderr } = await execFileAsync(FFMPEG, [
      '-hide_banner',
      '-i',
      filePath,
      '-af',
      silenceFilter(level),
      '-f',
      'null',
      '-',
    ])
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
  await execFileAsync(FFMPEG, [
    '-y',
    '-i',
    inputPath,
    '-vn',
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

/**
 * Cut keep-segments from a video and concatenate into one MP4.
 * Optional per-segment `speed` (>1 = faster) for SOW speed-ramp.
 */
export async function renderJumpCutVideo(input: {
  inputPath: string
  outputPath: string
  cuts: Array<{ start: number; end: number; speed?: number }>
  keepAudio: boolean
}): Promise<void> {
  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })

  const hasAudio = await probeHasAudio(input.inputPath)
  const useAudio = input.keepAudio && hasAudio

  const cuts = input.cuts
    .map((c) => ({
      start: Math.max(0, c.start),
      end: Math.max(c.start + 0.05, c.end),
      speed: Math.min(2, Math.max(0.5, c.speed && c.speed > 0 ? c.speed : 1)),
    }))
    .filter((c) => c.end > c.start)

  if (!cuts.length) {
    await execFileAsync(FFMPEG, [
      '-y',
      '-i',
      input.inputPath,
      '-c',
      'copy',
      input.outputPath,
    ])
    return
  }

  const limited = cuts.slice(0, env.fastExport ? 18 : 28)
  const filters: string[] = []
  const concatInputs: string[] = []

  limited.forEach((cut, i) => {
    const spd = cut.speed
    filters.push(
      `[0:v]trim=start=${cut.start}:end=${cut.end},setpts=(PTS-STARTPTS)/${spd}[v${i}]`,
    )
    if (useAudio) {
      // atempo supports 0.5–2.0; our speeds stay in range
      filters.push(
        `[0:a]atrim=start=${cut.start}:end=${cut.end},asetpts=PTS-STARTPTS,atempo=${spd.toFixed(3)}[a${i}]`,
      )
      concatInputs.push(`[v${i}][a${i}]`)
    } else {
      concatInputs.push(`[v${i}]`)
    }
  })

  const n = limited.length
  const scaleOut = env.fastExport
    ? `;[vout]scale=-2:720:flags=fast_bilinear[vout2]`
    : ''
  const vOut = env.fastExport ? '[vout2]' : '[vout]'
  const filterComplex = useAudio
    ? `${filters.join(';')};${concatInputs.join('')}concat=n=${n}:v=1:a=1[vout][aout]${scaleOut}`
    : `${filters.join(';')};${concatInputs.join('')}concat=n=${n}:v=1:a=0[vout]${scaleOut}`

  const args = [
    '-y',
    '-i',
    input.inputPath,
    '-filter_complex',
    filterComplex,
    '-map',
    vOut,
  ]
  if (useAudio) {
    args.push('-map', '[aout]', '-c:a', 'aac', '-b:a', '96k')
  }
  args.push(
    '-movflags',
    '+faststart',
    '-c:v',
    'libx264',
    '-preset',
    'ultrafast',
    '-crf',
    env.fastExport ? '28' : '26',
    '-threads',
    '0',
    input.outputPath,
  )

  await execFileAsync(FFMPEG, args, { maxBuffer: 20 * 1024 * 1024 })
}
