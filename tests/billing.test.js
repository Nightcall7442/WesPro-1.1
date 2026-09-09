// Тесты расчёта стоимости.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { costKopecks, sessionCostKopecks } from "../src/services/billing.js";
import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

const PRICE = 600; // ₽/час

test("расчёт 30 минут", () => {
  assert.equal(costKopecks(PRICE, 30 * 60), 300 * 100);
});

test("расчёт 1 часа", () => {
  assert.equal(costKopecks(PRICE, 60 * 60), 600 * 100);
});

test("расчёт 1.5 часа", () => {
  assert.equal(costKopecks(PRICE, 90 * 60), 900 * 100);
});

test("нулевая длительность — ноль", () => {
  assert.equal(costKopecks(PRICE, 0), 0);
});

test("округление половины копейки вверх", () => {
  // 500 ₽/час за 1 секунду = 13.888... копейки -> 14.
  assert.equal(costKopecks(500, 1), 14);
});

test("отрицательная длительность отклоняется", () => {
  assert.throws(() => costKopecks(PRICE, -1), RangeError);
});

test("стоимость между двумя метками времени", () => {
  const start = "2026-01-01T12:00:00.000Z";
  const end = "2026-01-01T13:30:00.000Z";
  assert.equal(sessionCostKopecks(PRICE, start, end), 90000);
});

test("интеграция: сеанс длительностью 1 час стоит цену тарифа", async () => {
  const { db, app } = makeApp();
  const request = await adminAgent(app);
  const table = await createTable(request);
  const tariff = await createTariff(request);

  const opened = await request
    .post(`/api/tables/${table.id}/open`)
    .send({ tariff_id: tariff.id });

  // Сдвигаем начало сеанса на час назад прямо в базе.
  const hourAgo = new Date(Date.now() - 3600 * 1000).toISOString();
  db.prepare("UPDATE table_sessions SET started_at = ? WHERE id = ?").run(
    hourAgo,
    opened.body.id
  );

  const closed = await request.post(`/api/tables/${table.id}/close`);
  assert.ok(
    Math.abs(closed.body.total_cost - 600) < 0.5,
    `итог ${closed.body.total_cost} ≉ 600`
  );
});
