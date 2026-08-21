import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const uploadSchema = new Schema(
  {
    userId: { type: Schema.Types.ObjectId, ref: 'User', required: true, index: true },
    originalFilename: { type: String, required: true },
    storedFilename: { type: String, required: true },
    mimeType: { type: String, required: true },
    fileSize: { type: Number, required: true },
    durationSeconds: { type: Number, default: 0 },
    storagePath: { type: String, required: true },
    publicUrl: { type: String, required: true },
  },
  { timestamps: true, versionKey: false },
)

export type UploadDocument = Document & InferSchemaType<typeof uploadSchema>
export const UploadModel = model<UploadDocument>('Upload', uploadSchema)
