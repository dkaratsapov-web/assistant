/**
 * Стартовый брифинг: короткое знакомство по всем направлениям бота — дела, бизнес,
 * здоровье, уведомления. Каждый ответ сразу включает персонализацию (норма калорий,
 * час утренней сводки, первая задача), любой шаг пропускается, прогресс виден.
 *
 * Канал-независим: возвращает вопрос как данные, а рисует его уже бот (MAX или Telegram).
 * Состояние живёт в sessions (db.setState), отметка о прохождении — в settings.
 */
import { DB } from "./db";
import { Profile, SCOPE_WORK } from "./types";
import { parseDue } from "./utils";

export interface OnbOption {
  label: string;
  value: string;
}

export interface OnbQuestion {
  key: string;
  /** «1 из 4» — какой блок идёт сейчас */
  block: string;
  text: string;
  options?: OnbOption[];
  /** можно ли пропустить шаг кнопкой */
  skippable: boolean;
}

const BLOCK_ABOUT = "1 из 4 · Знакомство";
const BLOCK_WORK = "2 из 4 · Дела";
const BLOCK_HEALTH = "3 из 4 · Здоровье";
const BLOCK_DONE = "4 из 4 · Готово";

/** Порядок вопросов. Ветвления — в nextKey(). */
const QUESTIONS: OnbQuestion[] = [
  {
    key: "name",
    block: BLOCK_ABOUT,
    text: "Как к тебе обращаться?",
    skippable: true,
  },
  {
    key: "business",
    block: BLOCK_ABOUT,
    text: "Чем занимаешься? Одной строкой — чтобы я понимала, о чём речь, когда ты пишешь про дела и клиентов.",
    skippable: true,
  },
  {
    key: "morning",
    block: BLOCK_WORK,
    text: "Во сколько присылать список дел на день?",
    options: [
      { label: "07:00", value: "7" },
      { label: "08:00", value: "8" },
      { label: "09:00", value: "9" },
      { label: "10:00", value: "10" },
      { label: "Не присылать", value: "off" },
    ],
    skippable: false,
  },
  {
    key: "clients",
    block: BLOCK_WORK,
    text: "Ведёшь клиентские проекты? Тогда буду держать клиентов, бюджеты и оплаты.",
    options: [
      { label: "Да", value: "yes" },
      { label: "Нет", value: "no" },
    ],
    skippable: false,
  },
  {
    key: "task",
    block: BLOCK_WORK,
    text: "Что нужно не забыть на этой неделе? Напиши одной строкой или скажи голосом — например: «в четверг отправить счёт Ромашке».",
    skippable: true,
  },
  {
    key: "goal",
    block: BLOCK_HEALTH,
    text: "Следишь за питанием?",
    options: [
      { label: "Снизить вес", value: "lose" },
      { label: "Поддерживать", value: "keep" },
      { label: "Набрать", value: "gain" },
      { label: "Не слежу", value: "none" },
    ],
    skippable: false,
  },
  {
    key: "sex",
    block: BLOCK_HEALTH,
    text: "Для расчёта нормы калорий — пол.",
    options: [
      { label: "Мужской", value: "m" },
      { label: "Женский", value: "f" },
    ],
    skippable: true,
  },
  {
    key: "params",
    block: BLOCK_HEALTH,
    text: "Рост, вес и год рождения — одной строкой. Например: 180 82 1990.",
    skippable: true,
  },
  {
    key: "allergies",
    block: BLOCK_HEALTH,
    text: "Есть аллергии или продукты, которые не ешь? Учту в меню и советах.",
    skippable: true,
  },
  {
    key: "water",
    block: BLOCK_HEALTH,
    text: "Напоминать пить воду в течение дня?",
    options: [
      { label: "Да", value: "yes" },
      { label: "Нет", value: "no" },
    ],
    skippable: false,
  },
];

const byKey = (key: string) => QUESTIONS.find((q) => q.key === key) ?? null;

