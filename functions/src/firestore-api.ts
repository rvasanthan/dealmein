import { createHash } from 'node:crypto'
import express from 'express'
import { getApps, initializeApp } from 'firebase-admin/app'
import { FieldValue, getFirestore } from 'firebase-admin/firestore'
import { getStorage } from 'firebase-admin/storage'
import multer from 'multer'
import type { Express, NextFunction, Request, Response } from 'express'

if (!getApps().length) initializeApp()
export const db = getFirestore()
const reportsPerClient = new Map<string, number[]>()
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 2 * 1024 * 1024, files: 1 } })
const pageSizeMax = 48
const notices: Record<string, string> = {
  PRICE_UNCLEAR: "The price in the source wasn't clear, so no price is shown.",
  PRICE_AMBIGUOUS: "The price in the source wasn't clear, so no price is shown.",
  DATES_UNCLEAR: "Sale dates weren't clear in the source.",
  DATES_CONFLICT: 'Sources disagree about the sale dates.',
  CONDITIONS_APPLY: 'Coupons, memberships, rebates or gift cards may be required.',
  MATERIAL_CHANGE: 'This offer changed since it was last reviewed.',
  CATEGORY_UNMATCHED: 'The category was assigned automatically.',
}

export function registerFirestoreApi(app: Express) {
  app.get('/api/health', async (_req, res) => {
    try {
      await db.collection('dealmein_meta').doc('health').get()
      res.json({ status: 'ok' })
    } catch { res.status(503).json({ status: 'unavailable' }) }
  })

  app.get('/api/categories', async (_req, res, next) => {
    try {
      await ensureDefaultCategories()
      const deals = await db.collection('dealmein_deals').where('status', 'in', ['DRAFT', 'PUBLISHED']).get()
      const counts = new Map<string, number>()
      deals.forEach((doc) => {
        const slug = doc.get('category.slug')
        if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1)
      })
      const categories = await db.collection('dealmein_categories').orderBy('sortOrder').get()
      res.json(categories.docs.map((doc) => ({ ...doc.data(), dealCount: counts.get(doc.get('slug')) ?? 0 })))
    } catch (error) { next(error) }
  })

  app.get('/api/retailers', async (_req, res, next) => {
    try {
      const deals = await db.collection('dealmein_deals').where('status', 'in', ['DRAFT', 'PUBLISHED']).get()
      const counts = new Map<string, number>()
      deals.forEach((doc) => {
        const slug = doc.get('retailer.slug')
        if (slug) counts.set(slug, (counts.get(slug) ?? 0) + 1)
      })
      const retailers = await db.collection('dealmein_retailers').orderBy('name').get()
      res.json(retailers.docs.filter((doc) => (counts.get(doc.get('slug')) ?? 0) > 0)
        .map((doc) => ({ name: doc.get('name'), slug: doc.get('slug'), dealCount: counts.get(doc.get('slug')) ?? 0 })))
    } catch (error) { next(error) }
  })

  app.get('/api/deals', async (req, res, next) => {
    try {
      const filters = parseFilters(req)
      const snapshot = await db.collection('dealmein_deals').where('status', 'in', ['DRAFT', 'PUBLISHED', 'EXPIRED']).get()
      const all = snapshot.docs.filter((doc) => isPublicDeal(doc.data())).map((doc) => firestoreDeal(doc.id, doc.data()))
        .filter((deal) => matches(deal, filters, false))
      const sorted = sortDeals(all, filters.sort, filters.q)
      const start = (filters.page - 1) * filters.size
      res.json({ items: sorted.slice(start, start + filters.size), page: filters.page, size: filters.size,
        total: sorted.length, totalPages: Math.ceil(sorted.length / filters.size) })
    } catch (error) { next(error) }
  })

  app.get('/api/deals/catalog', async (_req, res, next) => {
    try {
      const snapshot = await db.collection('dealmein_deals').where('status', 'in', ['DRAFT', 'PUBLISHED', 'EXPIRED']).get()
      const deals = snapshot.docs.filter((doc) => isPublicDeal(doc.data())).map((doc) => firestoreDeal(doc.id, doc.data()))
      res.json(sortDeals(deals, 'newest', ''))
    } catch (error) { next(error) }
  })

  app.get('/api/deals/by-ids', async (req, res, next) => {
    try {
      const ids = String(req.query.ids ?? '').split(',').slice(0, 101).map(Number).filter((id) => Number.isSafeInteger(id) && id > 0)
      if (ids.length > 100) throw apiError('Too many ids.')
      const items = await Promise.all(ids.map(async (id) => {
        const doc = await db.collection('dealmein_deals').doc(String(id)).get()
        if (!doc.exists || !isPublicDeal(doc.data()!)) return { id, unavailable: true }
        return firestoreDeal(doc.id, doc.data()!)
      }))
      res.json(items)
    } catch (error) { next(error) }
  })

  app.get('/api/deals/:id', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      const doc = await db.collection('dealmein_deals').doc(String(id)).get()
      if (!doc.exists || !isPublicDeal(doc.data()!)) throw apiError("This deal isn't available.", 404)
      const data = doc.data()!
      const sources = await db.collection('dealmein_deals').doc(doc.id).collection('sources').orderBy('id').get()
      const related = data.candidateGroupKey
        ? await db.collection('dealmein_deals').where('candidateGroupKey', '==', data.candidateGroupKey).limit(21).get()
        : null
      res.json({ ...firestoreDeal(doc.id, data), sources: sources.docs.map((source) => ({
        id: source.get('id'), name: source.get('name') ?? null, url: safeUrl(source.get('url')),
        ref: source.get('ref'), collectedAt: asIso(source.get('collectedAt')),
      })),
        listingLink: sources.docs.map((source) => source.get('url')).find(Boolean) ?? null,
        related: related?.docs.filter((item) => item.id !== doc.id && isPublicDeal(item.data()))
          .slice(0, 20).map((item) => firestoreDeal(item.id, item.data())) ?? [] })
    } catch (error) { next(error) }
  })

  app.post('/api/deals/:id/reports', async (req, res, next) => {
    try {
      const id = parseId(req.params.id)
      const reason = req.body?.reason
      const message = typeof req.body?.message === 'string' ? req.body.message.trim() : null
      if (!['EXPIRED', 'WRONG_PRICE', 'WRONG_LINK', 'OTHER'].includes(reason)) throw apiError('Unknown report reason.')
      if (message && message.length > 1000) throw apiError('Message must be 1000 characters or fewer.')
      const deal = await db.collection('dealmein_deals').doc(String(id)).get()
      if (!deal.exists || !isPublicDeal(deal.data()!)) throw apiError('Deal not found.', 404)
      const key = createHash('sha256').update(req.ip ?? '').digest('hex').slice(0, 32)
      const now = Date.now()
      const hits = (reportsPerClient.get(key) ?? []).filter((hit) => hit > now - 60 * 60 * 1000)
      if (hits.length >= 5) throw Object.assign(new Error("You've sent several reports recently. Please try again later."), { status: 429, code: 'RATE_LIMITED' })
      hits.push(now)
      reportsPerClient.set(key, hits)
      const reportRef = db.collection('dealmein_visitorReports').doc()
      await db.runTransaction(async (tx) => {
        tx.set(reportRef, { dealId: id, dealTitle: deal.get('title'), reason, message: message || null,
          status: 'OPEN', reporterHash: key, createdAt: FieldValue.serverTimestamp() })
        tx.update(db.collection('dealmein_deals').doc(String(id)), { openReports: FieldValue.increment(1) })
      })
      res.status(201).json({ ok: true, id: reportRef.id })
    } catch (error) { next(error) }
  })

  app.get('/uploads/:name', async (req, res, next) => {
    try {
      if (!/^[0-9a-f-]{36}\.(jpg|png|webp)$/.test(req.params.name)) return res.status(404).end()
      const [bytes] = await getStorage().bucket().file(`dealmein/uploads/${req.params.name}`).download()
      const [metadata] = await getStorage().bucket().file(`dealmein/uploads/${req.params.name}`).getMetadata()
      res.set('Content-Type', String(metadata.contentType ?? 'application/octet-stream')).set('Cache-Control', 'public,max-age=31536000,immutable').send(bytes)
    } catch (error) { if ((error as { code?: number }).code === 404) res.status(404).end(); else next(error) }
  })

}

