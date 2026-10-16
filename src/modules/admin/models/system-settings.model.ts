import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const systemSettingsSchema = new Schema(
  {
    key: { type: String, required: true, unique: true, default: 'global' },
    appName: { type: String, default: 'ClipAI' },
    supportEmail: { type: String, default: 'support@clipai.dev' },
    announcementBanner: { type: String, default: '' },
    maintenanceMode: { type: Boolean, default: false },
    allowSignups: { type: Boolean, default: true },
    maxUploadMb: { type: Number, default: 500, min: 1 },
    maxDurationSeconds: { type: Number, default: 1800, min: 30 },
    defaultPlanSlug: { type: String, default: 'basic' },
    featureFlags: {
      type: {
        captions: { type: Boolean, default: true },
        aiCombine: { type: Boolean, default: true },
        retakeRemoval: { type: Boolean, default: true },
        randomZoom: { type: Boolean, default: true },
      },
      default: () => ({}),
    },
  },
  { timestamps: true, versionKey: false },
)

export type SystemSettingsDocument = Document &
  InferSchemaType<typeof systemSettingsSchema>
export const SystemSettingsModel = model<SystemSettingsDocument>(
  'SystemSettings',
  systemSettingsSchema,
)
