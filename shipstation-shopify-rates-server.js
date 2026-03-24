#!/usr/bin/env node

/**
 * Shopify CarrierService callback -> ShipStation v2 rates bridge.
 *
 * Exposes:
 * - POST /shopify/carrier/rates
 * - GET  /health
 */

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { URL } = require('node:url');

function loadDotEnv(filepath) {
  if (!fs.existsSync(filepath)) return;

  const lines = fs.readFileSync(filepath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const separatorIndex = trimmed.indexOf('=');
    if (separatorIndex === -1) continue;

    const key = trimmed.slice(0, separatorIndex).trim();
    if (!key || Object.prototype.hasOwnProperty.call(process.env, key)) continue;

    let value = trimmed.slice(separatorIndex + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    process.env[key] = value;
  }
}

loadDotEnv(path.join(process.cwd(), '.env'));

const PORT = Number(process.env.PORT || 3000);
const SERVER_REQUEST_TIMEOUT_MS = Number(process.env.SERVER_REQUEST_TIMEOUT_MS || 15000);
const SERVER_HEADERS_TIMEOUT_MS = Number(process.env.SERVER_HEADERS_TIMEOUT_MS || 16000);
const SERVER_KEEP_ALIVE_TIMEOUT_MS = Number(process.env.SERVER_KEEP_ALIVE_TIMEOUT_MS || 5000);
const SHUTDOWN_GRACE_PERIOD_MS = Number(process.env.SHUTDOWN_GRACE_PERIOD_MS || 10000);
const SHIPSTATION_API_BASE_URL =
  process.env.SHIPSTATION_API_BASE_URL || 'https://api.shipstation.com/v2';
const SHIPSTATION_API_KEY = process.env.SHIPSTATION_API_KEY;
const SHIPSTATION_CARRIER_IDS = (process.env.SHIPSTATION_CARRIER_IDS || '')
  .split(',')
  .map((id) => id.trim())
  .filter(Boolean);
const SHIPSTATION_RATE_LIMIT_BACKOFF_MS = Number(process.env.SHIPSTATION_RATE_LIMIT_BACKOFF_MS || 5000);
const SHIPSTATION_TIMEOUT_MS = Number(process.env.SHIPSTATION_TIMEOUT_MS || 10000);
const DEFAULT_PACKAGE_WEIGHT_OZ = Number(process.env.DEFAULT_PACKAGE_WEIGHT_OZ || 4);
const RETURN_EMPTY_RATES_ON_ERROR = process.env.RETURN_EMPTY_RATES_ON_ERROR !== 'false';
const DEFAULT_CONTACT_PHONE = process.env.DEFAULT_CONTACT_PHONE || '5555555555';
const DEFAULT_RATE_DESCRIPTION = process.env.DEFAULT_RATE_DESCRIPTION || 'discreption here';
const RATE_CACHE_TTL_MS = Number(process.env.RATE_CACHE_TTL_MS || 180000);
const RATE_CACHE_STALE_TTL_MS = Math.max(
  RATE_CACHE_TTL_MS,
  Number(process.env.RATE_CACHE_STALE_TTL_MS || 3600000)
);
const RATE_CACHE_MAX_ENTRIES = Number(process.env.RATE_CACHE_MAX_ENTRIES || 1000);
const EMPTY_RATES_RETRY_ATTEMPTS = Number(process.env.EMPTY_RATES_RETRY_ATTEMPTS || 1);
const EMPTY_RATES_RETRY_DELAY_MS = Number(process.env.EMPTY_RATES_RETRY_DELAY_MS || 200);
const TECH_SUIT_TAG = process.env.TECH_SUIT_TAG || 'TECH-SUIT';
const SHOPIFY_STORE_DOMAIN = String(
  process.env.SHOPIFY_STORE_DOMAIN || process.env.SHOPIFY_SHOP_DOMAIN || process.env.SHOPIFY_STORE_URL || ''
).trim();
const SHOPIFY_ADMIN_API_TOKEN = String(
  process.env.SHOPIFY_ADMIN_API_TOKEN || process.env.SHOPIFY_ADMIN_ACCESS_TOKEN || process.env.SHOPIFY_ACCESS_TOKEN || ''
).trim();
const SHOPIFY_CLIENT_ID = String(
  process.env.SHOPIFY_CLIENT_ID || process.env.SHOPIFY_API_KEY || ''
).trim();
const SHOPIFY_CLIENT_SECRET = String(
  process.env.SHOPIFY_CLIENT_SECRET || process.env.SHOPIFY_API_SECRET || process.env.SHOPIFY_API_SECRET_KEY || ''
).trim();
const SHOPIFY_ADMIN_API_VERSION =
  process.env.SHOPIFY_ADMIN_API_VERSION || process.env.SHOPIFY_API_VERSION || '2025-10';
const SHOPIFY_PRODUCT_TAG_TIMEOUT_MS = Number(process.env.SHOPIFY_PRODUCT_TAG_TIMEOUT_MS || 1200);
const SHOPIFY_PRODUCT_TAG_CACHE_TTL_MS = Number(process.env.SHOPIFY_PRODUCT_TAG_CACHE_TTL_MS || 900000);
const SHOPIFY_PRODUCT_TAG_BATCH_SIZE = Math.max(1, Number(process.env.SHOPIFY_PRODUCT_TAG_BATCH_SIZE || 100));
const PRODUCT_TAG_CACHE_MAX_ENTRIES = Number(process.env.PRODUCT_TAG_CACHE_MAX_ENTRIES || 5000);
const SHOPIFY_TOKEN_TIMEOUT_MS = Number(process.env.SHOPIFY_TOKEN_TIMEOUT_MS || 2000);
const SHOPIFY_TOKEN_EXPIRY_SKEW_MS = Number(process.env.SHOPIFY_TOKEN_EXPIRY_SKEW_MS || 60000);
const RATE_INFLATION = 0.10;
const UPS_SERVICE_KEYS = new Set(['ups_ground', 'ups_2_day', 'ups_next_day']);
const ALLOWED_SERVICE_SPECS = [
  {
    key: 'usps_ground_advantage',
    service_name: 'USPS Ground Advantage',
    service_code: 'usps_ground_advantage',
    description:
      process.env.DESC_USPS_GROUND_ADVANTAGE ||
      process.env.DESC_USPS_FIRST_CLASS_MAIL ||
      process.env.DESC_USPS_FIRST_CLASS ||
      DEFAULT_RATE_DESCRIPTION,
  },
  {
    key: 'usps_priority_mail',
    service_name: 'USPS Priority Mail',
    service_code: 'usps_priority_mail',
    description: process.env.DESC_USPS_PRIORITY_MAIL || process.env.DESC_USPS_PRIORITY || DEFAULT_RATE_DESCRIPTION,
  },
  {
    key: 'ups_ground',
    service_name: 'UPS Ground',
    service_code: 'ups_ground',
    description: process.env.DESC_UPS_GROUND || DEFAULT_RATE_DESCRIPTION,
  },
  {
    key: 'ups_2_day',
    service_name: 'UPS 2nd Day Air',
    service_code: 'ups_2_day',
    description: process.env.DESC_UPS_2_DAY || DEFAULT_RATE_DESCRIPTION,
  },
  {
    key: 'ups_next_day',
    service_name: 'UPS Next Day Air',
    service_code: 'ups_next_day',
    description: process.env.DESC_UPS_NEXT_DAY || DEFAULT_RATE_DESCRIPTION,
  },
];

const SHIP_FROM = {
  name: process.env.SHIP_FROM_NAME || 'Warehouse',
  company_name: process.env.SHIP_FROM_COMPANY || '',
  phone: process.env.SHIP_FROM_PHONE || DEFAULT_CONTACT_PHONE,
  address_line1: process.env.SHIP_FROM_ADDRESS1 || '',
  address_line2: process.env.SHIP_FROM_ADDRESS2 || '',
  city_locality: process.env.SHIP_FROM_CITY || '',
  state_province: process.env.SHIP_FROM_STATE || '',
  postal_code: process.env.SHIP_FROM_POSTAL_CODE || '',
  country_code: process.env.SHIP_FROM_COUNTRY_CODE || 'US',
  address_residential_indicator: process.env.SHIP_FROM_RESIDENTIAL || 'no',
};

const rateCache = new Map();
const inFlightRateFetches = new Map();
const productTagCache = new Map();
const inFlightProductTagLookups = new Map();
let shopifyAccessTokenCache = null;
let inFlightShopifyAccessTokenPromise = null;
let hasWarnedMissingShopifyTagConfig = false;
let shipStationRateLimitedUntil = 0;

function validateStartupConfig() {
  const missing = [];
  if (!SHIPSTATION_API_KEY) missing.push('SHIPSTATION_API_KEY');
  if (!SHIPSTATION_CARRIER_IDS.length) missing.push('SHIPSTATION_CARRIER_IDS');
  if (!SHIP_FROM.address_line1) missing.push('SHIP_FROM_ADDRESS1');
  if (!SHIP_FROM.city_locality) missing.push('SHIP_FROM_CITY');
  if (!SHIP_FROM.state_province) missing.push('SHIP_FROM_STATE');
  if (!SHIP_FROM.postal_code) missing.push('SHIP_FROM_POSTAL_CODE');

  if (missing.length) {
    throw new Error(`Missing required env vars: ${missing.join(', ')}`);
  }
}

function sendJson(res, status, payload) {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  res.end(JSON.stringify(payload));
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    const maxBytes = Number(process.env.MAX_REQUEST_BODY_BYTES || 262144);
    let settled = false;

    req.on('data', (chunk) => {
      if (settled) return;
      totalBytes += chunk.length;
      if (totalBytes > maxBytes) {
        settled = true;
        reject(new Error('Request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      if (settled) return;
      try {
        const raw = Buffer.concat(chunks).toString('utf8') || '{}';
        settled = true;
        resolve(JSON.parse(raw));
      } catch (error) {
        settled = true;
        reject(new Error('Invalid JSON body'));
      }
    });
    req.on('error', (error) => {
      if (settled) return;
      settled = true;
      reject(error);
    });
  });
}

function toOunces(grams) {
  return grams / 28.349523125;
}

function toGrams(value, unit) {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) return 0;

  const normalizedUnit = normalizeToken(unit || 'g');
  if (normalizedUnit === 'kg' || normalizedUnit === 'kilogram' || normalizedUnit === 'kilograms') {
    return amount * 1000;
  }
  if (normalizedUnit === 'lb' || normalizedUnit === 'lbs' || normalizedUnit === 'pound' || normalizedUnit === 'pounds') {
    return amount * 453.59237;
  }
  if (
    normalizedUnit === 'oz' ||
    normalizedUnit === 'ounce' ||
    normalizedUnit === 'ounces'
  ) {
    return amount * 28.349523125;
  }
  return amount;
}

function getItemWeightGrams(item) {
  const directGrams = Number(item?.grams);
  if (Number.isFinite(directGrams) && directGrams > 0) {
    return directGrams;
  }

  const weightInGramsField = Number(item?.weight_grams || item?.gram_weight);
  if (Number.isFinite(weightInGramsField) && weightInGramsField > 0) {
    return weightInGramsField;
  }

  const weightValueCandidates = [item?.weight, item?.weight_value, item?.variant_weight];
  const weightUnitCandidates = [item?.weight_unit, item?.unit, item?.variant_weight_unit];

  for (const value of weightValueCandidates) {
    for (const unit of weightUnitCandidates) {
      const grams = toGrams(value, unit);
      if (grams > 0) return grams;
    }
    const grams = toGrams(value, 'g');
    if (grams > 0) return grams;
  }

  return 0;
}

function getTotalWeightGrams(items) {
  if (!Array.isArray(items) || items.length === 0) return 0;

  return items.reduce((sum, item) => {
    const itemGrams = getItemWeightGrams(item);
    const quantity = Number(item?.quantity || 1);
    const normalizedQuantity = Number.isFinite(quantity) && quantity > 0 ? quantity : 1;
    return sum + itemGrams * normalizedQuantity;
  }, 0);
}

function normalizePhone(input) {
  const value = String(input || '').trim();
  if (!value) return DEFAULT_CONTACT_PHONE;
  return value;
}

function normalizeToken(input) {
  return String(input || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '');
}

function normalizeProductId(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;

  if (/^\d+$/.test(raw)) return raw;

  const gidMatch = raw.match(/\/(\d+)\s*$/);
  if (gidMatch) return gidMatch[1];

  return null;
}

function splitTagValues(rawValue) {
  if (Array.isArray(rawValue)) {
    return rawValue.flatMap((value) => splitTagValues(value));
  }

  if (rawValue && typeof rawValue === 'object') {
    return Object.values(rawValue).flatMap((value) => splitTagValues(value));
  }

  const value = String(rawValue || '').trim();
  if (!value) return [];
  return value.split(/[|,]/).map((part) => part.trim()).filter(Boolean);
}

function itemHasTag(item, tagName) {
  const target = normalizeToken(tagName);
  return itemHasNormalizedTag(item, target);
}

function itemHasNormalizedTag(item, normalizedTag) {
  const target = String(normalizedTag || '').trim();
  if (!target) return false;

  const directTagFields = [
    item?.tags,
    item?.tag,
    item?.tag_list,
    item?.product_tags,
    item?.product_tag,
  ];

  for (const field of directTagFields) {
    const values = splitTagValues(field);
    if (values.some((value) => normalizeToken(value) === target)) {
      return true;
    }
  }

  if (Array.isArray(item?.properties)) {
    for (const property of item.properties) {
      const propertyKey = normalizeToken(property?.name || property?.key || '');
      if (!propertyKey.includes('tag')) continue;
      const values = splitTagValues(property?.value || property?.values);
      if (values.some((value) => normalizeToken(value) === target)) {
        return true;
      }
    }
  }

  return false;
}

function cartHasTag(shopifyRateRequest, tagName) {
  return inspectCartForTag(shopifyRateRequest, tagName).hasTag;
}

function inspectCartForTag(shopifyRateRequest, tagName) {
  const items = shopifyRateRequest?.rate?.items;
  if (!Array.isArray(items) || items.length === 0) {
    return {
      hasTag: false,
      productIds: [],
    };
  }

  const targetTag = normalizeToken(tagName);
  const ids = new Set();
  for (const item of items) {
    if (itemHasNormalizedTag(item, targetTag)) {
      return {
        hasTag: true,
        productIds: [],
      };
    }

    const candidates = [item?.product_id, item?.productId, item?.product?.id];
    for (const candidate of candidates) {
      const productId = normalizeProductId(candidate);
      if (productId) {
        ids.add(productId);
        break;
      }
    }
  }

  return {
    hasTag: false,
    productIds: Array.from(ids),
  };
}

function getCachedProductTagFlag(productId) {
  const entry = productTagCache.get(productId);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    productTagCache.delete(productId);
    return null;
  }
  return entry.hasTechSuit;
}

