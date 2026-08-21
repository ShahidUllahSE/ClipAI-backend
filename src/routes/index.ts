import { Router } from 'express'
import { adminRoutes } from '../modules/admin'
import { projectRoutes } from '../modules/project'
import { uploadRoutes } from '../modules/upload'
import { userRoutes } from '../modules/user'

export const apiRouter = Router()

apiRouter.get('/health', (_req, res) => {
  res.json({ ok: true, service: 'clipai-api' })
})

apiRouter.use('/auth', userRoutes)
apiRouter.use('/admin', adminRoutes)
apiRouter.use('/uploads', uploadRoutes)
apiRouter.use('/projects', projectRoutes)
