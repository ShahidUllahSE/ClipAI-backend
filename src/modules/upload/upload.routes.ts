import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { uploadController } from './upload.controller'

const router = Router()

router.post('/sessions', requireAuth, uploadController.initializeSession)
router.get('/sessions/:sessionId', requireAuth, uploadController.getSession)
router.post(
  '/sessions/:sessionId/chunks/:index',
  requireAuth,
  ...uploadController.uploadChunk,
)
router.post(
  '/sessions/:sessionId/complete',
  requireAuth,
  uploadController.completeSession,
)
router.delete(
  '/sessions/:sessionId',
  requireAuth,
  uploadController.cancelSession,
)
router.post('/', requireAuth, ...uploadController.upload)

export const uploadRoutes = router
