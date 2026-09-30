const pool = require("../db");

// Fixed Asset Lapsing Report - a period depreciation roll-forward
// (Beginning Accumulated Depreciation -> Depreciation Expense for the
// Period -> Ending Accumulated Depreciation) for every ACTIVE fixed
// asset, as of a From/To date range.
//
// There is no existing service layer for Fixed Assets to delegate to -
// the only prior authoritative calculation is the inline SQL in
// server.js's GET /api/reports/fixed-asset-register route, which this
// file does NOT modify, import, or duplicate logic away from. Instead,
// that exact same straight-line, as-of-a-date formula is reused
// verbatim (copied, not reinvented) and evaluated twice - once with
// `from` and once with `to` - so Beginning/Ending Accumulated
// Depreciation are two snapshots of the identical existing calculation:
//   monthlyDepreciation = ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2)
//   months = LEAST(GREATEST(TIMESTAMPDIFF(MONTH, acquisition_date, asOfDate), 0), useful_life_years * 12)
//   accumulatedDepreciation = LEAST(monthlyDepreciation * months, acquisition_cost - salvage_value)
// Depreciation Expense for the Period = Ending - Beginning (not a third,
// independent calculation). Beginning/Ending Book Value = Acquisition
// Cost - Beginning/Ending Accumulated Depreciation, matching the
// existing register's own Cost - Accumulated Depreciation = Book Value
// relationship.
//
// Scope is inherited, not invented: fixed_assets has no company_id or
// branch_id column (confirmed against 000_baseline_schema_migration.sql),
// so - exactly like the existing fixed-asset-register route and the
// fixed-asset CRUD routes - this report is NOT company- or branch-
// scoped. Only status = 'Active' assets are included, matching the
// existing register's own WHERE clause; disposed assets are excluded
// outright, and no disposal-date depreciation or gain/loss logic is
// invented here.

function round2(value) {
  return Math.round((Number(value) || 0) * 100) / 100;
}

async function getFixedAssetLapsing({ from, to }) {
  if (!from) throw new Error("From date is required");
  if (!to) throw new Error("To date is required");
  if (from > to) throw new Error("From date must not be after To date");

  const [rows] = await pool.execute(
    `
    SELECT
      id,
      asset_code AS assetCode,
      asset_name AS assetName,
      category,
      DATE_FORMAT(acquisition_date, '%Y-%m-%d') AS acquisitionDate,
      acquisition_cost AS acquisitionCost,
      salvage_value AS salvageValue,
      useful_life_years AS usefulLifeYears,
      ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2) AS monthlyDepreciation,
      LEAST(
        ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2) *
          LEAST(GREATEST(TIMESTAMPDIFF(MONTH, acquisition_date, ?), 0), useful_life_years * 12),
        acquisition_cost - salvage_value
      ) AS beginningAccumulatedDepreciation,
      LEAST(
        ROUND((acquisition_cost - salvage_value) / (useful_life_years * 12), 2) *
          LEAST(GREATEST(TIMESTAMPDIFF(MONTH, acquisition_date, ?), 0), useful_life_years * 12),
        acquisition_cost - salvage_value
      ) AS endingAccumulatedDepreciation
    FROM fixed_assets
    WHERE status = 'Active'
    ORDER BY asset_code ASC
    `,
    [from, to]
  );

  const shapedRows = rows.map((r) => {
    const acquisitionCost = round2(r.acquisitionCost);
    const salvageValue = round2(r.salvageValue);
    const beginningAccumulatedDepreciation = round2(r.beginningAccumulatedDepreciation);
    const endingAccumulatedDepreciation = round2(r.endingAccumulatedDepreciation);
    const depreciationExpense = round2(endingAccumulatedDepreciation - beginningAccumulatedDepreciation);
    const beginningBookValue = round2(acquisitionCost - beginningAccumulatedDepreciation);
    const endingBookValue = round2(acquisitionCost - endingAccumulatedDepreciation);

    return {
      id: r.id,
      assetCode: r.assetCode,
      assetName: r.assetName,
      category: r.category,
      acquisitionDate: r.acquisitionDate,
      acquisitionCost,
      salvageValue,
      usefulLifeYears: r.usefulLifeYears,
      monthlyDepreciation: round2(r.monthlyDepreciation),
      beginningAccumulatedDepreciation,
      depreciationExpense,
      endingAccumulatedDepreciation,
      beginningBookValue,
      endingBookValue,
    };
  });

  const grandTotals = shapedRows.reduce(
    (acc, row) => {
      acc.acquisitionCost += row.acquisitionCost;
      acc.salvageValue += row.salvageValue;
      acc.monthlyDepreciation += row.monthlyDepreciation;
      acc.beginningAccumulatedDepreciation += row.beginningAccumulatedDepreciation;
      acc.depreciationExpense += row.depreciationExpense;
      acc.endingAccumulatedDepreciation += row.endingAccumulatedDepreciation;
      acc.beginningBookValue += row.beginningBookValue;
      acc.endingBookValue += row.endingBookValue;
      return acc;
    },
    {
      acquisitionCost: 0,
      salvageValue: 0,
      monthlyDepreciation: 0,
      beginningAccumulatedDepreciation: 0,
      depreciationExpense: 0,
      endingAccumulatedDepreciation: 0,
      beginningBookValue: 0,
      endingBookValue: 0,
    }
  );
  for (const key of Object.keys(grandTotals)) grandTotals[key] = round2(grandTotals[key]);

  return { rows: shapedRows, grandTotals };
}

module.exports = { getFixedAssetLapsing };
