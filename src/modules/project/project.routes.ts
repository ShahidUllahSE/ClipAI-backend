import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { projectController } from './project.controller'
import {
  bulkDownloadSchema,
  createProjectSchema,
  updateProjectSchema,
} from './project.validation'

const router = Router()

router.use(requireAuth)

router.get('/', projectController.list)
router.post('/', validate(createProjectSchema), projectController.create)
router.post(
  '/download-bulk',
  validate(bulkDownloadSchema),
  projectController.downloadBulk,
)
router.get('/:id', projectController.get)
router.patch('/:id', validate(updateProjectSchema), projectController.update)
router.delete('/:id', projectController.remove)
router.post('/:id/process', projectController.process)
router.post('/:id/retry', projectController.retry)
router.get('/:id/job', projectController.job)
router.get('/:id/download', projectController.download)

export const projectRoutes = router
