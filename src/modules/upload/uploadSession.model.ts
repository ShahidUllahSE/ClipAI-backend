import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const uploadSessionSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    fingerprint: { type: String, required: true, index: true },
    filename: { type: String, required: true },
    mimeType: { type: String, required: true },
    totalSize: { type: Number, required: true },
    durationSeconds: { type: Number, default: 0 },
    chunkSize: { type: Number, required: true },
    totalChunks: { type: Number, required: true },
    uploadedChunks: { type: [Number], default: [] },
    status: { type: String, enum: ['pending', 'completed'], default: 'pending' },
    completedUploadId: { type: Schema.Types.ObjectId, ref: 'Upload' },
  },
  { timestamps: true, versionKey: false },
)

export type UploadSessionDocument = Document & InferSchemaType<typeof uploadSessionSchema>
export const UploadSessionModel = model<UploadSessionDocument>(
  'UploadSession',
  uploadSessionSchema,
)