export function registerFirestoreErrors(app: Express) {
  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    const failure = error as Error & { status?: number; code?: string; details?: Record<string, unknown> }
    const status = failure.status ?? 500
    if (status >= 500) console.error('Firestore API request failed', error)
    res.status(status).json({ status, code: failure.code ?? 'INTERNAL',
      message: status >= 500 ? 'Something went wrong. Please try again.' : failure.message,
      ...(failure.details ? { details: failure.details } : {}) })
  })
}

export function parseFilters(req: Request) {
  const q = typeof req.query.q === 'string' ? req.query.q.trim() : ''
  if (q.length > 200) throw apiError('Search text is too long.')
  const minPrice = parsePrice(req.query.minPrice, 'minPrice')
  const maxPrice = parsePrice(req.query.maxPrice, 'maxPrice')
  if (minPrice !== null && maxPrice !== null && minPrice > maxPrice) throw apiError('minPrice cannot be greater than maxPrice.')
  const timing = csv(req.query.timing).map((value) => value.toLowerCase())
  if (timing.some((value) => !['active', 'upcoming', 'expired', 'unknown'].includes(value))) throw apiError('Unknown timing filter.')
  const type = typeof req.query.type === 'string' ? req.query.type.toUpperCase() : ''
  if (type && !['PRODUCT', 'STOREWIDE'].includes(type)) throw apiError('type must be PRODUCT or STOREWIDE.')
  const sort = typeof req.query.sort === 'string' && req.query.sort ? req.query.sort : q ? 'relevance' : 'newest'
  if (!['newest', 'price_asc', 'price_desc', 'relevance'].includes(sort)) throw apiError('Unknown sort.')
  return { q, categories: csv(req.query.category), retailers: csv(req.query.retailer), timing, minPrice, maxPrice, type, sort,
    page: Math.max(1, Number.parseInt(String(req.query.page ?? '1'), 10) || 1),
    size: Math.min(pageSizeMax, Math.max(1, Number.parseInt(String(req.query.size ?? '24'), 10) || 24)),
    featured: String(req.query.featured) === 'true' }
}

