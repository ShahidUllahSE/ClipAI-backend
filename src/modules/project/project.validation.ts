import { z } from 'zod'
import {
  ASPECT_RATIOS,
  CAPTION_POSITIONS,
  COLOR_GRADES,
  CROP_PRESETS,
  EDITING_MODES,
  KEYFRAME_PRESETS,
  PACING_LEVELS,
  SILENCE_LEVELS,
  SPEED_RAMPS,
} from '../../constants/projects'

export const projectOptionsSchema = z.object({
  captions: z.boolean(),
  captionPosition: z.enum(CAPTION_POSITIONS),
  aspectRatio: z.enum(ASPECT_RATIOS),
  silenceSensitivity: z.enum(SILENCE_LEVELS),
  pacing: z.enum(PACING_LEVELS),
  speedRamp: z.enum(SPEED_RAMPS),
  keyframing: z.boolean(),
  keyframePreset: z.enum(KEYFRAME_PRESETS),
  keepAudio: z.boolean(),
  audioNormalize: z.boolean(),
  cropPreset: z.enum(CROP_PRESETS).default('none'),
  colorGrade: z.enum(COLOR_GRADES).default('clean'),
  fadeInOut: z.boolean().default(true),
  mirrorHorizontal: z.boolean().default(false),
  introTitleCard: z.boolean().default(true),
})

export const createProjectSchema = z
  .object({
    uploadId: z.string().min(1),
    secondaryUploadId: z.string().min(1).optional(),
    mode: z.enum(EDITING_MODES),
    options: projectOptionsSchema,
    title: z.string().trim().max(120).optional(),
    durationSeconds: z.number().min(0).max(20 * 60).optional(),
  })
  .superRefine((data, ctx) => {
    if (data.mode === 'ai-combine' && !data.secondaryUploadId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'AI Combine requires a second video (secondaryUploadId).',
        path: ['secondaryUploadId'],
      })
    }
  })

export const updateProjectSchema = z
  .object({
    title: z.string().trim().min(1).max(120).optional(),
    generatedTitle: z.string().trim().min(1).max(120).optional(),
    outputFilename: z.string().trim().min(1).max(160).optional(),
  })
  .refine((data) => Object.keys(data).length > 0, {
    message: 'Nothing to update.',
  })
