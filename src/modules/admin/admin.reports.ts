import { Types } from 'mongoose'
import { ProjectModel } from '../project/project.model'
import { UserModel } from '../user/user.model'
import { toCsv } from './admin.csv'
import { ActivityLogModel } from './models/activity-log.model'
import { PlanModel } from './models/plan.model'
import { TokenLedgerModel } from './models/token-ledger.model'

export const adminReportsService = {
  async listActivity(input: { page: number; limit: number; q?: string }) {
    const filter: Record<string, unknown> = {}
    if (input.q) {
      filter.$or = [
        { action: { $regex: input.q, $options: 'i' } },
        { summary: { $regex: input.q, $options: 'i' } },
        { actorEmail: { $regex: input.q, $options: 'i' } },
      ]
    }
    const skip = (input.page - 1) * input.limit
    const [items, total] = await Promise.all([
      ActivityLogModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      ActivityLogModel.countDocuments(filter),
    ])

    return {
      items: items.map((row) => ({
        id: row._id.toString(),
        actorId: row.actorId.toString(),
        actorEmail: row.actorEmail || '',
        action: row.action,
        targetType: row.targetType || '',
        targetId: row.targetId || '',
        summary: row.summary || '',
        meta: row.meta ?? null,
        createdAt: row.createdAt.toISOString(),
      })),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
    }
  },

  async exportUsersCsv() {
    const users = await UserModel.find().sort({ createdAt: -1 }).lean()
    return toCsv(
      [
        'id',
        'name',
        'email',
        'role',
        'isActive',
        'planId',
        'remainingEdits',
        'billingStatus',
        'emailVerified',
        'createdAt',
      ],
      users.map((u) => [
        u._id.toString(),
        u.name,
        u.email,
        u.role,
        u.isActive,
        u.planId,
        u.remainingEdits,
        u.billingStatus,
        u.emailVerified,
        u.createdAt.toISOString(),
      ]),
    )
  },

  async exportUsageCsv() {
    const rows = await TokenLedgerModel.find()
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean()
    return toCsv(
      [
        'id',
        'userId',
        'actorId',
        'delta',
        'balanceAfter',
        'reason',
        'note',
        'projectId',
        'createdAt',
      ],
      rows.map((r) => [
        r._id.toString(),
        r.userId.toString(),
        r.actorId ? r.actorId.toString() : '',
        r.delta,
        r.balanceAfter,
        r.reason,
        r.note || '',
        r.projectId ? r.projectId.toString() : '',
        r.createdAt.toISOString(),
      ]),
    )
  },

  async exportRevenueCsv() {
    const plans = await PlanModel.find().lean()
    const priceBySlug = Object.fromEntries(
      plans.map((p) => [p.slug, p.price]),
    )
    const users = await UserModel.find({
      billingStatus: { $in: ['active', 'past_due', 'canceled'] },
    })
      .select('name email planId billingStatus createdAt')
      .lean()

    return toCsv(
      [
        'userId',
        'name',
        'email',
        'planId',
        'billingStatus',
        'monthlyPrice',
        'createdAt',
      ],
      users.map((u) => [
        u._id.toString(),
        u.name,
        u.email,
        u.planId,
        u.billingStatus,
        priceBySlug[u.planId] ?? 0,
        u.createdAt.toISOString(),
      ]),
    )
  },

  async exportActivityCsv() {
    const rows = await ActivityLogModel.find()
      .sort({ createdAt: -1 })
      .limit(5000)
      .lean()
    return toCsv(
      [
        'id',
        'actorEmail',
        'action',
        'targetType',
        'targetId',
        'summary',
        'createdAt',
      ],
      rows.map((r) => [
        r._id.toString(),
        r.actorEmail,
        r.action,
        r.targetType,
        r.targetId,
        r.summary,
        r.createdAt.toISOString(),
      ]),
    )
  },

  async listUsage(input: {
    page: number
    limit: number
    userId?: string
    reason?: string
  }) {
    const filter: Record<string, unknown> = {}
    if (input.userId) {
      if (!Types.ObjectId.isValid(input.userId)) {
        return {
          items: [],
          pagination: { page: 1, limit: input.limit, total: 0, pages: 1 },
          totals: { tokensUsed: 0, tokensAdded: 0 },
        }
      }
      filter.userId = new Types.ObjectId(input.userId)
    }
    if (input.reason) filter.reason = input.reason

    const skip = (input.page - 1) * input.limit
    const [items, total, usedAgg, addedAgg] = await Promise.all([
      TokenLedgerModel.find(filter)
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      TokenLedgerModel.countDocuments(filter),
      TokenLedgerModel.aggregate<{ total: number }>([
        { $match: { ...filter, reason: 'consume' } },
        { $group: { _id: null, total: { $sum: { $abs: '$delta' } } } },
      ]),
      TokenLedgerModel.aggregate<{ total: number }>([
        {
          $match: {
            ...filter,
            reason: { $in: ['admin_add', 'admin_reset', 'plan_change'] },
            delta: { $gt: 0 },
          },
        },
        { $group: { _id: null, total: { $sum: '$delta' } } },
      ]),
    ])

    const userIds = [...new Set(items.map((r) => r.userId.toString()))]
    const users = userIds.length
      ? await UserModel.find({ _id: { $in: userIds } })
          .select('name email')
          .lean()
      : []
    const userById = new Map(users.map((u) => [u._id.toString(), u]))

    return {
      items: items.map((row) => {
        const user = userById.get(row.userId.toString())
        return {
          id: row._id.toString(),
          userId: row.userId.toString(),
          userName: user?.name ?? 'Unknown',
          userEmail: user?.email ?? '',
          actorId: row.actorId ? row.actorId.toString() : null,
          delta: row.delta,
          balanceAfter: row.balanceAfter,
          reason: row.reason,
          note: row.note || '',
          projectId: row.projectId ? row.projectId.toString() : null,
          createdAt: row.createdAt.toISOString(),
        }
      }),
      pagination: {
        page: input.page,
        limit: input.limit,
        total,
        pages: Math.max(1, Math.ceil(total / input.limit)),
      },
      totals: {
        tokensUsed: usedAgg[0]?.total ?? 0,
        tokensAdded: addedAgg[0]?.total ?? 0,
      },
    }
  },

  async listSubscriptions(input: {
    page: number
    limit: number
    billingStatus?: string
    planId?: string
    q?: string
  }) {
    const filter: Record<string, unknown> = {}
    if (input.billingStatus) filter.billingStatus = input.billingStatus
    if (input.planId) filter.planId = input.planId
    if (input.q) {
      filter.$or = [
        { name: { $regex: input.q, $options: 'i' } },
        { email: { $regex: input.q, $options: 'i' } },
      ]
    }

    const skip = (input.page - 1) * input.limit
    const [items, total, plans] = await Promise.all([
      UserModel.find(filter)
        .sort({ updatedAt: -1 })
        .skip(skip)
        .limit(input.limit)
        .lean(),
      UserModel.countDocuments(filter),
      PlanModel.find().lean(),
    ])
    const priceBySlug = Object.fromEntries(
      plans.map((p) => [p.slug, p.price]),
    )

    const userIds = items.map((u) => u._id)
    const projectCounts = userIds.length
      ? await ProjectModel.aggregate<{
          _id: Types.ObjectId
          completed: number
          total: number
        }>([
          { $match: { userId: { $in: userIds } } },
          {
            $group: {
              _id: '$userId',
              total: { $sum: 1 },
              completed: {
                $sum: { $cond: [{ $eq: ['$status', 'Completed'] }, 1, 0] },
              },
            },
          },
        ])
      : []
    const countByUser = new Map(
      projectCounts.map((r) => [r._id.toString(), r]),
    )

    return {
      items: items.map((user) => {
        const counts = countByUser.get(user._id.toString())
        return {
          id: user._id.toString(),
          name: user.name,
          email: user.email,
          planId: user.planId,
          billingStatus: user.billingStatus,
          remainingEdits: user.remainingEdits,
          monthlyPrice: priceBySlug[user.planId] ?? 0,
          isActive: user.isActive,
          projectsTotal: counts?.total ?? 0,
          projectsCompleted: counts?.completed ?? 0,
          createdAt: user.createdAt.toISOString(),
          updatedAt: user.updatedAt.toISOString(),
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
}
