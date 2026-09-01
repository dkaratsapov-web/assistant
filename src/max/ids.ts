/**
 * Пространства идентификаторов для каналов.
 *
 * Аккаунты MAX независимы от Telegram, но живут в тех же таблицах, где user_id —
 * это Telegram-id. Чтобы не перестраивать схему и не ловить коллизии, id пользователя
 * MAX сдвигается в свой диапазон: внутренний uid = MAX_UID_BASE + max_user_id.
 * Telegram-id и id MAX сейчас укладываются в 10^10, так что диапазоны не пересекаются.
 */
export const CHANNEL_MAX = "max";
export const MAX_UID_BASE = 1_000_000_000_000;

/** Внутренний uid по id пользователя MAX. */
export function maxUid(maxUserId: number): number {
  return MAX_UID_BASE + maxUserId;
}

/** Обратное преобразование: id в MAX по внутреннему uid (или null, если uid не из MAX). */
export function maxIdOf(uid: number): number | null {
  return uid > MAX_UID_BASE ? uid - MAX_UID_BASE : null;
}
