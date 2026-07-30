const pool = require("../db");
const { logAudit } = require("../lib/audit");

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
    throw Object.assign(new Error("Template not found"), { statusCode: 404 });
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

async function createTemplate({ name, description, grants, actingUser }) {
  if (!name || !name.trim()) {
    throw Object.assign(new Error("Template name is required."), { statusCode: 400 });
  }

  const [existing] = await pool.execute("SELECT id FROM permission_templates WHERE name = ?", [name.trim()]);
  if (existing.length > 0) {
    throw Object.assign(new Error("A template with this name already exists."), { statusCode: 409 });
  }

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    const [result] = await conn.execute(
      "INSERT INTO permission_templates (name, description, created_by) VALUES (?, ?, ?)",
      [name.trim(), description || null, actingUser.id]
    );
    const templateId = result.insertId;

    for (const g of grants || []) {
      if (!g.granted) continue;
      await conn.execute(
        "INSERT IGNORE INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)",
        [templateId, g.permissionId]
      );
    }

    await logAudit(conn, {
      module: "PERMISSION_TEMPLATES",
      entityType: "PERMISSION_TEMPLATE",
      entityId: templateId,
      action: "TEMPLATE_CREATED",
      description: `${actingUser.username} created permission template "${name.trim()}"`,
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

  const conn = await pool.getConnection();
  try {
    await conn.beginTransaction();

    if (name && name.trim() !== template.name) {
      const [existing] = await conn.execute("SELECT id FROM permission_templates WHERE name = ? AND id != ?", [name.trim(), id]);
      if (existing.length > 0) {
        throw Object.assign(new Error("A template with this name already exists."), { statusCode: 409 });
      }
      await conn.execute("UPDATE permission_templates SET name = ? WHERE id = ?", [name.trim(), id]);
    }
    if (description !== undefined) {
      await conn.execute("UPDATE permission_templates SET description = ? WHERE id = ?", [description, id]);
    }

    if (Array.isArray(grants)) {
      await conn.execute("DELETE FROM permission_template_items WHERE template_id = ?", [id]);
      for (const g of grants) {
        if (!g.granted) continue;
        await conn.execute(
          "INSERT INTO permission_template_items (template_id, permission_id, granted) VALUES (?, ?, 1)",
          [id, g.permissionId]
        );
      }
    }

    await logAudit(conn, {
      module: "PERMISSION_TEMPLATES",
      entityType: "PERMISSION_TEMPLATE",
      entityId: id,
      action: "TEMPLATE_UPDATED",
      description: `${actingUser.username} updated permission template "${template.name}" - existing users assigned this template are NOT affected unless explicitly re-applied`,
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
    throw Object.assign(new Error("Built-in templates cannot be deleted."), { statusCode: 400 });
  }

  await pool.execute("DELETE FROM permission_templates WHERE id = ?", [id]);

  await logAudit(pool, {
    module: "PERMISSION_TEMPLATES",
    entityType: "PERMISSION_TEMPLATE",
    entityId: id,
    action: "TEMPLATE_DELETED",
    description: `${actingUser.username} deleted permission template "${template.name}"`,
    user: actingUser,
  });

  return { id, deleted: true };
}

// Copies the template's current items into a user's overrides RIGHT NOW -
// a one-time copy, not a live link, per spec ("changing a template must
// not silently change existing users").
async function applyTemplateToUser(templateId, userId, actingUser) {
  const { items } = await getTemplateItems(templateId);
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
    description: `${actingUser.username} applied a permission template to user ${userId}`,
    user: actingUser,
  });

  return result;
}

module.exports = { listTemplates, getTemplateItems, createTemplate, updateTemplate, deleteTemplate, applyTemplateToUser };