function setCachedProductTagFlag(productId, hasTechSuit) {
  if (!productId) return;
  productTagCache.set(productId, {
    hasTechSuit: Boolean(hasTechSuit),
    expiresAt: Date.now() + SHOPIFY_PRODUCT_TAG_CACHE_TTL_MS,
  });
  trimMapToMaxEntries(productTagCache, PRODUCT_TAG_CACHE_MAX_ENTRIES);
}

function chunkArray(values, size) {
  if (!Array.isArray(values) || values.length === 0) return [];
  const chunks = [];
  for (let index = 0; index < values.length; index += size) {
    chunks.push(values.slice(index, index + size));
  }
  return chunks;
}

function getShopifyStoreDomain() {
  const raw = String(SHOPIFY_STORE_DOMAIN || '').trim();
  if (!raw) return '';

  try {
    const normalizedWithProtocol = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
    const parsed = new URL(normalizedWithProtocol);
    return String(parsed.host || '').trim().toLowerCase();
  } catch (_) {
    return raw
      .replace(/^https?:\/\//i, '')
      .split('/')[0]
      .trim()
      .toLowerCase();
  }
}

function canFetchShopifyProductTags() {
  const hasStaticToken = Boolean(SHOPIFY_ADMIN_API_TOKEN);
  const hasClientCredentials = Boolean(SHOPIFY_CLIENT_ID && SHOPIFY_CLIENT_SECRET);
  return Boolean(getShopifyStoreDomain() && (hasStaticToken || hasClientCredentials));
}

async function fetchShopifyAccessTokenViaClientCredentials() {
  const storeDomain = getShopifyStoreDomain();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_TOKEN_TIMEOUT_MS);

  try {
    const response = await fetch(`https://${storeDomain}/admin/oauth/access_token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: SHOPIFY_CLIENT_ID,
        client_secret: SHOPIFY_CLIENT_SECRET,
      }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Shopify token ${response.status}: ${errorBody}`);
    }

    const payload = await response.json();
    const accessToken = String(payload?.access_token || '').trim();
    if (!accessToken) {
      throw new Error('Shopify token response missing access_token');
    }

    const expiresInSeconds = Number(payload?.expires_in || 0);
    const ttlMs =
      expiresInSeconds > 0
        ? Math.max(0, expiresInSeconds * 1000 - SHOPIFY_TOKEN_EXPIRY_SKEW_MS)
        : 5 * 60 * 1000;
    const expiresAt = Date.now() + ttlMs;

    shopifyAccessTokenCache = {
      token: accessToken,
      expiresAt,
    };
    return accessToken;
  } finally {
    clearTimeout(timeout);
  }
}

