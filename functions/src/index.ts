import express from 'express'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { onRequest } from 'firebase-functions/v2/https'
import { onSchedule } from 'firebase-functions/v2/scheduler'
import { expiryDateFor, registerFirestoreApi, registerFirestoreErrors, timingFor } from './firestore-api.js'
import { registerFirestoreAdminApi } from './firestore-admin.js'
import { registerDealAccessGuard } from './firestore-access.js'

const app = express()
app.use(express.json({ limit: '1mb' }))

registerDealAccessGuard(app)
registerFirestoreApi(app)
registerFirestoreAdminApi(app)
registerFirestoreErrors(app)

app.use((_req, res) => {
  res.status(404).json({ status: 404, code: 'NOT_FOUND', message: 'Not found.' })
})

export const api = onRequest({
  region: 'us-east1',
  maxInstances: 2,
  concurrency: 10,
  memory: '512MiB',
  timeoutSeconds: 540,
  secrets: ['APP_ADMIN_USERNAME'],
}, app)

export const expireDueOffers = onSchedule({
  schedule: 'every 1 minutes',
  timeZone: 'Etc/UTC',
  region: 'us-east1',
  maxInstances: 1,
}, async () => {
  const db = getFirestore()
  const published = await db.collection('dealmein_deals').where('expiresAt', '<=', new Date()).limit(250).get()
  const batch = db.batch()
  let count = 0
  for (const doc of published.docs) {
    const data = doc.data()
    if (data.status !== 'PUBLISHED' || data.dateStatus !== 'KNOWN') continue
    if (timingFor(data) !== 'expired') continue
    batch.update(doc.ref, { status: 'EXPIRED', featured: false, expiresAt: FieldValue.delete(), updatedAt: FieldValue.serverTimestamp() })
    batch.set(db.collection('dealmein_auditEvents').doc(), { actor: 'system', action: 'DEAL_AUTO_EXPIRED', entityType: 'deal',
      entityId: Number(doc.id), details: {}, createdAt: FieldValue.serverTimestamp() })
    count++
    if (count === 250) break
  }
  if (count) await batch.commit()
})

export const cleanupImportChunks = onSchedule({
  schedule: 'every 24 hours',
  timeZone: 'Etc/UTC',
  region: 'us-east1',
  maxInstances: 1,
}, async () => {
  const db = getFirestore()
  const expired = await db.collection('dealmein_importUploads').where('expiresAt', '<=', new Date()).limit(100).get()
  for (const session of expired.docs) {
    const chunks = await session.ref.collection('chunks').limit(400).get()
    const batch = db.batch()
    chunks.docs.forEach((chunk) => batch.delete(chunk.ref))
    if (!chunks.empty) await batch.commit()
    await session.ref.delete()
  }
})