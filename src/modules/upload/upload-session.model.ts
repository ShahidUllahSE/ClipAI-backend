import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const uploadSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fingerprint: { type: String, required: true, index: true },
    originalFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    totalSize: { type: Number, required: true },
    durationSeconds: { type: Number, default: 0 },
    chunkSize: { type: Number, required: true },
    totalChunks: { type: Number, required: true },
    uploadedChunks: { type: [Number], default: [] },
    status: {
      type: String,
      enum: ['active', 'completing', 'completed'],
      default: 'active',
      index: true,
    },
    uploadId: { type: Schema.Types.ObjectId, ref: 'Upload', default: null },
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true, versionKey: false },
)

uploadSessionSchema.index({ userId: 1, fingerprint: 1, status: 1 })

export type UploadSessionDocument = Document &
  InferSchemaType<typeof uploadSessionSchema>

export const UploadSessionModel = model<UploadSessionDocument>(
  'UploadSession',
  uploadSessionSchema,
)
