import fs from "node:fs/promises";
import path from "node:path";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";

dotenv.config();

const workspaceRoot = path.resolve("..");
const outputDir = path.join(workspaceRoot, "outputs", "lstm_inventory");
const rawCsvPath = path.join(workspaceRoot, "retail_store_inventory.csv");
const modelVersion = process.env.FORECAST_MODEL_VERSION || "retail-lstm-strict-v1";
const dryRun = process.argv.includes("--dry-run");
const preserveDates = process.argv.includes("--preserve-dates");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      index += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") index += 1;
      row.push(value);
      if (row.some((cell) => cell !== "")) rows.push(row);
      row = [];
      value = "";
    } else {
      value += char;
    }
  }

  if (value || row.length) {
    row.push(value);
    rows.push(row);
  }

  const [headers, ...body] = rows;
  return body.map((cells) =>
    Object.fromEntries(
      headers.map((header, index) => {
        const raw = cells[index] ?? "";
        const numeric = Number(raw);
        if (raw === "True") return [header, true];
        if (raw === "False") return [header, false];
        return [header, raw !== "" && Number.isFinite(numeric) ? numeric : raw];
      }),
    ),
  );
}

async function readCsv(filePath) {
  const text = await fs.readFile(filePath, "utf8");
  return parseCsv(text.replace(/^\uFEFF/, ""));
}

function productKey(row) {
  return `${row["Store ID"]}-${row["Product ID"]}`;
}

function toIsoDate(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function taipeiToday() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Taipei",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
  return new Date(`${values.year}-${values.month}-${values.day}T00:00:00`);
}

function shiftedDate(originalDate, firstForecastDate) {
  if (preserveDates) return originalDate;
  const source = new Date(`${originalDate}T00:00:00`);
  const first = new Date(`${firstForecastDate}T00:00:00`);
  const offsetDays = Math.round((source - first) / 86400000);
  const target = taipeiToday();
  target.setDate(target.getDate() + offsetDays);
  return toIsoDate(target);
}

function uniqueBy(rows, keyFn) {
  const map = new Map();
  rows.forEach((row) => map.set(keyFn(row), row));
  return [...map.values()];
}

async function upsertInChunks(supabase, table, rows, options = {}) {
  const chunkSize = 500;
  for (let start = 0; start < rows.length; start += chunkSize) {
    const chunk = rows.slice(start, start + chunkSize);
    const { error } = await supabase.from(table).upsert(chunk, options);
    if (error) throw new Error(`${table}: ${error.message}`);
  }
}

async function main() {
  const supabaseUrl = process.env.SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_ANON_KEY;
  if (!supabaseUrl || !supabaseKey) {
    throw new Error("Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env");
  }

  const [rawRows, forecastRows, replenishmentRows, metrics] = await Promise.all([
    readCsv(rawCsvPath),
    readCsv(path.join(outputDir, "latest_7_day_forecast.csv")),
    readCsv(path.join(outputDir, "replenishment_recommendations.csv")),
    fs.readFile(path.join(outputDir, "metrics.json"), "utf8").then(JSON.parse),
  ]);

  const latestRawByProduct = new Map();
  rawRows.forEach((row) => latestRawByProduct.set(productKey(row), row));
  const replenishmentByProduct = new Map(
    replenishmentRows.map((row) => [productKey(row), row]),
  );
  const firstForecastDate = forecastRows
    .map((row) => row.forecast_date)
    .sort()[0];
  const rmse = Number(metrics.overall_rmse_units || 0);

  const products = uniqueBy(forecastRows, productKey).map((row) => {
    const raw = latestRawByProduct.get(productKey(row)) || row;
    const rec = replenishmentByProduct.get(productKey(row)) || {};
    return {
      id: productKey(row),
      name: `${row["Product ID"]}（${row["Store ID"]}）`,
      category: raw.Category || "未分類",
      price: Number(raw.Price || 0),
      safety_stock: Math.round(Number(rec.safety_stock_2_days || 0)),
      lead_time_days: 2,
      confidence: 0.35,
    };
  });

  const inventory = uniqueBy(forecastRows, productKey).map((row) => {
    const rec = replenishmentByProduct.get(productKey(row)) || row;
    return {
      product_id: productKey(row),
      on_hand: Math.round(Number(rec.latest_inventory_level || 0)),
      reserved: 0,
      incoming: 0,
      updated_at: new Date().toISOString(),
    };
  });

  const forecasts = forecastRows.map((row) => {
    const predicted = Number(row.predicted_units_sold || 0);
    return {
      product_id: productKey(row),
      forecast_date: shiftedDate(row.forecast_date, firstForecastDate),
      predicted_sales: Number(predicted.toFixed(2)),
      lower_bound: Number(Math.max(0, predicted - rmse).toFixed(2)),
      upper_bound: Number((predicted + rmse).toFixed(2)),
      model_version: modelVersion,
      created_at: new Date().toISOString(),
    };
  });

  const modelRun = {
    status: "success",
    optimizer: "Adam",
    weight_updated: true,
    model_version: modelVersion,
    hidden_layers: String(metrics.hidden_size || "48"),
    dropout_rate: 0.2,
    mae: Number(metrics.overall_mae_units || 0),
    rmse: Number(metrics.overall_rmse_units || 0),
    mape: null,
    note: `Synced from PyTorch LSTM outputs. Forecast dates ${
      preserveDates ? "preserved" : "shifted to current 7-day display window"
    }.`,
    created_at: new Date().toISOString(),
  };

  console.log(
    JSON.stringify(
      {
        dryRun,
        modelVersion,
        preserveDates,
        products: products.length,
        inventory: inventory.length,
        forecasts: forecasts.length,
        forecastDateStart: forecasts[0]?.forecast_date,
        forecastDateEnd: forecasts[forecasts.length - 1]?.forecast_date,
      },
      null,
      2,
    ),
  );

  if (dryRun) return;

  const supabase = createClient(supabaseUrl, supabaseKey);
  await upsertInChunks(supabase, "products", products, { onConflict: "id" });
  await upsertInChunks(supabase, "inventory", inventory, {
    onConflict: "product_id",
  });
  await upsertInChunks(supabase, "forecasts", forecasts, {
    onConflict: "product_id,forecast_date,model_version",
  });

  const { error } = await supabase.from("model_runs").insert(modelRun);
  if (error) throw new Error(`model_runs: ${error.message}`);

  console.log("LSTM forecast outputs synced to Supabase.");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