async function getShopifyAdminAccessToken() {
  if (SHOPIFY_ADMIN_API_TOKEN) {
    return SHOPIFY_ADMIN_API_TOKEN;
  }

  if (!SHOPIFY_CLIENT_ID || !SHOPIFY_CLIENT_SECRET) {
    throw new Error('Missing Shopify token credentials');
  }

  if (shopifyAccessTokenCache && shopifyAccessTokenCache.expiresAt > Date.now()) {
    return shopifyAccessTokenCache.token;
  }

  if (inFlightShopifyAccessTokenPromise) {
    return inFlightShopifyAccessTokenPromise;
  }

  inFlightShopifyAccessTokenPromise = (async () => {
    try {
      return await fetchShopifyAccessTokenViaClientCredentials();
    } finally {
      inFlightShopifyAccessTokenPromise = null;
    }
  })();

  return inFlightShopifyAccessTokenPromise;
}

async function fetchShopifyProductTagsForIds(productIds) {
  const storeDomain = getShopifyStoreDomain();
  const accessToken = await getShopifyAdminAccessToken();
  const query = `
    query ProductTags($ids: [ID!]!) {
      nodes(ids: $ids) {
        ... on Product {
          id
          tags
        }
      }
    }
  `;
  const variables = {
    ids: productIds.map((productId) => `gid://shopify/Product/${productId}`),
  };
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHOPIFY_PRODUCT_TAG_TIMEOUT_MS);

  try {
    const response = await fetch(
      `https://${storeDomain}/admin/api/${SHOPIFY_ADMIN_API_VERSION}/graphql.json`,
      {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': accessToken,
        },
        body: JSON.stringify({ query, variables }),
        signal: controller.signal,
      }
    );

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Shopify ${response.status}: ${errorBody}`);
    }

    const payload = await response.json();
    if (Array.isArray(payload?.errors) && payload.errors.length) {
      throw new Error(`Shopify GraphQL error: ${JSON.stringify(payload.errors)}`);
    }

    const result = new Map();
    for (const productId of productIds) {
      result.set(productId, false);
    }

    const nodes = Array.isArray(payload?.data?.nodes) ? payload.data.nodes : [];
    const tagToken = normalizeToken(TECH_SUIT_TAG);

    for (const node of nodes) {
      const productId = normalizeProductId(node?.id);
      if (!productId) continue;
      const tags = Array.isArray(node?.tags) ? node.tags : [];
      const hasTechSuit = tags.some((tag) => normalizeToken(tag) === tagToken);
      result.set(productId, hasTechSuit);
    }

    return result;
  } finally {
    clearTimeout(timeout);
  }
}

async function hydrateProductTagCache(productIds) {
  const pendingIds = Array.from(
    new Set(productIds.filter((productId) => getCachedProductTagFlag(productId) === null))
  );
  if (pendingIds.length === 0) return;

  if (!canFetchShopifyProductTags()) {
    if (!hasWarnedMissingShopifyTagConfig) {
      hasWarnedMissingShopifyTagConfig = true;
      console.warn(
        '[product-tag-lookup] missing SHOPIFY_STORE_DOMAIN and auth (SHOPIFY_ADMIN_API_TOKEN or SHOPIFY_CLIENT_ID/SHOPIFY_CLIENT_SECRET); skipping product tag lookup'
      );
    }
    return;
  }

  const waitFor = [];
  const idsToFetch = [];

  for (const productId of pendingIds) {
    const inFlight = inFlightProductTagLookups.get(productId);
    if (inFlight) {
      waitFor.push(inFlight);
      continue;
    }
    idsToFetch.push(productId);
  }

  const chunks = chunkArray(idsToFetch.sort(), SHOPIFY_PRODUCT_TAG_BATCH_SIZE);
  for (const chunk of chunks) {
    const fetchPromise = (async () => {
      try {
        const tagMap = await fetchShopifyProductTagsForIds(chunk);
        for (const productId of chunk) {
          setCachedProductTagFlag(productId, tagMap.get(productId) === true);
        }
      } catch (error) {
        console.warn('[product-tag-lookup] failed; continuing without product-tag override', error);
      } finally {
        for (const productId of chunk) {
          inFlightProductTagLookups.delete(productId);
        }
      }
    })();

    for (const productId of chunk) {
      inFlightProductTagLookups.set(productId, fetchPromise);
    }
    waitFor.push(fetchPromise);
  }

  await Promise.allSettled(waitFor);
}

async function resolveUpsOnlyForRequest(shopifyRateRequest) {
  const cartInspection = inspectCartForTag(shopifyRateRequest, TECH_SUIT_TAG);
  if (cartInspection.hasTag) {
    return true;
  }

  const productIds = cartInspection.productIds;
  if (productIds.length === 0) {
    return false;
  }

  await hydrateProductTagCache(productIds);
  return productIds.some((productId) => getCachedProductTagFlag(productId) === true);
}

function inflateAmount(amount, serviceKey) {
  if (!serviceKey) return amount;
  return amount * (1 + RATE_INFLATION);
}

function buildRateCacheKey(shopifyRateRequest, options = {}) {
  const { upsOnly: explicitUpsOnly } = options;
  const rate = shopifyRateRequest?.rate || {};
  const destination = rate.destination || {};

  const country = String(destination.country_code || destination.country || '').toUpperCase();
  const state = String(destination.province_code || destination.province || '').toUpperCase();
  const postal = String(destination.postal_code || '').toUpperCase();
  const city = normalizeToken(destination.city || '');
  const address1 = normalizeToken(destination.address1 || '');
  const currency = String(rate.currency || 'USD').toUpperCase();
  const grams = getTotalWeightGrams(rate.items);
  const itemCount = Array.isArray(rate.items) ? rate.items.length : 0;
  const upsOnly =
    explicitUpsOnly === undefined
      ? cartHasTag(shopifyRateRequest, TECH_SUIT_TAG)
      : Boolean(explicitUpsOnly);

  return `${country}|${state}|${postal}|${city}|${address1}|${currency}|${grams}|${itemCount}|upsOnly:${upsOnly ? '1' : '0'}`;
}

function trimMapToMaxEntries(map, maxEntries) {
  while (map.size > maxEntries) {
    const firstKey = map.keys().next().value;
    if (firstKey === undefined) break;
    map.delete(firstKey);
  }
}

function getShipStationStatusCode(error) {
  const match = String(error?.message || '').match(/^ShipStation (\d+):/);
  return match ? Number(match[1]) : null;
}

function isShipStationRateLimitError(error) {
  return getShipStationStatusCode(error) === 429;
}

function setShipStationRateLimitCooldown(retryAfterSeconds) {
  const retryAfterMs =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds * 1000
      : SHIPSTATION_RATE_LIMIT_BACKOFF_MS;
  shipStationRateLimitedUntil = Math.max(shipStationRateLimitedUntil, Date.now() + retryAfterMs);
}

function getShipStationCooldownRemainingMs() {
  return Math.max(0, shipStationRateLimitedUntil - Date.now());
}

function getCachedRates(cacheKey, options = {}) {
  const { allowStale = false } = options;
  if (!cacheKey) return null;
  const entry = rateCache.get(cacheKey);
  if (!entry) return null;
  if (entry.staleExpiresAt <= Date.now()) {
    rateCache.delete(cacheKey);
    return null;
  }
  if (!allowStale && entry.freshExpiresAt <= Date.now()) {
    return null;
  }
  return entry.rates;
}

function setCachedRates(cacheKey, rates) {
  if (!cacheKey || !Array.isArray(rates) || !rates.length) return;
  const now = Date.now();
  rateCache.set(cacheKey, {
    rates,
    freshExpiresAt: now + RATE_CACHE_TTL_MS,
    staleExpiresAt: now + RATE_CACHE_STALE_TTL_MS,
  });
  trimMapToMaxEntries(rateCache, RATE_CACHE_MAX_ENTRIES);
}

async function fetchRatesForCacheKey(cacheKey, fetcher) {
  const inFlight = inFlightRateFetches.get(cacheKey);
  if (inFlight) return inFlight;

  const requestPromise = (async () => {
    try {
      return await fetcher();
    } finally {
      inFlightRateFetches.delete(cacheKey);
    }
  })();

  inFlightRateFetches.set(cacheKey, requestPromise);
  return requestPromise;
}

function buildShipStationRateRequest(shopifyRateRequest) {
  const rate = shopifyRateRequest?.rate || {};
  const destination = rate.destination || {};

  const destinationName =
    destination.name ||
    [destination.first_name, destination.last_name].filter(Boolean).join(' ') ||
    'Customer';

  const stateProvince = destination.province_code || destination.province || '';
  const countryCode = destination.country_code || destination.country || 'US';
  const shipTo = {
    name: destinationName,
    phone: normalizePhone(destination.phone),
    company_name: destination.company_name || destination.company || '',
    // Shopify may call this endpoint while the customer is still editing the address.
    address_line1: destination.address1 || 'Address Pending',
    address_line2: destination.address2 || '',
    city_locality: destination.city || destination.province || 'City Pending',
    state_province: stateProvince || 'State Pending',
    postal_code: destination.postal_code || '',
    country_code: countryCode,
    address_residential_indicator: 'unknown',
  };

  const totalGrams = getTotalWeightGrams(rate.items);
  const rawWeightOz = totalGrams > 0 ? toOunces(totalGrams) : DEFAULT_PACKAGE_WEIGHT_OZ;
  const weightOz = Math.max(1, Math.ceil(rawWeightOz));
  if (totalGrams > 0) {
    console.log(
      `[rate-weight] total_grams=${Math.round(totalGrams)} total_ounces_raw=${rawWeightOz.toFixed(2)} total_ounces_rounded=${weightOz}`
    );
  } else {
    console.log(
      `[rate-weight] no line-item weight found; using DEFAULT_PACKAGE_WEIGHT_OZ=${DEFAULT_PACKAGE_WEIGHT_OZ} rounded_to=${weightOz}`
    );
  }

  return {
    rate_options: {
      carrier_ids: SHIPSTATION_CARRIER_IDS,
    },
    shipment: {
      validate_address: 'no_validation',
      ship_to: shipTo,
      ship_from: SHIP_FROM,
      packages: [
        {
          package_code: process.env.SHIPSTATION_PACKAGE_CODE || 'package',
          weight: {
            value: weightOz,
            unit: 'ounce',
          },
        },
      ],
    },
  };
}

function hasMinimumDestinationForRating(shopifyRateRequest) {
  const destination = shopifyRateRequest?.rate?.destination || {};
  const stateProvince = destination.province_code || destination.province || '';
  const countryCode = destination.country_code || destination.country || '';
  const normalizedCountry = String(countryCode || '').toUpperCase();

  if (!destination.postal_code || !countryCode) return false;
  if (normalizedCountry === 'US' || normalizedCountry === 'CA') {
    return Boolean(stateProvince);
  }
  return true;
}

function asNumber(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : 0;
}

function getRateTotalAmount(rate) {
  return (
    asNumber(rate?.shipping_amount?.amount) +
    asNumber(rate?.insurance_amount?.amount) +
    asNumber(rate?.confirmation_amount?.amount) +
    asNumber(rate?.other_amount?.amount)
  );
}

function normalizeRateCurrency(rate, fallback) {
  const currency =
    rate?.shipping_amount?.currency || rate?.other_amount?.currency || fallback || 'USD';
  return String(currency).toUpperCase();
}

function getCanonicalServiceKey(rate) {
  const carrier = normalizeToken(rate?.carrier_code || rate?.carrier_friendly_name || '');
  const serviceCode = normalizeToken(rate?.service_code || '');
  const serviceType = normalizeToken(rate?.service_type || '');

  if (carrier.includes('usps')) {
    if (
      serviceCode === 'uspsgroundadvantage' ||
      serviceType === 'uspsgroundadvantage' ||
      serviceCode === 'uspsfirstclassmail' ||
      serviceType === 'uspsfirstclassmail'
    ) {
      return 'usps_ground_advantage';
    }
    if (serviceCode === 'uspsprioritymail' || serviceType === 'uspsprioritymail') {
      return 'usps_priority_mail';
    }
    return null;
  }

  if (carrier.includes('ups')) {
    // Keep Next Day strict so we don't accidentally select Air Early/Saver variants.
    if (serviceCode === 'upsnextdayair' || serviceType === 'upsnextdayair') {
      return 'ups_next_day';
    }
    if (serviceCode === 'ups2nddayair' || serviceType === 'ups2nddayair') {
      return 'ups_2_day';
    }
    if (serviceCode === 'upsground' || serviceType === 'upsground') {
      return 'ups_ground';
    }
    return null;
  }

  return null;
}

function isUspsPriorityPackageVariant(rate) {
  const candidates = [
    rate?.package_type,
    rate?.package_code,
    rate?.package_name,
    rate?.package_friendly_name,
    rate?.package_description,
    rate?.service_name,
    rate?.service_friendly_name,
  ];

  return candidates.some((value) => {
    const token = normalizeToken(value);
    if (!token) return false;
    if (token === 'package' || token === 'parcel') return true;
    if (token.includes('flatrate')) return false;
    return token.endsWith('package');
  });
}

function pickAllowedRates(shipStationRates, options = {}) {
  const { upsOnly = false } = options;
  const selectedByService = new Map();

  for (const rate of shipStationRates) {
    const canonicalKey = getCanonicalServiceKey(rate);
    if (!canonicalKey) continue;
    if (upsOnly && !UPS_SERVICE_KEYS.has(canonicalKey)) continue;

    const existing = selectedByService.get(canonicalKey);
    if (!existing) {
      selectedByService.set(canonicalKey, rate);
      continue;
    }

    const existingAmount = getRateTotalAmount(existing);
    const nextAmount = getRateTotalAmount(rate);
    if (canonicalKey === 'usps_priority_mail') {
      const existingIsPackage = isUspsPriorityPackageVariant(existing);
      const nextIsPackage = isUspsPriorityPackageVariant(rate);

      if (nextIsPackage && !existingIsPackage) {
        selectedByService.set(canonicalKey, rate);
        continue;
      }
      if (!nextIsPackage && existingIsPackage) {
        continue;
      }
      if (nextAmount < existingAmount) {
        selectedByService.set(canonicalKey, rate);
      }
      continue;
    }

    if (UPS_SERVICE_KEYS.has(canonicalKey)) {
      if (nextAmount < existingAmount) {
        selectedByService.set(canonicalKey, rate);
      }
      continue;
    }

    if (nextAmount > existingAmount) {
      selectedByService.set(canonicalKey, rate);
    }
  }

  return ALLOWED_SERVICE_SPECS
    .filter((serviceSpec) => !upsOnly || UPS_SERVICE_KEYS.has(serviceSpec.key))
    .map((serviceSpec) => {
      const rate = selectedByService.get(serviceSpec.key);
      if (!rate) return null;
      return { rate, serviceSpec };
    })
    .filter(Boolean);
}

function mapShipStationRateToShopifyRate(rate, checkoutCurrency, serviceSpec) {
  const baseAmount = getRateTotalAmount(rate);
  const inflatedAmount = inflateAmount(baseAmount, serviceSpec.key);
  const totalPriceSubunits = Math.max(0, Math.round(inflatedAmount * 100));

  return {
    service_name: serviceSpec.service_name,
    service_code: serviceSpec.service_code,
    total_price: String(totalPriceSubunits),
    currency: normalizeRateCurrency(rate, checkoutCurrency),
    description: serviceSpec.description,
  };
}

async function fetchShipStationRates(body) {
  const cooldownRemainingMs = getShipStationCooldownRemainingMs();
  if (cooldownRemainingMs > 0) {
    throw new Error(`ShipStation 429: cooldown active (${cooldownRemainingMs}ms remaining)`);
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), SHIPSTATION_TIMEOUT_MS);

  try {
    const response = await fetch(`${SHIPSTATION_API_BASE_URL}/rates`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'API-Key': SHIPSTATION_API_KEY,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!response.ok) {
      const errorBody = await response.text();
      if (response.status === 429) {
        const retryAfterSeconds = Number(response.headers.get('retry-after'));
        setShipStationRateLimitCooldown(retryAfterSeconds);
      }
      throw new Error(`ShipStation ${response.status}: ${errorBody}`);
    }

    const payload = await response.json();
    return payload?.rate_response?.rates || [];
  } finally {
    clearTimeout(timeout);
  }
}

function delay(ms) {
  if (ms <= 0) return Promise.resolve();
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchShipStationRatesWithFallback(body) {
  try {
    return await fetchShipStationRates(body);
  } catch (error) {
    if (SHIPSTATION_CARRIER_IDS.length <= 1 || isShipStationRateLimitError(error)) {
      throw error;
    }

    console.warn('[shipstation-fallback] multi-carrier request failed, trying one-by-one');
    const allRates = [];
    let lastError = error;

    for (const carrierId of SHIPSTATION_CARRIER_IDS) {
      try {
        const fallbackBody = {
          ...body,
          rate_options: {
            ...(body.rate_options || {}),
            carrier_ids: [carrierId],
          },
        };

        const rates = await fetchShipStationRates(fallbackBody);
        allRates.push(...rates);
      } catch (singleError) {
        lastError = singleError;
        console.warn(`[shipstation-fallback] carrier failed: ${carrierId}`);
      }
    }

    if (allRates.length > 0) {
      return allRates;
    }

    throw lastError;
  }
}

async function fetchShipStationRatesWithSafeRetry(body) {
  let rates = await fetchShipStationRatesWithFallback(body);
  for (let attempt = 1; rates.length === 0 && attempt <= EMPTY_RATES_RETRY_ATTEMPTS; attempt += 1) {
    console.warn(
      `[shipstation-retry] empty rates received; retrying (${attempt}/${EMPTY_RATES_RETRY_ATTEMPTS})`
    );
    await delay(EMPTY_RATES_RETRY_DELAY_MS);
    rates = await fetchShipStationRatesWithFallback(body);
  }
  return rates;
}

async function handleRateRequest(req, res) {
  let shopifyRequest = null;
  let upsOnly = false;
  let cacheKey = null;
  try {
    shopifyRequest = await readJsonBody(req);
    upsOnly = await resolveUpsOnlyForRequest(shopifyRequest);
    cacheKey = buildRateCacheKey(shopifyRequest, { upsOnly });

    if (!hasMinimumDestinationForRating(shopifyRequest)) {
      const cachedRates = getCachedRates(cacheKey);
      if (cachedRates) {
        console.log('[rate-skip] destination incomplete; returning cached rates');
        return sendJson(res, 200, { rates: cachedRates });
      }

      console.log('[rate-skip] destination incomplete; returning empty rates');
      return sendJson(res, 200, { rates: [] });
    }

    const shipStationRequest = buildShipStationRateRequest(shopifyRequest);
    const checkoutCurrency = shopifyRequest?.rate?.currency || 'USD';

    console.log(
      `[rate-request] destination=${shopifyRequest?.rate?.destination?.postal_code || 'unknown'} items=${Array.isArray(shopifyRequest?.rate?.items) ? shopifyRequest.rate.items.length : 0}`
    );
    if (upsOnly) {
      console.log(`[rate-filter] ${TECH_SUIT_TAG} tag found; USPS rates disabled for this cart`);
    }

    const cachedRates = getCachedRates(cacheKey);
    if (cachedRates) {
      console.log('[rate-cache] returning fresh cached rates');
      return sendJson(res, 200, { rates: cachedRates });
    }

    const rates = await fetchRatesForCacheKey(cacheKey, async () => {
      const shipStationRates = await fetchShipStationRatesWithSafeRetry(shipStationRequest);
      const allowedRates = pickAllowedRates(shipStationRates, { upsOnly });
      const mappedRates = allowedRates.map(({ rate, serviceSpec }) =>
        mapShipStationRateToShopifyRate(rate, checkoutCurrency, serviceSpec)
      );
      console.log(`[rate-response] raw=${shipStationRates.length} filtered=${mappedRates.length}`);
      return mappedRates;
    });
    const staleRates = rates.length === 0 ? getCachedRates(cacheKey, { allowStale: true }) : null;
    const responseRates = staleRates?.length ? staleRates : rates;

    if (staleRates?.length) {
      console.warn('[carrier-rates-fallback] returning stale cached rates after empty upstream response');
    }

    setCachedRates(cacheKey, rates);

    sendJson(res, 200, { rates: responseRates });
  } catch (error) {
    console.error('[carrier-rates-error]', error);

    if (RETURN_EMPTY_RATES_ON_ERROR) {
      const fallbackCacheKey =
        shopifyRequest && !cacheKey
          ? buildRateCacheKey(shopifyRequest, { upsOnly })
          : cacheKey;
      const fallbackRates = fallbackCacheKey
        ? getCachedRates(fallbackCacheKey, { allowStale: true })
        : null;
      if (fallbackRates) {
        console.warn('[carrier-rates-fallback] returning cached rates instead of empty');
        return sendJson(res, 200, { rates: fallbackRates });
      }

      console.warn('[carrier-rates-fallback] returning empty rates instead of 502');
      return sendJson(res, 200, { rates: [] });
    }

    // 5xx tells Shopify to use backup rates if configured.
    return sendJson(res, 502, {
      error: 'Unable to retrieve real-time rates',
    });
  }
}

function requestHandler(req, res) {
  const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);
  console.log(`[request] ${req.method} ${url.pathname}`);

  if (req.method === 'GET' && url.pathname === '/health') {
    return sendJson(res, 200, { status: 'ok' });
  }

  if (req.method === 'POST' && url.pathname === '/shopify/carrier/rates') {
    return handleRateRequest(req, res);
  }

  return sendJson(res, 404, { error: 'Not found' });
}

function bootstrap() {
  validateStartupConfig();

  const server = http.createServer(requestHandler);
  server.requestTimeout = SERVER_REQUEST_TIMEOUT_MS;
  server.headersTimeout = SERVER_HEADERS_TIMEOUT_MS;
  server.keepAliveTimeout = SERVER_KEEP_ALIVE_TIMEOUT_MS;
  server.on('error', (error) => {
    console.error('[server-error]', error);
    process.exit(1);
  });

  let isShuttingDown = false;
  const shutdown = (signal) => {
    if (isShuttingDown) return;
    isShuttingDown = true;
    console.log(`[shutdown] received ${signal}; closing server`);

    const forceCloseTimer = setTimeout(() => {
      console.error('[shutdown] grace period expired; forcing exit');
      process.exit(1);
    }, SHUTDOWN_GRACE_PERIOD_MS);

    server.close((error) => {
      clearTimeout(forceCloseTimer);
      if (error) {
        console.error('[shutdown] server close failed', error);
        process.exit(1);
      }
      console.log('[shutdown] server closed cleanly');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));

  server.listen(PORT, () => {
    console.log(`Carrier rate bridge listening on http://localhost:${PORT}`);
    console.log('POST /shopify/carrier/rates');
  });
}

bootstrap();
