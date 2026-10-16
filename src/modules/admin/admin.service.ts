import { Types } from 'mongoose'
import { HTTP_STATUS } from '../../constants/http'
import {
  PLAN_EDIT_QUOTA,
  PLAN_IDS,
  type BillingStatus,
  type PlanId,
} from '../../constants/plans'
import {
  ACTIVE_PROCESS_STATUSES,
  EDITING_MODES,
  type ProjectStatus,
} from '../../constants/projects'
import { AppError } from '../../utils/AppError'
import { JobModel } from '../job/job.model'
import { jobService } from '../job/job.service'
import { toPublicProject } from '../project/project.mapper'
import { ProjectModel } from '../project/project.model'
import { toPublicUser } from '../user/user.mapper'
import { UserModel } from '../user/user.model'
import type { PublicUser } from '../user/user.types'
import { hashPassword } from '../../utils/password'
import { logAdminActivity } from './admin.activity'
import { resolvePlanQuota } from './admin.plans'
import { PlanModel } from './models/plan.model'
import { TokenLedgerModel } from './models/token-ledger.model'

interface ListUsersInput {
  page: number
  limit: number
  q?: string
  planId?: PlanId
  billingStatus?: string
  role?: string
  isActive?: boolean
}

interface ListProjectsInput {
  page: number
  limit: number
  q?: string
  status?: ProjectStatus
  mode?: (typeof EDITING_MODES)[number]
  userId?: string
}

interface ListJobsInput {
  page: number
  limit: number
  status?: ProjectStatus
  activeOnly?: boolean
}

async function countAdmins(): Promise<number> {
  return UserModel.countDocuments({ role: 'admin', isActive: true })
}

function startOfDay(date = new Date()) {
  const d = new Date(date)
  d.setHours(0, 0, 0, 0)
  return d
}

function daysAgo(days: number) {
  const d = startOfDay()
  d.setDate(d.getDate() - days)
  return d
}

