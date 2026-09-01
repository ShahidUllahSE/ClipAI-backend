import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { captionController } from './caption.controller'

const router = Router()

router.use(requireAuth)
router.post('/transcribe', ...captionController.transcribe)

export const captionRoutes = router
