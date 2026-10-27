const pool = require("../db");
const { logAudit } = require("../lib/audit");
const { soleCompanyOfUser } = require("../lib/auditCompany");
const PermissionService = require("./permissionService");

function httpError(message, statusCode) {
  return Object.assign(new Error(message), { statusCode });
}

async function listTemplates() {
  const [rows] = await pool.execute(
    `SELECT t.id, t.name, t.description, t.is_system, t.created_at, t.updated_at,
       creator.username AS created_by_username,
       (SELECT COUNT(*) FROM permission_template_items i WHERE i.template_id = t.id) AS permission_count
     FROM permission_templates t
     LEFT JOIN users creator ON creator.id = t.created_by
     ORDER BY t.name`
  );
  return rows;
}

async function getTemplateOr404(id) {
  const [rows] = await pool.execute("SELECT * FROM permission_templates WHERE id = ?", [id]);
  const template = rows[0];
  if (!template) {
    throw httpError("Template not found", 404);
  }
  return template;
}

async function getTemplateItems(id) {
  const template = await getTemplateOr404(id);
  const [items] = await pool.execute(
    `SELECT p.id AS permission_id, p.module_key, p.action, p.label, COALESCE(i.granted, 0) AS granted
     FROM permissions p
     LEFT JOIN permission_template_items i ON i.permission_id = p.id AND i.template_id = ?
     ORDER BY p.module_key, p.action`,
    [id]
  );
  return { template, items };
}

// The permissions a template grants, as audit-friendly references.
async function getGrantedPermissions(templateId, conn = pool) {
  const [rows] = await conn.execute(
    `SELECT p.id, p.module_key, p.action, p.label
     FROM permission_template_items i JOIN permissions p ON p.id = i.permission_id
     WHERE i.template_id = ? AND i.granted = 1
     ORDER BY p.module_key, p.action`,
    [templateId]
  );
  return rows.map((r) => ({ permissionId: r.id, permission: `${r.module_key}.${r.action}`, moduleKey: r.module_key, action: r.action, label: r.label }));
}

function snapshot(template, permissions) {
  return {
    name: template.name,
    description: template.description ?? null,
    isSystem: !!template.is_system,
    permissions: permissions.map((p) => p.permission),
  };
}

function diffKeys(beforeKeys, afterKeys) {
  const b = new Set(beforeKeys);
  const a = new Set(afterKeys);
  return {
    added: afterKeys.filter((k) => !b.has(k)),
    removed: beforeKeys.filter((k) => !a.has(k)),
  };
}

// Can `inviter` hand this template to a new user with `invitedRole`?
// Used when an invitation is created and again when it is accepted (the
// template may have changed in between).
//   - the template must exist and grant at least one permission (an empty
//     template would be applied as a complete deny set - a user who can do
//     nothing - so it is refused instead);
//   - a non-Super-Admin inviter may only hand out permissions they hold
//     themselves, and no Administration permission the invited role
//     doesn't already have by default.
// Super Admin is exempt from the last two checks.
async function assertTemplateAssignable(templateId, { inviterId, invitedRoleId }) {
  const id = Number(templateId);
  if (!Number.isInteger(id) || id <= 0) {
    throw httpError("Selected permission template does not exist.", 400);
  }
  const [rows] = await pool.execute("SELECT id, name FROM permission_templates WHERE id = ?", [id]);
  const template = rows[0];
  if (!template) {
    throw httpError("Selected permission template does not exist.", 400);
  }
  const granted = await getGrantedPermissions(id);
  if (granted.length === 0) {
    throw httpError(
      `The "${template.name}" permission template has no permissions configured, so it can't be used. Choose another template or none.`,
      400
    );
  }

  const [[inviter]] = await pool.execute(
    "SELECT u.id, r.code AS role_code FROM users u LEFT JOIN roles r ON r.id = u.role_id WHERE u.id = ?",
    [inviterId]
  );
  if (inviter?.role_code === "SUPER_ADMIN") return { template, granted };

  const inviterKeys = inviter ? await PermissionService.getGrantedPermissionKeys(inviter.id) : new Set();
  const exceeding = granted.filter((p) => !inviterKeys.has(p.permission));
  if (exceeding.length) {
    throw httpError(
      `The "${template.name}" template grants permissions you don't have: ${exceeding.slice(0, 5).map((p) => p.permission).join(", ")}${exceeding.length > 5 ? ` (+${exceeding.length - 5} more)` : ""}.`,
      403
    );
  }

  const [roleRows] = await pool.execute(
    `SELECT p.module_key, p.action FROM role_permissions rp JOIN permissions p ON p.id = rp.permission_id
     WHERE rp.role_id = ? AND rp.granted = 1`,
    [invitedRoleId]
  );
  const roleKeys = new Set(roleRows.map((r) => `${r.module_key}.${r.action}`));
  const adminOnly = granted.filter((p) => p.moduleKey.startsWith("ADMIN.") && !roleKeys.has(p.permission));
  if (adminOnly.length) {
    throw httpError(
      `The "${template.name}" template grants administration permissions this role can't receive: ${adminOnly.map((p) => p.permission).join(", ")}.`,
      403
    );
  }
  return { template, granted };
}

