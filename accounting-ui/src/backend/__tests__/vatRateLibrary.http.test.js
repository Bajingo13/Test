const request = require("supertest");
const bcrypt = require("bcryptjs");
const app = require("../server");
const pool = require("../db");
const { assertNotProductionDatabase } = require("../lib/testDatabaseGuard");

// Phase 6D (VAT Rate Library). Covers: field-length/enum validation
// matching vat_rate_codes' real DDL (code varchar(20), description
// varchar(255), rate decimal(6,3), applies_to/status enums), the
// app-level + DB-level duplicate-code check (a real UNIQUE key exists on
// `code`, unlike ewt_library's atc_code), no DELETE route, and real
// backend permission enforcement (not just frontend hiding) for both
// VIEW and CONFIGURE.

jest.setTimeout(180000);

let token, userId;

const TEST_USERNAME_PATTERN = "test_vatlib%";
const TEST_CODE_PREFIX = "ZTESTVAT";

async function cleanupAllStaleFixtures() {
  await pool.query("DELETE FROM vat_rate_codes WHERE code LIKE ?", [`${TEST_CODE_PREFIX}%`]);
  const [staleUsers] = await pool.query("SELECT id FROM users WHERE username LIKE ?", [TEST_USERNAME_PATTERN]);
  const staleUserIds = staleUsers.map((r) => r.id);
  if (staleUserIds.length) {
    await pool.query("DELETE FROM users WHERE id IN (?)", [staleUserIds]);
  }
}

