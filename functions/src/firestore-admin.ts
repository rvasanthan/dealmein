import { randomUUID } from 'node:crypto'
import { FieldPath, FieldValue } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import multer from 'multer'
import type { Express, NextFunction, Request, Response } from 'express'
import { asIso, db, expiryDateFor, firestoreDeal, timingFor } from './firestore-api.js'
import { registerFirestoreImportApi } from './firestore-import.js'
import { adminRef, isApprovedAdmin, isBootstrapAdmin, userRef, verifyGoogleToken } from './google-admin-auth.js'

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } })
export function registerFirestoreAdminApi(app: Express) {
  app.post('/api/user/access-request', async (req, res, next) => {
    try {
      const identity = await verifyGoogleToken(req.header('authorization'))
      if (!identity) { res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in with Google first.' }); return }
      if (await isApprovedAdmin(identity)) { res.json({ status: 'approved', email: identity.email, role: 'admin' }); return }
      const ref = userRef(identity.email)
      const status = await db.runTransaction(async (tx) => {
        const account = await tx.get(ref)
        if (account.exists) return String(account.get('status'))
        tx.create(ref, { email: identity.email, name: identity.name, uid: identity.uid, status: 'pending', requestedAt: FieldValue.serverTimestamp() })
        return 'pending'
      })
      res.json({ status, email: identity.email, role: 'user' })
    } catch (error) { next(error) }
  })
  app.get('/api/user/session', async (req, res, next) => {
    try {
      const identity = await verifyGoogleToken(req.header('authorization'))
      if (!identity) { res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in with Google first.' }); return }
      const admin = await isApprovedAdmin(identity)
      if (!admin && (await userRef(identity.email).get()).get('status') !== 'approved') {
        res.status(403).json({ status: 403, code: 'USER_APPROVAL_REQUIRED', message: 'Account approval is required.' }); return
      }
      res.json({ email: identity.email, name: identity.name, role: admin ? 'admin' : 'user' })
    } catch (error) { next(error) }
  })
  app.post('/api/access/request', async (req, res, next) => {
    try {
      const identity = await verifyGoogleToken(req.header('authorization'))
      if (!identity) { res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in with Google first.' }); return }
      if (isBootstrapAdmin(identity.email)) { res.json({ status: 'approved', email: identity.email }); return }
      const ref = adminRef(identity.email)
      const status = await db.runTransaction(async (tx) => {
        const account = await tx.get(ref)
        if (account.exists) return String(account.get('status'))
        tx.create(ref, { email: identity.email, name: identity.name, uid: identity.uid, status: 'pending', requestedAt: FieldValue.serverTimestamp() })
        return 'pending'
      })
      res.json({ status, email: identity.email })
    } catch (error) { next(error) }
  })

  app.use('/api/admin', auth)
  registerFirestoreImportApi(app)
  app.get('/api/admin/me', (_req, res) => res.json({ username: res.locals.actor }))
  app.get('/api/admin/users', async (_req, res, next) => {
    try {
      const [accounts, admins] = await Promise.all([
        db.collection('dealmein_userAccounts').orderBy('email').get(),
        db.collection('dealmein_adminAccounts').where('status', '==', 'approved').get(),
      ])
      const adminEmails = new Set(admins.docs.map((doc) => String(doc.get('email')).toLowerCase()))
      res.json(accounts.docs.map((doc) => {
        const email = String(doc.get('email'))
        const isAdmin = isBootstrapAdmin(email.toLowerCase()) || adminEmails.has(email.toLowerCase())
        return { email, name: doc.get('name') ?? null, status: isAdmin ? 'approved' : doc.get('status'), role: isAdmin ? 'admin' : 'user',
          requestedAt: asIso(doc.get('requestedAt')), updatedAt: asIso(doc.get('updatedAt')) }
      }))
    } catch (error) { next(error) }
  })
  app.put('/api/admin/users', async (req, res, next) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      const status = req.body?.status
      const role = req.body?.role
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['approved', 'revoked'].includes(status)
        || (status === 'approved' && !['user', 'admin'].includes(role))) throw apiError('Provide a valid email, approval status and role.')
      if ((status === 'revoked' || role === 'user') && isBootstrapAdmin(email)) throw apiError('The initial administrator cannot be changed here.')
      if ((status === 'revoked' || role === 'user') && email === res.locals.actor) throw apiError('You cannot revoke or remove your own administrator access.')
      const ref = userRef(email)
      const adminAccountRef = adminRef(email)
      await db.runTransaction(async (tx) => {
        const [account, adminAccount] = await Promise.all([tx.get(ref), tx.get(adminAccountRef)])
        if (!account.exists) throw apiError('User request not found.', 404)
        tx.update(ref, { status, updatedBy: res.locals.actor, updatedAt: FieldValue.serverTimestamp() })
        if (status === 'approved' && role === 'admin') {
          tx.set(adminAccountRef, { email, status: 'approved', updatedBy: res.locals.actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
        } else if (adminAccount.exists && adminAccount.get('status') !== 'revoked') {
          tx.update(adminAccountRef, { status: 'revoked', updatedBy: res.locals.actor, updatedAt: FieldValue.serverTimestamp() })
        }
        tx.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor,
          action: status === 'approved' ? 'USER_APPROVED' : 'USER_REVOKED', entityType: 'user', entityId: email,
          details: { role: status === 'approved' ? role : null }, createdAt: FieldValue.serverTimestamp() })
      })
      res.json({ email, status, role: status === 'approved' ? role : null })
    } catch (error) { next(error) }
  })
  app.get('/api/admin/accounts', async (_req, res, next) => {
    try {
      const accounts = await db.collection('dealmein_adminAccounts').orderBy('email').limit(500).get()
      res.json(accounts.docs.map((doc) => ({ email: doc.get('email'), name: doc.get('name') ?? null,
        status: doc.get('status'), requestedAt: asIso(doc.get('requestedAt')), updatedAt: asIso(doc.get('updatedAt')) })))
    } catch (error) { next(error) }
  })
  app.put('/api/admin/accounts', async (req, res, next) => {
    try {
      const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : ''
      const status = req.body?.status
      if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !['approved', 'revoked'].includes(status)) throw apiError('Provide a valid email and approval status.')
      if (isBootstrapAdmin(email)) throw apiError('The initial administrator cannot be changed here.')
      if (email === res.locals.actor && status === 'revoked') throw apiError('You cannot revoke your own administrator access.')
      const batch = db.batch()
      batch.set(adminRef(email), { email, status, updatedBy: res.locals.actor, updatedAt: FieldValue.serverTimestamp() }, { merge: true })
      batch.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor, action: status === 'approved' ? 'ADMIN_APPROVED' : 'ADMIN_REVOKED',
        entityType: 'admin', entityId: email, details: {}, createdAt: FieldValue.serverTimestamp() })
      await batch.commit()
      res.json({ email, status })
    } catch (error) { next(error) }
  })
  app.get('/api/admin/stats', async (_req, res, next) => {
    try {
      const snapshot = await db.collection('dealmein_deals').get()
      const stats: Record<string, number> = { draft: 0, published: 0, expired: 0, archived: 0, openReports: 0 }
      snapshot.forEach((doc) => { const key = String(doc.get('status') ?? '').toLowerCase(); if (key in stats) stats[key]++ })
      const reports = await db.collection('dealmein_visitorReports').where('status', '==', 'OPEN').count().get()
      stats.openReports = reports.data().count
      res.json(stats)
    } catch (error) { next(error) }
  })
  app.get('/api/admin/deals', async (req, res, next) => {
    try {
      const filters = parseAdminFilters(req)
      const snapshot = await db.collection('dealmein_deals').get()
      const groupCounts = new Map<string, number>()
      snapshot.docs.forEach((doc) => { const key = doc.get('candidateGroupKey'); if (key) groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1) })
      const deals = snapshot.docs.map((doc) => firestoreDeal(doc.id, { ...doc.data(), relatedCount: Math.max(0, (groupCounts.get(doc.get('candidateGroupKey')) ?? 1) - 1) }, true))
        .filter((deal) => adminMatches(deal, filters))
        .sort((a, b) => sortAdmin(a, b, filters))
      const start = (filters.page - 1) * filters.size
      res.json({ items: deals.slice(start, start + filters.size), page: filters.page, size: filters.size,
        total: deals.length, totalPages: Math.ceil(deals.length / filters.size) })
    } catch (error) { next(error) }
  })
  app.get('/api/admin/deals/:id(\\d+)', async (req, res, next) => {
    try {
      const id = parseId(String((req.params as Record<string, string>).id))
      const ref = db.collection('dealmein_deals').doc(String(id))
      const doc = await ref.get()
      if (!doc.exists) throw apiError('Deal not found.', 404)
      const [sources, audit] = await Promise.all([
        ref.collection('sources').orderBy('id').get(),
        db.collection('dealmein_auditEvents').where('entityId', '==', id).limit(200).get(),
      ])
      const data = firestoreDeal(doc.id, doc.data()!, true)
      const related = data.candidateGroupKey ? await db.collection('dealmein_deals').where('candidateGroupKey', '==', data.candidateGroupKey).limit(21).get() : null
      const relatedCount = related ? Math.max(0, related.size - 1) : 0
      res.json({ ...data, relatedCount, sources: sources.docs.map((source) => source.data()),
        listingLink: sources.docs.map((source) => source.get('url')).find(Boolean) ?? null,
        related: related?.docs.filter((item) => item.id !== doc.id && item.get('status') !== 'ARCHIVED').slice(0, 20)
          .map((item) => firestoreDeal(item.id, item.data(), true)) ?? [],
        audit: audit.docs.filter((event) => event.get('entityType') === 'deal')
          .sort((a, b) => dateValue(b.get('createdAt')) - dateValue(a.get('createdAt'))).slice(0, 50)
          .map((event) => ({ id: event.id, ...event.data(), createdAt: asIso(event.get('createdAt')) })) })
    } catch (error) { next(error) }
  })
  app.post('/api/admin/deals/bulk-publish', async (req, res, next) => {
    try {
      if (req.body?.confirmUnverified !== true) throw apiError('Confirm that these deals may be unverified.')
      const cursor = req.body?.cursor
      if (cursor !== undefined && (typeof cursor !== 'string' || !/^\d+$/.test(cursor))) throw apiError('Invalid cursor.')
      let query = db.collection('dealmein_deals').where('status', '==', 'DRAFT').orderBy(FieldPath.documentId()).limit(100)
      if (cursor) query = query.startAfter(cursor)
      const snapshot = await query.get()
      const result = { published: 0, expired: 0, changed: 0, failed: 0, cursor: snapshot.size === 100 ? snapshot.docs[snapshot.size - 1].id : null }
      for (let offset = 0; offset < snapshot.size; offset += 10) {
        const outcomes = await Promise.allSettled(snapshot.docs.slice(offset, offset + 10).map((doc) => db.runTransaction(async (tx) => {
          const current = await tx.get(doc.ref)
          const data = current.data()
          if (!data || data.status !== 'DRAFT') return 'changed' as const
          if (timingFor(data) === 'expired') return 'expired' as const
          tx.update(doc.ref, { status: 'PUBLISHED', publishedAt: FieldValue.serverTimestamp(),
            expiresAt: expiryDateFor(data), reviewedAt: null, reviewedBy: null, updatedAt: FieldValue.serverTimestamp() })
          tx.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor, action: 'DEAL_BULK_PUBLISHED',
            entityType: 'deal', entityId: Number(doc.id), details: { unverified: true }, createdAt: FieldValue.serverTimestamp() })
          return 'published' as const
        })))
        for (const outcome of outcomes) {
          if (outcome.status === 'fulfilled') result[outcome.value]++
          else result.failed++
        }
      }
      res.json(result)
    } catch (error) { next(error) }
  })
  app.post('/api/admin/deals/:id/publish', async (req, res, next) => {
    try {
      if (!['identity', 'link', 'price', 'conditions', 'timing'].every((key) => req.body?.[key] === true)) {
        throw apiError('Confirm that product identity, retailer link, price, conditions and timing have all been checked.')
      }
      const ref = db.collection('dealmein_deals').doc(String(parseId(String(req.params.id))))
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref)
        if (!doc.exists) throw apiError('Deal not found.', 404)
        const data = doc.data()!
        if (data.status !== 'DRAFT') throw Object.assign(new Error(`Only draft offers can be published (current status: ${data.status}).`), { status: 409, code: 'CONFLICT' })
        if (timingFor(data) === 'expired') throw Object.assign(new Error("This offer's sale period has already ended. Correct the dates or archive it."), { status: 409, code: 'CONFLICT' })
        tx.update(ref, { status: 'PUBLISHED', publishedAt: FieldValue.serverTimestamp(), reviewedAt: FieldValue.serverTimestamp(),
          expiresAt: expiryDateFor(data), reviewedBy: res.locals.actor, updatedAt: FieldValue.serverTimestamp(),
          reviewFlags: (data.reviewFlags ?? []).filter((flag: string) => flag !== 'MATERIAL_CHANGE') })
        tx.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor, action: 'DEAL_PUBLISHED', entityType: 'deal',
          entityId: parseId(req.params.id), details: { checklist: req.body }, createdAt: FieldValue.serverTimestamp() })
      })
      res.json({ ok: true })
    } catch (error) { next(error) }
  })
  app.post('/api/admin/deals/:id/status', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      const target = String(req.body?.status ?? '').toUpperCase()
      const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim() : ''
      if (!['DRAFT', 'EXPIRED', 'ARCHIVED'].includes(target)) throw apiError('status must be DRAFT, EXPIRED or ARCHIVED. Use the publish action to publish.')
      if (target === 'ARCHIVED' && reason.length > 200) throw apiError('Reason is too long.')
      const ref = db.collection('dealmein_deals').doc(String(id))
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref)
        if (!doc.exists) throw apiError('Deal not found.', 404)
        const data = doc.data()!
        if (data.status === target) throw Object.assign(new Error(`The deal is already ${target}.`), { status: 409, code: 'CONFLICT' })
        if (data.status === 'ARCHIVED' && data.mergedIntoId && target === 'DRAFT') throw Object.assign(new Error("Merged offers can't be restored."), { status: 409, code: 'CONFLICT' })
        tx.update(ref, { status: target, archiveReason: target === 'ARCHIVED' ? reason || 'ARCHIVED' : null,
          featured: false, expiresAt: FieldValue.delete(), publishedAt: target === 'EXPIRED' ? data.publishedAt : null, updatedAt: FieldValue.serverTimestamp() })
        tx.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor, action: 'DEAL_STATUS_CHANGED', entityType: 'deal',
          entityId: id, details: { from: data.status, to: target, reason: reason || null }, createdAt: FieldValue.serverTimestamp() })
      })
      res.json({ ok: true })
    } catch (error) { next(error) }
  })
  app.post('/api/admin/deals/:id/featured', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      const ref = db.collection('dealmein_deals').doc(String(id))
      await db.runTransaction(async (tx) => {
        const doc = await tx.get(ref)
        if (!doc.exists) throw apiError('Deal not found.', 404)
        const featured = req.body?.featured === true
        if (featured && doc.get('status') !== 'PUBLISHED') throw Object.assign(new Error('Only published offers can be featured.'), { status: 409, code: 'CONFLICT' })
        tx.update(ref, { featured, updatedAt: FieldValue.serverTimestamp() })
        tx.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor, action: featured ? 'DEAL_FEATURED' : 'DEAL_UNFEATURED',
          entityType: 'deal', entityId: id, details: {}, createdAt: FieldValue.serverTimestamp() })
      })
      res.json({ ok: true })
    } catch (error) { next(error) }
  })

  app.get('/api/admin/deals/merge-preview', async (req, res, next) => {
    try {
      const primaryId = parseId(String(req.query.primaryId ?? ''))
      const secondaryId = parseId(String(req.query.secondaryId ?? ''))
      if (primaryId === secondaryId) throw apiError('Choose two different offers.')
      const [primary, secondary] = await Promise.all([loadDeal(primaryId), loadDeal(secondaryId)]) as Array<Record<string, any> | null>
      if (!primary) throw apiError('Primary deal not found.', 404)
      if (!secondary) throw apiError('Secondary deal not found.', 404)
      const fields = ['title', 'variant', 'model', 'seller', 'condition', 'offerType', 'category', 'retailer', 'listedCashPrice',
        'sourcePrice', 'sourcePriceText', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice', 'startsOn', 'endsOn', 'dateText', 'productUrl']
      const conflict = new Set(['listedCashPrice', 'sourcePrice', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice'])
      const differences = fields.flatMap((field) => {
        const a = flatten(primary[field]); const b = flatten(secondary[field])
        return JSON.stringify(a) === JSON.stringify(b) ? [] : [{ field, primary: a, secondary: b, requiresChoice: conflict.has(field) }]
      })
      const changed = new Set(differences.map((item) => item.field))
      const warnings: string[] = []
      if (changed.has('retailer')) warnings.push('These offers are from different retailers and should normally stay separate.')
      if (changed.has('variant') || changed.has('model')) warnings.push('Variant or model differs (size, width, color, capacity or pack quantity).')
      if (changed.has('condition')) warnings.push('New, used and refurbished items should stay separate.')
      if (changed.has('startsOn') || changed.has('endsOn')) warnings.push('The sale periods differ.')
      if (changed.has('conditionsText') || changed.has('rewardText') || changed.has('rewardAmount')) warnings.push('Coupon, membership, gift-card or rebate conditions differ.')
      res.json({ primary, secondary, differences, warnings, sourcesToMove: secondary.sources ?? [] })
    } catch (error) { next(error) }
  })

  app.post('/api/admin/deals/merge', async (req, res, next) => {
    try {
      const primaryId = parseId(String(req.body?.primaryId ?? ''))
      const secondaryId = parseId(String(req.body?.secondaryId ?? ''))
      if (primaryId === secondaryId) throw apiError('Choose two different offers.')
      const primaryRef = db.collection('dealmein_deals').doc(String(primaryId))
      const secondaryRef = db.collection('dealmein_deals').doc(String(secondaryId))
      const [primarySnap, secondarySnap] = await Promise.all([primaryRef.get(), secondaryRef.get()])
      if (!primarySnap.exists) throw apiError('Primary deal not found.', 404)
      if (!secondarySnap.exists) throw apiError('Secondary deal not found.', 404)
      const primary = primarySnap.data()!
      const secondary = secondarySnap.data()!
      const resolutions = req.body?.resolutions && typeof req.body.resolutions === 'object' ? req.body.resolutions as Record<string, string> : {}
      const conflictFields = new Set(['listedCashPrice', 'sourcePrice', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice'])
      const comparable = ['title', 'variant', 'model', 'seller', 'condition', 'offerType', 'category', 'retailer', 'listedCashPrice', 'sourcePrice',
        'sourcePriceText', 'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice', 'startsOn', 'endsOn', 'dateText', 'productUrl']
      const differences = comparable.filter((field) => JSON.stringify(flatten(primary[field])) !== JSON.stringify(flatten(secondary[field])))
      const changed = new Set(differences)
      const hasWarnings = changed.has('retailer') || changed.has('variant') || changed.has('model') || changed.has('condition')
        || changed.has('startsOn') || changed.has('endsOn') || changed.has('conditionsText') || changed.has('rewardText') || changed.has('rewardAmount')
      for (const field of differences) if (conflictFields.has(field) && !resolutions[field]) {
        throw Object.assign(new Error(`Choose which value to keep for '${field}'. Conflicting prices and conditions are never resolved automatically.`), { status: 409, code: 'RESOLUTION_REQUIRED' })
      }
      if (Object.values(resolutions).some((value) => !['primary', 'secondary'].includes(value))) throw apiError("Resolution must be 'primary' or 'secondary'.")
      if (hasWarnings && req.body?.acknowledgeWarnings !== true) {
        throw Object.assign(new Error('Acknowledge the merge warnings to continue.'), { status: 409, code: 'WARNINGS_NOT_ACKNOWLEDGED' })
      }
      const chosen: Record<string, unknown> = {}
      const editable = new Set(['title', 'variant', 'model', 'seller', 'condition', 'offerType', 'sourcePriceText', 'originalPriceText',
        'conditionsText', 'rewardText', 'rewardAmount', 'referencePrice', 'referencePriceText', 'startsOn', 'endsOn', 'startsAt', 'endsAt', 'dateText', 'productUrl'])
      for (const [field, choice] of Object.entries(resolutions)) if (choice === 'secondary' && editable.has(field)) chosen[field] = secondary[field] ?? null
      const sourceSnap = await secondaryRef.collection('sources').get()
      const reportsSnap = await db.collection('dealmein_visitorReports').where('dealId', '==', secondaryId).get()
      if (sourceSnap.size * 2 + reportsSnap.size + 3 > 500) throw apiError('This merge is too large to complete atomically.')
      const batch = db.batch()
      const openReportCount = reportsSnap.docs.filter((report) => report.get('status') === 'OPEN').length
      batch.update(primaryRef, { ...chosen, openReports: FieldValue.increment(openReportCount),
        overrides: { ...(primary.overrides ?? {}), ...Object.fromEntries(Object.keys(chosen).map((field) => [field, true])) }, updatedAt: FieldValue.serverTimestamp() })
      for (const source of sourceSnap.docs) {
        const duplicate = await primaryRef.collection('sources').where('ref', '==', source.get('ref')).limit(1).get()
        const ref = duplicate.empty ? source.get('ref') : `${source.get('ref')} [merged from deal ${secondaryId}]`
        batch.set(primaryRef.collection('sources').doc(slugify(String(ref))), { ...source.data(), ref })
        batch.delete(source.ref)
      }
      reportsSnap.docs.forEach((report) => batch.update(report.ref, { dealId: primaryId, dealTitle: primary.title }))
      batch.update(secondaryRef, { status: 'ARCHIVED', archiveReason: 'MERGED', mergedIntoId: primaryId, featured: false, openReports: 0,
        expiresAt: FieldValue.delete(), publishedAt: null, updatedAt: FieldValue.serverTimestamp() })
      batch.set(db.collection('dealmein_auditEvents').doc(), { actor: res.locals.actor, action: 'DEALS_MERGED', entityType: 'deal', entityId: primaryId,
        details: { secondaryId, resolutions, differences }, createdAt: FieldValue.serverTimestamp() })
      await batch.commit()
      res.json({ ok: true })
    } catch (error) { next(error) }
  })

  app.patch('/api/admin/deals/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      const ref = db.collection('dealmein_deals').doc(String(id))
      const body = req.body as Record<string, unknown> | null
      if (!body || typeof body !== 'object' || Array.isArray(body) || !Object.keys(body).length) throw apiError('No changes supplied.')
      const editable: Record<string, { key: string; kind: string; max?: number; values?: string[]; tracked?: boolean }> = {
        title: { key: 'title', kind: 'string', max: 300, tracked: true }, variant: { key: 'variant', kind: 'string', max: 300, tracked: true },
        model: { key: 'model', kind: 'string', max: 120, tracked: true }, seller: { key: 'seller', kind: 'string', max: 200, tracked: true },
        condition: { key: 'condition', kind: 'enum', values: ['NEW', 'USED', 'REFURBISHED', 'UNKNOWN'], tracked: true },
        offerType: { key: 'offerType', kind: 'enum', values: ['PRODUCT', 'STOREWIDE'], tracked: true },
        sourcePriceText: { key: 'sourcePriceText', kind: 'string', max: 500, tracked: true }, originalPriceText: { key: 'originalPriceText', kind: 'string', max: 500, tracked: true },
        conditionsText: { key: 'conditionsText', kind: 'string', max: 2000, tracked: true }, rewardText: { key: 'rewardText', kind: 'string', max: 1000, tracked: true },
        taxNote: { key: 'taxNote', kind: 'string', max: 500 }, referencePriceText: { key: 'referencePriceText', kind: 'string', max: 500, tracked: true },
        dateText: { key: 'dateText', kind: 'string', max: 500, tracked: true }, listedCashPrice: { key: 'listedCashPrice', kind: 'money', tracked: true },
        sourcePrice: { key: 'sourcePrice', kind: 'money', tracked: true }, rewardAmount: { key: 'rewardAmount', kind: 'money', tracked: true },
        shippingCost: { key: 'shippingCost', kind: 'money' }, referencePrice: { key: 'referencePrice', kind: 'money', tracked: true },
        startsOn: { key: 'startsOn', kind: 'date', tracked: true }, endsOn: { key: 'endsOn', kind: 'date', tracked: true },
        startsAt: { key: 'startsAt', kind: 'instant', tracked: true }, endsAt: { key: 'endsAt', kind: 'instant', tracked: true },
        dateStatus: { key: 'dateStatus', kind: 'enum', values: ['KNOWN', 'UNKNOWN', 'CONFLICT'], tracked: true },
        productUrl: { key: 'productUrl', kind: 'url', tracked: true }, imageUrl: { key: 'imageUrl', kind: 'url' },
      }
      const errors: Record<string, string> = {}
      const changes: Record<string, unknown> = {}
      const updates: Record<string, unknown> = { updatedAt: FieldValue.serverTimestamp() }
      const overrideMarks: Record<string, boolean> = {}
      const beforeDoc = await ref.get()
      if (!beforeDoc.exists) throw apiError('Deal not found.', 404)
      const before = beforeDoc.data()!
      for (const [field, raw] of Object.entries(body)) {
        if (field === 'imageAuthorized' || field === 'productUrlVerified' || field === 'category') continue
        const spec = editable[field]
        if (!spec) { errors[field] = "This field can't be edited."; continue }
        try {
          const value = coerceEdit(field, raw, spec)
          updates[spec.key] = value
          if (spec.tracked) overrideMarks[spec.key] = true
          changes[field] = { from: before[spec.key] ?? null, to: value }
        } catch (error) { errors[field] = (error as Error).message }
      }
      if ('category' in body) {
        const categoryDoc = await db.collection('dealmein_categories').doc(String(body.category)).get()
        if (!categoryDoc.exists) errors.category = 'Unknown category.'
        else { updates.category = { name: categoryDoc.get('name'), slug: categoryDoc.get('slug') }; overrideMarks.category = true }
      }
      if ('productUrl' in body || 'productUrlVerified' in body) {
        const url = 'productUrl' in body ? coerceEdit('productUrl', body.productUrl, editable.productUrl) : before.productUrl
        const verified = body.productUrlVerified === true
        if (verified && !url) errors.productUrlVerified = 'Enter a product URL before marking it verified.'
        updates.productUrl = url ?? null
        updates.productUrlVerified = Boolean(verified && url)
        changes.productUrlVerified = { to: Boolean(verified && url) }
      }
      if ('imageUrl' in body || 'imageAuthorized' in body) {
        const imageUrl = 'imageUrl' in body ? coerceEdit('imageUrl', body.imageUrl, editable.imageUrl) : before.imageUrl
        const authorized = body.imageAuthorized === true
        if (authorized && !imageUrl) errors.imageAuthorized = 'Add an image before confirming it is authorized.'
        updates.imageUrl = imageUrl ?? null
        updates.imageAuthorized = Boolean(authorized && imageUrl)
        changes.imageAuthorized = { to: Boolean(authorized && imageUrl) }
      }
      if (Object.keys(errors).length) throw Object.assign(new Error('Some fields are invalid.'), { status: 400, code: 'VALIDATION_FAILED', details: errors })
      const startsOn = String(updates.startsOn ?? before.startsOn ?? '')
      const endsOn = String(updates.endsOn ?? before.endsOn ?? '')
      if (startsOn && endsOn && startsOn > endsOn) throw apiError('The start date is after the end date.')
      updates.overrides = { ...(before.overrides ?? {}), ...overrideMarks }
      if ((updates.status ?? before.status) === 'PUBLISHED') updates.expiresAt = expiryDateFor({ ...before, ...updates })
      else updates.expiresAt = FieldValue.delete()
      await ref.update(updates)
      await writeAudit(res.locals.actor, 'DEAL_EDITED', 'deal', id, { changes })
      res.json({ ok: true })
    } catch (error) { next(error) }
  })

  app.get('/api/admin/reports', async (req, res, next) => {
    try {
      const status = typeof req.query.status === 'string' ? req.query.status.toUpperCase() : ''
      if (status && !['OPEN', 'RESOLVED', 'DISMISSED'].includes(status)) throw apiError('Unknown report status.')
      const snapshot = await db.collection('dealmein_visitorReports').orderBy('createdAt', 'desc').limit(200).get()
      const reports: Record<string, any>[] = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data() }))
      res.json(reports.filter((report) => !status || report.status === status).map((report) => ({ ...report, createdAt: asIso(report.createdAt), resolvedAt: asIso(report.resolvedAt) })))
    } catch (error) { next(error) }
  })
  app.post('/api/admin/reports/:id/resolve', async (req, res, next) => {
    try {
      const status = String(req.body?.status ?? '').toUpperCase()
      if (!['RESOLVED', 'DISMISSED'].includes(status)) throw apiError('status must be RESOLVED or DISMISSED.')
      const ref = db.collection('dealmein_visitorReports').doc(req.params.id)
      const doc = await ref.get()
      if (!doc.exists) throw apiError('Report not found.', 404)
      await db.runTransaction(async (tx) => {
        const fresh = await tx.get(ref)
        if (!fresh.exists) throw apiError('Report not found.', 404)
        tx.update(ref, { status, resolvedBy: res.locals.actor, resolvedAt: FieldValue.serverTimestamp() })
        if (fresh.get('status') === 'OPEN') tx.update(db.collection('dealmein_deals').doc(String(fresh.get('dealId'))), { openReports: FieldValue.increment(-1) })
      })
      await writeAudit(res.locals.actor, `REPORT_${status}`, 'report', req.params.id, { status })
      res.json({ ok: true })
    } catch (error) { next(error) }
  })
  app.get('/api/admin/audit', async (req, res, next) => {
    try {
      const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 100))
      const snapshot = await db.collection('dealmein_auditEvents').orderBy('createdAt', 'desc').limit(limit).get()
      const type = typeof req.query.entityType === 'string' ? req.query.entityType : ''
      const id = typeof req.query.entityId === 'string' ? req.query.entityId : ''
      const events: Record<string, any>[] = snapshot.docs.map((doc) => ({ id: doc.id, ...doc.data(), createdAt: asIso(doc.get('createdAt')) }))
      res.json(events.filter((event) => (!type || event.entityType === type) && (!id || String(event.entityId) === id)))
    } catch (error) { next(error) }
  })
  app.get('/api/admin/retailers', async (_req, res, next) => {
    try {
      const snapshot = await db.collection('dealmein_retailers').orderBy('name').get()
      res.json(snapshot.docs.map((doc) => ({ id: Number(doc.get('id')), ...doc.data() })))
    } catch (error) { next(error) }
  })
  app.patch('/api/admin/retailers/:id', async (req, res, next) => {
    try {
      const id = parseId(String(req.params.id))
      const timezone = typeof req.body?.timezone === 'string' && req.body.timezone.trim() ? req.body.timezone.trim() : null
      if (timezone) { try { new Intl.DateTimeFormat('en-US', { timeZone: timezone }).format() } catch { throw apiError('Unknown timezone. Use an IANA name such as America/New_York.') } }
      const query = await db.collection('dealmein_retailers').where('id', '==', id).limit(1).get()
      if (query.empty) throw apiError('Retailer not found.', 404)
      await query.docs[0].ref.update({ timezone })
      const deals = await db.collection('dealmein_deals').where('retailer.slug', '==', query.docs[0].get('slug')).get()
      for (let offset = 0; offset < deals.docs.length; offset += 450) {
        const batch = db.batch()
        deals.docs.slice(offset, offset + 450).forEach((deal) => {
          const value = deal.data()
          batch.update(deal.ref, { retailerTimezone: timezone,
            expiresAt: value.status === 'PUBLISHED' ? expiryDateFor({ ...value, retailerTimezone: timezone }) : FieldValue.delete() })
        })
        await batch.commit()
      }
      await writeAudit(res.locals.actor, 'RETAILER_TIMEZONE_SET', 'retailer', id, { timezone })
      res.json({ id, timezone })
    } catch (error) { next(error) }
  })
  app.get('/api/admin/deals/export.csv', async (req, res, next) => {
    try {
      const snapshot = await db.collection('dealmein_deals').limit(2000).get()
      const filters = parseAdminFilters(req)
      const groupCounts = new Map<string, number>()
      snapshot.docs.forEach((doc) => { const key = doc.get('candidateGroupKey'); if (key) groupCounts.set(key, (groupCounts.get(key) ?? 0) + 1) })
      const header = ['id', 'source_record_id', 'title', 'variant', 'retailer', 'category', 'status', 'listed_cash_price', 'source_price_text', 'conditions', 'dates', 'timing', 'product_url', 'product_url_verified', 'review_flags']
      const cell = (value: unknown) => `"${String(value ?? '').replaceAll('"', '""')}"`
      const lines = [header.map(cell).join(',')]
      snapshot.docs.map((doc) => ({ doc, deal: firestoreDeal(doc.id, { ...doc.data(), relatedCount: Math.max(0, (groupCounts.get(doc.get('candidateGroupKey')) ?? 1) - 1) }, true) }))
        .filter(({ deal }) => adminMatches(deal, filters)).forEach(({ doc, deal }) => {
        const d = doc.data()
        lines.push([doc.id, d.sourceRecordId, d.title, d.variant, d.retailer?.name, d.category?.name, d.status, d.listedCashPrice,
          d.sourcePriceText, d.conditionsText, d.dateText, timingFor(d), d.productUrl, d.productUrlVerified, (d.reviewFlags ?? []).join(';')].map(cell).join(','))
      })
      await writeAudit(res.locals.actor, 'DEALS_EXPORTED', 'deal', null, {})
      res.set('Content-Type', 'text/csv; charset=utf-8').set('Content-Disposition', 'attachment; filename="deal-me-in-deals.csv"').send(lines.join('\r\n'))
    } catch (error) { next(error) }
  })
  app.post('/api/admin/deals/:id/image', upload.single('file'), async (req, res, next) => {
    try {
      const id = parseId(String(req.params.id))
      const file = req.file
      if (!file?.buffer.length) throw apiError('Choose an image to upload.')
      const detected = detectImage(file.buffer)
      if (!detected) throw Object.assign(new Error('Only JPEG, PNG or WebP images are accepted.'), { status: 415, code: 'UNSUPPORTED_MEDIA_TYPE' })
      const ref = db.collection('dealmein_deals').doc(String(id))
      if (!(await ref.get()).exists) throw apiError('Deal not found.', 404)
      const name = `${randomUUID()}.${detected.extension}`
      await getStorage().bucket().file(`dealmein/uploads/${name}`).save(file.buffer, { resumable: false, metadata: { contentType: detected.contentType, cacheControl: 'public,max-age=31536000,immutable' } })
      await ref.update({ imageUrl: `/uploads/${name}`, imageAuthorized: false, updatedAt: FieldValue.serverTimestamp() })
      await writeAudit(res.locals.actor, 'DEAL_IMAGE_UPLOADED', 'deal', id, { path: `/uploads/${name}` })
      res.json({ imageUrl: `/uploads/${name}`, note: 'Confirm the image is authorized before it will be shown publicly.' })
    } catch (error) { next(error) }
  })
}

