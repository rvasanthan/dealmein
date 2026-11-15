export interface Deal {
  id: number
  title: string
  variant: string | null
  model: string | null
  condition: 'NEW' | 'USED' | 'REFURBISHED' | 'UNKNOWN'
  retailer: { name: string; slug: string }
  seller: string | null
  category: { name: string; slug: string }
  offerType: 'PRODUCT' | 'STOREWIDE'
  listedCashPrice: number | null
  sourcePriceText: string | null
  originalPriceText: string | null
  conditionsText: string | null
  rewardText: string | null
  rewardAmount: number | null
  shippingCost: number | null
  taxNote: string | null
  referencePrice: number | null
  referencePriceText: string | null
  discountPercent: number | null
  startsOn: string | null
  endsOn: string | null
  startsAt: string | null
  endsAt: string | null
  dateText: string | null
  dateStatus: 'KNOWN' | 'UNKNOWN' | 'CONFLICT'
  timing: 'active' | 'upcoming' | 'expired' | 'unknown'
  retailerTimezone: string | null
  collectedAt: string | null
  retailerVerifiedAt: string | null
  reviewedAt: string | null
  sourceVerificationStatus: string | null
  reviewNotices: string[]
  retailerLink: string | null
  listingLink?: string | null
  imageUrl: string | null
  featured: boolean
  status: 'DRAFT' | 'PUBLISHED' | 'EXPIRED' | 'ARCHIVED'
  relatedCount: number
  sources?: Source[]
  related?: Deal[]
  unavailable?: boolean
  // admin only
  sourceRecordId?: string
  reviewFlags?: string[]
  candidateGroupKey?: string | null
  productUrl?: string | null
  productUrlVerified?: boolean
  imageUrlRaw?: string | null
  imageAuthorized?: boolean
  archiveReason?: string | null
  overrides?: Record<string, boolean>
  importedSnapshot?: unknown
  openReports?: number
  publishedAt?: string | null
  audit?: AuditEvent[]
}

export interface Source {
  id: number
  name: string | null
  url: string | null
  ref: string
  collectedAt: string | null
  originRecordId?: string
  raw?: unknown
}

export interface Page<T> {
  items: T[]
  page: number
  size: number
  total: number
  totalPages: number
}

export interface Facet {
  name: string
  slug: string
  dealCount: number
}

export interface AuditEvent {
  id: number
  actor: string
  action: string
  entityType: string
  entityId: string | null
  details: unknown
  createdAt: string
}

export interface ApiErrorBody {
  status: number
  code: string
  message: string
  details?: Record<string, unknown>
}
