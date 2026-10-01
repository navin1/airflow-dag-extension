/**
 * Service-account JWT signing using the Web Crypto API (RS256).
 * Works natively in Chrome extension pages — no Node.js libraries needed.
 *
 * Flow:
 *   1. Load service-account JSON from chrome.storage.local
 *   2. Build a JWT (header.payload) signed with the private key via crypto.subtle
 *   3. POST to Google's token endpoint → access_token (valid 1 h)
 *   4. Cache the token in chrome.storage.local; refresh when < 2 min remain
 */

export interface ServiceAccount {
  project_id:   string;
  client_email: string;
  private_key:  string;
}

const TOKEN_CACHE_KEY    = 'vertex_access_token';
const TOKEN_EXPIRY_KEY   = 'vertex_token_expiry';
const GCP_TOKEN_ENDPOINT = 'https://oauth2.googleapis.com/token';
const GCP_SCOPE          = 'https://www.googleapis.com/auth/cloud-platform';

// ── Storage helpers ───────────────────────────────────────────────────────────

async function localGet<T extends Record<string, unknown>>(keys: string[]): Promise<T> {
  if (typeof chrome === 'undefined' || !chrome.storage) return {} as T;
  return new Promise(r => chrome.storage.local.get(keys, v => r(v as T)));
}

async function localSet(obj: Record<string, unknown>): Promise<void> {
  if (typeof chrome === 'undefined' || !chrome.storage) return;
  return new Promise(r => chrome.storage.local.set(obj, r));
}

export async function loadServiceAccount(): Promise<ServiceAccount | null> {
  const { serviceAccountJson } = await localGet<{ serviceAccountJson: string }>(['serviceAccountJson']);
  if (!serviceAccountJson) return null;
  try {
    return JSON.parse(serviceAccountJson) as ServiceAccount;
  } catch {
    return null;
  }
}

// ── Base64url helpers ─────────────────────────────────────────────────────────

function base64url(data: ArrayBuffer | string): string {
  let base64: string;
  if (typeof data === 'string') {
    base64 = btoa(unescape(encodeURIComponent(data)));
  } else {
    base64 = btoa(String.fromCharCode(...new Uint8Array(data)));
  }
  return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

// ── PEM → CryptoKey ───────────────────────────────────────────────────────────

function pemToDer(pem: string): ArrayBuffer {
  const stripped = pem
    .replace(/-----BEGIN [^-]+-----|-----END [^-]+-----/g, '')
    .replace(/\s+/g, '');
  const binary = atob(stripped);
  const bytes  = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes.buffer;
}

async function importPrivateKey(pem: string): Promise<CryptoKey> {
  const der = pemToDer(pem);
  return crypto.subtle.importKey(
    'pkcs8',
    der,
    { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' },
    false,
    ['sign'],
  );
}

// ── JWT creation + signing ────────────────────────────────────────────────────

async function createSignedJwt(sa: ServiceAccount): Promise<string> {
  const header  = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const now     = Math.floor(Date.now() / 1000);
  const payload = base64url(JSON.stringify({
    iss: sa.client_email,
    sub: sa.client_email,
    scope: GCP_SCOPE,
    aud: GCP_TOKEN_ENDPOINT,
    iat: now,
    exp: now + 3600,
  }));

  const unsigned  = `${header}.${payload}`;
  const key       = await importPrivateKey(sa.private_key);
  const signature = await crypto.subtle.sign(
    'RSASSA-PKCS1-v1_5',
    key,
    new TextEncoder().encode(unsigned),
  );

  return `${unsigned}.${base64url(signature)}`;
}

// ── Token exchange ────────────────────────────────────────────────────────────

async function exchangeJwtForToken(jwt: string): Promise<{ token: string; expiry: number }> {
  const resp = await fetch(GCP_TOKEN_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion:  jwt,
    }),
  });

  if (!resp.ok) {
    const body = await resp.text();
    throw new Error(`Token exchange failed (${resp.status}): ${body}`);
  }

  const data = await resp.json() as { access_token: string; expires_in: number };
  return {
    token:  data.access_token,
    expiry: Date.now() + (data.expires_in ?? 3600) * 1000,
  };
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Returns a valid GCP access token for the configured service account.
 * Caches in chrome.storage.local; refreshes automatically when < 2 min remain.
 */
let inflight: Promise<string> | null = null;

export async function getVertexToken(): Promise<string> {
  // Single-flight: parallel callers (batch optimizer workers) share one
  // token exchange instead of each minting their own.
  inflight ??= mintVertexToken().finally(() => { inflight = null; });
  return inflight;
}

async function mintVertexToken(): Promise<string> {
  // Check cache
  const { [TOKEN_CACHE_KEY]: cached, [TOKEN_EXPIRY_KEY]: expiry } =
    await localGet<Record<string, string>>([TOKEN_CACHE_KEY, TOKEN_EXPIRY_KEY]);

  if (cached && expiry && Number(expiry) - Date.now() > 120_000) {
    return cached;
  }

  // Load service account and fetch new token
  const sa = await loadServiceAccount();
  if (!sa) throw new Error('No service account configured. Add your JSON key in Settings → Vertex AI.');

  const jwt  = await createSignedJwt(sa);
  const { token, expiry: newExpiry } = await exchangeJwtForToken(jwt);

  await localSet({ [TOKEN_CACHE_KEY]: token, [TOKEN_EXPIRY_KEY]: String(newExpiry) });
  return token;
}