/** Следующий вопрос с учётом ветвлений (здоровье пропускаем, если человек не следит). */
function nextKey(current: string, state: Record<string, string>): string | null {
  const idx = QUESTIONS.findIndex((q) => q.key === current);
  for (let i = idx + 1; i < QUESTIONS.length; i++) {
    const q = QUESTIONS[i];
    // Не следит за питанием — не мучаем ростом, весом и аллергиями
    if (state.goal === "none" && ["sex", "params", "allergies"].includes(q.key)) continue;
    return q.key;
  }
  return null;
}

export interface OnbState {
  key: string;
  answers: Record<string, string>;
}

/** Первый вопрос брифинга. */
export function onboardingFirst(): OnbQuestion {
  return QUESTIONS[0];
}

/** Отметка о пройденном брифинге — чтобы не спрашивать дважды. */
export async function onboardingDone(db: DB, uid: number): Promise<boolean> {
  return !!(await db.getSetting(`onb_done:${uid}`));
}

export async function markOnboardingDone(db: DB, uid: number): Promise<void> {
  await db.setSetting(`onb_done:${uid}`, new Date().toISOString());
}

/** Норма калорий по Миффлину–Сан Жеору; null, если данных не хватает. */
function suggestKcal(p: Profile, weightKg: number): number | null {
  const age = p.birth_year > 1900 ? new Date().getUTCFullYear() - p.birth_year : 0;
  if (!weightKg || !p.height_cm || !age || (p.sex !== "m" && p.sex !== "f")) return null;
  const bmr = 10 * weightKg + 6.25 * p.height_cm - 5 * age + (p.sex === "m" ? 5 : -161);
  const factor = p.activity === "high" ? 1.725 : p.activity === "medium" ? 1.45 : 1.2;
  let kcal = bmr * factor;
  if (p.goal === "lose") kcal *= 0.85;
  else if (p.goal === "gain") kcal *= 1.1;
  return Math.round(kcal / 10) * 10;
}

export interface OnbResult {
  /** что ответить на сам ответ (подтверждение, польза) */
  reply: string;
  /** следующий вопрос или null, если брифинг закончен */
  question: OnbQuestion | null;
  /** итог, если закончили */
  summary?: string;
}

/**
 * Применяет ответ на текущий вопрос и возвращает следующий.
 * `raw` — текст пользователя или value кнопки; "" означает «пропустить».
 */
