export type Env = {
  SITES: R2Bucket;
  ASSETS: Fetcher;
  DEPLOYS: RateLimit;
  LOOKUPS: RateLimit;
  BULK: RateLimit;
  SITE_DOMAIN: string;
  SITE_TOKEN?: string;
};
