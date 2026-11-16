import { describe, expect, it } from 'vitest'
import { needsApprovedSession } from './api'

describe('protected deal API paths', () => {
  it('requires a user token for catalog, details, reports, and facets', () => {
    for (const path of ['/api/deals', '/api/deals/catalog', '/api/deals/1', '/api/deals/1/reports', '/api/deals/by-ids?ids=1', '/api/categories', '/api/retailers', '/api/favorites', '/api/favorites/1']) {
      expect(needsApprovedSession(path)).toBe(true)
    }
  })
  it('does not apply the catalog token handling to sign-in and admin endpoints', () => {
    for (const path of ['/api/health', '/api/user/session', '/api/user/access-request', '/api/admin/deals']) {
      expect(needsApprovedSession(path)).toBe(false)
    }
  })
})