export async function onboardingAnswer(
  db: DB,
  uid: number,
  state: OnbState,
  raw: string,
  tz: number
): Promise<OnbResult> {
  const answer = (raw ?? "").trim();
  const skipped = !answer || /^(пропустить|потом|skip|-)$/i.test(answer);
  const answers = { ...state.answers };
  if (!skipped) answers[state.key] = answer;

  let reply = "";
  const profile = await db.getProfile(uid);
  let profileChanged = false;

  if (!skipped) {
    switch (state.key) {
      case "name":
        profile.name = answer.slice(0, 60);
        profileChanged = true;
        reply = `Приятно познакомиться, ${profile.name}.`;
        break;

      case "business":
        profile.about = answer.slice(0, 300);
        profileChanged = true;
        reply = "Запомнила.";
        break;

      case "morning": {
        const notif = await db.getNotif(uid);
        if (answer === "off") {
          notif.morning.on = false;
          reply = "Хорошо, утром беспокоить не буду.";
        } else {
          const hour = Math.max(0, Math.min(23, parseInt(answer, 10) || 9));
          notif.morning = { on: true, hour };
          reply = `Буду присылать список дел в ${String(hour).padStart(2, "0")}:00.`;
        }
        await db.setNotif(uid, notif);
        break;
      }

      case "clients":
        reply =
          answer === "yes"
            ? "Понятно. Клиента заведём так: «добавь клиента Ромашка, Директ, бюджет 100000»."
            : "Ок, раздел с клиентами показывать не буду.";
        break;

      case "task": {
        const dueAt = parseDue(answer, tz);
        const id = await db.addTask({ title: answer.slice(0, 200), creatorId: uid, assigneeId: uid, scope: SCOPE_WORK, dueAt });
        reply = dueAt ? `✅ Записала. Напомню заранее.` : `✅ Записала (#${id}). Скажешь срок — напомню.`;
        break;
      }

      case "goal":
        if (answer === "none") {
          reply = "Хорошо, про питание спрашивать не буду.";
        } else {
          profile.goal = answer;
          profileChanged = true;
          reply = answer === "lose" ? "Цель — снижение веса." : answer === "gain" ? "Цель — набор." : "Цель — поддерживать форму.";
        }
        break;

      case "sex":
        profile.sex = answer === "f" ? "f" : "m";
        profileChanged = true;
        break;

      case "params": {
        const nums = answer.match(/\d{2,4}/g)?.map((n) => parseInt(n, 10)) ?? [];
        const height = nums.find((n) => n >= 120 && n <= 230) ?? 0;
        const weight = nums.find((n) => n >= 35 && n <= 250 && n !== height) ?? 0;
        const year = nums.find((n) => n >= 1920 && n <= new Date().getUTCFullYear() - 10) ?? 0;
        if (height) profile.height_cm = height;
        if (year) profile.birth_year = year;
        profileChanged = !!(height || year);
        if (weight) await db.addWeight(uid, weight);

        const kcal = suggestKcal(profile, weight);
        if (kcal) {
          await db.setSetting(`hkcal:${uid}`, String(kcal));
          await db.setSetting(`hwater:${uid}`, String(Math.round((weight * 30) / 50) * 50));
          reply = `Твоя норма — около ${kcal} ккал в день, воды ${(Math.round((weight * 30) / 50) * 50) / 1000} л. Записывай еду словами или фото — посчитаю.`;
        } else {
          reply = "Записала, что поняла.";
        }
        break;
      }

      case "allergies":
        profile.allergies = answer.slice(0, 200);
        profileChanged = true;
        reply = "Учту — в меню и советах это исключу.";
        break;

      case "water": {
        const notif = await db.getNotif(uid);
        notif.water.on = answer === "yes";
        await db.setNotif(uid, notif);
        reply = answer === "yes" ? "Буду напоминать с 9 до 21." : "Не буду.";
        break;
      }
    }
  }

  if (profileChanged) await db.setProfile(uid, profile);

  const next = nextKey(state.key, answers);
  if (!next) {
    await markOnboardingDone(db, uid);
    await db.clearState(uid);
    return { reply, question: null, summary: await onboardingSummary(db, uid) };
  }
  await db.setState(uid, { step: "onb", onb: { key: next, answers } });
  return { reply, question: byKey(next) };
}

/** Итог брифинга: что бот теперь знает и что будет делать. */
export async function onboardingSummary(db: DB, uid: number): Promise<string> {
  const p = await db.getProfile(uid);
  const notif = await db.getNotif(uid);
  const kcal = await db.getSetting(`hkcal:${uid}`);
  const lines: string[] = [];
  lines.push(p.name ? `Готово, ${p.name}. Вот что я запомнила:` : "Готово. Вот что я запомнила:");
  if (p.about) lines.push(`• чем занимаешься: ${p.about}`);
  if (notif.morning.on) lines.push(`• список дел — каждое утро в ${String(notif.morning.hour).padStart(2, "0")}:00`);
  if (kcal) lines.push(`• норма ${kcal} ккал в день`);
  if (p.allergies) lines.push(`• исключаю: ${p.allergies}`);
  if (notif.water.on) lines.push("• напоминаю про воду днём");
  lines.push("");
  lines.push("Дальше просто говори как человеку: «в пятницу отправить счёт», «созвон завтра в 15:00», «съел борщ». Голосовые тоже понимаю.");
  return lines.join("\n");
}

/** Достаёт состояние брифинга из сессии, если он идёт. */
export function onboardingState(state: Record<string, unknown>): OnbState | null {
  if (state.step !== "onb") return null;
  const onb = state.onb as OnbState | undefined;
  return onb && onb.key ? { key: onb.key, answers: onb.answers ?? {} } : null;
}

/** Запустить брифинг: ставит состояние и отдаёт первый вопрос. */
export async function onboardingStart(db: DB, uid: number): Promise<OnbQuestion> {
  const first = onboardingFirst();
  await db.setState(uid, { step: "onb", onb: { key: first.key, answers: {} } });
  return first;
}
