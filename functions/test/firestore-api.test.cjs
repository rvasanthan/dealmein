const assert = require('node:assert/strict')
const test = require('node:test')
const express = require('express')
const request = require('supertest')
const { registerFirestoreAdminApi } = require('../lib/firestore-admin.js')
const { db, firestoreDeal, isPublicDeal, registerFirestoreApi, timingFor } = require('../lib/firestore-api.js')
const { parseImport } = require('../lib/firestore-import.js')
const { registerDealAccessGuard } = require('../lib/firestore-access.js')
const { registerFavoritesApi } = require('../lib/firestore-favorites.js')
const googleAdminAuth = require('../lib/google-admin-auth.js')
const { googleIdentity } = googleAdminAuth
googleAdminAuth.verifyGoogleToken = async (header) => header === 'Bearer valid-google-token'
  ? { uid: 'uid-1', email: 'admin@example.com', name: null } : header === 'Bearer pending-google-token'
    ? { uid: 'uid-2', email: 'pending@example.com', name: null } : header === 'Bearer second-google-token'
      ? { uid: 'uid-3', email: 'second@example.com', name: null } : null
process.env.APP_ADMIN_USERNAME = 'admin@example.com'

test('Firestore deal mapper preserves the frontend contract and hides unapproved media', () => {
  const deal = firestoreDeal('12', {
    title: 'Lamp', status: 'PUBLISHED', publishedAt: new Date().toISOString(), dateStatus: 'UNKNOWN',
    retailer: { name: 'Store', slug: 'store' }, category: { name: 'Home', slug: 'home' },
    listedCashPrice: null, reviewFlags: ['PRICE_UNCLEAR'], imageUrl: '/uploads/image.jpg', imageAuthorized: false,
    productUrl: 'javascript:alert(1)', productUrlVerified: true,
  })
  assert.equal(deal.id, 12)
  assert.equal(deal.imageUrl, null)
  assert.equal(deal.retailerLink, null)
  assert.equal(deal.listedCashPrice, null)
  assert.equal(deal.reviewNotices.length, 1)
  assert.equal(deal.sourceRecordId, undefined)
})

test('Firestore date timing treats unknown and inclusive end dates safely', () => {
  assert.equal(timingFor({ dateStatus: 'UNKNOWN', status: 'PUBLISHED' }, Date.UTC(2026, 0, 1)), 'unknown')
  assert.equal(timingFor({ dateStatus: 'KNOWN', status: 'PUBLISHED', endsOn: '2025-11-28', retailerTimezone: 'America/New_York' }, Date.UTC(2025, 10, 29, 4)), 'active')
  assert.equal(timingFor({ dateStatus: 'KNOWN', status: 'PUBLISHED', endsOn: '2025-11-28', retailerTimezone: 'America/New_York' }, Date.UTC(2025, 10, 29, 6)), 'expired')
})

test('Firestore admin routes require a valid admin token, including imports and uploads', async () => {
  process.env.APP_JWT_SECRET = 'test-secret-with-at-least-thirty-two-characters'
  const app = express()
  app.use(express.json())
  registerFirestoreAdminApi(app)
  for (const path of ['/api/admin/me', '/api/admin/deals', '/api/admin/imports', '/api/admin/reports', '/api/admin/audit']) {
    await request(app).get(path).expect(401)
  }
  await request(app).post('/api/admin/imports/preview').expect(401)
  await request(app).post('/api/admin/imports/upload-chunk').set('Content-Type', 'application/octet-stream').send(Buffer.from('part')).expect(401)
  await request(app).post('/api/admin/deals/1/image').expect(401)
  await request(app).post('/api/admin/deals/bulk-publish').send({ confirmUnverified: true }).expect(401)
  await request(app).post('/api/admin/deals').send({ title: 'Lamp', retailer: 'Store' }).expect(401)
})

test('Only verified Google identities are eligible for admin approval', () => {
  const token = { uid: '123', email: 'ADMIN@example.com', email_verified: true, firebase: { sign_in_provider: 'google.com' } }
  assert.equal(googleIdentity(token).email, 'admin@example.com')
  assert.equal(googleIdentity({ ...token, email_verified: false }), null)
  assert.equal(googleIdentity({ ...token, firebase: { sign_in_provider: 'password' } }), null)
})

