/**
 * Прослойка «D1 поверх обычного SQLite».
 *
 * На Cloudflare база — D1. На своём сервере её нет, но вся работа с базой идёт
 * через одну и ту же цепочку: prepare → bind → run/first/all. Запросов в
 * проекте больше сотни, а методов всего три, поэтому переписывать db.ts не
 * пришлось: достаточно повторить эти три метода над node:sqlite.
 *
 * node:sqlite выбран нарочно: он встроен в Node, его не надо собирать из
 * исходников на сервере. better-sqlite3 требует компилятора и заголовков — на
 * чистой машине это лишний повод для падения при установке.
 *
 * Разница, из-за которой нельзя просто подставить node:sqlite:
 *   • D1 отдаёт { meta: { last_row_id, changes } }, node:sqlite — { lastInsertRowid, changes };
 *   • D1 отдаёт из first() null, node:sqlite — undefined;
 *   • node:sqlite не принимает undefined, true/false и Date — их надо приводить.
 */

import { DatabaseSync, StatementSync } from "node:sqlite";

/** Значения, которые SQLite примет. */
type Bindable = string | number | bigint | null | Uint8Array;

/**
 * Приводит значение к тому, что понимает SQLite.
 *
 * Без этого падает на ровном месте: в коде полно `opts.clientId ?? null`, но
 * где-то проскакивает и голый undefined, а булево значение приходит из настроек.
 */
function bindable(v: unknown): Bindable {
  if (v === undefined || v === null) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" || typeof v === "number" || typeof v === "bigint") return v;
  if (v instanceof Uint8Array) return v;
  return String(v);
}

/** Подготовленный запрос: тот же набор методов, что у D1. */
class Prepared {
  private args: Bindable[] = [];
  constructor(private stmt: StatementSync, private sql: string) {}

  bind(...values: unknown[]): Prepared {
    this.args = values.map(bindable);
    return this;
  }

  async run(): Promise<{ meta: { last_row_id: number; changes: number } }> {
    const res = this.stmt.run(...this.args);
    return {
      meta: {
        last_row_id: Number(res.lastInsertRowid ?? 0),
        changes: Number(res.changes ?? 0),
      },
    };
  }

  async first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...this.args);
    return (row as T) ?? null;
  }

  async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
    return { results: (this.stmt.all(...this.args) as T[]) ?? [] };
  }

  /** Для сообщений об ошибке: по тексту запроса сразу видно, где сломалось. */
  toString(): string {
    return this.sql;
  }
}

/** База, которую можно подставить вместо D1. */
export class SqliteD1 {
  private db: DatabaseSync;
  /** Разобранные запросы переиспользуем: их больше сотни и они повторяются. */
  private cache = new Map<string, StatementSync>();

  constructor(file: string) {
    this.db = new DatabaseSync(file);
    // WAL — чтобы чтение не ждало записи. Без него под нагрузкой ловим
    // «database is locked» на ровном месте.
    this.db.exec("PRAGMA journal_mode = WAL");
    this.db.exec("PRAGMA foreign_keys = ON");
    // Если база занята другим запросом — подождать, а не падать сразу
    this.db.exec("PRAGMA busy_timeout = 5000");
  }

  prepare(sql: string): Prepared {
    let stmt = this.cache.get(sql);
    if (!stmt) {
      stmt = this.db.prepare(sql);
      this.cache.set(sql, stmt);
    }
    return new Prepared(stmt, sql);
  }

  /** Применение schema.sql при первом запуске. */
  exec(sql: string): void {
    this.db.exec(sql);
  }

  close(): void {
    this.db.close();
  }
}
