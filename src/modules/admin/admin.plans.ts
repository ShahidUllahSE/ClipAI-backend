import { Types } from 'mongoose'
import { HTTP_STATUS } from '../../constants/http'
import { PLAN_EDIT_QUOTA, type PlanId } from '../../constants/plans'
import { AppError } from '../../utils/AppError'
import { UserModel } from '../user/user.model'
import { logAdminActivity } from './admin.activity'
import { PlanModel } from './models/plan.model'

function toPublicPlan(plan: {
  _id: { toString(): string }
  slug: string
  name: string
  price: number
  editQuota: number
  description?: string
  features?: string[]
  isActive: boolean
  sortOrder?: number
  createdAt: Date
  updatedAt: Date
}) {
  return {
    id: plan._id.toString(),
    slug: plan.slug,
    name: plan.name,
    price: plan.price,
    editQuota: plan.editQuota,
    description: plan.description || '',
    features: plan.features ?? [],
    isActive: plan.isActive,
    sortOrder: plan.sortOrder ?? 0,
    createdAt: plan.createdAt.toISOString(),
    updatedAt: plan.updatedAt.toISOString(),
  }
}

export async function resolvePlanQuota(planSlug: string): Promise<number> {
  const plan = await PlanModel.findOne({ slug: planSlug, isActive: true })
    .select('editQuota')
    .lean()
  if (plan) return plan.editQuota
  if (planSlug in PLAN_EDIT_QUOTA) {
    return PLAN_EDIT_QUOTA[planSlug as PlanId]
  }
  return PLAN_EDIT_QUOTA.basic
}

export const adminPlansService = {
  async list() {
    const plans = await PlanModel.find().sort({ sortOrder: 1, createdAt: 1 }).lean()
    const counts = await UserModel.aggregate<{ _id: string; count: number }>([
      { $group: { _id: '$planId', count: { $sum: 1 } } },
    ])
    const countBySlug = Object.fromEntries(
      counts.map((row) => [row._id, row.count]),
    )
    return {
      plans: plans.map((plan) => ({
        ...toPublicPlan(plan),
        users: countBySlug[plan.slug] ?? 0,
      })),
    }
  },

  async create(
    actorId: string,
    input: {
      slug: string
      name: string
      price: number
      editQuota: number
      description?: string
      features?: string[]
      isActive?: boolean
      sortOrder?: number
    },
  ) {
    const slug = input.slug.trim().toLowerCase()
    const exists = await PlanModel.findOne({ slug }).lean()
    if (exists) {
      throw new AppError('Plan slug already exists.', HTTP_STATUS.CONFLICT)
    }
    const plan = await PlanModel.create({
      slug,
      name: input.name.trim(),
      price: input.price,
      editQuota: input.editQuota,
      description: input.description ?? '',
      features: input.features ?? [],
      isActive: input.isActive ?? true,
      sortOrder: input.sortOrder ?? 99,
    })
    await logAdminActivity({
      actorId,
      action: 'plan.create',
      targetType: 'plan',
      targetId: plan._id.toString(),
      summary: `Created plan ${slug}`,
    })
    return { plan: toPublicPlan(plan) }
  },

  async update(
    actorId: string,
    id: string,
    input: Partial<{
      name: string
      price: number
      editQuota: number
      description: string
      features: string[]
      isActive: boolean
      sortOrder: number
    }>,
  ) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Plan not found.', HTTP_STATUS.NOT_FOUND)
    }
    const plan = await PlanModel.findById(id)
    if (!plan) throw new AppError('Plan not found.', HTTP_STATUS.NOT_FOUND)

    if (input.name !== undefined) plan.name = input.name.trim()
    if (input.price !== undefined) plan.price = input.price
    if (input.editQuota !== undefined) plan.editQuota = input.editQuota
    if (input.description !== undefined) plan.description = input.description
    if (input.features !== undefined) plan.features = input.features
    if (input.isActive !== undefined) plan.isActive = input.isActive
    if (input.sortOrder !== undefined) plan.sortOrder = input.sortOrder

    await plan.save()
    await logAdminActivity({
      actorId,
      action: 'plan.update',
      targetType: 'plan',
      targetId: id,
      summary: `Updated plan ${plan.slug}`,
      meta: input,
    })
    return { plan: toPublicPlan(plan) }
  },

  async remove(actorId: string, id: string) {
    if (!Types.ObjectId.isValid(id)) {
      throw new AppError('Plan not found.', HTTP_STATUS.NOT_FOUND)
    }
    const plan = await PlanModel.findById(id)
    if (!plan) throw new AppError('Plan not found.', HTTP_STATUS.NOT_FOUND)

    const usersOnPlan = await UserModel.countDocuments({ planId: plan.slug })
    if (usersOnPlan > 0) {
      throw new AppError(
        `Cannot delete plan with ${usersOnPlan} assigned user(s). Deactivate it instead.`,
        HTTP_STATUS.BAD_REQUEST,
      )
    }

    await plan.deleteOne()
    await logAdminActivity({
      actorId,
      action: 'plan.delete',
      targetType: 'plan',
      targetId: id,
      summary: `Deleted plan ${plan.slug}`,
    })
    return { message: 'Plan deleted.' }
  },
}
