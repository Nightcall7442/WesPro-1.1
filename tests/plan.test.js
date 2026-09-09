// Тесты плана зала: сетка, стены/двери, позиции и размеры столов.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, cashierAgent, createTable, makeApp } from "./helpers.js";

test("план по умолчанию: сетка 40×25 без элементов", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const res = await admin.get("/api/plan");
  assert.equal(res.status, 200);
  assert.equal(res.body.cols, 40);
  assert.equal(res.body.rows, 25);
  assert.deepEqual(res.body.elements, []);
});

test("сохранение плана: стены, дверь и размер сетки", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);

  const saved = await admin.put("/api/plan").send({
    cols: 30,
    rows: 20,
    elements: [
      { type: "wall", x: 0, y: 0, w: 30, h: 1 },
      { type: "wall", x: 0, y: 0, w: 1, h: 20 },
      { type: "door", x: 10, y: 19, w: 4, h: 1 },
    ],
  });
  assert.equal(saved.status, 200);
  assert.equal(saved.body.cols, 30);
  assert.equal(saved.body.elements.length, 3);

  const again = await admin.get("/api/plan");
  assert.equal(again.body.elements.filter((e) => e.type === "door").length, 1);
});

test("элемент за пределами сетки отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const res = await admin.put("/api/plan").send({
    cols: 20,
    rows: 10,
    elements: [{ type: "wall", x: 18, y: 0, w: 5, h: 1 }],
  });
  assert.equal(res.status, 409);
});

test("раскладка стола сохраняется и видна на дашборде", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);

  const res = await admin
    .put(`/api/tables/${table.id}/layout`)
    .send({ x: 5, y: 7, w: 6, h: 4 });
  assert.equal(res.status, 200);
  assert.equal(res.body.pos_x, 5);
  assert.equal(res.body.size_w, 6);

  const dashboard = await admin.get("/api/dashboard");
  const row = dashboard.body.find((t) => t.id === table.id);
  assert.equal(row.pos_y, 7);
  assert.equal(row.size_h, 4);
});

test("недопустимый размер стола отклоняется", async () => {
  const { app } = makeApp();
  const admin = await adminAgent(app);
  const table = await createTable(admin);
  const res = await admin
    .put(`/api/tables/${table.id}/layout`)
    .send({ x: 0, y: 0, w: 1, h: 1 });
  assert.equal(res.status, 409);
});

test("кассир видит план, но не может его менять", async () => {
  const { db, app } = makeApp();
  const cashier = await cashierAgent(app, db);
  assert.equal((await cashier.get("/api/plan")).status, 200);
  assert.equal(
    (await cashier.put("/api/plan").send({ cols: 20, rows: 10, elements: [] }))
      .status,
    403
  );
});
