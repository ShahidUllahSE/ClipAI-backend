import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

export const TICKET_STATUSES = [
  'open',
  'in_progress',
  'waiting',
  'resolved',
  'closed',
] as const

export const TICKET_PRIORITIES = ['low', 'normal', 'high', 'urgent'] as const

const messageSchema = new Schema(
  {
    authorId: { type: Schema.Types.ObjectId, ref: 'User', required: true },
    authorName: { type: String, default: '' },
    body: { type: String, required: true, maxlength: 5000 },
    isStaff: { type: Boolean, default: false },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
)

const supportTicketSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    subject: { type: String, required: true, trim: true, maxlength: 160 },
    status: {
      type: String,
      enum: TICKET_STATUSES,
      default: 'open',
      index: true,
    },
    priority: {
      type: String,
      enum: TICKET_PRIORITIES,
      default: 'normal',
      index: true,
    },
    messages: { type: [messageSchema], default: [] },
    assignedTo: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
)

supportTicketSchema.index({ createdAt: -1 })

export type SupportTicketDocument = Document &
  InferSchemaType<typeof supportTicketSchema>
export const SupportTicketModel = model<SupportTicketDocument>(
  'SupportTicket',
  supportTicketSchema,
)
