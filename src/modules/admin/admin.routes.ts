import { Router } from 'express'
import { requireAuth, requireAdmin } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { adminController } from './admin.controller'
import {
  adjustTokensSchema,
  createPlanSchema,
  createTemplateSchema,
  createTicketSchema,
  createUserSchema,
  listActivityQuerySchema,
  listJobsQuerySchema,
  listProjectsQuerySchema,
  listSubscriptionsQuerySchema,
  listTicketsQuerySchema,
  listUsageQuerySchema,
  listUsersQuerySchema,
  replyTicketSchema,
  updatePlanSchema,
  updateSettingsSchema,
  updateTemplateSchema,
  updateTicketSchema,
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
router.post('/users', validate(createUserSchema), adminController.createUser)
router.get('/users/:id', adminController.getUser)
router.patch(
  '/users/:id',
  validate(updateUserSchema),
  adminController.updateUser,
)
router.post(
  '/users/:id/tokens',
  validate(adjustTokensSchema),
  adminController.adjustTokens,
)
router.delete('/users/:id', adminController.deleteUser)
router.post('/users/:id/verify-email', adminController.verifyUserEmail)

router.get(
  '/projects',
  validate(listProjectsQuerySchema, 'query'),
  adminController.listProjects,
)
router.get('/projects/:id', adminController.getProject)
router.delete('/projects/:id', adminController.deleteProject)
router.post('/projects/:id/retry', adminController.retryProject)

router.get(
  '/jobs',
  validate(listJobsQuerySchema, 'query'),
  adminController.listJobs,
)

router.get('/plans', adminController.listPlans)
router.post('/plans', validate(createPlanSchema), adminController.createPlan)
router.patch(
  '/plans/:id',
  validate(updatePlanSchema),
  adminController.updatePlan,
)
router.delete('/plans/:id', adminController.deletePlan)

router.get(
  '/subscriptions',
  validate(listSubscriptionsQuerySchema, 'query'),
  adminController.listSubscriptions,
)

router.get(
  '/usage',
  validate(listUsageQuerySchema, 'query'),
  adminController.listUsage,
)

router.get(
  '/tickets',
  validate(listTicketsQuerySchema, 'query'),
  adminController.listTickets,
)
router.post(
  '/tickets',
  validate(createTicketSchema),
  adminController.createTicket,
)
router.get('/tickets/:id', adminController.getTicket)
router.post(
  '/tickets/:id/reply',
  validate(replyTicketSchema),
  adminController.replyTicket,
)
router.patch(
  '/tickets/:id',
  validate(updateTicketSchema),
  adminController.updateTicket,
)

router.get('/templates', adminController.listTemplates)
router.post(
  '/templates',
  validate(createTemplateSchema),
  adminController.createTemplate,
)
router.patch(
  '/templates/:id',
  validate(updateTemplateSchema),
  adminController.updateTemplate,
)
router.delete('/templates/:id', adminController.deleteTemplate)

router.get(
  '/activity',
  validate(listActivityQuerySchema, 'query'),
  adminController.listActivity,
)

router.get('/exports/users', adminController.exportUsers)
router.get('/exports/usage', adminController.exportUsage)
router.get('/exports/revenue', adminController.exportRevenue)
router.get('/exports/activity', adminController.exportActivity)

router.get('/settings', adminController.getSettings)
router.patch(
  '/settings',
  validate(updateSettingsSchema),
  adminController.updateSettings,
)

export const adminRoutes = router
