/**
 * Распознавание речи через Yandex SpeechKit (STT, синхронное API v1).
 * Голосовые Telegram приходят в формате OGG/Opus — SpeechKit принимает его напрямую.
 * Лимиты синхронного API: до ~30 секунд и ~1 МБ на запрос.
 *
 * Сервисному аккаунту нужна роль `ai.speechkit-stt.user` (тот же API-ключ, что и у YandexGPT).
 */

interface SttResponse {
  result?: string;
  error_code?: string;
  error_message?: string;
}

/** Распознаёт русскую речь из аудио. По умолчанию OGG/Opus (голос Telegram); для вебапа — lpcm 16кГц. */
export async function transcribeVoice(
  apiKey: string,
  folderId: string,
  audio: ArrayBuffer,
  opts: { lang?: string; format?: "oggopus" | "lpcm"; sampleRateHertz?: number } = {}
): Promise<string> {
  const lang = opts.lang ?? "ru-RU";
  const format = opts.format ?? "oggopus";
  let url =
    `https://stt.api.cloud.yandex.net/speech/v1/stt:recognize` +
    `?lang=${encodeURIComponent(lang)}&format=${format}&folderId=${encodeURIComponent(folderId)}`;
  if (format === "lpcm") url += `&sampleRateHertz=${opts.sampleRateHertz ?? 16000}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { Authorization: `Api-Key ${apiKey}` },
    body: audio,
  });
  const data = (await res.json().catch(() => ({}))) as SttResponse;
  if (!res.ok) {
    throw new Error(data.error_message || `SpeechKit ${res.status}`);
  }
  return (data.result ?? "").trim();
}
