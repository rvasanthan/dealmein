import type { Express, NextFunction, Request, Response } from 'express'
import { isApprovedAdmin, userRef, verifyGoogleToken } from './google-admin-auth.js'

export async function requireApprovedUser(req: Request, res: Response, next: NextFunction) {
  res.set('Cache-Control', 'private, no-store')
  try {
    const identity = await verifyGoogleToken(req.header('authorization'))
    if (!identity) { res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in with Google first.' }); return }
    if (!await isApprovedAdmin(identity) && (await userRef(identity.email).get()).get('status') !== 'approved') {
      res.status(403).json({ status: 403, code: 'USER_APPROVAL_REQUIRED', message: 'Account approval is required.' }); return
    }
    next()
  } catch (error) { next(error) }
}

export function registerDealAccessGuard(app: Express) {
  app.use(['/api/deals', '/api/categories', '/api/retailers'], requireApprovedUser)
}