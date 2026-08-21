import type { NextFunction, Request, Response } from 'express'
import type { ZodTypeAny } from 'zod'
import { HTTP_STATUS } from '../constants/http'
import { AppError } from '../utils/AppError'

type RequestSource = 'body' | 'query' | 'params'

export function validate(schema: ZodTypeAny, source: RequestSource = 'body') {
  return (req: Request, _res: Response, next: NextFunction) => {
    const result = schema.safeParse(req[source])

    if (!result.success) {
      const message = result.error.issues[0]?.message ?? 'Invalid input.'
      return next(new AppError(message, HTTP_STATUS.BAD_REQUEST))
    }

    req[source] = result.data
    next()
  }
}
