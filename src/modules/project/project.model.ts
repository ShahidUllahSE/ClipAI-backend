import { Schema, model, type Document, type InferSchemaType } from 'mongoose'
import {
  ASPECT_RATIOS,
  CAPTION_COLORS,
  CAPTION_FONT_FAMILIES,
  CAPTION_FONT_SIZES,
  CAPTION_POSITIONS,
  COLOR_GRADES,
  CROP_PRESETS,
  EDITING_MODES,
  KEYFRAME_PRESETS,
  PACING_LEVELS,
  PROJECT_STATUSES,
  SILENCE_LEVELS,
  SPEED_RAMPS,
} from '../../constants/projects'

const optionsSchema = {
  captions: { type: Boolean, default: true },
  captionPosition: { type: String, enum: CAPTION_POSITIONS, default: 'bottom' },
  captionFontFamily: {
    type: String,
    enum: CAPTION_FONT_FAMILIES,
    default: 'arial',
  },
  captionFontSize: {
    type: Number,
    enum: CAPTION_FONT_SIZES,
    default: 22,
  },
  captionColor: { type: String, enum: CAPTION_COLORS, default: 'white' },
  aspectRatio: { type: String, enum: ASPECT_RATIOS, default: '9:16' },
  silenceSensitivity: {
    type: String,
    enum: SILENCE_LEVELS,
    default: 'medium',
  },
  pacing: { type: String, enum: PACING_LEVELS, default: 'fast' },
  speedRamp: { type: String, enum: SPEED_RAMPS, default: 'light' },
  keyframing: { type: Boolean, default: true },
  keyframePreset: {
    type: String,
    enum: KEYFRAME_PRESETS,
    default: 'speaker-punch-in',
  },
  keepAudio: { type: Boolean, default: true },
  audioNormalize: { type: Boolean, default: true },
  cropPreset: { type: String, enum: CROP_PRESETS, default: 'none' },
  colorGrade: { type: String, enum: COLOR_GRADES, default: 'clean' },
  fadeInOut: { type: Boolean, default: true },
  mirrorHorizontal: { type: Boolean, default: false },
  introTitleCard: { type: Boolean, default: true },
  timelineJson: { type: Schema.Types.Mixed, default: null },
}

const projectSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    uploadId: {
      type: Schema.Types.ObjectId,
      ref: 'Upload',
      required: true,
    },
    secondaryUploadId: {
      type: Schema.Types.ObjectId,
      ref: 'Upload',
      required: false,
      default: null,
    },
    title: { type: String, required: true, trim: true },
    originalFilename: { type: String, required: true },
    fileSize: { type: Number, required: true },
    durationSeconds: { type: Number, required: true },
    mimeType: { type: String, required: true },
    mode: { type: String, enum: EDITING_MODES, required: true },
    options: { type: optionsSchema, default: () => ({}) },
    status: {
      type: String,
      enum: PROJECT_STATUSES,
      default: 'Uploaded',
      index: true,
    },
    generatedTitle: { type: String, required: true },
    outputFilename: { type: String, required: true },
    sourceUrl: { type: String, required: true },
    outputUrl: { type: String, default: '' },
    errorMessage: { type: String, default: '' },
    progressPercent: { type: Number, default: 0 },
    progressNote: { type: String, default: '' },
    analysis: { type: Schema.Types.Mixed, default: null },
    editPlan: { type: Schema.Types.Mixed, default: null },
    creditCharged: { type: Boolean, default: false },
  },
  { timestamps: true, versionKey: false },
)

projectSchema.index({ userId: 1, createdAt: -1 })

export type ProjectDocument = Document & InferSchemaType<typeof projectSchema>
export const ProjectModel = model<ProjectDocument>('Project', projectSchema)