async function auth(req: Request, res: Response, next: NextFunction) {
  try {
    const identity = await verifyGoogleToken(req.header('authorization'))
    if (!identity) { res.status(401).json({ status: 401, code: 'UNAUTHORIZED', message: 'Sign in with Google first.' }); return }
    if (!await isApprovedAdmin(identity)) { res.status(403).json({ status: 403, code: 'ADMIN_APPROVAL_REQUIRED', message: 'Administrator approval is required.' }); return }
    res.locals.actor = identity.email
    next()
  } catch (error) { next(error) }
}
function parseAdminFilters(req: Request) {
  return { status: typeof req.query.status === 'string' ? req.query.status.split(',').map((x) => x.toUpperCase()) : [],
    q: typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '',
    categories: typeof req.query.category === 'string' ? req.query.category.split(',') : [],
    retailers: typeof req.query.retailer === 'string' ? req.query.retailer.split(',') : [],
    minPrice: req.query.minPrice === undefined ? null : Number(req.query.minPrice),
    maxPrice: req.query.maxPrice === undefined ? null : Number(req.query.maxPrice),
    type: typeof req.query.type === 'string' ? req.query.type.toUpperCase() : '',
    featured: String(req.query.featured) === 'true',
    missingLink: String(req.query.missingLink) === 'true', unclearPrice: String(req.query.unclearPrice) === 'true',
    staleDates: String(req.query.staleDates) === 'true', possibleDuplicates: String(req.query.possibleDuplicates) === 'true',
    openReports: String(req.query.openReports) === 'true', timing: typeof req.query.timing === 'string' ? req.query.timing.split(',') : [],
    page: Math.max(1, Number(req.query.page) || 1), size: Math.min(48, Math.max(1, Number(req.query.size) || 24)),
    sort: typeof req.query.sort === 'string' ? req.query.sort : 'newest' }
}
function adminMatches(deal: Record<string, any>, filters: ReturnType<typeof parseAdminFilters>) {
  if (filters.status.length && !filters.status.includes(deal.status)) return false
  if (filters.q && ![deal.title, deal.model, deal.variant, deal.retailer?.name].some((value) => String(value ?? '').toLowerCase().includes(filters.q))) return false
  if (filters.categories.length && !filters.categories.includes(deal.category?.slug)) return false
  if (filters.retailers.length && !filters.retailers.includes(deal.retailer?.slug)) return false
  if (filters.minPrice !== null && (!Number.isFinite(filters.minPrice) || deal.listedCashPrice === null || deal.listedCashPrice < filters.minPrice)) return false
  if (filters.maxPrice !== null && (!Number.isFinite(filters.maxPrice) || deal.listedCashPrice === null || deal.listedCashPrice > filters.maxPrice)) return false
  if (filters.type && deal.offerType !== filters.type) return false
  if (filters.featured && !deal.featured) return false
  if (filters.timing.length && !filters.timing.includes(deal.timing)) return false
  if (filters.missingLink && deal.productUrlVerified) return false
  if (filters.unclearPrice && deal.listedCashPrice !== null) return false
  if (filters.staleDates && deal.timing !== 'expired') return false
  if (filters.possibleDuplicates && !deal.relatedCount) return false
  if (filters.openReports && !deal.openReports) return false
  return true
}
function sortAdmin(a: Record<string, any>, b: Record<string, any>, filters: ReturnType<typeof parseAdminFilters>) {
  if (filters.sort === 'price_asc' || filters.sort === 'price_desc') {
    const diff = (a.listedCashPrice ?? Infinity) - (b.listedCashPrice ?? Infinity)
    if (diff && Number.isFinite(diff)) return filters.sort === 'price_asc' ? diff : -diff
  }
  return (Date.parse(String(b.collectedAt ?? b.createdAt ?? 0)) || 0) - (Date.parse(String(a.collectedAt ?? a.createdAt ?? 0)) || 0)
}
async function loadDeal(id: number) {
  const doc = await db.collection('dealmein_deals').doc(String(id)).get()
  if (!doc.exists) return null
  const sources = await doc.ref.collection('sources').get()
  return { ...firestoreDeal(doc.id, doc.data()!), sources: sources.docs.map((source) => source.data()) }
}
function flatten(value: unknown): unknown { return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>).slug : value }
function slugify(value: string) { return value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'unknown' }
function dateValue(value: unknown) { if (value && typeof (value as { toMillis?: unknown }).toMillis === 'function') return (value as { toMillis(): number }).toMillis(); return Date.parse(String(value ?? '')) || 0 }
function parseId(value: string) { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw apiError('Deal not found.', 404); return id }
function apiError(message: string, status = 400) { return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' }) }
function coerceEdit(field: string, raw: unknown, spec: { key: string; kind: string; max?: number; values?: string[] }) {
  if (raw === null || raw === undefined || typeof raw === 'string' && !raw.trim()) return null
  if (typeof raw !== 'string' && typeof raw !== 'number') throw new Error('Invalid value.')
  const value = String(raw).trim()
  if (spec.kind === 'string') { if (value.length > (spec.max ?? 0)) throw new Error(`Must be ${spec.max} characters or fewer.`); return value }
  if (spec.kind === 'money') { if (!/^\d{1,10}(\.\d{1,2})?$/.test(value)) throw new Error('Use a dollar amount like 49.99.'); return Number(value) }
  if (spec.kind === 'date') { if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error('Use YYYY-MM-DD.'); return value }
  if (spec.kind === 'instant') { if (Number.isNaN(Date.parse(value)) || !/(Z|[+-]\d{2}:?\d{2})$/i.test(value)) throw new Error('Use an ISO timestamp with offset.'); return value }
  if (spec.kind === 'url') { if (field === 'imageUrl' && value.startsWith('/uploads/') && !value.includes('..')) return value; try { const url = new URL(value); if (['http:', 'https:'].includes(url.protocol)) return value } catch {} throw new Error('Enter a full http:// or https:// address.') }
  if (spec.kind === 'enum') { const upper = value.toUpperCase(); if (!spec.values?.includes(upper)) throw new Error(`Must be one of ${spec.values?.join(', ')}.`); return upper }
  return value
}
function detectImage(bytes: Buffer): { extension: string; contentType: string } | null {
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return { extension: 'jpg', contentType: 'image/jpeg' }
  if (bytes.length >= 8 && bytes[0] === 137 && bytes.toString('ascii', 1, 4) === 'PNG' && bytes[4] === 13 && bytes[5] === 10 && bytes[6] === 26 && bytes[7] === 10) return { extension: 'png', contentType: 'image/png' }
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return { extension: 'webp', contentType: 'image/webp' }
  return null
}
async function writeAudit(actor: string, action: string, entityType: string, entityId: unknown, details: Record<string, unknown>) {
  await db.collection('dealmein_auditEvents').add({ actor, action, entityType, entityId, details, createdAt: FieldValue.serverTimestamp() })
}
