import type { NextFunction, Request, Response } from 'express'
import { MongoServerError } from 'mongodb'
import { Error as MongooseError } from 'mongoose'
import { env } from '../config'
import { HTTP_STATUS } from '../constants/http'
import { AppError } from '../utils/AppError'

export function notFoundHandler(
  _req: Request,
  _res: Response,
  next: NextFunction,
): void {
  next(new AppError('Route not found.', HTTP_STATUS.NOT_FOUND))
}

export function errorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  _next: NextFunction,
): void {
  if (err instanceof AppError) {
    res.status(err.statusCode).json({ message: err.message })
    return
  }

  if (err instanceof MongoServerError && err.code === 11000) {
    res
      .status(HTTP_STATUS.CONFLICT)
      .json({ message: 'An account with this email already exists.' })
    return
  }

  if (err instanceof MongooseError.ValidationError) {
    const message = Object.values(err.errors)[0]?.message ?? 'Validation failed.'
    res.status(HTTP_STATUS.BAD_REQUEST).json({ message })
    return
  }

  console.error(err)
  res.status(HTTP_STATUS.INTERNAL_ERROR).json({
    message:
      env.isDev && err instanceof Error ? err.message : 'Server error.',
  })
}
