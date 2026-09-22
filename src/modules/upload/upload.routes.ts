import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { uploadController } from './upload.controller'
import { uploadSessionController } from './uploadSession.controller'

const router = Router()

router.post('/', requireAuth, ...uploadController.upload)

router.post('/sessions', requireAuth, uploadSessionController.create)
router.post(
  '/sessions/:sessionId/chunks/:index(\\d+)',
  requireAuth,
  ...uploadSessionController.uploadChunk,
)
router.post('/sessions/:sessionId/complete', requireAuth, uploadSessionController.complete)

export const uploadRoutes = router
