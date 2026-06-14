import fs from "node:fs/promises";
import path from "node:path";

const workspaceRoot = path.resolve("..");
const sourceDir = path.join(workspaceRoot, "outputs", "lstm_inventory");
const rawCsvPath = path.join(workspaceRoot, "retail_store_inventory.csv");
const publicDataDir = path.resolve("public", "data");

function parseCsv(text) {
  const rows = [];
  let row = [];
  let value = "";
  let quoted = false;

  for (let i = 0; i < text.length; i += 1) {
    const char = text[i];
    const next = text[i + 1];
    if (char === '"' && quoted && next === '"') {
      value += '"';
      i += 1;
    } else if (char === '"') {
      quoted = !quoted;
    } else if (char === "," && !quoted) {
      row.push(value);
      value = "";
    } else if ((char === "\n" || char === "\r") && !quoted) {
      if (char === "\r" && next === "\n") i += 1;
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

function unique(values) {
  return [...new Set(values)].sort();
}

function sum(values) {
  return values.reduce((total, value) => total + Number(value || 0), 0);
}

function mean(values) {
  return values.length ? sum(values) / values.length : 0;
}

async function readCsv(name) {
  const text = await fs.readFile(path.join(sourceDir, name), "utf8");
  return parseCsv(text.replace(/^\uFEFF/, ""));
}

async function main() {
  await fs.mkdir(publicDataDir, { recursive: true });

  const [metrics, rawCsv, latestForecast, replenishment, predictionSample, trainingHistory] =
    await Promise.all([
      fs.readFile(path.join(sourceDir, "metrics.json"), "utf8").then(JSON.parse),
      fs.readFile(rawCsvPath, "utf8").then((text) => parseCsv(text.replace(/^\uFEFF/, ""))),
      readCsv("latest_7_day_forecast.csv"),
      readCsv("replenishment_recommendations.csv"),
      readCsv("test_predictions_sample.csv"),
      readCsv("training_history.csv"),
    ]);

  const dates = rawCsv.map((row) => row.Date);
  const rawSummary = {
    rows: rawCsv.length,
    columns: Object.keys(rawCsv[0] ?? {}).length,
    dateStart: dates[0],
    dateEnd: dates[dates.length - 1],
    stores: unique(rawCsv.map((row) => row["Store ID"])),
    products: unique(rawCsv.map((row) => row["Product ID"])),
    categories: unique(rawCsv.map((row) => row.Category)),
    regions: unique(rawCsv.map((row) => row.Region)),
    avgInventory: mean(rawCsv.map((row) => row["Inventory Level"])),
    avgUnitsSold: mean(rawCsv.map((row) => row["Units Sold"])),
    avgUnitsOrdered: mean(rawCsv.map((row) => row["Units Ordered"])),
    avgDemandForecast: mean(rawCsv.map((row) => row["Demand Forecast"])),
    avgPrice: mean(rawCsv.map((row) => row.Price)),
    avgDiscount: mean(rawCsv.map((row) => row.Discount)),
  };

  const topReplenishment = [...replenishment]
    .sort((a, b) => b.recommended_order_qty - a.recommended_order_qty)
    .slice(0, 12);

  await fs.writeFile(
    path.join(publicDataDir, "local-lstm-dashboard.json"),
    JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        metrics,
        rawSummary,
        latestForecast,
        replenishment,
        topReplenishment,
        predictionSample,
        trainingHistory,
      },
      null,
      2,
    ),
    "utf8",
  );

  console.log(
    `Prepared local LSTM data: ${latestForecast.length} forecast rows, ${replenishment.length} recommendations.`,
  );
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
