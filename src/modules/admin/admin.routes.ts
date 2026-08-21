import { Router } from 'express'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { adminController } from './admin.controller'
import {
  listUsersQuerySchema,
  updateUserSchema,
} from './admin.validation'

const router = Router()

router.use(requireAuth, requireAdmin)

router.get('/stats', adminController.stats)
router.get(
  '/users',
  validate(listUsersQuerySchema, 'query'),
  adminController.listUsers,
)
router.get('/users/:id', adminController.getUser)
router.patch(
  '/users/:id',
  validate(updateUserSchema),
  adminController.updateUser,
)
router.delete('/users/:id', adminController.deleteUser)
router.post('/users/:id/verify-email', adminController.verifyUserEmail)

export const adminRoutes = router
