const keyPrefix = "tmx_";

const randomBytes = 32;

function randomHex(bytes: number): string {
  const buffer = new Uint8Array(bytes);
  crypto.getRandomValues(buffer);
  return [...buffer].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function generateApiKey(): string {
  return `${keyPrefix}${randomHex(randomBytes)}`;
}

export function generateOAuthState(): string {
  return randomHex(randomBytes);
}

export async function registerLogin(
  db: D1Database,
  login: string,
  avatarUrl: string,
  keyHash: string,
): Promise<void> {
  const normalized = login.toLowerCase();
  await db.batch([
    db
      .prepare(
        "INSERT INTO users (github_login, avatar_url) VALUES (?, ?) ON CONFLICT(github_login) DO UPDATE SET avatar_url = excluded.avatar_url",
      )
      .bind(normalized, avatarUrl),
    db
      .prepare(
        "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = (SELECT id FROM users WHERE github_login = ?) AND revoked_at IS NULL",
      )
      .bind(normalized),
    db
      .prepare(
        "INSERT INTO api_keys (key_hash, user_id) VALUES (?, (SELECT id FROM users WHERE github_login = ?))",
      )
      .bind(keyHash, normalized),
  ]);
}

export async function rotateApiKey(
  db: D1Database,
  userId: number,
  newKeyHash: string,
): Promise<void> {
  await db.batch([
    db
      .prepare(
        "UPDATE api_keys SET revoked_at = CURRENT_TIMESTAMP WHERE user_id = ? AND revoked_at IS NULL",
      )
      .bind(userId),
    db
      .prepare("INSERT INTO api_keys (key_hash, user_id) VALUES (?, ?)")
      .bind(newKeyHash, userId),
  ]);
}
