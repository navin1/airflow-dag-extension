/**
 * Auth utilities for fetching a GCP Bearer token.
 *
 * Two modes (chosen in Settings):
 *  1. OAuth via chrome.identity.launchWebAuthFlow  — requires a GCP OAuth2 client_id
 *     configured as a "Web Application" with the redirect URI returned by
 *     chrome.identity.getRedirectURL(). Token is cached in chrome.storage.local.
 *  2. Manual token — user pastes a token from `gcloud auth print-access-token`.
 *     Stored in chrome.storage.sync with an optional expiry timestamp.
 */

const CACHE_KEY_TOKEN  = 'cached_gcp_token';
const CACHE_KEY_EXPIRY = 'cached_gcp_token_expiry';
const GCP_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

// ── Helpers ───────────────────────────────────────────────────────────────────

function chromeStorage() {
  return typeof chrome !== 'undefined' ? chrome.storage : null;
}

async function syncGet<T extends Record<string, unknown>>(keys: string[]): Promise<T> {
  const s = chromeStorage();
  if (!s) return {} as T;
  return new Promise(resolve => s.sync.get(keys, r => resolve(r as T)));
}

async function localGet<T extends Record<string, unknown>>(keys: string[]): Promise<T> {
  const s = chromeStorage();
  if (!s) return {} as T;
  return new Promise(resolve => s.local.get(keys, r => resolve(r as T)));
}

async function localSet(obj: Record<string, unknown>): Promise<void> {
  const s = chromeStorage();
  if (!s) return;
  return new Promise(resolve => s.local.set(obj, resolve));
}

// ── OAuth via launchWebAuthFlow ───────────────────────────────────────────────

async function getCachedOAuthToken(): Promise<string | null> {
  const { [CACHE_KEY_TOKEN]: tok, [CACHE_KEY_EXPIRY]: exp } =
    await localGet<{ [key: string]: string }>([CACHE_KEY_TOKEN, CACHE_KEY_EXPIRY]);
  if (!tok || !exp) return null;
  const expiresAt = new Date(exp).getTime();
  if (expiresAt - Date.now() > 60_000) return tok; // still valid for > 1 min
  return null;
}

let inflightOAuth: Promise<string> | null = null;

/**
 * Single-flight wrapper: when parallel callers (batch optimizer workers) all
 * find the cache empty, only one interactive auth flow is launched.
 */
function fetchOAuthToken(clientId: string): Promise<string> {
  inflightOAuth ??= fetchOAuthTokenUncached(clientId).finally(() => { inflightOAuth = null; });
  return inflightOAuth;
}

async function fetchOAuthTokenUncached(clientId: string): Promise<string> {
  const cached = await getCachedOAuthToken();
  if (cached) return cached;

  if (typeof chrome === 'undefined' || !chrome.identity) {
    throw new Error('chrome.identity not available. Use manual token mode.');
  }

  const redirectUri = chrome.identity.getRedirectURL();
  const authUrl = new URL('https://accounts.google.com/o/oauth2/auth');
  authUrl.searchParams.set('client_id', clientId);
  authUrl.searchParams.set('response_type', 'token');
  authUrl.searchParams.set('redirect_uri', redirectUri);
  authUrl.searchParams.set('scope', GCP_SCOPE);
  authUrl.searchParams.set('prompt', 'none'); // silent if already authorized

  return new Promise((resolve, reject) => {
    chrome.identity.launchWebAuthFlow(
      { url: authUrl.toString(), interactive: true },
      async (responseUrl) => {
        if (chrome.runtime.lastError || !responseUrl) {
          reject(new Error(chrome.runtime.lastError?.message ?? 'OAuth flow failed'));
          return;
        }
        // Token is in the hash, convert # → ? for URLSearchParams parsing
        const params = new URLSearchParams(new URL(responseUrl.replace('#', '?')).search);
        const token = params.get('access_token');
        const expiresIn = parseInt(params.get('expires_in') ?? '3600', 10);
        if (!token) {
          reject(new Error('No access_token in OAuth response'));
          return;
        }
        const expiry = new Date(Date.now() + expiresIn * 1000).toISOString();
        await localSet({ [CACHE_KEY_TOKEN]: token, [CACHE_KEY_EXPIRY]: expiry });
        resolve(token);
      },
    );
  });
}

// ── Public API ────────────────────────────────────────────────────────────────

/** Invalidate the cached OAuth token (call on 401 responses). */
export async function invalidateCachedToken(): Promise<void> {
  await localSet({ [CACHE_KEY_TOKEN]: '', [CACHE_KEY_EXPIRY]: '' });
}

/**
 * Returns a valid GCP Bearer token, or throws an AuthError if nothing is configured.
 * Tries OAuth first, then manual token.
 */
export async function getToken(): Promise<string> {
  const { oauthClientId, manualToken, manualTokenExpiry, useManualToken } =
    await syncGet<{
      oauthClientId: string;
      manualToken: string;
      manualTokenExpiry: string;
      useManualToken: boolean;
    }>(['oauthClientId', 'manualToken', 'manualTokenExpiry', 'useManualToken']);

  if (!useManualToken && oauthClientId) {
    return fetchOAuthToken(oauthClientId);
  }

  // Manual token path
  if (manualToken) {
    if (manualTokenExpiry) {
      const expiry = new Date(manualTokenExpiry).getTime();
      if (expiry - Date.now() < 0) {
        throw new Error('Manual token has expired. Please update it in Settings.');
      }
    }
    return manualToken;
  }

  throw new Error(
    'No authentication configured. Open Settings and add a GCP Bearer token or configure OAuth.',
  );
}
