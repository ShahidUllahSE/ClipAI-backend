import { Schema, model, type Document, type InferSchemaType } from 'mongoose'
import {
  BILLING_STATUSES,
  PLAN_EDIT_QUOTA,
  PLAN_IDS,
  TOKEN_TYPES,
} from '../../constants/plans'
import { USER_ROLES } from '../../constants/roles'

const authTokenSchema = new Schema(
  {
    type: {
      type: String,
      enum: Object.values(TOKEN_TYPES),
      required: true,
    },
    tokenHash: { type: String, required: true, index: true },
    expiresAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
    createdAt: { type: Date, default: Date.now },
  },
  { _id: true },
)

const userSchema = new Schema(
  {
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: 80,
    },
    email: {
      type: String,
      required: true,
      unique: true,
      lowercase: true,
      trim: true,
      index: true,
    },
    passwordHash: {
      type: String,
      required: true,
      select: false,
    },
    role: {
      type: String,
      enum: USER_ROLES,
      default: 'user',
      index: true,
    },
    isActive: {
      type: Boolean,
      default: true,
      index: true,
    },
    planId: {
      type: String,
      enum: PLAN_IDS,
      default: 'basic',
    },
    remainingEdits: {
      type: Number,
      default: PLAN_EDIT_QUOTA.basic,
      min: 0,
    },
    billingStatus: {
      type: String,
      enum: BILLING_STATUSES,
      default: 'active',
    },
    emailVerified: {
      type: Boolean,
      default: false,
    },
    tokens: {
      type: [authTokenSchema],
      default: [],
      select: false,
    },
  },
  {
    timestamps: true,
    versionKey: false,
  },
)

userSchema.index({ email: 1 }, { unique: true })
userSchema.index({ createdAt: -1 })

export type UserDocument = Document & InferSchemaType<typeof userSchema>

export const UserModel = model<UserDocument>('User', userSchema)