export const adminService = {
  async getStats() {
    const today = startOfDay()
    const weekAgo = daysAgo(7)
    const [
      totalUsers,
      activeUsers,
      disabledUsers,
      admins,
      verifiedUsers,
      signupsToday,
      signupsWeek,
      byPlan,
      byBilling,
      recentUsers,
      totalProjects,
      completedProjects,
      failedProjects,
      processingProjects,
      byProjectStatus,
      tokenPool,
      tokensUsedAgg,
      planDocs,
      recentProjects,
      chargedProjects,
    ] = await Promise.all([
      UserModel.countDocuments(),
      UserModel.countDocuments({ isActive: true }),
      UserModel.countDocuments({ isActive: false }),
      UserModel.countDocuments({ role: 'admin' }),
      UserModel.countDocuments({ emailVerified: true }),
      UserModel.countDocuments({ createdAt: { $gte: today } }),
      UserModel.countDocuments({ createdAt: { $gte: weekAgo } }),
      UserModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$planId', count: { $sum: 1 } } },
      ]),
      UserModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$billingStatus', count: { $sum: 1 } } },
      ]),
      UserModel.find().sort({ createdAt: -1 }).limit(12).lean(),
      ProjectModel.countDocuments(),
      ProjectModel.countDocuments({ status: 'Completed' }),
      ProjectModel.countDocuments({ status: 'Failed' }),
      ProjectModel.countDocuments({
        status: { $in: ACTIVE_PROCESS_STATUSES },
      }),
      ProjectModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$status', count: { $sum: 1 } } },
      ]),
      UserModel.aggregate<{ totalRemaining: number }>([
        {
          $group: {
            _id: null,
            totalRemaining: { $sum: '$remainingEdits' },
          },
        },
      ]),
      TokenLedgerModel.aggregate<{ total: number }>([
        { $match: { reason: 'consume' } },
        { $group: { _id: null, total: { $sum: { $abs: '$delta' } } } },
      ]),
      PlanModel.find().lean(),
      ProjectModel.find()
        .sort({ createdAt: -1 })
        .limit(12)
        .select(
          'userId title generatedTitle status mode createdAt progressPercent errorMessage',
        )
        .lean(),
      ProjectModel.countDocuments({ creditCharged: true }),
    ])

    const projectUserIds = [
      ...new Set(recentProjects.map((p) => p.userId.toString())),
    ]
    const projectUsers = projectUserIds.length
      ? await UserModel.find({ _id: { $in: projectUserIds } })
          .select('name email')
          .lean()
      : []
    const userById = new Map(
      projectUsers.map((u) => [u._id.toString(), u]),
    )

    return {
      totals: {
        users: totalUsers,
        activeUsers,
        disabledUsers,
        admins,
        verifiedUsers,
        signupsToday,
        signupsWeek,
        projects: totalProjects,
        completedProjects,
        failedProjects,
        processingProjects,
        tokensRemaining: tokenPool[0]?.totalRemaining ?? 0,
        tokensUsed:
          tokensUsedAgg[0]?.total ??
          chargedProjects ??
          0,
        videosEdited: chargedProjects,
      },
      revenue: (() => {
        const fallbackPrices: Record<string, number> = {
          basic: 20,
          standard: 40,
          pro: 49,
          unlimited: 99,
        }
        const priceBySlug = Object.fromEntries(
          planDocs.map((p) => [p.slug, p.price]),
        )
        const mrr = byPlan.reduce((sum, row) => {
          const price = priceBySlug[row._id] ?? fallbackPrices[row._id] ?? 0
          return sum + price * row.count
        }, 0)
        return {
          estimatedMrr: Math.round(mrr),
          activeSubscriptions:
            byBilling.find((row) => row._id === 'active')?.count ?? 0,
          note: 'Estimated from plan prices × subscribers (payments not live yet).',
        }
      })(),
      byPlan: Object.fromEntries(byPlan.map((row) => [row._id, row.count])),
      byBilling: Object.fromEntries(
        byBilling.map((row) => [row._id, row.count]),
      ),
      byProjectStatus: Object.fromEntries(
        byProjectStatus.map((row) => [row._id, row.count]),
      ),
      recentUsers: recentUsers.map((user) => toPublicUser(user)),
      recentProjects: recentProjects.map((project) => {
        const owner = userById.get(project.userId.toString())
        return {
          id: project._id.toString(),
          title: project.generatedTitle || project.title,
          status: project.status,
          mode: project.mode,
          progressPercent: project.progressPercent ?? 0,
          errorMessage: project.errorMessage || undefined,
          createdAt: project.createdAt.toISOString(),
          userId: project.userId.toString(),
          userName: owner?.name ?? 'Unknown',
          userEmail: owner?.email ?? '',
        }
      }),
      plans: (
        planDocs.length > 0
          ? planDocs.map((p) => ({ slug: p.slug, editQuota: p.editQuota }))
          : PLAN_IDS.map((id) => ({
              slug: id,
              editQuota: PLAN_EDIT_QUOTA[id],
            }))
      ).map((plan) => ({
        id: plan.slug,
        editQuota: plan.editQuota,
        users: byPlan.find((row) => row._id === plan.slug)?.count ?? 0,
      })),
    }
  },

  async listUsers(input: ListUsersInput) {
    const filter: Record<string, unknown> = {}

    if (input.q) {
      filter.$or = [
        { name: { $regex: input.q, $options: 'i' } },
        { email: { $regex: input.q, $options: 'i' } },
      ]
    }
    if (input.planId) filter.planId = input.planId
    if (input.billingStatus) filter.billingStatus = input.billingStatus
    if (input.role) filter.role = input.role
    if (input.isActive !== undefined) filter.isActive = input.isActive

    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      UserModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      UserModel.countDocuments(filter),
    ])

    return {
      items: items.map((user) => toPublicUser(user)),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
    }
  },

  async getUser(id: string): Promise<{
    user: PublicUser
    projectCounts: {
      total: number
      completed: number
      failed: number
      processing: number
    }
    recentProjects: ReturnType<typeof toPublicProject>[]
  }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    const user = await UserModel.findById(id).lean()
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)

    const userOid = new Types.ObjectId(id)
    const [total, completed, failed, processing, recent] = await Promise.all([
      ProjectModel.countDocuments({ userId: userOid }),
      ProjectModel.countDocuments({ userId: userOid, status: 'Completed' }),
      ProjectModel.countDocuments({ userId: userOid, status: 'Failed' }),
      ProjectModel.countDocuments({
        userId: userOid,
        status: { $in: ACTIVE_PROCESS_STATUSES },
      }),
      ProjectModel.find({ userId: userOid })
        .sort({ createdAt: -1 })
        .limit(10)
        .lean(),
    ])

    return {
      user: toPublicUser(user),
      projectCounts: { total, completed, failed, processing },
      recentProjects: recent.map((p) => toPublicProject(p)),
    }
  },

  async listProjects(input: ListProjectsInput) {
    const filter: Record<string, unknown> = {}
    if (input.status) filter.status = input.status
    if (input.mode) filter.mode = input.mode
    if (input.userId) {
      if (!Types.ObjectId.isValid(input.userId)) {
        throw new AppError('Invalid user id.', HTTP_STATUS.BAD_REQUEST)
      }
      filter.userId = new Types.ObjectId(input.userId)
    }
    if (input.q) {
      filter.$or = [
        { title: { $regex: input.q, $options: 'i' } },
        { generatedTitle: { $regex: input.q, $options: 'i' } },
        { originalFilename: { $regex: input.q, $options: 'i' } },
        { outputFilename: { $regex: input.q, $options: 'i' } },
      ]
    }

    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      ProjectModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      ProjectModel.countDocuments(filter),
    ])

    const userIds = [...new Set(items.map((p) => p.userId.toString()))]
    const users = userIds.length
      ? await UserModel.find({ _id: { $in: userIds } })
          .select('name email')
          .lean()
      : []
    const userById = new Map(users.map((u) => [u._id.toString(), u]))

    return {
      items: items.map((project) => {
        const owner = userById.get(project.userId.toString())
        return {
          ...toPublicProject(project, { slim: true }),
          userName: owner?.name ?? 'Unknown',
          userEmail: owner?.email ?? '',
        }
      }),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
    }
  },

  async getProject(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    }
    const project = await ProjectModel.findById(id).lean()
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)

    const owner = await UserModel.findById(project.userId)
      .select('name email planId')
      .lean()
    const latestJob = await JobModel.findOne({ projectId: project._id })
      .sort({ createdAt: -1 })
      .lean()

    return {
      project: toPublicProject(project),
      owner: owner
        ? {
            id: owner._id.toString(),
            name: owner.name,
            email: owner.email,
            planId: owner.planId,
          }
        : null,
      latestJob: latestJob
        ? {
            id: latestJob._id.toString(),
            status: latestJob.status,
            errorMessage: latestJob.errorMessage || undefined,
            startedAt: latestJob.startedAt?.toISOString?.() ?? undefined,
            finishedAt: latestJob.finishedAt
              ? latestJob.finishedAt.toISOString()
              : undefined,
            steps: latestJob.steps ?? [],
          }
        : null,
    }
  },

  async deleteProject(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    }
    const project = await ProjectModel.findById(id)
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    if (ACTIVE_PROCESS_STATUSES.includes(project.status as ProjectStatus)) {
      throw new AppError(
        'Cannot delete a project while it is processing.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    await JobModel.deleteMany({ projectId: project._id })
    await project.deleteOne()
    return { message: 'Project deleted.' }
  },

  async retryProject(id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    }
    const project = await ProjectModel.findById(id).lean()
    if (!project) throw new AppError('Project not found.', HTTP_STATUS.NOT_FOUND)
    if (project.status !== 'Failed') {
      throw new AppError(
        'Only failed projects can be retried.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }
    return jobService.retry(id, project.userId.toString())
  },

  async listJobs(input: ListJobsInput) {
    const filter: Record<string, unknown> = {}
    if (input.activeOnly) {
      filter.status = { $in: ACTIVE_PROCESS_STATUSES }
    } else if (input.status) {
      filter.status = input.status
    }

    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      JobModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      JobModel.countDocuments(filter),
    ])

    const projectIds = [...new Set(items.map((j) => j.projectId.toString()))]
    const userIds = [...new Set(items.map((j) => j.userId.toString()))]
    const [projects, users] = await Promise.all([
      projectIds.length
        ? ProjectModel.find({ _id: { $in: projectIds } })
            .select('title generatedTitle status mode')
            .lean()
        : [],
      userIds.length
        ? UserModel.find({ _id: { $in: userIds } })
            .select('name email')
            .lean()
        : [],
    ])
    const projectById = new Map(projects.map((p) => [p._id.toString(), p]))
    const userById = new Map(users.map((u) => [u._id.toString(), u]))

    return {
      items: items.map((job) => {
        const project = projectById.get(job.projectId.toString())
        const owner = userById.get(job.userId.toString())
        return {
          id: job._id.toString(),
          projectId: job.projectId.toString(),
          projectTitle:
            project?.generatedTitle || project?.title || 'Untitled project',
          projectMode: project?.mode ?? '',
          projectStatus: project?.status ?? job.status,
          userId: job.userId.toString(),
          userName: owner?.name ?? 'Unknown',
          userEmail: owner?.email ?? '',
          status: job.status,
          errorMessage: job.errorMessage || undefined,
          startedAt: job.startedAt?.toISOString?.() ?? job.createdAt.toISOString(),
          finishedAt: job.finishedAt
            ? job.finishedAt.toISOString()
            : undefined,
          createdAt: job.createdAt.toISOString(),
          stepCount: Array.isArray(job.steps) ? job.steps.length : 0,
        }
      }),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
    }
  },

  getPlans() {
    return {
      plans: PLAN_IDS.map((id) => ({
        id,
        editQuota: PLAN_EDIT_QUOTA[id],
      })),
    }
  },

  async createUser(
    actorId: string,
    input: {
      name: string
      email: string
      password: string
      planId?: string
      remainingEdits?: number
      billingStatus?: BillingStatus
      role?: 'user' | 'admin'
      isActive?: boolean
      emailVerified?: boolean
    },
  ) {
    const email = input.email.trim().toLowerCase()
    const taken = await UserModel.findOne({ email }).lean()
    if (taken) {
      throw new AppError('Email already in use.', HTTP_STATUS.CONFLICT)
    }
    const planId = (input.planId || 'basic').trim().toLowerCase()
    const quota = await resolvePlanQuota(planId)
    const user = await UserModel.create({
      name: input.name.trim(),
      email,
      passwordHash: await hashPassword(input.password),
      planId,
      remainingEdits:
        input.remainingEdits !== undefined ? input.remainingEdits : quota,
      billingStatus: input.billingStatus ?? 'active',
      role: input.role ?? 'user',
      isActive: input.isActive ?? true,
      emailVerified: input.emailVerified ?? true,
    })
    await logAdminActivity({
      actorId,
      action: 'user.create',
      targetType: 'user',
      targetId: user._id.toString(),
      summary: `Created user ${email}`,
    })
    return { user: toPublicUser(user) }
  },

  async adjustTokens(
    actorId: string,
    id: string,
    input: {
      mode: 'add' | 'deduct' | 'set' | 'reset'
      amount?: number
      note?: string
    },
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    const user = await UserModel.findById(id)
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)

    const before = user.remainingEdits
    let reason:
      | 'admin_add'
      | 'admin_deduct'
      | 'admin_reset'
      | 'plan_change' = 'admin_add'
    let note = input.note?.trim() || ''

    if (input.mode === 'reset') {
      user.remainingEdits = await resolvePlanQuota(user.planId)
      reason = 'admin_reset'
      note = note || `Reset to plan quota (${user.planId})`
    } else if (input.mode === 'set') {
      if (input.amount === undefined || input.amount < 0) {
        throw new AppError('amount is required.', HTTP_STATUS.BAD_REQUEST)
      }
      user.remainingEdits = input.amount
      reason = 'admin_reset'
      note = note || `Set tokens to ${input.amount}`
    } else if (input.mode === 'add') {
      if (input.amount === undefined || input.amount <= 0) {
        throw new AppError('amount must be > 0.', HTTP_STATUS.BAD_REQUEST)
      }
      user.remainingEdits += input.amount
      reason = 'admin_add'
      note = note || `Added ${input.amount} tokens`
    } else {
      if (input.amount === undefined || input.amount <= 0) {
        throw new AppError('amount must be > 0.', HTTP_STATUS.BAD_REQUEST)
      }
      user.remainingEdits = Math.max(0, user.remainingEdits - input.amount)
      reason = 'admin_deduct'
      note = note || `Deducted ${input.amount} tokens`
    }

    await user.save()
    const delta = user.remainingEdits - before
    await TokenLedgerModel.create({
      userId: user._id,
      actorId,
      delta,
      balanceAfter: user.remainingEdits,
      reason,
      note,
    })
    await logAdminActivity({
      actorId,
      action: 'user.tokens',
      targetType: 'user',
      targetId: id,
      summary: note,
      meta: { mode: input.mode, amount: input.amount, delta },
    })
    return { user: toPublicUser(user) }
  },

  async updateUser(
    id: string,
    actorId: string,
    input: {
      name?: string
      email?: string
      planId?: string
      remainingEdits?: number
      billingStatus?: BillingStatus
      role?: 'user' | 'admin'
      isActive?: boolean
      emailVerified?: boolean
    },
  ): Promise<{ user: PublicUser }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }

    const user = await UserModel.findById(id)
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)

    if (input.email && input.email !== user.email) {
      const taken = await UserModel.findOne({
        email: input.email,
        _id: { $ne: user._id },
      }).lean()
      if (taken) {
        throw new AppError('Email already in use.', HTTP_STATUS.CONFLICT)
      }
      user.email = input.email
    }

    if (input.name) user.name = input.name

    const beforeTokens = user.remainingEdits
    if (input.planId) {
      user.planId = input.planId
      if (input.remainingEdits === undefined) {
        user.remainingEdits = await resolvePlanQuota(input.planId)
      }
    }

    if (input.remainingEdits !== undefined) {
      user.remainingEdits = input.remainingEdits
    }

    if (input.billingStatus) user.billingStatus = input.billingStatus
    if (input.emailVerified !== undefined) {
      user.emailVerified = input.emailVerified
    }

    if (input.role && input.role !== user.role) {
      if (user.role === 'admin' && input.role === 'user') {
        const admins = await countAdmins()
        if (admins <= 1) {
          throw new AppError(
            'Cannot demote the last active admin.',
            HTTP_STATUS.BAD_REQUEST,
          )
        }
      }
      user.role = input.role
    }

    if (input.isActive !== undefined && input.isActive !== user.isActive) {
      if (user.role === 'admin' && input.isActive === false) {
        const admins = await countAdmins()
        if (admins <= 1) {
          throw new AppError(
            'Cannot disable the last active admin.',
            HTTP_STATUS.BAD_REQUEST,
          )
        }
      }
      if (id === actorId && input.isActive === false) {
        throw new AppError(
          'You cannot disable your own account.',
          HTTP_STATUS.BAD_REQUEST,
        )
      }
      user.isActive = input.isActive
    }

    await user.save()

    if (user.remainingEdits !== beforeTokens) {
      await TokenLedgerModel.create({
        userId: user._id,
        actorId,
        delta: user.remainingEdits - beforeTokens,
        balanceAfter: user.remainingEdits,
        reason: input.planId ? 'plan_change' : 'admin_reset',
        note: input.planId
          ? `Plan changed to ${input.planId}`
          : 'Tokens updated via user edit',
      })
    }

    await logAdminActivity({
      actorId,
      action: 'user.update',
      targetType: 'user',
      targetId: id,
      summary: `Updated user ${user.email}`,
      meta: input,
    })
    return { user: toPublicUser(user) }
  },

  async deleteUser(id: string, actorId: string): Promise<{ message: string }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    if (id === actorId) {
      throw new AppError(
        'You cannot delete your own account.',
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    const user = await UserModel.findById(id)
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)

    if (user.role === 'admin') {
      const admins = await countAdmins()
      if (admins <= 1) {
        throw new AppError(
          'Cannot delete the last active admin.',
          HTTP_STATUS.BAD_REQUEST,
        )
      }
    }

    await user.deleteOne()
    await logAdminActivity({
      actorId,
      action: 'user.delete',
      targetType: 'user',
      targetId: id,
      summary: `Deleted user ${user.email}`,
    })
    return { message: 'User deleted.' }
  },

  async verifyUserEmail(
    id: string,
    actorId?: string,
  ): Promise<{ user: PublicUser }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    const user = await UserModel.findByIdAndUpdate(
      id,
      { emailVerified: true },
      { new: true },
    )
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    if (actorId) {
      await logAdminActivity({
        actorId,
        action: 'user.verify_email',
        targetType: 'user',
        targetId: id,
        summary: `Verified email for ${user.email}`,
      })
    }
    return { user: toPublicUser(user) }
  },
}
