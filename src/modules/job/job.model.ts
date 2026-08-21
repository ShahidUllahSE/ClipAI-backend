import { Schema, model, type Document, type InferSchemaType } from 'mongoose'
import { PROJECT_STATUSES } from '../../constants/projects'

const jobSchema = new Schema(
  {
    projectId: {
      type: Schema.Types.ObjectId,
      ref: 'Project',
      required: true,
      index: true,
    },
    userId: {
      type: Schema.Types.ObjectId,
      ref: 'User',
      required: true,
      index: true,
    },
    status: {
      type: String,
      enum: PROJECT_STATUSES,
      default: 'Queued',
      index: true,
    },
    steps: {
      type: [
        {
          status: String,
          at: { type: Date, default: Date.now },
          note: { type: String, default: '' },
        },
      ],
      default: [],
    },
    errorMessage: { type: String, default: '' },
    speechResult: { type: Schema.Types.Mixed, default: null },
    understandingResult: { type: Schema.Types.Mixed, default: null },
    namingResult: { type: Schema.Types.Mixed, default: null },
    renderResult: { type: Schema.Types.Mixed, default: null },
    startedAt: { type: Date, default: Date.now },
    finishedAt: { type: Date, default: null },
  },
  { timestamps: true, versionKey: false },
)

export type JobDocument = Document & InferSchemaType<typeof jobSchema>
export const JobModel = model<JobDocument>('Job', jobSchema)