async function createTemplate({ name, description, grants, actingUser }) {
  if (!name || !name.trim()) {
    throw httpError("Template name is required.", 400);
  }
  const normalized = await PermissionService.normalizeGrants(grants || []);

  const [existing] = await pool.execute("SELECT id FROM permission_templates WHERE name = ?", [name.trim()]);
  if (existing.length > 0) {
    throw httpError("A template with this name already exists.", 409);
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      "INSERT INTO permission_templates (name, description, created_by) VALUES (?, ?, ?)",
      [name.trim(), description || null, actingUser.id]
    );
    const templateId = result.insertId;

    for (const g of normalized) {
      if (!g.granted) continue;
      await conn.execute(
        "INSERT IGNORE INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)",
        [templateId, g.permissionId]
      );
    }

    const granted = await getGrantedPermissions(templateId, conn);
    await logAudit(conn, {
      module: "PERMISSION_TEMPLATES",
      entityType: "PERMISSION_TEMPLATE",
      entityId: templateId,
      action: "TEMPLATE_CREATED",
      description: `${actingUser.username} created permission template "${name.trim()}" (${granted.length} permission(s))`,
      afterData: snapshot({ name: name.trim(), description: description || null, is_system: 0 }, granted),
      user: actingUser,
    });

    await conn.commit();
    return getTemplateItems(templateId);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

// Editing a template only affects future applications of it (invitation
// acceptance, or an explicit "Apply Template" action) - it never reaches
// back and changes users who were previously assigned it, per spec.
async function updateTemplate(id, { name, description, grants }, actingUser) {
  const template = await getTemplateOr404(id);
  const normalized = Array.isArray(grants) ? await PermissionService.normalizeGrants(grants) : null;
  const beforePermissions = await getGrantedPermissions(id);

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (name && name.trim() !== template.name) {
      const [existing] = await conn.execute("SELECT id FROM permission_templates WHERE name = ? AND id != ?", [name.trim(), id]);
      if (existing.length > 0) {
        throw httpError("A template with this name already exists.", 409);
      }
      await conn.execute("UPDATE permission_templates SET name = ? WHERE id = ?", [name.trim(), id]);
    }
    if (description !== undefined) {
      await conn.execute("UPDATE permission_templates SET description = ? WHERE id = ?", [description, id]);
    }

    if (normalized) {
      await conn.execute("DELETE FROM permission_template_items WHERE template_id = ?", [id]);
      for (const g of normalized) {
        if (!g.granted) continue;
        await conn.execute(
          "INSERT INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)",
          [id, g.permissionId]
        );
      }
    }

    const [[updated]] = await conn.execute("SELECT * FROM permission_templates WHERE id = ?", [id]);
    const afterPermissions = await getGrantedPermissions(id, conn);
    const before = snapshot(template, beforePermissions);
    const after = snapshot(updated, afterPermissions);

    await logAudit(conn, {
      module: "PERMISSION_TEMPLATES",
      entityType: "PERMISSION_TEMPLATE",
      entityId: id,
      action: "TEMPLATE_UPDATED",
      description: `${actingUser.username} updated permission template "${template.name}" - existing users assigned this template are NOT affected unless explicitly re-applied`,
      beforeData: before,
      afterData: { ...after, ...diffKeys(before.permissions, after.permissions) },
      user: actingUser,
    });

    await conn.commit();
    return getTemplateItems(id);
  } catch (err) {
    await conn.rollback();
    throw err;
  } finally {
    conn.release();
  }
}

