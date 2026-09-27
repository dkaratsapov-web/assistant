/**
 * Заглушка сервера для дымового теста: отдаёт public/ и правдоподобные ответы API.
 * Настоящий воркер здесь не нужен — проверяем, что приложение вообще поднимается
 * и не падает на сохранённых настройках. Это тот класс ошибок, который дважды
 * доезжал до пользователя.
 */
import http from "node:http";
import fs from "node:fs";
import path from "node:path";

const ROOT = path.resolve("public");
const TYPES = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".png": "image/png", ".webp": "image/webp" };

const API = {
  "/api/me": { user_id: 1, role: "owner", channel: "max", telemost: false, voice: true },
  "/api/prefs": null, // отдаём то, что прислал тест (см. PREFS ниже)
  "/api/home": { tasks: { work: 2, personal: 1 }, overdue: [{ id: 1, title: "Просроченное дело", due_at: new Date(Date.now() - 86400000).toISOString(), scope: "work" }], today: [], birthdays: [] },
  "/api/tasks": { tasks: [{ id: 1, title: "Тестовая задача", status: "open", scope: "work", due_at: null, client_id: null }] },
  "/api/events": { events: [{ id: 1, title: "Встреча", starts_at: new Date(Date.now() + 86400000).toISOString(), location: "", notes: "", client_id: null }] },
  "/api/clients": { clients: [{ id: 1, name: "АйПапа", status: "active", platforms: "direct", budget: "", contact: "", notes: "", pay_amount: "", pay_due: "" }] },
  "/api/contacts": { contacts: [] },
  "/api/notes": { notes: [] },
  "/api/health": { kcal: { consumed: 0, goal: 2200, protein: 0, fat: 0, carbs: 0, goalP: 165, goalF: 73, goalC: 220 }, water: { ml: 0, goal: 2500 }, entries: [], notes: [], weight: { latest: null, history: [] }, week: {}, activity: [], supplements: [] },
  "/api/ai/history": { messages: [] },
  "/api/notifications": { morning: { on: true, hour: 9 }, tasks: { on: true }, events: { on: true, lead: 30 }, birthdays: { on: true }, water: { on: false, everyHours: 2, from: 9, to: 21 }, meals: { on: false, breakfast: 9, lunch: 14, dinner: 19 } },
  "/api/profile": { sex: "", height: 0, weight: 0, birth_year: 0, goal: "", allergies: "" },
};

export function startStubServer(prefs, port = 8977) {
  // Настройки держим в памяти и возвращаем изменённые: заглушка, которая молча
  // откатывает только что сохранённое, показывает несуществующие ошибки.
  let current = { ...prefs };
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, "http://x");
    const p = url.pathname;
    if (p.startsWith("/api/")) {
      res.setHeader("content-type", "application/json; charset=utf-8");
      if (p === "/api/prefs") {
        if (req.method !== "POST") return res.end(JSON.stringify(current));
        let body = "";
        req.on("data", (c) => (body += c));
        req.on("end", () => {
          try { current = { ...current, ...JSON.parse(body) }; } catch (e) {}
          res.end(JSON.stringify(current));
        });
        return;
      }
      const key = Object.keys(API).find((k) => p === k);
      if (key) return res.end(JSON.stringify(API[key]));
      return res.end(JSON.stringify({ ok: true }));
    }
    if (p === "/version") { res.setHeader("content-type", "text/plain"); return res.end("smoke"); }
    const file = p === "/" || p === "/app" ? "/index.html" : p;
    const full = path.join(ROOT, file);
    if (!full.startsWith(ROOT) || !fs.existsSync(full)) { res.statusCode = 404; return res.end("not found"); }
    res.setHeader("content-type", TYPES[path.extname(full)] ?? "application/octet-stream");
    res.end(fs.readFileSync(full));
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () => resolve({ server, port })));
}