test('Unapproved Google users cannot access administrator APIs', async () => {
  const original = db.collection
  db.collection = () => ({ doc: () => ({ get: async () => ({ exists: true, get: () => 'pending' }) }) })
  try {
    const app = express()
    registerFirestoreAdminApi(app)
    await request(app).get('/api/admin/me').set('Authorization', 'Bearer pending-google-token').expect(403)
    await request(app).get('/api/admin/me').set('Authorization', 'Bearer old-custom-token').expect(401)
    await request(app).get('/api/admin/me').set('Authorization', 'Bearer valid-google-token').expect(200)
  } finally { db.collection = original }
})

test('Google access requests require approval and revocation immediately removes access', async () => {
  const accounts = new Map()
  const audit = []
  const collection = db.collection
  const batch = db.batch
  const runTransaction = db.runTransaction
  db.collection = (name) => ({ doc: (id) => ({ collection: name, id,
    get: async () => ({ exists: accounts.has(id), get: (field) => accounts.get(id)?.[field] }) }) })
  db.runTransaction = async (handler) => handler({
    get: async (ref) => ({ exists: accounts.has(ref.id), get: (field) => accounts.get(ref.id)?.[field] }),
    create: (ref, data) => accounts.set(ref.id, data),
  })
  db.batch = () => {
    const operations = []
    return { set: (ref, data) => operations.push({ ref, data }), commit: async () => {
      for (const { ref, data } of operations) {
        if (ref.collection === 'dealmein_adminAccounts') accounts.set(ref.id, { ...accounts.get(ref.id), ...data })
        else audit.push(data)
      }
    } }
  }
  try {
    const app = express()
    app.use(express.json())
    registerFirestoreAdminApi(app)
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }))
    const pending = 'Bearer pending-google-token'
    const owner = 'Bearer valid-google-token'
    assert.equal((await request(app).post('/api/access/request').set('Authorization', pending).expect(200)).body.status, 'pending')
    await request(app).put('/api/admin/accounts').set('Authorization', pending).send({ email: 'pending@example.com', status: 'approved' }).expect(403)
    await request(app).put('/api/admin/accounts').set('Authorization', owner).send({ email: 'pending@example.com', status: 'approved' }).expect(200)
    await request(app).get('/api/admin/me').set('Authorization', pending).expect(200)
    await request(app).put('/api/admin/accounts').set('Authorization', owner).send({ email: 'admin@example.com', status: 'revoked' }).expect(400)
    await request(app).put('/api/admin/accounts').set('Authorization', owner).send({ email: 'pending@example.com', status: 'revoked' }).expect(200)
    await request(app).get('/api/admin/me').set('Authorization', pending).expect(403)
    assert.equal((await request(app).post('/api/access/request').set('Authorization', pending).expect(200)).body.status, 'revoked')
    assert.deepEqual(audit.map((entry) => entry.action), ['ADMIN_APPROVED', 'ADMIN_REVOKED'])
  } finally { db.collection = collection; db.batch = batch; db.runTransaction = runTransaction }
})

