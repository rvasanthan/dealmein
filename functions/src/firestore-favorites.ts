import type { Express } from 'express'
import { FieldValue } from 'firebase-admin/firestore'
import { db, isPublicDeal } from './firestore-api.js'

export function registerFavoritesApi(app: Express) {
  const favorites = (uid: string) => db.collection('dealmein_userFavorites').doc(uid).collection('deals')
  app.get('/api/favorites', async (_req, res, next) => {
    try {
      const snapshot = await favorites(res.locals.user.uid).orderBy('addedAt', 'desc').get()
      res.json(snapshot.docs.map((doc) => Number(doc.id)).filter((id) => Number.isSafeInteger(id) && id > 0))
    } catch (error) { next(error) }
  })
  app.put('/api/favorites/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) { res.status(400).json({ status: 400, code: 'BAD_REQUEST', message: 'Invalid deal ID.' }); return }
      const deal = await db.collection('dealmein_deals').doc(String(id)).get()
      if (!deal.exists || !isPublicDeal(deal.data()!)) { res.status(404).json({ status: 404, code: 'NOT_FOUND', message: 'Deal not found.' }); return }
      await favorites(res.locals.user.uid).doc(String(id)).set({ addedAt: FieldValue.serverTimestamp() }, { merge: true })
      res.json({ id, favorite: true })
    } catch (error) { next(error) }
  })
  app.delete('/api/favorites/:id', async (req, res, next) => {
    try {
      const id = Number(req.params.id)
      if (!/^[1-9]\d*$/.test(req.params.id) || !Number.isSafeInteger(id)) { res.status(400).json({ status: 400, code: 'BAD_REQUEST', message: 'Invalid deal ID.' }); return }
      await favorites(res.locals.user.uid).doc(String(id)).delete()
      res.json({ id, favorite: false })
    } catch (error) { next(error) }
  })
}