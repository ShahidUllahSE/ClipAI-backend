import { Router } from 'express'
import { requireAuth } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { projectController } from './project.controller'
import {
  createProjectSchema,
  updateProjectSchema,
} from './project.validation'

const router = Router()

router.use(requireAuth)

router.get('/', projectController.list)
router.post('/', validate(createProjectSchema), projectController.create)
router.get('/:id', projectController.get)
router.patch('/:id', validate(updateProjectSchema), projectController.update)
router.delete('/:id', projectController.remove)
router.post('/:id/process', projectController.process)
router.post('/:id/retry', projectController.retry)
router.get('/:id/job', projectController.job)

export const projectRoutes = router