function matches(deal: Record<string, any>, filters: ReturnType<typeof parseFilters>, admin: boolean) {
  const timing = timingFor(deal)
  if (!admin && timing === 'expired' && !filters.timing.includes('expired')) return false
  if (filters.timing.length && !filters.timing.includes(timing)) return false
  if (filters.categories.length && !filters.categories.includes(deal.category?.slug)) return false
  if (filters.retailers.length && !filters.retailers.includes(deal.retailer?.slug)) return false
  if (filters.minPrice !== null && (deal.listedCashPrice === null || deal.listedCashPrice < filters.minPrice)) return false
  if (filters.maxPrice !== null && (deal.listedCashPrice === null || deal.listedCashPrice > filters.maxPrice)) return false
  if (filters.type && deal.offerType !== filters.type) return false
  if (filters.featured && !deal.featured) return false
  if (filters.q && !searchMatches(deal, filters.q)) return false
  return true
}

function searchMatches(deal: Record<string, any>, query: string) {
  const haystack = [deal.title, deal.model, deal.variant, deal.retailer?.name, deal.seller, deal.category?.name,
    deal.sourcePriceText, deal.originalPriceText, deal.conditionsText, deal.rewardText].filter(Boolean).join(' ').toLowerCase()
  return query.toLowerCase().split(/\s+/).every((term) => haystack.includes(term))
}

