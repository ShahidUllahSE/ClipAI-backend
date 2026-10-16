import { Schema, model, type Document, type InferSchemaType } from 'mongoose'

export const TOKEN_LEDGER_REASONS = [
  'consume',
  'admin_add',
  'admin_deduct',
  'admin_reset',
  'plan_change',
] as const

const tokenLedgerSchema = new Schema(
  {
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    actorId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      default: null,
    },
    delta: { type: Number, required: true },
    balanceAfter: { type: Number, required: true },
    reason: {
      type: String,
      enum: TOKEN_LEDGER_REASONS,
      required: true,
      index: true,
    },
    note: { type: String, default: '', maxlength: 240 },
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      default: null,
    },
  },
  { timestamps: true, versionKey: false },
)

tokenLedgerSchema.index({ createdAt: -1 })
tokenLedgerSchema.index({ userId: 1, createdAt: -1 })

export type TokenLedgerDocument = Document &
  InferSchemaType<typeof tokenLedgerSchema>
export const TokenLedgerModel = model<TokenLedgerDocument>(
  'TokenLedger',
  tokenLedgerSchema,
)
