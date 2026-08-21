import { Types } from 'mongoose'
import { HTTP_STATUS } from '../../constants/http'
import { PLAN_EDIT_QUOTA, type BillingStatus, type PlanId } from '../../constants/plans'
import { AppError } from '../../utils/AppError'
import { toPublicUser } from '../user/user.mapper'
import { UserModel } from '../user/user.model'
import type { PublicUser } from '../user/user.types'

interface ListUsersInput {
  page: number
  limit: number
  q?: string
  planId?: PlanId
  billingStatus?: string
  role?: string
  isActive?: boolean
}

async function countAdmins(): Promise<number> {
  return UserModel.countDocuments({ role: 'admin', isActive: true })
}

export const adminService = {
  async getStats() {
    const [
      totalUsers,
      activeUsers,
      disabledUsers,
      admins,
      verifiedUsers,
      byPlan,
      byBilling,
      recentUsers,
    ] = await Promise.all([
      UserModel.countDocuments(),
      UserModel.countDocuments({ isActive: true }),
      UserModel.countDocuments({ isActive: false }),
      UserModel.countDocuments({ role: 'admin' }),
      UserModel.countDocuments({ emailVerified: true }),
      UserModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$planId', count: { $sum: 1 } } },
      ]),
      UserModel.aggregate<{ _id: string; count: number }>([
        { $group: { _id: '$billingStatus', count: { $sum: 1 } } },
      ]),
      UserModel.find()
        .sort({ createdAt: -1 })
        .limit(5)
        .lean(),
    ])

    return {
      totals: {
        users: totalUsers,
        activeUsers,
        disabledUsers,
        admins,
        verifiedUsers,
      },
      byPlan: Object.fromEntries(byPlan.map((row) => [row._id, row.count])),
      byBilling: Object.fromEntries(
        byBilling.map((row) => [row._id, row.count]),
      ),
      recentUsers: recentUsers.map((user) => toPublicUser(user)),
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

  async getUser(id: string): Promise<{ user: PublicUser }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    const user = await UserModel.findById(id).lean()
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    return { user: toPublicUser(user) }
  },

  async updateUser(
    id: string,
    actorId: string,
    input: {
      name?: string
      email?: string
      planId?: PlanId
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

    if (input.planId) {
      user.planId = input.planId
      if (input.remainingEdits === undefined) {
        user.remainingEdits = PLAN_EDIT_QUOTA[input.planId]
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
    return { message: 'User deleted.' }
  },

  async verifyUserEmail(id: string): Promise<{ user: PublicUser }> {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    }
    const user = await UserModel.findByIdAndUpdate(
      id,
      { emailVerified: true },
      { new: true },
    )
    if (!user) throw new AppError('User not found.', HTTP_STATUS.NOT_FOUND)
    return { user: toPublicUser(user) }
  },
}