async function deleteTemplate(id, actingUser) {
  const template = await getTemplateOr404(id);
  if (template.is_system) {
    throw httpError("Built-in templates cannot be deleted.", 400);
  }
  const beforePermissions = await getGrantedPermissions(id);

  await pool.execute("DELETE FROM permission_templates WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "PERMISSION_TEMPLATES",
    entityType: "PERMISSION_TEMPLATE",
    entityId: id,
    action: "TEMPLATE_DELETED",
    description: `${actingUser.username} deleted permission template "${template.name}"`,
    beforeData: snapshot(template, beforePermissions),
    user: actingUser,
  });

  return { id, deleted: true };
}

// Copies the template's current items into a user's overrides RIGHT NOW -
// a one-time copy, not a live link, per spec ("changing a template must
// not silently change existing users").
async function applyTemplateToUser(templateId, userId, actingUser) {
  const { template, items } = await getTemplateItems(templateId);
  // An empty template would be written as a complete deny set (below),
  // leaving the user unable to do anything - refuse it instead.
  if (!items.some((i) => i.granted)) {
    throw httpError(`The "${template.name}" permission template has no permissions configured, so it can't be applied.`, 400);
  }
  const [[target]] = await pool.execute("SELECT id, username FROM users WHERE id = ?", [userId]);
  const [previous] = await pool.execute(
    `SELECT p.module_key, p.action, up.granted FROM user_permissions up JOIN permissions p ON p.id = up.permission_id
     WHERE up.user_id = ? ORDER BY p.module_key, p.action`,
    [userId]
  );

  // A template must apply as a COMPLETE override set (explicit allow AND
  // explicit deny for every permission), not just allow-overrides for what
  // it includes - otherwise a restrictive template (e.g. "Reporting Only")
  // applied to a broad role (e.g. Accountant) wouldn't actually restrict
  // anything, since unmentioned permissions would keep falling through to
  // the role's own (broader) defaults.
  const grants = items.map((i) => ({ permissionId: i.permission_id, granted: !!i.granted }));

  const RestrictionService = require("./restrictionService");
  const result = await RestrictionService.setUserAccess(userId, grants, actingUser);

  await logAudit(pool, {
    module: "PERMISSION_TEMPLATES",
    entityType: "PERMISSION_TEMPLATE",
    entityId: templateId,
    action: "TEMPLATE_APPLIED",
    description: `${actingUser.username} applied permission template "${template.name}" to user ${target?.username || userId}`,
    beforeData: {
      targetUserId: Number(userId),
      overrides: previous.map((r) => ({ permission: `${r.module_key}.${r.action}`, granted: !!r.granted })),
    },
    afterData: {
      templateId: Number(templateId),
      templateName: template.name,
      targetUserId: Number(userId),
      targetUsername: target?.username || null,
      granted: items.filter((i) => i.granted).map((i) => `${i.module_key}.${i.action}`),
      deniedCount: items.filter((i) => !i.granted).length,
    },
    user: actingUser,
    // The template itself is global; the event is about the target user,
    // so it follows that user's single company (NULL if several or none).
    companyId: await soleCompanyOfUser(pool, userId),
  });

  return result;
}

module.exports = {
  listTemplates,
  getTemplateItems,
  createTemplate,
  updateTemplate,
  deleteTemplate,
  applyTemplateToUser,
  assertTemplateAssignable,
};
