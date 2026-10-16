import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const planSchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 80 },
    price: { type: Number, required: true, min: 0, default: 0 },
    editQuota: { type: Number, required: true, min: 0, default: 0 },
    description: { type: String, default: '', maxlength: 240 },
    features: { type: [String], default: [] },
    isActive: { type: Boolean, default: true, index: true },
    sortOrder: { type: Number, default: 0 },
  },
  { timestamps: true, versionKey: false },
)

export type PlanDocument = Document & InferSchemaType<typeof planSchema>
export const PlanModel = model<PlanDocument>('Plan', planSchema)
