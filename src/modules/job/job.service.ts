import { HTTP_STATUS } from '../../constants/http'
import { ACTIVE_PROCESS_STATUSES, type ProjectStatus } from '../../constants/projects'
import { AppError } from '../../utils/AppError'
import { toPublicProject } from '../project/project.mapper'
import { projectService } from '../project/project.service'
import { UserModel } from '../user/user.model'
import { JobModel } from './job.model'
import { runJobPipeline } from './job.processor'

export const jobService = {
  async start(projectId: string, userId: string) {
    const user = await UserModel.findById(userId)
    if (!user) throw new AppError('Not signed in.', HTTP_STATUS.UNAUTHORIZED)
    if (user.billingStatus === 'canceled') {
      throw new AppError(
        'Subscription canceled. Reactivate a plan to process.',
        HTTP_STATUS.PAYMENT_REQUIRED,
      )
    }
    if (user.planId !== 'unlimited' && user.remainingEdits <= 0) {
      throw new AppError(
        'No edit credits remaining. Upgrade your plan.',
        HTTP_STATUS.PAYMENT_REQUIRED,
      )
    }

    const project = await projectService.getDocument(projectId, userId)
    if (ACTIVE_PROCESS_STATUSES.includes(project.status as ProjectStatus)) {
      throw new AppError(
        'Project is already processing.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    if (!['Uploaded', 'Failed', 'Completed'].includes(project.status)) {
      throw new AppError(
        'Project cannot be processed from this status.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    project.status = 'Queued'
    project.errorMessage = ''
    await project.save()

    const job = await JobModel.create({
      projectId: project._id,
      userId,
      status: 'Queued',
      steps: [{ status: 'Queued', at: new Date(), note: 'Accepted' }],
    })

    void runJobPipeline(job._id.toString(), project._id.toString())

    return {
      project: toPublicProject(project),
      job: {
        id: job._id.toString(),
        status: job.status,
        startedAt: job.startedAt.toISOString(),
      },
    }
  },

  async retry(projectId: string, userId: string) {
    const project = await projectService.getDocument(projectId, userId)
    if (project.status !== 'Failed') {
      throw new AppError(
        'Only failed jobs can be retried.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    return this.start(projectId, userId)
  },

  async getLatest(projectId: string, userId: string) {
    await projectService.getDocument(projectId, userId)
    const job = await JobModel.findOne({ projectId, userId })
      .sort({ createdAt: -1 })
      .lean()
    if (!job) {
      return { job: null }
    }
    return {
      job: {
        id: job._id.toString(),
        status: job.status,
        steps: job.steps,
        errorMessage: job.errorMessage || undefined,
        startedAt: job.startedAt?.toISOString(),
        finishedAt: job.finishedAt?.toISOString() || undefined,
      },
    }
  },
}
