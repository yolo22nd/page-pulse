import { z } from 'zod';

export const AuditRequestSchema = z.object({
  url: z
    .string({ required_error: 'url is required' })
    .trim()
    .url({ message: 'Must be a valid HTTP or HTTPS URL' })
    .refine((val) => val.startsWith('http://') || val.startsWith('https://'), {
      message: 'URL scheme must be http or https',
    }),
  timeoutMs: z
    .number()
    .int()
    .min(1000, { message: 'timeoutMs must be at least 1000ms' })
    .max(30000, { message: 'timeoutMs must not exceed 30000ms' })
    .default(10000),
  forceRefresh: z.boolean().default(false),
});

export type AuditRequest = z.infer<typeof AuditRequestSchema>;

export const HttpAuditSchema = z.object({
  statusCode: z.number(),
  responseTimeMs: z.number(),
  redirectChain: z.array(z.string()),
});
export type HttpAudit = z.infer<typeof HttpAuditSchema>;

export const SslAuditSchema = z
  .object({
    isValid: z.boolean(),
    issuer: z.string(),
    daysUntilExpiry: z.number(),
  })
  .nullable();
export type SslAudit = z.infer<typeof SslAuditSchema>;

export const SeoAuditSchema = z.object({
  title: z.string().nullable(),
  metaDescription: z.string().nullable(),
  canonicalUrl: z.string().nullable(),
  h1Count: z.number(),
  firstH1: z.string().nullable(),
  metaRobots: z.string().nullable(),
});
export type SeoAudit = z.infer<typeof SeoAuditSchema>;

export const BrokenLinkSchema = z.object({
  url: z.string(),
  statusCode: z.number().nullable(),
  error: z.string().nullable(),
});
export type BrokenLink = z.infer<typeof BrokenLinkSchema>;

export const BrokenLinksAuditSchema = z.object({
  checkedCount: z.number(),
  brokenCount: z.number(),
  skippedCount: z.number(),
  brokenLinks: z.array(BrokenLinkSchema),
});
export type BrokenLinksAudit = z.infer<typeof BrokenLinksAuditSchema>;

export const PerformanceAuditSchema = z.object({
  htmlSizeBytes: z.number(),
  scriptTagCount: z.number(),
  cssTagCount: z.number(),
  score: z.number().min(0).max(100),
});
export type PerformanceAudit = z.infer<typeof PerformanceAuditSchema>;

export const AuditResultDataSchema = z.object({
  url: z.string(),
  auditedAt: z.string(),
  overallScore: z.number().min(0).max(100),
  http: HttpAuditSchema,
  ssl: SslAuditSchema,
  seo: SeoAuditSchema,
  brokenLinks: BrokenLinksAuditSchema,
  performance: PerformanceAuditSchema,
  errors: z.array(z.string()).default([]),
  cached: z.boolean().default(false),
  cacheAge: z.number().nullable().default(null),
});
export type AuditResultData = z.infer<typeof AuditResultDataSchema>;

export const AuditSuccessResponseSchema = z.object({
  success: z.literal(true),
  data: AuditResultDataSchema,
});
export type AuditSuccessResponse = z.infer<typeof AuditSuccessResponseSchema>;

export const ApiErrorCodeSchema = z.enum([
  'VALIDATION_ERROR',
  'UPSTREAM_FETCH_ERROR',
  'REDIRECT_LIMIT_EXCEEDED',
  'AUDIT_TIMEOUT',
  'CONCURRENCY_LIMIT_EXCEEDED',
  'RATE_LIMIT_EXCEEDED',
  'INTERNAL_SERVER_ERROR',
]);
export type ApiErrorCode = z.infer<typeof ApiErrorCodeSchema>;

export const ApiErrorResponseSchema = z.object({
  error: z.object({
    code: ApiErrorCodeSchema,
    message: z.string(),
    details: z.unknown().optional(),
  }),
});
export type ApiErrorResponse = z.infer<typeof ApiErrorResponseSchema>;
