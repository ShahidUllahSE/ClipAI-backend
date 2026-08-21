import { createHash, randomBytes } from 'crypto'

export function createRawToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex')
}

export function hashToken(raw: string): string {
  return createHash('sha256').update(raw).digest('hex')
}
