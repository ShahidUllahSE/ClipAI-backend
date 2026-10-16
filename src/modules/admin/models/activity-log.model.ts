import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const activityLogSchema = new Schema(
  {
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actorEmail: { type: String, default: '' },
    action: { type: String, required: true, index: true },
    targetType: { type: String, default: '', index: true },
    targetId: { type: String, default: '' },
    summary: { type: String, default: '', maxlength: 300 },
    meta: { type: Schema.Types.Mixed, default: null },
  },
  { timestamps: true, versionKey: false },
)

activityLogSchema.index({ createdAt: -1 })

export type ActivityLogDocument = Document &
  InferSchemaType<typeof activityLogSchema>
export const ActivityLogModel = model<ActivityLogDocument>(
  'ActivityLog',
  activityLogSchema,
)
