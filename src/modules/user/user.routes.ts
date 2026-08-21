import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { userController } from './user.controller'
import {
  changePasswordSchema,
  forgotPasswordSchema,
  loginSchema,
  registerSchema,
  resetPasswordSchema,
  setPlanSchema,
  updateProfileSchema,
  verifyEmailSchema,
} from './user.validation'

const router = Router()

router.post('/register', validate(registerSchema), userController.register)
router.post('/login', validate(loginSchema), userController.login)
router.post('/logout', requireAuth, userController.logout)
router.get('/me', requireAuth, userController.me)
router.patch(
  '/profile',
  requireAuth,
  validate(updateProfileSchema),
  userController.updateProfile,
)
router.post(
  '/change-password',
  requireAuth,
  validate(changePasswordSchema),
  userController.changePassword,
)
router.post(
  '/forgot-password',
  validate(forgotPasswordSchema),
  userController.forgotPassword,
)
router.post(
  '/reset-password',
  validate(resetPasswordSchema),
  userController.resetPassword,
)
router.post(
  '/verify-email',
  validate(verifyEmailSchema),
  userController.verifyEmail,
)
router.post(
  '/resend-verification',
  requireAuth,
  userController.resendVerification,
)
router.post(
  '/plan',
  requireAuth,
  validate(setPlanSchema),
  userController.setPlan,
)
router.post(
  '/cancel-subscription',
  requireAuth,
  userController.cancelSubscription,
)
router.post('/use-credit', requireAuth, userController.useCredit)

export const userRoutes = router
