const JWKS_URL = "https://clerk.tryaurum.store/.well-known/jwks.json";

async function getJWKS() {
  const res = await fetch(JWKS_URL);
  if (!res.ok) throw new Error("Failed to fetch JWKS");
  return res.json();
}

function base64UrlToArrayBuffer(base64url) {
  const base64 = base64url.replace(/-/g, "+").replace(/_/g, "/");
  const padded = base64.padEnd(base64.length + (4 - (base64.length % 4)) % 4, "=");
  const binary = atob(padded);
  const buffer = new ArrayBuffer(binary.length);
  const view = new Uint8Array(buffer);
  for (let i = 0; i < binary.length; i++) {
    view[i] = binary.charCodeAt(i);
  }
  return buffer;
}

async function importKey(jwk) {
  return crypto.subtle.importKey(
    "jwk",
    jwk,
    { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
    false,
    ["verify"]
  );
}

function parseJWT(token) {
  const parts = token.split(".");
  if (parts.length !== 3) throw new Error("Invalid JWT structure");
  const header  = JSON.parse(atob(parts[0].replace(/-/g, "+").replace(/_/g, "/")));
  const payload = JSON.parse(atob(parts[1].replace(/-/g, "+").replace(/_/g, "/")));
  return { header, payload, signature: parts[2], raw: parts };
}

async function verifyJWT(token) {
  const { header, payload, signature, raw } = parseJWT(token);

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && payload.exp < now) throw new Error("Token expired");

  const { keys } = await getJWKS();
  const jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) throw new Error("No matching key found in JWKS");

  const key = await importKey(jwk);
  const signingInput = `${raw[0]}.${raw[1]}`;
  const encoder = new TextEncoder();
  const data = encoder.encode(signingInput);
  const sigBuffer = base64UrlToArrayBuffer(signature);

  const valid = await crypto.subtle.verify(
    "RSASSA-PKCS1-v1_5",
    key,
    sigBuffer,
    data
  );

  if (!valid) throw new Error("Invalid JWT signature");
  return payload;
}

/**
 * Verify Clerk JWT and return user object.
 * Returns { id, email } on success or { error } on failure.
 * id = Clerk user ID (sub claim).
 */
export async function requireAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { error: "Missing or invalid Authorization header" };
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyJWT(token);
    return {
      id:    payload.sub,
      email: payload.email ?? null,
    };
  } catch (err) {
    return { error: err.message };
  }
}

/**
 * Auth check for requests that can't set custom headers — currently
 * only the crew chat WebSocket upgrade, since browsers' native
 * WebSocket constructor cannot attach an Authorization header.
 * Reads the token from a `?token=` query param instead. Uses the
 * exact same verifyJWT() as requireAuth — only the token's source
 * differs, not how it's validated.
 */
export async function requireAuthFromQuery(request, env) {
  const url = new URL(request.url);
  const token = url.searchParams.get("token");
  if (!token) {
    return { error: "Missing token query parameter" };
  }
  try {
    const payload = await verifyJWT(token);
    return {
      id:    payload.sub,
      email: payload.email ?? null,
    };
  } catch (err) {
    return { error: err.message };
  }
}
/**
 * Auth check for endpoints that are publicly viewable but should
 * personalize their response when a valid session exists. Never
 * throws or blocks the request — returns { id: null } if there's
 * no token, a malformed header, or the token fails to verify.
 */
export async function optionalAuth(request, env) {
  const authHeader = request.headers.get("Authorization");
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return { id: null };
  }
  const token = authHeader.slice(7);
  try {
    const payload = await verifyJWT(token);
    return {
      id:    payload.sub,
      email: payload.email ?? null,
    };
  } catch (err) {
    return { id: null };
  }
}

/**
 * Verify the request is from an admin.
 * Admin IDs are set as ADMIN_USER_IDS in wrangler.toml (comma-separated Clerk user IDs).
 * Returns { id, email } on success or { error } on failure.
 */
export async function requireAdmin(request, env) {
  const user = await requireAuth(request, env);
  if (user.error) return user;

  const adminIds = (env.ADMIN_USER_IDS ?? "").split(",").map(s => s.trim()).filter(Boolean);

  if (!adminIds.includes(user.id)) {
    return { error: "Admin access required" };
  }

  return user;
}