test('Regular Google users require approval without receiving administrator access', async () => {
  const accounts = new Map()
  const audits = []
  const collection = db.collection
  const runTransaction = db.runTransaction
  const snapshot = (ref) => ({ exists: accounts.has(ref.key), get: (field) => accounts.get(ref.key)?.[field] })
  db.collection = (name) => ({ doc: (id) => ({ key: `${name}/${id}`, get: async function () { return snapshot(this) } }) })
  db.runTransaction = async (handler) => handler({
    get: async (ref) => snapshot(ref),
    create: (ref, data) => accounts.set(ref.key, data),
    update: (ref, data) => accounts.set(ref.key, { ...accounts.get(ref.key), ...data }),
    set: (ref, data) => {
      if (ref.key.startsWith('dealmein_adminAccounts/')) accounts.set(ref.key, { ...accounts.get(ref.key), ...data })
      else audits.push(data)
    },
  })
  try {
    const app = express()
    app.use(express.json())
    registerFirestoreAdminApi(app)
    app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }))
    const user = 'Bearer pending-google-token'
    const admin = 'Bearer valid-google-token'
    await request(app).post('/api/user/access-request').expect(401)
    assert.equal((await request(app).post('/api/user/access-request').set('Authorization', user).expect(200)).body.status, 'pending')
    await request(app).get('/api/user/session').set('Authorization', user).expect(403)
    await request(app).put('/api/admin/users').set('Authorization', user).send({ email: 'pending@example.com', status: 'approved', role: 'admin' }).expect(403)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'pending@example.com', status: 'approved' }).expect(400)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'admin@example.com', status: 'revoked' }).expect(400)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'admin@example.com', status: 'approved', role: 'user' }).expect(400)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'pending@example.com', status: 'approved', role: 'user' }).expect(200)
    assert.equal((await request(app).get('/api/user/session').set('Authorization', user).expect(200)).body.role, 'user')
    await request(app).get('/api/admin/me').set('Authorization', user).expect(403)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'pending@example.com', status: 'approved', role: 'admin' }).expect(200)
    assert.equal((await request(app).get('/api/user/session').set('Authorization', user).expect(200)).body.role, 'admin')
    await request(app).get('/api/admin/me').set('Authorization', user).expect(200)
    await request(app).put('/api/admin/users').set('Authorization', user).send({ email: 'pending@example.com', status: 'approved', role: 'user' }).expect(400)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'pending@example.com', status: 'approved', role: 'user' }).expect(200)
    assert.equal((await request(app).get('/api/user/session').set('Authorization', user).expect(200)).body.role, 'user')
    await request(app).get('/api/admin/me').set('Authorization', user).expect(403)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'pending@example.com', status: 'approved', role: 'admin' }).expect(200)
    await request(app).put('/api/admin/users').set('Authorization', admin).send({ email: 'pending@example.com', status: 'revoked' }).expect(200)
    await request(app).get('/api/user/session').set('Authorization', user).expect(403)
    await request(app).get('/api/admin/me').set('Authorization', user).expect(403)
    assert.equal((await request(app).post('/api/user/access-request').set('Authorization', user).expect(200)).body.status, 'revoked')
    assert.deepEqual(audits.map((entry) => entry.action), ['USER_APPROVED', 'USER_APPROVED', 'USER_APPROVED', 'USER_APPROVED', 'USER_REVOKED'])
    assert.deepEqual(audits.map((entry) => entry.details.role), ['user', 'admin', 'user', 'admin', null])
  } finally { db.collection = collection; db.runTransaction = runTransaction }
})

test('User list shows effective admin roles, including separately nominated administrators', async () => {
  const collection = db.collection
  const doc = (values) => ({ get: (field) => values[field] })
  db.collection = (name) => {
    if (name === 'dealmein_userAccounts') return { orderBy: () => ({ get: async () => ({ docs: [
      doc({ email: 'pending@example.com', status: 'pending' }),
      doc({ email: 'nominated@example.com', status: 'pending' }),
    ] }) }) }
    if (name === 'dealmein_adminAccounts') return { where: () => ({ get: async () => ({ docs: [
      doc({ email: 'nominated@example.com', status: 'approved' }),
    ] }) }) }
    throw new Error(`Unexpected collection: ${name}`)
  }
  try {
    const app = express()
    registerFirestoreAdminApi(app)
    const response = await request(app).get('/api/admin/users').set('Authorization', 'Bearer valid-google-token').expect(200)
    assert.deepEqual(response.body.map(({ email, status, role }) => ({ email, status, role })), [
      { email: 'pending@example.com', status: 'pending', role: 'user' },
      { email: 'nominated@example.com', status: 'approved', role: 'admin' },
    ])
  } finally { db.collection = collection }
})

test('Deal routes require an approved user or administrator and disallow caching', async () => {
  let userStatus = 'pending'
  const collection = db.collection
  db.collection = (name) => ({ doc: () => ({ get: async () => ({
    exists: name === 'dealmein_userAccounts', get: () => name === 'dealmein_userAccounts' ? userStatus : undefined,
  }) }) })
  try {
    const app = express()
    registerDealAccessGuard(app)
    app.use((_req, res) => res.json({ visible: true }))
    for (const path of ['/api/deals', '/api/deals/catalog', '/api/deals/by-ids', '/api/deals/1', '/api/categories', '/api/retailers']) {
      const anonymous = await request(app).get(path).expect(401)
      assert.match(anonymous.headers['cache-control'], /no-store/)
      await request(app).get(path).set('Authorization', 'Bearer pending-google-token').expect(403)
    }
    userStatus = 'approved'
    await request(app).get('/api/deals/catalog').set('Authorization', 'Bearer pending-google-token').expect(200)
    await request(app).get('/api/deals/catalog').set('Authorization', 'Bearer valid-google-token').expect(200)
    userStatus = 'revoked'
    await request(app).get('/api/deals/catalog').set('Authorization', 'Bearer pending-google-token').expect(403)
    await request(app).get('/api/health').expect(200)
    await request(app).post('/api/user/access-request').expect(200)
  } finally { db.collection = collection }
})

