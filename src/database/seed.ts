import { env } from '../config'
import { hashPassword } from '../utils/password'
import { UserModel } from '../modules/user/user.model'

export async function seedAdminUser(): Promise<void> {
  const email = env.ADMIN_EMAIL.toLowerCase()
  const passwordHash = await hashPassword(env.ADMIN_PASSWORD)
  const existing = await UserModel.findOne({ email }).select('+passwordHash')

  if (existing) {
    existing.role = 'admin'
    existing.isActive = true
    existing.emailVerified = true
    existing.passwordHash = passwordHash
    if (!existing.planId) existing.planId = 'unlimited'
    if (existing.remainingEdits == null) existing.remainingEdits = 9999
    await existing.save()
    console.log(`[ClipAI] Synced admin account: ${email}`)
    return
  }

  await UserModel.create({
    name: env.ADMIN_NAME,
    email,
    passwordHash,
    role: 'admin',
    isActive: true,
    emailVerified: true,
    planId: 'unlimited',
    remainingEdits: 9999,
    billingStatus: 'active',
  })

  console.log(`[ClipAI] Seeded admin account: ${email}`)
}
