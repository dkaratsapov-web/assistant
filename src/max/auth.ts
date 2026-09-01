/**
 * Проверка подписи initData мини-приложения MAX.
 *
 * Схема повторяет модель Telegram: параметры запуска сортируются, склеиваются в
 * data-check-string и подписываются ключом, производным от токена бота. Точная
 * производная у MAX официально не подтверждена, поэтому проверяем несколько
 * кандидатов: подделать hash нельзя ни при одной из них, не зная токена бота,
 * поэтому перебор кандидатов безопасен — он лишь расширяет совместимость.
 */
const enc = new TextEncoder();

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

export interface MaxWebAppUser {
  id: number;
  name?: string;
  username?: string;
}

/** Проверяет подпись и возвращает пользователя или null. */
export async function validateMaxInitData(
  initData: string,
  botToken: string,
  maxAge = 86400
): Promise<MaxWebAppUser | null> {
  if (!initData || !botToken) return null;
  const params = new URLSearchParams(initData);
  const received = (params.get("hash") ?? params.get("signature") ?? "").toLowerCase();
  if (!received) return null;
  params.delete("hash");
  params.delete("signature");

  const dcs = [...params.keys()]
    .sort()
    .map((k) => `${k}=${params.get(k)}`)
    .join("\n");

  const candidates: (ArrayBuffer | Uint8Array)[] = [
    await hmac(enc.encode("WebAppData"), botToken), // как в Telegram
    await crypto.subtle.digest("SHA-256", enc.encode(botToken)),
    enc.encode(botToken),
  ];
  let ok = false;
  for (const key of candidates) {
    if (toHex(await hmac(key, dcs)) === received) {
      ok = true;
      break;
    }
  }
  if (!ok) return null;

  const authDate = parseInt(params.get("auth_date") ?? "0", 10);
  if (maxAge && authDate && Date.now() / 1000 - authDate > maxAge) return null;

  try {
    const raw = JSON.parse(params.get("user") ?? "{}");
    const id = Number(raw.id ?? raw.user_id);
    if (!id) return null;
    return { id, name: raw.name ?? raw.first_name, username: raw.username };
  } catch {
    return null;
  }
}