test('Favorites require approval and are isolated by verified user ID', async () => {
  const collection = db.collection
  const saved = new Map()
  let userStatus = 'pending'
  db.collection = (name) => {
    if (name === 'dealmein_adminAccounts') return { doc: () => ({ get: async () => ({ exists: false }) }) }
    if (name === 'dealmein_userAccounts') return { doc: () => ({ get: async () => ({ get: () => userStatus }) }) }
    if (name === 'dealmein_deals') return { doc: (id) => ({ get: async () => ({ exists: id !== '99', data: () => ({ status: id === '98' ? 'ARCHIVED' : 'DRAFT' }) }) }) }
    if (name === 'dealmein_userFavorites') return { doc: (uid) => ({ collection: () => ({
      orderBy: () => ({ get: async () => ({ docs: [...(saved.get(uid) ?? new Set())].map((id) => ({ id })) }) }),
      doc: (id) => ({ set: async () => { if (!saved.has(uid)) saved.set(uid, new Set()); saved.get(uid).add(id) },
        delete: async () => { saved.get(uid)?.delete(id) } }),
    }) }) }
    throw new Error(`Unexpected collection: ${name}`)
  }
  try {
    const app = express()
    registerDealAccessGuard(app)
    registerFavoritesApi(app)
    await request(app).get('/api/favorites').expect(401)
    await request(app).put('/api/favorites/1').set('Authorization', 'Bearer pending-google-token').expect(403)
    userStatus = 'approved'
    await request(app).put('/api/favorites/1').set('Authorization', 'Bearer pending-google-token').expect(200)
    await request(app).put('/api/favorites/1').set('Authorization', 'Bearer pending-google-token').expect(200)
    assert.deepEqual((await request(app).get('/api/favorites').set('Authorization', 'Bearer pending-google-token').expect(200)).body, [1])
    assert.deepEqual((await request(app).get('/api/favorites').set('Authorization', 'Bearer second-google-token').expect(200)).body, [])
    await request(app).put('/api/favorites/98').set('Authorization', 'Bearer pending-google-token').expect(404)
    await request(app).put('/api/favorites/99').set('Authorization', 'Bearer pending-google-token').expect(404)
    await request(app).put('/api/favorites/0').set('Authorization', 'Bearer pending-google-token').expect(400)
    await request(app).delete('/api/favorites/1').set('Authorization', 'Bearer second-google-token').expect(200)
    assert.deepEqual((await request(app).get('/api/favorites').set('Authorization', 'Bearer pending-google-token').expect(200)).body, [1])
    await request(app).delete('/api/favorites/1').set('Authorization', 'Bearer pending-google-token').expect(200)
    await request(app).delete('/api/favorites/1').set('Authorization', 'Bearer pending-google-token').expect(200)
    userStatus = 'revoked'
    await request(app).get('/api/favorites').set('Authorization', 'Bearer pending-google-token').expect(403)
  } finally { db.collection = collection }
})

test('Draft imports are visible and retailer links do not require a verification flag', () => {
  assert.equal(isPublicDeal({ status: 'DRAFT' }), true)
  assert.equal(isPublicDeal({ status: 'ARCHIVED', publishedAt: new Date() }), false)
  assert.equal(isPublicDeal({ status: 'PUBLISHED', publishedAt: null }), false)
  const deal = firestoreDeal('1', { status: 'DRAFT', title: 'Lamp', productUrl: 'https://store.example/lamp', productUrlVerified: false })
  assert.equal(deal.retailerLink, 'https://store.example/lamp')
})

test('Catalog includes expired and draft offers but excludes archived offers', async () => {
  const values = [
    { status: 'DRAFT', title: 'Draft', dateStatus: 'UNKNOWN' },
    { status: 'EXPIRED', title: 'Expired', publishedAt: new Date(), dateStatus: 'UNKNOWN' },
    { status: 'ARCHIVED', title: 'Archived' },
  ]
  const docs = values.map((value, index) => ({ id: String(index + 1), data: () => value }))
  const collection = db.collection
  db.collection = () => ({ where: () => ({ get: async () => ({ docs }) }) })
  try {
    const app = express()
    registerFirestoreApi(app)
    const response = await request(app).get('/api/deals/catalog').expect(200)
    assert.deepEqual(response.body.map((deal) => deal.title).sort(), ['Draft', 'Expired'])
  } finally { db.collection = collection }
})

