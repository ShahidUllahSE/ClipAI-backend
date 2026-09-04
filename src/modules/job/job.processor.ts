import path from 'path'
import fs from 'fs'
import { env } from '../../config'
import type { ProjectStatus } from '../../constants/projects'
import { processTalkingHead } from '../../integrations/talking-head.service'
import { processAsmrUnboxing } from '../../integrations/asmr.service'
import {
  applyExportPolish,
  burnTimedCaptions,
  makeTempSibling,
} from '../../integrations/export-polish.service'
import { prepareExportCaptionsSrt } from '../../integrations/caption-transcribe.service'
import { probeDuration, type ClipMotion } from '../../integrations/ffmpeg'
import {
  planBeautifulCombine,
  renderHighlightCombine,
} from '../../integrations/ai-combine.service'
import { analyzeVideoUnderstanding } from '../../integrations/understanding.service'
import { generateProjectName } from '../../integrations/naming.service'
import { renderEditedVideo } from '../../integrations/render.service'
import { analyzeSpeech } from '../../integrations/speech.service'
import { UploadModel } from '../upload/upload.model'
import { userService } from '../user/user.service'
import { ProjectModel } from '../project/project.model'
import type { ProjectOptionsDto } from '../project/project.types'
import { JobModel } from './job.model'
import { buildEditPlan } from './edit-plan'
import {
  isCloudinaryEnabled,
  uploadLocalVideo,
} from '../../integrations/cloudinary.service'

async function publishOutputUrl(
  localPath: string,
  projectId: string,
  fallbackUrl: string,
  notes: string[],
): Promise<string> {
  if (!isCloudinaryEnabled()) return fallbackUrl
  try {
    const uploaded = await uploadLocalVideo({
      localPath,
      publicId: projectId,
      folder: 'clipai/outputs',
    })
    notes.push('Delivered via Cloudinary CDN')
    return uploaded.url
  } catch (error) {
    notes.push(
      `Cloudinary upload skipped: ${
        error instanceof Error ? error.message.slice(0, 120) : 'unknown'
      }`,
    )
    return fallbackUrl
  }
}

function normalizeOptions(raw: ProjectOptionsDto): ProjectOptionsDto {
  return {
    captions: raw.captions ?? true,
    captionPosition: raw.captionPosition ?? 'bottom',
    captionFontFamily: raw.captionFontFamily ?? 'arial',
    captionFontSize: raw.captionFontSize ?? 22,
    captionColor: raw.captionColor ?? 'white',
    aspectRatio: raw.aspectRatio ?? '9:16',
    silenceSensitivity: raw.silenceSensitivity ?? 'medium',
    pacing: raw.pacing ?? 'fast',
    speedRamp: raw.speedRamp ?? 'light',
    keyframing: raw.keyframing ?? true,
    keyframePreset: raw.keyframePreset ?? 'speaker-punch-in',
    keepAudio: raw.keepAudio ?? true,
    audioNormalize: raw.audioNormalize ?? true,
    cropPreset: raw.cropPreset ?? 'center',
    colorGrade: raw.colorGrade ?? 'clean',
    fadeInOut: raw.fadeInOut ?? true,
    mirrorHorizontal: raw.mirrorHorizontal ?? false,
    introTitleCard: raw.introTitleCard ?? true,
    timelineJson: raw.timelineJson ?? null,
  }
}

