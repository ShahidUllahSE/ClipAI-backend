import { ActivityLogModel } from './models/activity-log.model'
import { UserModel } from '../user/user.model'

export async function logAdminActivity(input: {
  actorId: string
  action: string
  targetType?: string
  targetId?: string
  summary?: string
  meta?: Record<string, unknown> | null
}) {
  let actorEmail = ''
  try {
    const actor = await UserModel.findById(input.actorId).select('email').lean()
    actorEmail = actor?.email ?? ''
  } catch {
    actorEmail = ''
  }

  await ActivityLogModel.create({
    actorId: input.actorId,
    actorEmail,
    action: input.action,
    targetType: input.targetType ?? '',
    targetId: input.targetId ?? '',
    summary: input.summary ?? '',
    meta: input.meta ?? null,
  })
}
