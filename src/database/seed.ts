import { env } from '../config'
import { hashPassword } from '../utils/password'
import { UserModel } from '../modules/user/user.model'

export async function seedAdminUser(): Promise<void> {
  const email = env.ADMIN_EMAIL.toLowerCase()
  const existing = await UserModel.findOne({ email }).lean()

  if (existing) {
    if (existing.role !== 'admin') {
      await UserModel.updateOne(
        { email },
        {
          $set: {
            role: 'admin',
            isActive: true,
            emailVerified: true,
          },
        },
      )
      console.log(`[ClipAI] Promoted existing user to admin: ${email}`)
    }
    return
  }

  await UserModel.create({
    name: env.ADMIN_NAME,
    email,
    passwordHash: await hashPassword(env.ADMIN_PASSWORD),
    role: 'admin',
    isActive: true,
    emailVerified: true,
    planId: 'unlimited',
    remainingEdits: 9999,
    billingStatus: 'active',
  })

  console.log(`[ClipAI] Seeded admin account: ${email}`)
}