beforeAll(async () => {
  assertNotProductionDatabase();
  await cleanupAllStaleFixtures();

  const hash = await bcrypt.hash("VatLibPass!1", 10);
  const [userResult] = await pool.execute(
    "INSERT INTO users (username, password, role_id, status) VALUES ('test_vatlib_admin', ?, 2, 'ACTIVE')",
    [hash]
  );
  userId = userResult.insertId;

  const loginRes = await request(app).post("/api/login").send({ username: "test_vatlib_admin", password: "VatLibPass!1" });
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

async function createVat(body) {
  return request(app).post("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`).send(body);
}

describe("1: seed row and existing records load", () => {
  test("GET /api/vat-rate-codes returns 200 with an array, including the seeded STANDARD_VAT row", async () => {
    const res = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
    const seed = res.body.find((r) => r.code === "STANDARD_VAT");
    expect(seed).toBeDefined();
    expect(seed.description).toBe("Standard VAT");
    expect(seed.appliesTo).toBe("BOTH");
    expect(Number(seed.rate)).toBe(12);
    expect(seed.status).toBe("ACTIVE");
  });

  test("activeOnly=true excludes inactive codes", async () => {
    const created = await createVat({ code: `${TEST_CODE_PREFIX}INACT`, description: "x", appliesTo: "BOTH", rate: 5, status: "INACTIVE" });
    expect(created.status).toBe(200);

    const res = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`).query({ activeOnly: "true" });
    expect(res.status).toBe(200);
    expect(res.body.find((r) => r.code === `${TEST_CODE_PREFIX}INACT`)).toBeUndefined();
  });
});

describe("2: Create VAT code works", () => {
  test("a valid new VAT code is created and returned on reload", async () => {
    const created = await createVat({
      code: `${TEST_CODE_PREFIX}001`, description: "Test VAT", appliesTo: "OUTPUT", rate: 10, status: "ACTIVE",
    });
    expect(created.status).toBe(200);
    expect(created.body.success).toBe(true);
    expect(created.body.id).toBeGreaterThan(0);

    const list = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
    const row = list.body.find((r) => r.code === `${TEST_CODE_PREFIX}001`);
    expect(row).toBeDefined();
    expect(row.description).toBe("Test VAT");
    expect(row.appliesTo).toBe("OUTPUT");
    expect(Number(row.rate)).toBe(10);
  });
});

describe("3: Edit VAT code works", () => {
  test("PUT updates an existing record's description, rate, and status", async () => {
    const created = await createVat({ code: `${TEST_CODE_PREFIX}002`, description: "Original", appliesTo: "BOTH", rate: 2, status: "ACTIVE" });
    const id = created.body.id;

    const updated = await request(app).put(`/api/vat-rate-codes/${id}`).set("Authorization", `Bearer ${token}`).send({
      code: `${TEST_CODE_PREFIX}002`, description: "Updated Description", appliesTo: "INPUT", rate: 3.5, status: "INACTIVE",
    });
    expect(updated.status).toBe(200);

    const list = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
    const row = list.body.find((r) => r.code === `${TEST_CODE_PREFIX}002`);
    expect(row.description).toBe("Updated Description");
    expect(row.appliesTo).toBe("INPUT");
    expect(Number(row.rate)).toBe(3.5);
    expect(row.status).toBe("INACTIVE");
  });

  test("activate/deactivate is a normal PUT (no dedicated status route, matching this project's established style)", async () => {
    const created = await createVat({ code: `${TEST_CODE_PREFIX}TOGGLE`, description: "x", appliesTo: "BOTH", rate: 1, status: "ACTIVE" });
    const id = created.body.id;

    const deactivated = await request(app).put(`/api/vat-rate-codes/${id}`).set("Authorization", `Bearer ${token}`).send({
      code: `${TEST_CODE_PREFIX}TOGGLE`, description: "x", appliesTo: "BOTH", rate: 1, status: "INACTIVE",
    });
    expect(deactivated.status).toBe(200);

    const reactivated = await request(app).put(`/api/vat-rate-codes/${id}`).set("Authorization", `Bearer ${token}`).send({
      code: `${TEST_CODE_PREFIX}TOGGLE`, description: "x", appliesTo: "BOTH", rate: 1, status: "ACTIVE",
    });
    expect(reactivated.status).toBe(200);

    const list = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
    expect(list.body.find((r) => r.code === `${TEST_CODE_PREFIX}TOGGLE`).status).toBe("ACTIVE");
  });
});

describe("4: no DELETE route exists", () => {
  test("DELETE /api/vat-rate-codes/:id is not a registered route (404, not 200/403)", async () => {
    const created = await createVat({ code: `${TEST_CODE_PREFIX}NODEL`, description: "x", appliesTo: "BOTH", rate: 1 });
    const res = await request(app).delete(`/api/vat-rate-codes/${created.body.id}`).set("Authorization", `Bearer ${token}`);
    expect(res.status).toBe(404);

    const list = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
    expect(list.body.find((r) => r.code === `${TEST_CODE_PREFIX}NODEL`)).toBeDefined();
  });
});

describe("5: required-field and enum validation", () => {
  test("blank VAT Code rejected with a clear 400", async () => {
    const res = await createVat({ code: "  ", description: "x", rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/VAT Code is required/);
  });

  test("missing Rate rejected with a clear 400", async () => {
    const res = await createVat({ code: `${TEST_CODE_PREFIX}003`, description: "x" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Rate is required/);
  });

  test("invalid Applies To rejected", async () => {
    const res = await createVat({ code: `${TEST_CODE_PREFIX}004`, description: "x", appliesTo: "SOMETHING", rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Applies To must be one of/);
  });

  test("invalid Status rejected", async () => {
    const res = await createVat({ code: `${TEST_CODE_PREFIX}005`, description: "x", rate: 1, status: "DELETED" });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/Status must be one of/);
  });
});

describe("6: max-length validation (matches vat_rate_codes' actual DDL)", () => {
  test("VAT Code longer than varchar(20) rejected, not truncated", async () => {
    const tooLong = "A".repeat(21);
    const res = await createVat({ code: tooLong, description: "x", rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 20 characters/);
  });

  test("Description longer than varchar(255) rejected, not truncated", async () => {
    const tooLong = "B".repeat(256);
    const res = await createVat({ code: `${TEST_CODE_PREFIX}006`, description: tooLong, rate: 1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 255 characters/);
  });
});

describe("7: invalid rate rejected", () => {
  test("negative rate rejected", async () => {
    const res = await createVat({ code: `${TEST_CODE_PREFIX}007`, description: "x", rate: -1 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/non-negative/);
  });

  test("rate exceeding decimal(6,3) capacity rejected", async () => {
    const res = await createVat({ code: `${TEST_CODE_PREFIX}008`, description: "x", rate: 1000 });
    expect(res.status).toBe(400);
    expect(res.body.message).toMatch(/at most 999.999/);
  });
});

describe("8: duplicate VAT Code handled correctly (real DB UNIQUE key + app-level check)", () => {
  test("creating the same code twice is rejected with 409", async () => {
    const first = await createVat({ code: `${TEST_CODE_PREFIX}009`, description: "First", rate: 1 });
    expect(first.status).toBe(200);

    const dup = await createVat({ code: `${TEST_CODE_PREFIX}009`, description: "Second", rate: 2 });
    expect(dup.status).toBe(409);
    expect(dup.body.message).toMatch(/already exists/);
  });

  test("duplicate check is case-insensitive (matches the column's utf8mb4_0900_ai_ci collation)", async () => {
    const dup = await createVat({ code: `${TEST_CODE_PREFIX.toLowerCase()}009`, description: "Lowercase collision", rate: 2 });
    expect(dup.status).toBe(409);
  });

  test("editing a record to its OWN existing code is not rejected as a duplicate of itself", async () => {
    const created = await createVat({ code: `${TEST_CODE_PREFIX}010`, description: "Self", rate: 1 });
    const id = created.body.id;
    const res = await request(app).put(`/api/vat-rate-codes/${id}`).set("Authorization", `Bearer ${token}`).send({
      code: `${TEST_CODE_PREFIX}010`, description: "Self Updated", rate: 1,
    });
    expect(res.status).toBe(200);
  });

  test("editing a record to collide with a DIFFERENT existing code is rejected", async () => {
    await createVat({ code: `${TEST_CODE_PREFIX}011`, description: "A", rate: 1 });
    const created2 = await createVat({ code: `${TEST_CODE_PREFIX}012`, description: "B", rate: 1 });
    const res = await request(app).put(`/api/vat-rate-codes/${created2.body.id}`).set("Authorization", `Bearer ${token}`).send({
      code: `${TEST_CODE_PREFIX}011`, description: "B", rate: 1,
    });
    expect(res.status).toBe(409);
  });
});

describe("9: no accounting calculation changes", () => {
  test("a valid VAT record's code/appliesTo/rate remain exactly what was submitted (never recalculated at save time)", async () => {
    const created = await createVat({ code: `${TEST_CODE_PREFIX}013`, description: "x", appliesTo: "INPUT", rate: 12.345 });
    expect(created.status).toBe(200);
    const list = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
    const row = list.body.find((r) => r.code === `${TEST_CODE_PREFIX}013`);
    expect(row.appliesTo).toBe("INPUT");
    expect(Number(row.rate)).toBe(12.345);
  });
});

describe("10: permission behavior - real backend enforcement, not frontend-only", () => {
  test("no token is rejected on GET", async () => {
    const res = await request(app).get("/api/vat-rate-codes");
    expect(res.status).toBe(401);
  });

  test("no token is rejected on POST", async () => {
    const res = await request(app).post("/api/vat-rate-codes").send({ code: "X", description: "x", rate: 1 });
    expect(res.status).toBe(401);
  });

  test("FILESETUP.TAX_SETUP VIEW is enforced (403 when not granted)", async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'FILESETUP.TAX_SETUP' AND action = 'VIEW'");
    await pool.execute("UPDATE role_permissions SET granted = 0 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    try {
      const hash = await bcrypt.hash("VatLibPass!D1", 10);
      const [userResult] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 3, 'ACTIVE')",
        ["test_vatlib_noview", hash]
      );
      const noViewToken = (await request(app).post("/api/login").send({ username: "test_vatlib_noview", password: "VatLibPass!D1" })).body.token;

      const res = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${noViewToken}`);
      expect(res.status).toBe(403);

      await pool.query("DELETE FROM users WHERE id = ?", [userResult.insertId]);
    } finally {
      await pool.execute("UPDATE role_permissions SET granted = 1 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    }
  });

  test("a user WITH VIEW granted can list VAT codes", async () => {
    // role_id 2 (ADMIN), not 3 (ACCOUNTANT) - confirmed against
    // user_access_control_migration.sql's own default grant seed:
    // ACCOUNTANT's starter grant set is TRANSACTIONS/LEDGER/REPORTS/
    // POSTING/DASHBOARD only, deliberately excluding File Setup
    // configuration modules like FILESETUP.TAX_SETUP. ADMIN gets
    // everything except the Super-Admin-only Administration surfaces.
    const hash = await bcrypt.hash("VatLibPass!V1", 10);
    const [userResult] = await pool.execute(
      "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')",
      ["test_vatlib_view", hash]
    );
    const viewToken = (await request(app).post("/api/login").send({ username: "test_vatlib_view", password: "VatLibPass!V1" })).body.token;

    const res = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${viewToken}`);
    expect(res.status).toBe(200);

    await pool.query("DELETE FROM users WHERE id = ?", [userResult.insertId]);
  });

  test("FILESETUP.TAX_SETUP CONFIGURE is enforced (403 when not granted, VIEW alone is not enough to create)", async () => {
    const [[perm]] = await pool.query("SELECT id FROM permissions WHERE module_key = 'FILESETUP.TAX_SETUP' AND action = 'CONFIGURE'");
    await pool.execute("UPDATE role_permissions SET granted = 0 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    try {
      const hash = await bcrypt.hash("VatLibPass!D2", 10);
      const [userResult] = await pool.execute(
        "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 3, 'ACTIVE')",
        ["test_vatlib_noconfig", hash]
      );
      const noConfigToken = (await request(app).post("/api/login").send({ username: "test_vatlib_noconfig", password: "VatLibPass!D2" })).body.token;

      const res = await request(app).post("/api/vat-rate-codes").set("Authorization", `Bearer ${noConfigToken}`).send({
        code: `${TEST_CODE_PREFIX}NOPERM`, description: "x", rate: 1,
      });
      expect(res.status).toBe(403);

      const list = await request(app).get("/api/vat-rate-codes").set("Authorization", `Bearer ${token}`);
      expect(list.body.find((r) => r.code === `${TEST_CODE_PREFIX}NOPERM`)).toBeUndefined();

      await pool.query("DELETE FROM users WHERE id = ?", [userResult.insertId]);
    } finally {
      await pool.execute("UPDATE role_permissions SET granted = 1 WHERE role_id = 3 AND permission_id = ?", [perm.id]);
    }
  });

  test("a user WITH CONFIGURE granted can create a VAT code", async () => {
    // role_id 2 (ADMIN) - see the comment on the VIEW-granted test above.
    const hash = await bcrypt.hash("VatLibPass!C1", 10);
    const [userResult] = await pool.execute(
      "INSERT INTO users (username, password, role_id, status) VALUES (?, ?, 2, 'ACTIVE')",
      ["test_vatlib_config", hash]
    );
    const configToken = (await request(app).post("/api/login").send({ username: "test_vatlib_config", password: "VatLibPass!C1" })).body.token;

    const res = await request(app).post("/api/vat-rate-codes").set("Authorization", `Bearer ${configToken}`).send({
      code: `${TEST_CODE_PREFIX}HASPERM`, description: "x", rate: 1,
    });
    expect(res.status).toBe(200);

    await pool.query("DELETE FROM users WHERE id = ?", [userResult.insertId]);
  });
});
