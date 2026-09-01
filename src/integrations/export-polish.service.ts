import { execFile } from 'child_process'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { promisify } from 'util'
import { env } from '../config'
import type { ProjectOptionsDto } from '../modules/project/project.types'
import { FFMPEG, probeDuration, probeHasAudio } from './ffmpeg'
import {
  assFontSizeFromUi,
  parseSrtFile,
  writeAssFile,
} from './timed-edit'

const execFileAsync = promisify(execFile)

function captionFontName(family: ProjectOptionsDto['captionFontFamily']) {
  switch (family) {
    case 'impact':
      return 'Impact'
    case 'georgia':
      return 'Georgia'
    case 'verdana':
      return 'Verdana'
    case 'comic-sans':
      return 'Comic Sans MS'
    case 'courier':
      return 'Courier New'
    case 'segoe':
      return 'Segoe UI'
    default:
      return 'Arial'
  }
}

function captionAssColor(color: ProjectOptionsDto['captionColor']) {
  switch (color) {
    case 'yellow':
      return '&H0000FFFF'
    case 'black':
      return '&H00000000'
    case 'cyan':
      return '&H00FFFF00'
    default:
      return '&H00FFFFFF'
  }
}

function captionCssColor(color: ProjectOptionsDto['captionColor']) {
  switch (color) {
    case 'yellow':
      return '#facc15'
    case 'black':
      return 'black'
    case 'cyan':
      return '#22d3ee'
    default:
      return 'white'
  }
}

function captionStyle(options: ProjectOptionsDto) {
  return {
    fontName: captionFontName(options.captionFontFamily),
    fontSize: options.captionFontSize ?? 18,
    assColor: captionAssColor(options.captionColor),
    cssColor: captionCssColor(options.captionColor),
    outline: options.captionColor === 'black' ? '&H00FFFFFF' : '&H80000000',
  }
}

function escapeDrawText(text: string) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
    .replace(/%/g, '\\%')
    .slice(0, 80)
}

function targetSize(aspect: ProjectOptionsDto['aspectRatio']) {
  // Prefer 720p on FAST_EXPORT for much faster VPS encodes
  if (env.fastExport) {
    if (aspect === '1:1') return { w: 720, h: 720 }
    if (aspect === '16:9') return { w: 1280, h: 720 }
    return { w: 720, h: 1280 }
  }
  if (aspect === '1:1') return { w: 1080, h: 1080 }
  if (aspect === '16:9') return { w: 1920, h: 1080 }
  return { w: 1080, h: 1920 }
}

function assStyleFromOptions(options: ProjectOptionsDto) {
  return {
    fontName: captionFontName(options.captionFontFamily),
    fontSize: assFontSizeFromUi(options.captionFontSize ?? 22),
    primaryColour: captionAssColor(options.captionColor),
    alignment: options.captionPosition === 'top' ? 8 : 2,
    marginV: options.captionPosition === 'top' ? 90 : 80,
  }
}

function materializeAssCaptions(
  captionsPath: string,
  options: ProjectOptionsDto,
  tag: string,
) {
  const assPath = path.join(os.tmpdir(), `clipai-${tag}-${Date.now()}.ass`)
  if (captionsPath.toLowerCase().endsWith('.ass')) {
    fs.copyFileSync(captionsPath, assPath)
    return assPath
  }
  writeAssFile(parseSrtFile(captionsPath), assPath, assStyleFromOptions(options))
  return assPath
}

function speedFactor(level: ProjectOptionsDto['speedRamp']) {
  switch (level) {
    case 'light':
      return 1.1
    case 'medium':
      return 1.25
    case 'aggressive':
      return 1.45
    default:
      return 1
  }
}

function cropZoom(
  preset: ProjectOptionsDto['cropPreset'],
  keyframing: boolean,
  keyframePreset: ProjectOptionsDto['keyframePreset'],
) {
  let zoom = 1
  if (preset === 'center') zoom = 1.08
  if (preset === 'tight') zoom = 1.22
  if (preset === 'top' || preset === 'bottom') zoom = 1.12

  if (keyframing) {
    if (keyframePreset === 'speaker-punch-in') zoom = Math.max(zoom, 1.18)
    if (keyframePreset === 'product-reveal-zoom') zoom = Math.max(zoom, 1.15)
    if (keyframePreset === 'slow-zoom-in') zoom = Math.max(zoom, 1.12)
    if (keyframePreset === 'slow-zoom-out') zoom = Math.max(zoom, 1.06)
  }

  return zoom
}

function gradeFilter(grade: ProjectOptionsDto['colorGrade']) {
  switch (grade) {
    case 'clean':
      return 'eq=contrast=1.05:brightness=0.02:saturation=1.05'
    case 'warm':
      return 'eq=contrast=1.06:saturation=1.12'
    case 'cool':
      return 'eq=contrast=1.05:saturation=1.08'
    case 'vivid':
      return 'eq=contrast=1.12:saturation=1.28:brightness=0.01'
    default:
      return ''
  }
}

