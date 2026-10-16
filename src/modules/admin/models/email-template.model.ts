import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

const emailTemplateSchema = new Schema(
  {
    slug: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    subject: { type: String, required: true, trim: true, maxlength: 200 },
    body: { type: String, required: true, maxlength: 20000 },
    isActive: { type: Boolean, default: true },
  },
  { timestamps: true, versionKey: false },
)

export type EmailTemplateDocument = Document &
  InferSchemaType<typeof emailTemplateSchema>
export const EmailTemplateModel = model<EmailTemplateDocument>(
  'EmailTemplate',
  emailTemplateSchema,
)
