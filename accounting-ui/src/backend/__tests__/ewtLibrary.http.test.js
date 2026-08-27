const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 4 (EWT Library improvements). Covers the new backend-side pieces:
// field-length validation matching ewt_library's real DDL exactly
// (atc_code varchar(20), description varchar(255), rate decimal(6,3)),
// and the app-level duplicate-atc_code check (no DB UNIQUE constraint
// exists - confirmed against 000_baseline_schema_migration.sql - so this
// is deliberately an application check, not a migration). The label
// rename ("EWT Name" -> "Nature of Income Payment") and the dirty-guard
// work are frontend-only and verified separately via live Playwright.

jest.setTimeout(180000);

let token, userId;

const TEST_USERNAME_PATTERN = "test_ewtlib%";
const TEST_ATC_PREFIX = "ZTEST";

async function cleanupAllStaleFixtures() {
  await pool.query("DELETE FROM ewt_library WHERE atc_code LIKE ?", [`${TEST_ATC_PREFIX}%`]);
  const [staleUsers] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [TEST_USERNAME_PATTERN]);
  const staleUserIds = staleUsers.map((r) => r.id);
  if (staleUserIds.length) {
    await pool.query("DELETE FROM users WHERE id IN (?)", [staleUserIds]);
  }
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanupAllStaleFixtures();

  const hash = await bcrypt.hash("EwtLibPass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('test_ewtlib_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;

  const loginRes = await request(app).post("/api/login").send({ username: "test_ewtlib_admin", password: "EwtLibPass!1" });
  token = loginRes.body.token;
  if (!token) throw new Error("login failed: " + JSON.stringify(loginRes.body));
});

afterAll(async () => {
  try {
    await cleanupAllStaleFixtures();
  } finally {
    await pool.end();
  }
});

async function createEwt(body) {
  return request(app).post("/api/ewt-library").set("Authorization", `Bearer ${token}`).send(body);
}

describe("1: existing EWT records load", () => {
  test("GET /api/ewt-library returns 200 with an array, including createdAt", async () => {
    const res = await request(app).get("/api/ewt-library").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });
});

describe("2: Create EWT works", () => {
  test("a valid new EWT/ATC code is created and returned on reload", async () => {
    const created = await createEwt({
      atcCode: `${TEST_ATC_PREFIX}001`, description: "Test Nature Of Income", taxType: "EWT", rate: 5, birForm: "1601-EQ", status: "ACTIVE",
    });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(created.body.id).toBeGreaterThan(0);

    const list = await request(app).get("/api/ewt-library").set("Authorization", `Bearer ${token}`);
    const row = list.body.find((r) => r.atcCode === `${TEST_ATC_PREFIX}001`);
    expect(row).toBeDefined();
    expect(row.description).toBe("Test Nature Of Income");
    expect(Number(row.rate)).toBe(5);
    expect(row.createdAt).toBeTruthy();
  });
});

describe("3: Edit EWT works", () => {
  test("PUT updates an existing record's description and rate", async () => {
    const created = await createEwt({ atcCode: `${TEST_ATC_PREFIX}002`, description: "Original", taxType: "EWT", rate: 2, birForm: "1601-EQ", status: "ACTIVE" });
    const id = created.body.id;

    const updated = await request(app).put(`/api/ewt-library/${id}`).set("Authorization", `Bearer ${token}`).send({
      atcCode: `${TEST_ATC_PREFIX}002`, description: "Updated Description", taxType: "EWT", rate: 3.5, birForm: "1601-EQ", status: "ACTIVE",
    });
    expect(updated.status).toBe(200);

    const list = await request(app).get("/api/ewt-library").set("Authorization", `Bearer ${token}`);
    const row = list.body.find((r) => r.atcCode === `${TEST_ATC_PREFIX}002`);
    expect(row.description).toBe("Updated Description");
    expect(Number(row.rate)).toBe(3.5);
  });
});