function cropYExpr(preset: ProjectOptionsDto['cropPreset']) {
  if (preset === 'top') return '0'
  if (preset === 'bottom') return 'ih-oh'
  return '(ih-oh)/2'
}

/**
 * ClipAI-built polish pass (no third-party API keys).
 */
export async function applyExportPolish(input: {
  inputPath: string
  outputPath: string
  options: ProjectOptionsDto
  title?: string
  captionLine?: string
  captionsPath?: string
  /** When true, skip whole-video speed (already applied per segment). */
  segmentSpeedApplied?: boolean
  durationSeconds?: number
}): Promise<{ notes: string[]; durationSeconds: number }> {
  const notes: string[] = ['ClipAI studio polish (local FFmpeg)']
  const options = input.options
  const duration =
    input.durationSeconds && input.durationSeconds > 0
      ? input.durationSeconds
      : await probeDuration(input.inputPath)

  const { w, h } = targetSize(options.aspectRatio)
  notes.push(`Aspect ${options.aspectRatio} → ${w}x${h}`)

  const zoom = cropZoom(
    options.cropPreset,
    options.keyframing,
    options.keyframePreset,
  )
  if (options.cropPreset !== 'none' || zoom > 1.01) {
    notes.push(
      options.keyframing
        ? `Crop/zoom ${zoom.toFixed(2)}x (${options.keyframePreset})`
        : `Crop ${options.cropPreset}`,
    )
  }

  const vf: string[] = [
    `scale=${w}:${h}:force_original_aspect_ratio=increase`,
    `crop=${w}:${h}:(iw-ow)/2:${cropYExpr(options.cropPreset)}`,
  ]

  if (zoom > 1.01) {
    const zw = Math.max(2, Math.round(w / zoom) & ~1)
    const zh = Math.max(2, Math.round(h / zoom) & ~1)
    vf.push(`crop=${zw}:${zh}:(iw-ow)/2:(ih-oh)/2`, `scale=${w}:${h}`)
  }

  if (options.mirrorHorizontal) {
    vf.push('hflip')
    notes.push('Mirror horizontal')
  }

  const grade = gradeFilter(options.colorGrade)
  if (grade) {
    vf.push(grade)
    notes.push(`Color grade: ${options.colorGrade}`)
  }

  if (options.fadeInOut && duration > 1.2) {
    const fade = Math.min(0.45, duration / 6)
    vf.push(`fade=t=in:st=0:d=${fade.toFixed(2)}`)
    vf.push(
      `fade=t=out:st=${Math.max(0, duration - fade).toFixed(2)}:d=${fade.toFixed(2)}`,
    )
    notes.push('Fade in/out')
  }

  const hasTimedCaptions =
    Boolean(options.captions && input.captionsPath) &&
    fs.existsSync(input.captionsPath ?? '')

  let timedAssPath: string | undefined
  if (hasTimedCaptions && input.captionsPath) {
    timedAssPath = materializeAssCaptions(input.captionsPath, options, 'polish')
    vf.push(subtitlesFilter(timedAssPath))
    notes.push(
      `Timed speech captions burned in (${options.captionPosition}, ${options.captionFontFamily} ${options.captionFontSize})`,
    )
  } else {
    const overlayLines: string[] = []
    if (options.introTitleCard && input.title?.trim()) {
      overlayLines.push(input.title.trim())
      notes.push('Intro title card')
    }
    if (options.captions) {
      const line =
        input.captionLine?.trim() ||
        (input.title ? input.title.trim().slice(0, 60) : '')
      if (line) {
        const already = overlayLines[0] === line
        if (!already) {
          overlayLines.push(line)
          notes.push(`Caption burn-in (${options.captionPosition})`)
        } else if (!options.introTitleCard) {
          notes.push(`Caption burn-in (${options.captionPosition})`)
        }
      }
    }

    const style = captionStyle(options)
    for (let i = 0; i < overlayLines.length; i++) {
      const text = escapeDrawText(overlayLines[i])
      const isTitle = Boolean(options.introTitleCard && i === 0)
      const yBase = options.captionPosition === 'top' ? 0.1 : 0.86
      const y = `h*${(yBase + i * 0.06).toFixed(2)}`
      const enable = isTitle ? `:enable='lt(t,2.2)'` : ''
      vf.push(
        `drawtext=text='${text}':font='${style.fontName}':fontsize=${isTitle ? Math.max(34, style.fontSize + 8) : style.fontSize}:fontcolor=${style.cssColor}:borderw=3:bordercolor=black@0.65:x=(w-text_w)/2:y=${y}${enable}`,
      )
    }
  }

  // Intro title still useful even with timed captions
  if (hasTimedCaptions && options.introTitleCard && input.title?.trim()) {
    const text = escapeDrawText(input.title.trim())
    vf.push(
      `drawtext=text='${text}':fontsize=34:fontcolor=white:borderw=3:bordercolor=black@0.65:x=(w-text_w)/2:y=h*0.08:enable='lt(t,2.2)'`,
    )
    notes.push('Intro title card')
  }

  const speed = input.segmentSpeedApplied
    ? 1
    : speedFactor(options.speedRamp)
  if (speed !== 1) {
    vf.push(`setpts=${(1 / speed).toFixed(4)}*PTS`)
    notes.push(`Playback speed ${speed.toFixed(2)}x`)
  } else if (input.segmentSpeedApplied) {
    notes.push('Whole-video speed skipped (segment ramp already applied)')
  }

  const hasAudio = await probeHasAudio(input.inputPath)
  const af: string[] = []
  let mapAudio = false

  if (options.keepAudio && hasAudio) {
    mapAudio = true
    if (speed !== 1) {
      let remaining = speed
      while (remaining > 2.001) {
        af.push('atempo=2.0')
        remaining /= 2
      }
      af.push(`atempo=${remaining.toFixed(3)}`)
    }
    if (options.audioNormalize && !env.fastExport) {
      af.push('loudnorm=I=-16:TP=-1.5:LRA=11')
      notes.push('Audio normalize')
    }
    if (options.fadeInOut && duration > 1.2) {
      const fade = Math.min(0.45, duration / 6)
      const outStart = Math.max(0, duration / speed - fade)
      af.push(`afade=t=in:st=0:d=${fade.toFixed(2)}`)
      af.push(`afade=t=out:st=${outStart.toFixed(2)}:d=${fade.toFixed(2)}`)
    }
  } else {
    notes.push(options.keepAudio ? 'No source audio' : 'Audio muted')
  }

  fs.mkdirSync(path.dirname(input.outputPath), { recursive: true })

  const buildArgs = (videoFilters: string[], audioFilters: string[]) => {
    const args = ['-y', '-i', input.inputPath, '-vf', videoFilters.join(',')]
    if (mapAudio) {
      if (audioFilters.length) args.push('-af', audioFilters.join(','))
      args.push('-c:a', 'aac', '-b:a', '128k')
    } else {
      args.push('-an')
    }
    args.push(
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-crf',
      env.fastExport ? '28' : '26',
      '-movflags',
      '+faststart',
      '-pix_fmt',
      'yuv420p',
      '-threads',
      '0',
      input.outputPath,
    )
    return args
  }

  try {
    try {
      await execFileAsync(FFMPEG, buildArgs(vf, af), {
        maxBuffer: 30 * 1024 * 1024,
      })
    } catch (error) {
      notes.push(
        `Polish retry (simplified): ${
          error instanceof Error ? error.message.slice(0, 120) : 'ffmpeg error'
        }`,
      )
      const simpleVf = vf.filter(
        (f) => !f.startsWith('drawtext=') && !f.startsWith('subtitles='),
      )
      const simpleAf = af.filter((f) => !f.startsWith('loudnorm'))
      await execFileAsync(FFMPEG, buildArgs(simpleVf, simpleAf), {
        maxBuffer: 30 * 1024 * 1024,
      })
    }
  } finally {
    if (timedAssPath) {
      try {
        fs.unlinkSync(timedAssPath)
      } catch {
        /* ignore */
      }
    }
  }

  const outDur = await probeDuration(input.outputPath)
  notes.push(`Polished export ~${outDur.toFixed(1)}s`)

  return { notes, durationSeconds: outDur || duration / speed }
}

