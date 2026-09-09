// Пересменка с открытым столом: если кассир А открыл стол и закрыл
// смену, не закрыв стол (обычное дело при пересменке), выручка стола
// не должна "потеряться" или остаться у кассира А — она целиком уходит
// тому, кто фактически закрыл стол (close_shift_id ставится в момент
// закрытия, а не открытия — см. src/services/sessions.js closeSession).

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { createUser } from "../src/services/users.js";
import { adminAgent, createTable, createTariff, makeApp } from "./helpers.js";

async function loginAgent(app, login, password) {
  const agent = supertest.agent(app);
  const res = await agent.post("/api/auth/login").send({ login, password });
  if (res.status !== 200) throw new Error(`login ${login}: ${res.status}`);
  return agent;
}

test("выручка стола, оставшегося открытым при смене кассира, целиком уходит тому, кто его закрыл", async () => {
  const { db, app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const tariff = await createTariff(admin, "Тариф", 600);

  createUser(db, { login: "kassirA", password: "pass1234", name: "Кассир А", role: "cashier" });
  createUser(db, { login: "kassirB", password: "pass1234", name: "Кассир Б", role: "cashier" });

  const cashierA = await loginAgent(app, "kassirA", "pass1234");
  const shiftAOpen = await cashierA.post("/api/shifts/open").send({});
  assert.equal(shiftAOpen.status, 201);

  const opened = await cashierA.post(`/api/tables/${table.id}/open`).send({
    tariff_id: tariff.id,
    mode: "amount",
    amount: 600,
    payment_method: "cash",
  });
  assert.equal(opened.status, 201);

  // Кассир А сдаёт смену, не закрыв стол — обычная пересменка на живой точке.
  const closedShiftA = await cashierA.post("/api/shifts/close").send({});
  assert.equal(closedShiftA.status, 200);
  assert.equal(
    closedShiftA.body.sessions_count,
    0,
    "стол ещё не закрыт — в смену А выручка пока не попала"
  );
  assert.equal(closedShiftA.body.revenue, 0);

  const cashierB = await loginAgent(app, "kassirB", "pass1234");
  const shiftBOpen = await cashierB.post("/api/shifts/open").send({});
  assert.equal(shiftBOpen.status, 201);

  const closedTable = await cashierB.post(`/api/tables/${table.id}/close`).send({});
  assert.equal(closedTable.status, 200);
  assert.ok(closedTable.body.total_cost > 0, "со стола есть выручка");

  const row = db
    .prepare("SELECT shift_id, close_shift_id FROM table_sessions WHERE id = ?")
    .get(closedTable.body.id);
  assert.notEqual(
    row.shift_id,
    row.close_shift_id,
    "сеанс открыт в одной смене, закрыт в другой — это и есть пересменка"
  );

  const closedShiftB = await cashierB.post("/api/shifts/close").send({});
  assert.equal(closedShiftB.status, 200);
  assert.equal(
    closedShiftB.body.sessions_count,
    1,
    "стол закрыл кассир Б — сеанс числится в его смене"
  );
  assert.equal(
    closedShiftB.body.revenue,
    closedTable.body.total_cost,
    "вся выручка стола целиком ушла кассиру, который его закрыл"
  );
});