test('Bulk publishing requires explicit acknowledgement before accessing Firestore', async () => {
  const token = 'valid-google-token'
  const app = express()
  app.use(express.json())
  registerFirestoreAdminApi(app)
  app.use((error, _req, res, _next) => res.status(error.status || 500).json({ message: error.message }))
  await request(app).post('/api/admin/deals/bulk-publish').set('Authorization', `Bearer ${token}`).send({}).expect(400)
  await request(app).post('/api/admin/deals/bulk-publish').set('Authorization', `Bearer ${token}`)
    .send({ confirmUnverified: true, cursor: 'not-an-id' }).expect(400)
  await request(app).post('/api/admin/deals').set('Authorization', `Bearer ${token}`)
    .send({ title: 'Lamp', retailer: 'Store', product_url: 'javascript:alert(1)' }).expect(400)
})

test('Bulk publishing skips expired or changed drafts and does not claim individual review', async () => {
  const token = 'valid-google-token'
  const docs = [
    { id: '1', data: { status: 'DRAFT', dateStatus: 'UNKNOWN', reviewFlags: ['PRODUCT_LINK_MISSING'] } },
    { id: '2', data: { status: 'DRAFT', dateStatus: 'KNOWN', endsAt: '2020-01-01T00:00:00Z' } },
    { id: '3', data: { status: 'ARCHIVED' } },
  ].map((entry) => ({ id: entry.id, ref: entry }))
  const updates = []
  const audit = []
  const query = { where() { return this }, orderBy() { return this }, limit() { return this },
    async get() { return { size: docs.length, docs } } }
  const collection = db.collection
  const runTransaction = db.runTransaction
  db.collection = (name) => name === 'dealmein_deals' ? query : { doc: () => ({}) }
  db.runTransaction = async (handler) => handler({
    get: async (ref) => ({ data: () => ref.data }),
    update: (ref, fields) => updates.push({ ref, fields }),
    set: (_ref, fields) => audit.push(fields),
  })
  try {
    const app = express()
    app.use(express.json())
    registerFirestoreAdminApi(app)
    const response = await request(app).post('/api/admin/deals/bulk-publish').set('Authorization', `Bearer ${token}`)
      .send({ confirmUnverified: true }).expect(200)
    assert.deepEqual(response.body, { published: 1, expired: 1, changed: 1, failed: 0, cursor: null })
    assert.equal(updates[0].fields.status, 'PUBLISHED')
    assert.equal(updates[0].fields.reviewedAt, null)
    assert.equal(updates[0].fields.reviewedBy, null)
    assert.equal(updates[0].fields.reviewFlags, undefined)
    assert.equal(audit[0].action, 'DEAL_BULK_PUBLISHED')
  } finally {
    db.collection = collection
    db.runTransaction = runTransaction
  }
})

test('Firestore import parser normalizes valid rows and records invalid-row issues', () => {
  const parsed = parseImport(Buffer.from(JSON.stringify({ records: [
    { id: 'R-1', title: 'Desk lamp', retailer: 'Example Store', source_reported_price: 19.99, listed_cash_price: 18.5,
      start_date: '2026-11-20', possible_product_group: 'group-a', publish_ready: false,
      sources: [{ source_name: 'Publisher', source_url: 'https://example.com/deal', source_locator: 'item-1' }] },
    { title: 'Missing ID', retailer: 'Example Store' },
  ] })))
  assert.equal(parsed.totalRows, 2)
  assert.equal(parsed.records.length, 1)
  assert.equal(parsed.records[0].data.sourcePrice, 19.99)
  assert.equal(parsed.records[0].data.listedCashPrice, 18.5)
  assert.equal(parsed.records[0].data.candidateGroupKey, 'group-a')
  assert.equal(parsed.records[0].data.dateStatus, 'KNOWN')
  assert.equal(parsed.records[0].sources[0].url, 'https://example.com/deal')
  assert.equal(parsed.records[0].sources[0].ref, 'item-1')
  assert.ok(parsed.issues.some((issue) => issue.severity === 'ERROR'))
})

test('Firestore import parser rejects JSON without a records array', () => {
  assert.throws(() => parseImport(Buffer.from('{"unexpected":true}')), /JSON array/)
})