// Тесты создания столов.

import assert from "node:assert/strict";
import { test } from "node:test";
import supertest from "supertest";

import { adminAgent, makeApp } from "./helpers.js";

test("создание стола", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  const res = await request.post("/api/tables").send({ name: "Стол А" });
  assert.equal(res.status, 201);
  assert.equal(res.body.name, "Стол А");
  assert.equal(res.body.status, "free");

  const list = await request.get("/api/tables");
  assert.deepEqual(
    list.body.map((t) => t.name),
    ["Стол А"]
  );
});

test("дубликат названия стола отклоняется", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  await request.post("/api/tables").send({ name: "Стол А" });
  const res = await request.post("/api/tables").send({ name: "Стол А" });
  assert.equal(res.status, 409);
  assert.match(res.body.detail, /уже существует/);
});

test("создание стола пишется в журнал", async () => {
  const { app } = makeApp();
  const request = await adminAgent(app);

  await request.post("/api/tables").send({ name: "Стол А" });
  const journal = await request.get("/api/journal");
  assert.ok(journal.body.some((e) => e.event === "table_created"));
});