async function finalizeExport(input: {
  projectId: string
  cutPath: string
  outputPath: string
  options: ProjectOptionsDto
  title?: string
  captionLine?: string
  existingCaptionsPath?: string
  segmentSpeedApplied?: boolean
  durationSeconds: number
}): Promise<{ notes: string[]; durationSeconds: number; captionsPath?: string }> {
  const captionsPath = await prepareExportCaptionsSrt({
    enabled: input.options.captions,
    videoPath: input.cutPath,
    srtPath: path.join(
      path.dirname(input.outputPath),
      `${input.projectId}.captions.srt`,
    ),
    existingPath: input.existingCaptionsPath,
  })

  if (env.skipExportPolish || input.durationSeconds > 120) {
    if (captionsPath) {
      try {
        await burnTimedCaptions({
          inputPath: input.cutPath,
          outputPath: input.outputPath,
          captionsPath,
          options: input.options,
        })
        return {
          notes: [
            env.fastExport
              ? 'FAST_EXPORT: cut + burned captions'
              : input.durationSeconds > 120
                ? 'Long-form: skipped studio polish — burned captions'
                : 'Skipped studio polish — burned captions',
          ],
          durationSeconds: input.durationSeconds,
          captionsPath,
        }
      } catch (error) {
        fs.copyFileSync(input.cutPath, input.outputPath)
        return {
          notes: [
            `Caption burn skipped: ${
              error instanceof Error ? error.message.slice(0, 120) : 'ffmpeg error'
            }`,
          ],
          durationSeconds: input.durationSeconds,
          captionsPath,
        }
      }
    }

    fs.copyFileSync(input.cutPath, input.outputPath)
    return {
      notes: [
        env.fastExport
          ? 'FAST_EXPORT: skipped studio polish (cut only)'
          : input.durationSeconds > 120
            ? 'Long-form: skipped studio polish (cut only)'
            : 'Skipped studio polish (SKIP_EXPORT_POLISH)',
      ],
      durationSeconds: input.durationSeconds,
    }
  }

  const polish = await applyExportPolish({
    inputPath: input.cutPath,
    outputPath: input.outputPath,
    options: input.options,
    title: input.title,
    captionLine: input.captionLine,
    captionsPath,
    segmentSpeedApplied: input.segmentSpeedApplied,
    durationSeconds: input.durationSeconds,
  })
  return { ...polish, captionsPath }
}

function unlinkQuiet(filePath?: string) {
  if (!filePath) return
  try {
    if (fs.existsSync(filePath)) fs.unlinkSync(filePath)
  } catch {
    /* ignore */
  }
}

function clipMotionFromTimeline(timelineJson: unknown): ClipMotion {
  const json = timelineJson as {
    timeline?: { transition?: { type?: string } | null }
    output?: { transition?: { type?: string } | null }
  } | null
  const type = json?.timeline?.transition?.type ?? json?.output?.transition?.type
  if (type === 'none') return 'none'
  if (
    type === 'zoom-in' ||
    type === 'zoom-out' ||
    type === 'ken-burns' ||
    type === 'fade' ||
    type === 'punch'
  ) {
    return type
  }
  if (type === 'flash' || type === 'blur') return 'punch'
  if (type === 'slide-left' || type === 'slide-right') return 'fade'
  return 'punch'
}

async function setStatus(
  projectId: string,
  jobId: string,
  status: ProjectStatus,
  note = '',
) {
  await Promise.all([
    ProjectModel.updateOne(
      { _id: projectId },
      { $set: { status, errorMessage: status === 'Failed' ? note : '' } },
    ),
    JobModel.updateOne(
      { _id: jobId },
      {
        $set: { status },
        $push: { steps: { status, at: new Date(), note } },
      },
    ),
  ])
}