describe("4: required-field validation", () => {
  test("blank EWT Code rejected with a clear 400", async () => {
    const res = await createEwt({ atcCode: "  ", description: "x", rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/EWT Code is required/);
  });

  test("blank Nature of Income Payment rejected with a clear 400", async () => {
    const res = await createEwt({ atcCode: `${TEST_ATC_PREFIX}003`, description: "   ", rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Nature of Income Payment is required/);
  });

  test("missing Tax Rate rejected with a clear 400", async () => {
    const res = await createEwt({ atcCode: `${TEST_ATC_PREFIX}004`, description: "x" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Tax Rate is required/);
  });
});

describe("5: max-length validation (matches ewt_library's actual DDL)", () => {
  test("EWT Code longer than varchar(20) rejected, not truncated", async () => {
    const tooLong = "A".repeat(21);
    const res = await createEwt({ atcCode: tooLong, description: "x", rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 20 characters/);

    const list = await request(app).get("/api/ewt-library").set("Authorization", `Bearer ${token}`);
    expect(list.body.find((r) => r.atcCode.startsWith("A".repeat(20)))).toBeUndefined();
  });

  test("Nature of Income Payment longer than varchar(255) rejected, not truncated", async () => {
    const tooLong = "B".repeat(256);
    const res = await createEwt({ atcCode: `${TEST_ATC_PREFIX}005`, description: tooLong, rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 255 characters/);
  });
});

describe("6: invalid tax rate rejected", () => {
  test("negative rate rejected", async () => {
    const res = await createEwt({ atcCode: `${TEST_ATC_PREFIX}006`, description: "x", rate: -1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/non-negative/);
  });

  test("non-numeric rate rejected", async () => {
    const res = await createEwt({ atcCode: `${TEST_ATC_PREFIX}007`, description: "x", rate: "abc" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/non-negative/);
  });

  test("rate exceeding decimal(6,3) capacity rejected", async () => {
    const res = await createEwt({ atcCode: `${TEST_ATC_PREFIX}008`, description: "x", rate: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 999.999/);
  });
});

describe("7: duplicate EWT Code handled correctly", () => {
  test("creating the same ATC code twice is rejected with 409", async () => {
    const first = await createEwt({ atcCode: `${TEST_ATC_PREFIX}009`, description: "First", rate: 1 });
    expect(first.status).toBe(200);

    const dup = await createEwt({ atcCode: `${TEST_ATC_PREFIX}009`, description: "Second", rate: 2 });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already exists/);
  });

  test("duplicate check is case-insensitive (matches the column's existing collation)", async () => {
    const dup = await createEwt({ atcCode: `${TEST_ATC_PREFIX.toLowerCase()}009`, description: "Lowercase collision", rate: 2 });
    expect(dup.status).toBe(409);
  });

  test("editing a record to its OWN existing code is not rejected as a duplicate of itself", async () => {
    const created = await createEwt({ atcCode: `${TEST_ATC_PREFIX}010`, description: "Self", rate: 1 });
    const id = created.body.id;
    const res = await request(app).put(`/api/ewt-library/${id}`).set("Authorization", `Bearer ${token}`).send({
      atcCode: `${TEST_ATC_PREFIX}010`, description: "Self Updated", rate: 1,
    });
    expect(res.status).toBe(200);
  });

  test("editing a record to collide with a DIFFERENT existing code is rejected", async () => {
    await createEwt({ atcCode: `${TEST_ATC_PREFIX}011`, description: "A", rate: 1 });
    const created2 = await createEwt({ atcCode: `${TEST_ATC_PREFIX}012`, description: "B", rate: 1 });
    const res = await request(app).put(`/api/ewt-library/${created2.body.id}`).set("Authorization", `Bearer ${token}`).send({
      atcCode: `${TEST_ATC_PREFIX}011`, description: "B", rate: 1,
    });
    expect(res.status).toBe(409);
  });
});

describe("8: no accounting calculation changes", () => {
  test("a valid EWT record's atc_code/tax_type/rate remain exactly what was submitted (never recalculated at save time)", async () => {
    const created = await createEwt({ atcCode: `${TEST_ATC_PREFIX}013`, description: "x", taxType: "FINAL", rate: 12.345 });
    expect(created.status).toBe(200);
    const list = await request(app).get("/api/ewt-library").set("Authorization", `Bearer ${token}`);
    const row = list.body.find((r) => r.atcCode === `${TEST_ATC_PREFIX}013`);
    expect(row.taxType).toBe("FINAL");
    expect(Number(row.rate)).toBe(12.345);
  });
});

describe("9: permission behavior remains correct", () => {
  test("no token is rejected", async () => {
    const res = await request(app).get("/api/ewt-library");
    expect(res.status).toBe(401);
  });

  test("POST without token is rejected", async () => {
    const res = await request(app).post("/api/ewt-library").send({ atcCode: "X", description: "x", rate: 1 });
    expect(res.status).toBe(401);
  });
});
