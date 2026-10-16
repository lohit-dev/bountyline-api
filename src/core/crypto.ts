import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

/** Random URL-safe token. */
export function randomToken(bytes = 24): string {
  return b64(randomBytes(bytes));
}

/** AES-256-GCM. `keyHex` is 64 hex characters (32 bytes). Used for PayPal emails at rest. */
export function encrypt(plain: string, keyHex: string): string {
  const key = Buffer.from(keyHex, "hex");
  if (key.length !== 32) throw new Error("ENCRYPTION_KEY must be 32 bytes (64 hex characters)");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", b64(iv), b64(cipher.getAuthTag()), b64(ct)].join(".");
}

export function decrypt(payload: string, keyHex: string): string {
  const [v, iv, tag, ct] = payload.split(".");
  if (v !== "v1" || !iv || !tag || !ct) throw new Error("Unsupported ciphertext");
  const key = Buffer.from(keyHex, "hex");
  const decipher = createDecipheriv("aes-256-gcm", key, unb64(iv));
  decipher.setAuthTag(unb64(tag));
  return Buffer.concat([decipher.update(unb64(ct)), decipher.final()]).toString("utf8");
}

export function maskEmail(email: string): string {
  const [name = "", domain = ""] = email.split("@");
  return `${name.slice(0, 1)}***@${domain}`;
}

/** Signed, expiring token for sessions and OAuth state: base64url(json).signature */
export function signToken(secret: string, payload: Record<string, unknown>, ttlSeconds: number, now = new Date()): string {
  const body = b64(Buffer.from(JSON.stringify({ ...payload, exp: Math.floor(now.getTime() / 1000) + ttlSeconds })));
  const sig = b64(createHmac("sha256", secret).update(body).digest());
  return `${body}.${sig}`;
}

export function verifyToken<T extends Record<string, unknown>>(
  secret: string,
  token: string | undefined | null,
  now = new Date(),
): T | null {
  if (!token) return null;
  const [body, sig] = token.split(".");
  if (!body || !sig) return null;
  const expected = createHmac("sha256", secret).update(body).digest();
  const given = unb64(sig);
  if (given.length !== expected.length || !timingSafeEqual(given, expected)) return null;
  try {
    const data = JSON.parse(unb64(body).toString("utf8")) as T & { exp?: number };
    if (typeof data.exp !== "number" || data.exp < Math.floor(now.getTime() / 1000)) return null;
    return data;
  } catch {
    return null;
  }
}
