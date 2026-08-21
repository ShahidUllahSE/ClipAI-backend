import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { uploadController } from './upload.controller'

const router = Router()

router.post('/', requireAuth, ...uploadController.upload)

export const uploadRoutes = router
