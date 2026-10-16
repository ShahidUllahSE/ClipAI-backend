import { Router } from 'express'
import { z } from 'zod'
import { requireAuth } from '../../middleware/auth.middleware'
import { validate } from '../../middleware/validate.middleware'
import { asyncHandler } from '../../utils/asyncHandler'
import { sendSuccess } from '../../utils/response'
import { supportService } from './support.service'

const createSchema = z.object({
  subject: z.string().trim().min(1).max(160),
  body: z.string().trim().min(1).max(5000),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
})

const replySchema = z.object({
  body: z.string().trim().min(1).max(5000),
})

const router = Router()
router.use(requireAuth)

router.get(
  '/',
  asyncHandler(async (req, res) => {
    sendSuccess(res, await supportService.listMine(String(req.userId)))
  }),
)

router.post(
  '/',
  validate(createSchema),
  asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await supportService.create(String(req.userId), req.body),
      201,
    )
  }),
)

router.get(
  '/:id',
  asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await supportService.getMine(String(req.userId), String(req.params.id)),
    )
  }),
)

router.post(
  '/:id/reply',
  validate(replySchema),
  asyncHandler(async (req, res) => {
    sendSuccess(
      res,
      await supportService.reply(
        String(req.userId),
        String(req.params.id),
        req.body.body,
      ),
    )
  }),
)

export const supportRoutes = router