export function makeTempSibling(filePath: string, tag: string) {
  const dir = path.dirname(filePath)
  const base = path.basename(filePath, path.extname(filePath))
  return path.join(dir, `${base}.${tag}.mp4`)
}

function subtitlesFilter(captionsPath: string) {
  const escaped = captionsPath
    .replace(/\\/g, '/')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\\'")
  return `subtitles='${escaped}'`
}

/** Burn timed captions onto a cut when full studio polish is skipped. */
export async function burnTimedCaptions(input: {
  inputPath: string
  outputPath: string
  captionsPath: string
  options: ProjectOptionsDto
}): Promise<void> {
  const tmpAss = materializeAssCaptions(input.captionsPath, input.options, 'cap')
  try {
    await execFileAsync(
      FFMPEG,
      [
        '-y',
        '-hide_banner',
        '-nostats',
        '-i',
        input.inputPath,
        '-vf',
        subtitlesFilter(tmpAss),
        '-c:v',
        'libx264',
        '-preset',
        'ultrafast',
        '-crf',
        env.fastExport ? '28' : '26',
        '-pix_fmt',
        'yuv420p',
        '-c:a',
        'copy',
        '-movflags',
        '+faststart',
        '-threads',
        '0',
        input.outputPath,
      ],
      { maxBuffer: 30 * 1024 * 1024, timeout: 25 * 60 * 1000 },
    )
  } finally {
    try {
      fs.unlinkSync(tmpAss)
    } catch {
      /* ignore */
    }
  }
}