function sortDeals(deals: Record<string, any>[], sort: string, query: string) {
  return deals.sort((a, b) => {
    if (sort === 'price_asc' || sort === 'price_desc') {
      const av = a.listedCashPrice
      const bv = b.listedCashPrice
      if (av === null && bv !== null) return 1
      if (bv === null && av !== null) return -1
      if (av !== bv) return sort === 'price_asc' ? (av ?? 0) - (bv ?? 0) : (bv ?? 0) - (av ?? 0)
    }
    if (sort === 'relevance' && query) {
      const terms = query.toLowerCase().split(/\s+/)
      const score = (d: Record<string, any>) => terms.reduce((sum, term) => sum + (String(d.title ?? '').toLowerCase().includes(term) ? 3 : 0)
        + ([d.model, d.variant, d.retailer?.name, d.seller, d.category?.name].some((x) => String(x ?? '').toLowerCase().includes(term)) ? 1 : 0), 0)
      const diff = score(b) - score(a)
      if (diff) return diff
    }
    return dateMillis(b.collectedAt ?? b.createdAt) - dateMillis(a.collectedAt ?? a.createdAt) || a.id - b.id
  })
}

export function firestoreDeal(id: string, data: FirebaseFirestore.DocumentData, admin = false) {
  const price = num(data.listedCashPrice)
  const reference = num(data.referencePrice)
  const flags: string[] = data.reviewFlags ?? []
  const result: Record<string, any> = { id: Number(id), title: data.title, variant: data.variant ?? null, model: data.model ?? null,
    condition: data.condition ?? 'UNKNOWN', retailer: data.retailer, seller: data.seller ?? null, category: data.category,
    offerType: data.offerType ?? 'PRODUCT', listedCashPrice: price, sourcePriceText: data.sourcePriceText ?? null,
    originalPriceText: data.originalPriceText ?? null, conditionsText: data.conditionsText ?? null,
    rewardText: data.rewardText ?? null, rewardAmount: num(data.rewardAmount), shippingCost: num(data.shippingCost),
    taxNote: data.taxNote ?? null, referencePrice: reference, referencePriceText: data.referencePriceText ?? null,
    discountPercent: reference && price !== null && reference > price ? Math.floor((reference - price) / reference * 100) : null,
    startsOn: data.startsOn ?? null, endsOn: data.endsOn ?? null, startsAt: asIso(data.startsAt), endsAt: asIso(data.endsAt),
    dateText: data.dateText ?? null, dateStatus: data.dateStatus ?? 'UNKNOWN', timing: timingFor(data),
    retailerTimezone: data.retailerTimezone ?? null, collectedAt: asIso(data.collectedAt),
    retailerVerifiedAt: asIso(data.retailerVerifiedAt), reviewedAt: asIso(data.reviewedAt),
    sourceVerificationStatus: data.sourceVerificationStatus ?? null,
    reviewNotices: [...new Set(flags.map((flag) => notices[flag]).filter(Boolean))],
    retailerLink: safeUrl(data.productUrl),
    listingLink: data.listingLink ?? null,
    imageUrl: data.imageAuthorized ? data.imageUrl ?? null : null,
    featured: Boolean(data.featured), status: data.status, relatedCount: Number(data.relatedCount ?? 0) }
  if (admin) Object.assign(result, {
    sourceRecordId: data.sourceRecordId, reviewFlags: flags, candidateGroupKey: data.candidateGroupKey ?? null,
    productUrl: data.productUrl ?? null, productUrlVerified: Boolean(data.productUrlVerified), imageUrlRaw: data.imageUrl ?? null,
    imageAuthorized: Boolean(data.imageAuthorized), archiveReason: data.archiveReason ?? null,
    mergedIntoId: data.mergedIntoId ?? null, overrides: data.overrides ?? {}, importedSnapshot: data.importedSnapshot ?? null,
    openReports: Number(data.openReports ?? 0), publishedAt: asIso(data.publishedAt), reviewedBy: data.reviewedBy ?? null,
    updatedAt: asIso(data.updatedAt), createdAt: asIso(data.createdAt),
  })
  return result
}

export function isPublicDeal(data: FirebaseFirestore.DocumentData) {
  return data.status === 'DRAFT' || Boolean(data.publishedAt && ['PUBLISHED', 'EXPIRED'].includes(data.status))
}