export async function runJobPipeline(jobId: string, projectId: string) {
  const project = await ProjectModel.findById(projectId)
  const job = await JobModel.findById(jobId)
  if (!project || !job) return

  try {
    await setStatus(projectId, jobId, 'Queued', 'Job queued')
    await delay(200)

    // ——— AI Combine: Gemini vision picks beautiful moments + FFmpeg blend ———
    if (project.mode === 'ai-combine') {
      await setStatus(
        projectId,
        jobId,
        'Analyzing',
        'Sampling frames & finding beautiful moments',
      )

      const uploadA = await UploadModel.findById(project.uploadId)
      const uploadB = project.secondaryUploadId
        ? await UploadModel.findById(project.secondaryUploadId)
        : null

      if (!uploadA?.storagePath || !uploadB?.storagePath) {
        throw new Error('Both source videos are required for AI Combine.')
      }

      const options = normalizeOptions(
        project.options as unknown as ProjectOptionsDto,
      )

      const [durationA, durationB] = await Promise.all([
        probeDuration(uploadA.storagePath),
        probeDuration(uploadB.storagePath),
      ])

      const plan = await planBeautifulCombine({
        pathA: uploadA.storagePath,
        pathB: uploadB.storagePath,
        filenameA: uploadA.originalFilename,
        filenameB: uploadB.originalFilename,
        durationA: durationA || uploadA.durationSeconds || 1,
        durationB: durationB || uploadB.durationSeconds || 1,
      })

      await setStatus(
        projectId,
        jobId,
        'Preparing edit',
        `${plan.provider}: ${plan.clips.length} highlight moments`,
      )

      const outputName = `${project._id.toString()}.mp4`
      const outputPath = path.resolve(
        process.cwd(),
        env.UPLOAD_DIR,
        'outputs',
        outputName,
      )
      const outputUrl = `${env.PUBLIC_API_URL}/uploads/outputs/${outputName}`

      await setStatus(
        projectId,
        jobId,
        'Rendering',
        'Fast single-pass highlight render',
      )

      // Render straight to final path — skip slow second-pass polish for AI Combine.
      const [combine, naming] = await Promise.all([
        renderHighlightCombine({
          pathA: uploadA.storagePath,
          pathB: uploadB.storagePath,
          outputPath,
          plan,
          keepAudio: options.keepAudio,
        }),
        generateProjectName({
          originalFilename: project.originalFilename,
          mode: project.mode,
          summary: `${plan.titleHint}. ${plan.reason}`,
        }),
      ])

      const polishNotes = ['Skipped studio polish (AI Combine fast path)']
      const polishDuration = combine.outputDurationSeconds

      const allNotes = [
        ...combine.notes,
        plan.reason,
        plan.pacingNote,
        ...polishNotes,
      ]

      const deliveryUrl = await publishOutputUrl(
        outputPath,
        projectId,
        outputUrl,
        allNotes,
      )

      job.namingResult = naming
      job.renderResult = {
        provider: `gemini-vision+ffmpeg-fast`,
        outputUrl: deliveryUrl,
        status: 'done',
        message: allNotes.join(' | '),
      }
      await job.save()

      project.analysis = {
        combinePlan: plan,
        notes: allNotes,
        outputDurationSeconds: polishDuration,
      }
      project.editPlan = {
        mode: 'ai-combine',
        clips: plan.clips,
        notes: allNotes,
      }
      project.generatedTitle = naming.title || plan.titleHint
      project.title = naming.title || plan.titleHint
      project.outputFilename = naming.outputFilename
      project.durationSeconds = polishDuration

      if (!project.creditCharged) {
        await userService.useEditCredit(project.userId.toString())
        project.creditCharged = true
      }

      project.outputUrl = deliveryUrl
      project.status = 'Completed'
      project.errorMessage = ''
      await project.save()

      job.status = 'Completed'
      job.finishedAt = new Date()
      job.steps.push({
        status: 'Completed',
        at: new Date(),
        note: `AI Combine highlights via ${plan.provider} + fast FFmpeg`,
      })
      await job.save()
      return
    }

    // ——— Talking-head: real free FFmpeg pipeline ———
    if (project.mode === 'talking-head') {
      await setStatus(
        projectId,
        jobId,
        'Analyzing',
        'Detecting silence with FFmpeg',
      )

      const upload = await UploadModel.findById(project.uploadId)
      if (!upload?.storagePath || !fs.existsSync(upload.storagePath)) {
        throw new Error(
          'Source video is not on this server. Upload the file again from this site.',
        )
      }

      const options = normalizeOptions(
        project.options as unknown as ProjectOptionsDto,
      )
      const outputName = `${project._id.toString()}.mp4`
      const outputPath = path.resolve(
        process.cwd(),
        env.UPLOAD_DIR,
        'outputs',
        outputName,
      )
      const cutPath = makeTempSibling(outputPath, 'cut')
      const outputUrl = `${env.PUBLIC_API_URL}/uploads/outputs/${outputName}`

      await setStatus(
        projectId,
        jobId,
        'Preparing edit',
        'Building speech keep-segments',
      )

      await setStatus(projectId, jobId, 'Rendering', 'Cutting silence with FFmpeg')

      const result = await processTalkingHead({
        inputPath: upload.storagePath,
        outputPath: cutPath,
        outputUrl,
        silenceSensitivity: options.silenceSensitivity,
        keepAudio: options.keepAudio,
        speedRamp: options.speedRamp,
        captions: Boolean(options.captions),
        captionOptions: options,
        durationSeconds: project.durationSeconds,
        motion: clipMotionFromTimeline(options.timelineJson),
        aspectRatio: options.aspectRatio,
      })

      await setStatus(
        projectId,
        jobId,
        'Rendering',
        options.captions
          ? 'Adding captions to the export'
          : 'Applying ClipAI studio polish',
      )

      const naming = await generateProjectName({
        originalFilename: project.originalFilename,
        mode: project.mode,
        transcript: result.transcript,
        summary: result.notes.join('; '),
      })

      let polishNotes: string[] = []
      let polishDuration = result.outputDurationSeconds
      let exportCaptionsPath: string | undefined

      try {
        if (result.captionsBurned) {
          fs.copyFileSync(cutPath, outputPath)
          polishNotes = ['Talking-head cut with burned captions']
          polishDuration = result.outputDurationSeconds
          exportCaptionsPath = result.captionsPath
        } else if (options.captions && !result.captionsPath) {
          const captionsPath = await prepareExportCaptionsSrt({
            enabled: true,
            videoPath: cutPath,
            srtPath: path.join(
              path.dirname(outputPath),
              `${projectId}.captions.srt`,
            ),
          })
          if (captionsPath) {
            try {
              await burnTimedCaptions({
                inputPath: cutPath,
                outputPath,
                captionsPath,
                options,
              })
              polishNotes = [
                'Talking-head fallback kept the punch cuts and burned captions',
              ]
              exportCaptionsPath = captionsPath
            } catch (error) {
              fs.copyFileSync(cutPath, outputPath)
              polishNotes = [
                `Caption burn skipped: ${
                  error instanceof Error
                    ? error.message.slice(0, 120)
                    : 'ffmpeg error'
                }`,
              ]
              exportCaptionsPath = captionsPath
            }
          } else {
            fs.copyFileSync(cutPath, outputPath)
            polishNotes = [
              'Talking-head fallback kept the punch cuts; captions were unavailable',
            ]
          }
          polishDuration = result.outputDurationSeconds
        } else {
          const finalized = await finalizeExport({
            projectId,
            cutPath,
            outputPath,
            options: {
              ...options,
              aspectRatio: result.aspectRatio,
              // Jump-cut already framed the speaker. Extra 9:16 punch-in chops heads.
              cropPreset: 'none',
              keyframing: false,
            },
            title: naming.title,
            captionLine: result.transcript?.slice(0, 90),
            existingCaptionsPath: result.captionsPath,
            segmentSpeedApplied: result.segmentSpeedApplied,
            durationSeconds: result.outputDurationSeconds,
          })
          polishNotes = finalized.notes
          polishDuration = finalized.durationSeconds
          exportCaptionsPath = finalized.captionsPath
        }

        const outDur = await probeDuration(outputPath).catch(() => 0)
        if (!outDur || outDur < 0.4) {
          fs.copyFileSync(cutPath, outputPath)
          polishNotes.push(
            'Polish output unreadable — delivered edit cut instead',
          )
          polishDuration = result.outputDurationSeconds
        }
      } catch (polishError) {
        fs.copyFileSync(cutPath, outputPath)
        polishNotes = [
          `Polish failed — delivered edit cut: ${
            polishError instanceof Error
              ? polishError.message.slice(0, 140)
              : 'unknown'
          }`,
        ]
        polishDuration = result.outputDurationSeconds
      }

      unlinkQuiet(cutPath)
      unlinkQuiet(result.captionsPath)
      unlinkQuiet(exportCaptionsPath)

      const allNotes = [...result.notes, ...polishNotes]
      const polish = { notes: polishNotes, durationSeconds: polishDuration }

      const deliveryUrl = await publishOutputUrl(
        outputPath,
        projectId,
        outputUrl,
        allNotes,
      )

      job.speechResult = {
        provider: result.provider,
        transcript: result.transcript,
        words: result.words,
        silenceRanges: result.silenceRanges,
      }
      job.namingResult = naming
      job.renderResult = {
        provider: 'ffmpeg+clipai-polish',
        outputUrl: deliveryUrl,
        status: 'done',
        message: allNotes.join(' | '),
      }
      await job.save()

      project.analysis = {
        speech: job.speechResult,
        notes: allNotes,
        removedSeconds: result.removedSeconds,
        outputDurationSeconds: polish.durationSeconds,
      }
      project.editPlan = {
        cuts: result.cuts,
        captions: options.captions,
        aspectRatio: options.aspectRatio,
        keepAudio: options.keepAudio,
        notes: allNotes,
      }
      project.generatedTitle = naming.title
      project.title = naming.title
      project.outputFilename = naming.outputFilename
      if (result.durationSeconds > 0) {
        project.durationSeconds = result.durationSeconds
      }

      if (!project.creditCharged) {
        await userService.useEditCredit(project.userId.toString())
        project.creditCharged = true
      }

      project.outputUrl = deliveryUrl
      project.status = 'Completed'
      project.errorMessage = ''
      await project.save()

      job.status = 'Completed'
      job.finishedAt = new Date()
      job.steps.push({
        status: 'Completed',
        at: new Date(),
        note: `Talking-head via ${result.provider} + polish`,
      })
      await job.save()
      return
    }

    // ——— ASMR / unboxing: real free FFmpeg sound-peak pipeline ———
    if (project.mode === 'asmr') {
      await setStatus(
        projectId,
        jobId,
        'Analyzing',
        'Finding product sounds / quiet waits',
      )

      const upload = await UploadModel.findById(project.uploadId)
      if (!upload?.storagePath || !fs.existsSync(upload.storagePath)) {
        throw new Error(
          'Source video is not on this server. Upload the file again from this site.',
        )
      }

      const options = normalizeOptions(
        project.options as unknown as ProjectOptionsDto,
      )
      const outputName = `${project._id.toString()}.mp4`
      const outputPath = path.resolve(
        process.cwd(),
        env.UPLOAD_DIR,
        'outputs',
        outputName,
      )
      const cutPath = makeTempSibling(outputPath, 'cut')
      const outputUrl = `${env.PUBLIC_API_URL}/uploads/outputs/${outputName}`

      await setStatus(
        projectId,
        jobId,
        'Preparing edit',
        'Keeping sound & reveal moments',
      )
      await setStatus(
        projectId,
        jobId,
        'Rendering',
        'Cutting empty waits with FFmpeg',
      )

      const result = await processAsmrUnboxing({
        inputPath: upload.storagePath,
        outputPath: cutPath,
        outputUrl,
        originalFilename: project.originalFilename,
        silenceSensitivity: options.silenceSensitivity,
        pacing: options.pacing,
        keepAudio: options.keepAudio,
        speedRamp: options.speedRamp,
        durationSeconds: project.durationSeconds,
      })

      await setStatus(
        projectId,
        jobId,
        'Rendering',
        options.captions
          ? 'Adding captions to the export'
          : 'Applying ClipAI studio polish',
      )

      const naming = await generateProjectName({
        originalFilename: project.originalFilename,
        mode: project.mode,
        summary: result.summary,
      })

      let polishNotes: string[] = []
      let polishDuration = result.outputDurationSeconds
      let exportCaptionsPath: string | undefined

      try {
        const finalized = await finalizeExport({
          projectId,
          cutPath,
          outputPath,
          options,
          title: naming.title,
          captionLine: result.summary?.slice(0, 90),
          segmentSpeedApplied: result.segmentSpeedApplied,
          durationSeconds: result.outputDurationSeconds,
        })
        polishNotes = finalized.notes
        polishDuration = finalized.durationSeconds
        exportCaptionsPath = finalized.captionsPath

        const outDur = await probeDuration(outputPath).catch(() => 0)
        if (!outDur || outDur < 0.4) {
          fs.copyFileSync(cutPath, outputPath)
          polishNotes.push(
            'Polish output unreadable — delivered ASMR cut instead',
          )
          polishDuration = result.outputDurationSeconds
        }
      } catch (polishError) {
        fs.copyFileSync(cutPath, outputPath)
        polishNotes = [
          `Polish failed — delivered ASMR cut: ${
            polishError instanceof Error
              ? polishError.message.slice(0, 140)
              : 'unknown'
          }`,
        ]
        polishDuration = result.outputDurationSeconds
      }

      unlinkQuiet(cutPath)
      unlinkQuiet(exportCaptionsPath)

      const allNotes = [...result.notes, ...polishNotes]
      const polish = { notes: polishNotes, durationSeconds: polishDuration }

      const deliveryUrl = await publishOutputUrl(
        outputPath,
        projectId,
        outputUrl,
        allNotes,
      )

      job.understandingResult = {
        provider: result.provider,
        summary: result.summary,
        category: result.category,
        moments: result.cuts.map((c, i) => ({
          start: c.start,
          end: c.end,
          label: `ASMR moment ${i + 1}`,
          score: 1,
        })),
      }
      job.namingResult = naming
      job.renderResult = {
        provider: 'ffmpeg+clipai-polish',
        outputUrl: deliveryUrl,
        status: 'done',
        message: allNotes.join(' | '),
      }
      await job.save()

      project.analysis = {
        understanding: job.understandingResult,
        notes: allNotes,
        removedSeconds: result.removedSeconds,
        outputDurationSeconds: polish.durationSeconds,
      }
      project.editPlan = {
        cuts: result.cuts,
        captions: options.captions,
        aspectRatio: options.aspectRatio,
        keepAudio: options.keepAudio,
        notes: allNotes,
      }
      project.generatedTitle = naming.title
      project.title = naming.title
      project.outputFilename = naming.outputFilename
      if (result.durationSeconds > 0) {
        project.durationSeconds = result.durationSeconds
      }

      if (!project.creditCharged) {
        await userService.useEditCredit(project.userId.toString())
        project.creditCharged = true
      }

      project.outputUrl = deliveryUrl
      project.status = 'Completed'
      project.errorMessage = ''
      await project.save()

      job.status = 'Completed'
      job.finishedAt = new Date()
      job.steps.push({
        status: 'Completed',
        at: new Date(),
        note: `ASMR via ${result.provider} + polish`,
      })
      await job.save()
      return
    }

    // ——— Rapid-cut (and others): existing AI / mock path ———
    await setStatus(projectId, jobId, 'Analyzing', 'Running AI analysis')

    const speech = await analyzeSpeech({
      sourceUrl: project.sourceUrl,
      durationSeconds: project.durationSeconds,
    })
    const understanding = await analyzeVideoUnderstanding({
      mode: project.mode,
      originalFilename: project.originalFilename,
      durationSeconds: project.durationSeconds,
      transcript: speech.transcript,
    })

    const naming = await generateProjectName({
      originalFilename: project.originalFilename,
      mode: project.mode,
      transcript: speech.transcript,
      summary: understanding.summary,
    })

    job.speechResult = speech
    job.understandingResult = understanding
    job.namingResult = naming
    await job.save()

    await setStatus(projectId, jobId, 'Preparing edit', 'Building edit plan')
    const editPlan = buildEditPlan({
      mode: project.mode,
      options: project.options as unknown as ProjectOptionsDto,
      durationSeconds: project.durationSeconds,
      speech,
      understanding,
    })

    project.analysis = { speech, understanding }
    project.editPlan = editPlan
    project.generatedTitle = naming.title
    project.title = naming.title
    project.outputFilename = naming.outputFilename
    await project.save()

    await setStatus(projectId, jobId, 'Rendering', 'Rendering output MP4')
    const render = await renderEditedVideo({
      sourceUrl: project.sourceUrl,
      outputFilename: project.outputFilename,
      editPlan,
    })
    job.renderResult = render
    await job.save()

    if (render.status !== 'done') {
      throw new Error(render.message || 'Render failed')
    }

    if (!project.creditCharged) {
      await userService.useEditCredit(project.userId.toString())
      project.creditCharged = true
    }

    project.outputUrl = render.outputUrl
    project.status = 'Completed'
    project.errorMessage = ''
    await project.save()

    job.status = 'Completed'
    job.finishedAt = new Date()
    job.steps.push({
      status: 'Completed',
      at: new Date(),
      note: `Render via ${render.provider}`,
    })
    await job.save()
  } catch (error) {
    const message =
      error instanceof Error ? error.message : 'Processing failed.'
    console.error('[job]', projectId, message)
    await ProjectModel.updateOne(
      { _id: projectId },
      { $set: { status: 'Failed', errorMessage: message } },
    )
    await JobModel.updateOne(
      { _id: jobId },
      {
        $set: {
          status: 'Failed',
          errorMessage: message,
          finishedAt: new Date(),
        },
        $push: {
          steps: { status: 'Failed', at: new Date(), note: message },
        },
      },
    )
  }
}

function delay(ms: number) {
  return new Promise((r) => setTimeout(r, ms))
}
