import { Router } from 'express'
import { asyncHandler } from '../utils/asyncHandler'
import { sendSuccess } from '../utils/response'
import { adminRoutes } from '../modules/admin'
import { getPublicSettings } from '../modules/admin/public-settings'
import { captionRoutes } from '../modules/caption'
import { projectRoutes } from '../modules/project'
import { supportRoutes } from '../modules/support/support.routes'
import { uploadRoutes } from '../modules/upload'
import { userRoutes } from '../modules/user'

export const apiRouter = Router()

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'clipai-api' })
})

apiRouter.get(
  '/public/settings',
  asyncHandler(async (_req, res) => {
    sendSuccess(res, { settings: await getPublicSettings() })
  }),
)

apiRouter.use('/auth', userRoutes)
apiRouter.use('/admin', adminRoutes)
apiRouter.use('/support', supportRoutes)
apiRouter.use('/uploads', uploadRoutes)
apiRouter.use('/projects', projectRoutes)
apiRouter.use('/captions', captionRoutes)