export function timingFor(deal: Record<string, any>, now = Date.now()): 'active' | 'upcoming' | 'expired' | 'unknown' {
  if (deal.status === 'EXPIRED') return 'expired'
  if (deal.dateStatus !== 'KNOWN') return 'unknown'
  const start = deal.startsAt ? Date.parse(deal.startsAt) : dateAtTimezone(deal.startsOn, deal.retailerTimezone, false)
  const end = deal.endsAt ? Date.parse(deal.endsAt) : dateAtTimezone(deal.endsOn, deal.retailerTimezone, true)
  if (deal.startsAt || deal.startsOn || deal.endsAt || deal.endsOn) {
    if (deal.startsOn && !deal.startsAt && !deal.retailerTimezone || deal.endsOn && !deal.endsAt && !deal.retailerTimezone) return 'unknown'
  } else return 'unknown'
  if (end !== null && end <= now) return 'expired'
  if (start !== null && start > now) return 'upcoming'
  return 'active'
}

export function expiryDateFor(deal: Record<string, any>): Date | null {
  if (deal.dateStatus !== 'KNOWN') return null
  if (deal.endsAt) {
    const instant = new Date(deal.endsAt)
    return Number.isNaN(instant.getTime()) ? null : instant
  }
  const end = dateAtTimezone(deal.endsOn, deal.retailerTimezone, true)
  return end === null ? null : new Date(end)
}

function dateAtTimezone(date: string | null | undefined, timezone: string | null, inclusiveEnd: boolean): number | null {
  if (!date) return null
  if (!timezone) return null
  const [year, month, day] = date.split('-').map(Number)
  const target = new Date(Date.UTC(year, month - 1, day + (inclusiveEnd ? 1 : 0)))
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).formatToParts(target)
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]))
  const localAsUtc = Date.UTC(Number(values.year), Number(values.month) - 1, Number(values.day), Number(values.hour), Number(values.minute), Number(values.second))
  return target.getTime() - (localAsUtc - target.getTime())
}

function parsePrice(value: unknown, name: string): number | null {
  if (value === undefined || value === null || value === '') return null
  const price = Number(value)
  if (!Number.isFinite(price) || price < 0) throw apiError(`${name} must be a non-negative dollar amount.`)
  return price
}
function csv(value: unknown): string[] { return typeof value === 'string' ? value.split(',').map((part) => part.trim()).filter(Boolean).slice(0, 50) : [] }
function dateMillis(value: unknown): number { return value ? Date.parse(String(value)) || 0 : 0 }
function num(value: unknown): number | null { return value === null || value === undefined ? null : Number(value) }
export function asIso(value: unknown): string | null {
  if (value === null || value === undefined) return null
  if (value instanceof Date) return value.toISOString()
  if (typeof value === 'string') return value
  const timestamp = value as { toDate?: () => Date }
  return typeof timestamp.toDate === 'function' ? timestamp.toDate().toISOString() : null
}
function safeUrl(value: unknown): string | null { if (typeof value !== 'string') return null; try { const url = new URL(value); return ['http:', 'https:'].includes(url.protocol) ? value : null } catch { return null } }
function parseId(value: string) { const id = Number(value); if (!Number.isSafeInteger(id) || id < 1) throw apiError('Deal not found.', 404); return id }
function apiError(message: string, status = 400) { return Object.assign(new Error(message), { status, code: status === 404 ? 'NOT_FOUND' : 'BAD_REQUEST' }) }
export async function ensureDefaultCategories() {
  const collection = db.collection('dealmein_categories')
  const existing = await collection.limit(1).get()
  if (!existing.empty) return
  const names = ['Electronics', 'Clothing', 'Shoes', 'Home', 'Kitchen', 'Appliances', 'Beauty', 'Toys', 'Sports', 'Tools', 'Groceries', 'Other']
  const batch = db.batch()
  names.forEach((name, index) => batch.set(collection.doc(name.toLowerCase()), { name, slug: name.toLowerCase(), sortOrder: index + 1 }))
  await batch.commit()
}