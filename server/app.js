import express from "express";
import cors from "cors";
import dotenv from "dotenv";

import { createClient } from "@supabase/supabase-js";
import { addDays, format, subDays } from "date-fns";

dotenv.config();

const app = express();
const port = Number(process.env.PORT || 4000);
const supabaseUrl =
  process.env.SUPABASE_URL || "https://hcbtyxaelyhybpdnkzrb.supabase.co";
const supabaseKey =
  process.env.SUPABASE_ANON_KEY ||
  "sb_publishable_kNtrRiDqjye40HMYCI95Kw_oidkdgI8";
const supabase = createClient(supabaseUrl, supabaseKey);
const forecastModelVersion =
  process.env.FORECAST_MODEL_VERSION || "retail-lstm-strict-v1";

app.use(cors());
app.use(express.json());

const today = new Date();
const fmt = (date) => format(date, "yyyy-MM-dd");
const clamp = (value, min, max) => Math.min(Math.max(value, min), max);
const round = (value, digit = 0) => Number(value.toFixed(digit));

async function selectRows(table, columns = "*", builder = (query) => query) {
  const query = builder(supabase.from(table).select(columns));
  const { data, error } = await query;
  if (error) throw new Error(`${table}: ${error.message}`);
  return data || [];
}

function normalizeSalesRows(rows) {
  return rows
    .map((row) => ({
      productId: row.product_id ?? row.productId,
      date: row.sale_date ?? row.date ?? row.created_at?.slice(0, 10),
      quantity: Number(row.quantity ?? row.qty ?? row.units ?? row.sales ?? 0),
      revenue: Number(row.revenue ?? row.amount ?? row.total ?? 0),
    }))
    .filter((row) => row.date && Number.isFinite(row.quantity));
}

function normalizeForecastRows(rows) {
  return rows
    .map((row) => ({
      productId: row.product_id ?? row.productId,
      date: row.forecast_date ?? row.date,
      predictedSales: Number(
        row.predicted_sales ??
          row.predictedSales ??
          row.quantity ??
          row.forecast ??
          0,
      ),
      lowerBound: Number(
        row.lower_bound ?? row.lowerBound ?? row.predicted_sales_low ?? 0,
      ),
      upperBound: Number(
        row.upper_bound ?? row.upperBound ?? row.predicted_sales_high ?? 0,
      ),
    }))
    .filter((row) => row.date && Number.isFinite(row.predictedSales));
}

function aggregateByDate(rows, key) {
  const map = new Map();
  rows.forEach((row) =>
    map.set(row.date, (map.get(row.date) || 0) + Number(row[key] || 0)),
  );
  return [...map.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({ date, value: round(value) }));
}

function buildTrendFromData(
  salesRows,
  forecastRows,
  productId = "all",
  days = 14,
) {
  const sales = normalizeSalesRows(salesRows).filter(
    (row) => productId === "all" || String(row.productId) === String(productId),
  );
  const forecasts = normalizeForecastRows(forecastRows).filter(
    (row) => productId === "all" || String(row.productId) === String(productId),
  );
  const history = aggregateByDate(sales, "quantity")
    .slice(-14)
    .map((row) => ({
      date: row.date,
      actualSales: row.value,
      predictedSales: null,
      lowerBound: null,
      upperBound: null,
    }));

  const forecastMap = new Map();
  forecasts.slice(0, days).forEach((row) => {
    const current = forecastMap.get(row.date) || {
      predictedSales: 0,
      lowerBound: 0,
      upperBound: 0,
    };
    current.predictedSales += row.predictedSales;
    current.lowerBound += row.lowerBound || 0;
    current.upperBound += row.upperBound || 0;
    forecastMap.set(row.date, current);
  });

  const forecast = [...forecastMap.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([date, value]) => ({
      date,
      actualSales: null,
      predictedSales: round(value.predictedSales),
      lowerBound: value.lowerBound ? round(value.lowerBound) : null,
      upperBound: value.upperBound ? round(value.upperBound) : null,
    }));

  // Bridge: connect the last history point to the first forecast point
  // so the chart lines don't have a visual gap
  if (history.length && forecast.length) {
    const lastActual = history[history.length - 1].actualSales;
    // 讓預測線與置信區間的「起點」從歷史最後一點開始（呈現扇形展開）
    history[history.length - 1].predictedSales = lastActual;
    history[history.length - 1].lowerBound = lastActual;
    history[history.length - 1].upperBound = lastActual;
  }

  return [...history, ...forecast];
}

function calculateStockRecommendations(products, inventory, forecasts) {
  const forecastRows = normalizeForecastRows(forecasts);
  return products
    .map((product) => {
      const inv =
        inventory.find(
          (item) =>
            String(item.product_id ?? item.productId) === String(product.id),
        ) || {};
      const onHand = Number(inv.on_hand ?? inv.onHand ?? inv.stock ?? 0);
      const reserved = Number(inv.reserved ?? 0);
      const incoming = Number(inv.incoming ?? 0);
      const available = onHand - reserved + incoming;
      const productForecasts = forecastRows.filter(
        (row) => String(row.productId) === String(product.id),
      );
      const sevenDayDemand = productForecasts
        .slice(0, 7)
        .reduce((sum, row) => sum + row.predictedSales, 0);
      const safetyStock = Number(
        product.safety_stock ?? product.safetyStock ?? 0,
      );
      const recommendedOrderQty = Math.max(
        0,
        Math.ceil(sevenDayDemand + safetyStock - available),
      );
      const overstockQty = Math.max(
        0,
        Math.ceil(available - sevenDayDemand * 1.8 - safetyStock),
      );
      const status =
        recommendedOrderQty > 0
          ? "shortage"
          : overstockQty > 0
            ? "overstock"
            : "healthy";

      return {
        productId: product.id,
        productName: product.name,
        category: product.category ?? "未分類",
        available: round(available),
        sevenDayDemand: round(sevenDayDemand),
        safetyStock,
        recommendedOrderQty,
        overstockQty,
        status,
        leadTimeDays: Number(
          product.lead_time_days ?? product.leadTimeDays ?? 0,
        ),
        confidence: Number(
          product.confidence ?? product.forecast_confidence ?? 0,
        ),
      };
    })
    .sort((a, b) => b.recommendedOrderQty - a.recommendedOrderQty);
}

function calculateStability(forecasts) {
  const rows = normalizeForecastRows(forecasts).filter(
    (row) => row.predictedSales > 0,
  );
  if (rows.length < 2) {
    return {
      confidenceBandAvg: 0,
      volatilityScore: 0,
      bufferSuggestion: "Supabase 預測資料不足，尚無法計算穩定性",
      riskLevel: "unknown",
    };
  }

  const confidenceRows = rows.filter(
    (row) => row.lowerBound > 0 && row.upperBound > 0,
  );
  const avgWidth = confidenceRows.length
    ? confidenceRows.reduce(
        (sum, row) =>
          sum + (row.upperBound - row.lowerBound) / row.predictedSales,
        0,
      ) / confidenceRows.length
    : 0;
  const volatility =
    rows.reduce((sum, row, index) => {
      if (index === 0 || rows[index - 1].predictedSales === 0) return sum;
      return (
        sum +
        Math.abs(row.predictedSales - rows[index - 1].predictedSales) /
          rows[index - 1].predictedSales
      );
    }, 0) /
    (rows.length - 1);
  const riskLevel =
    avgWidth > 0.25 || volatility > 0.18
      ? "high"
      : avgWidth > 0.16 || volatility > 0.1
        ? "medium"
        : "low";

  return {
    confidenceBandAvg: round(avgWidth * 100, 1),
    volatilityScore: round(volatility * 100, 1),
    bufferSuggestion:
      riskLevel === "high"
        ? "建議保留較高安全庫存"
        : riskLevel === "medium"
          ? "建議觀察波動並提高備貨彈性"
          : "目前預測穩定，可維持標準備貨",
    riskLevel,
  };
}

function normalizeFeatureWeights(rows) {
  return rows
    .map((row) => ({
      name: row.feature_name ?? row.name,
      contribution: Number(row.contribution ?? row.weight ?? 0),
      direction: row.direction ?? "neutral",
    }))
    .filter((row) => row.name);
}

function normalizeEvents(rows) {
  return rows
    .map((row) => ({
      date: row.event_date ?? row.date,
      productName: row.product_name ?? row.productName ?? row.product_id,
      type: row.event_type ?? row.type,
      impact: row.impact,
      response: row.response,
    }))
    .filter((row) => row.date || row.type);
}

function normalizeHolidays(rows) {
  return rows.map((row) => ({
    date: row.date,
    name: row.name,
    expectedImpact: row.expected_impact ?? row.expectedImpact,
  }));
}

function normalizeModelHealth(latestRun) {
  if (!latestRun) {
    return {
      status: "unknown",
      label: "無模型執行資料",
      lastRunAt: null,
      optimizer: null,
      weightUpdated: false,
      note: "請在 Supabase model_runs 表新增模型執行紀錄",
    };
  }

  const rawStatus = String(latestRun.status || "").toLowerCase();
  const healthy = ["success", "completed", "healthy"].includes(rawStatus);
  const warning = ["warning", "delayed", "partial"].includes(rawStatus);
  const weightUpdated = Boolean(latestRun.weight_updated);
  const lastRunTime = latestRun.created_at
    ? new Date(latestRun.created_at).getTime()
    : 0;
  const hoursSinceLastRun = lastRunTime
    ? (Date.now() - lastRunTime) / (1000 * 60 * 60)
    : Infinity;
  const updateOverdue = hoursSinceLastRun > 24;

  let status, label, note;
  if (healthy && !updateOverdue) {
    status = "green";
    label = "運行正常";
    note = "資料來自 Supabase model_runs 表";
  } else if (
    warning ||
    (healthy && updateOverdue) ||
    (!healthy && weightUpdated)
  ) {
    status = "yellow";
    label = "警告：權重更新延遲";
    note = updateOverdue
      ? `最近一次執行距今已超過 ${Math.round(hoursSinceLastRun)} 小時，建議確認排程`
      : "模型運行狀態異常，但權重更新仍完成，建議持續觀察";
  } else {
    status = "red";
    label = "異常：需技術人員處理";
    note = `模型狀態：${rawStatus || "未知"}，建議通報技術人員檢查`;
  }

  return {
    status,
    label,
    lastRunAt: latestRun.created_at,
    optimizer: latestRun.optimizer,
    weightUpdated,
    note,
  };
}

async function getProducts() {
  return selectRows("products", "*", (query) => query.limit(1000));
}

async function getInventory() {
  return selectRows("inventory", "*", (query) => query.limit(1000));
}

async function getSales(days = 45, productId = "all") {
  const fromDate = fmt(subDays(today, days));
  return selectRows("sales", "*", (query) => {
    let next = query.gte("sale_date", fromDate).limit(1000);
    if (productId !== "all") next = next.eq("product_id", productId);
    return next;
  });
}

async function getForecasts(days = 30, productId = "all") {
  const toDate = fmt(addDays(today, days));
  return selectRows("forecasts", "*", (query) => {
    let next = query
      .gte("forecast_date", fmt(today))
      .lte("forecast_date", toDate)
      .eq("model_version", forecastModelVersion)
      .limit(1000);
    if (productId !== "all") next = next.eq("product_id", productId);
    return next;
  });
}

function handleError(res, error) {
  res.status(500).json({ error: error.message, source: "supabase" });
}

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, supabaseUrl, generatedAt: new Date().toISOString() });
});

app.get("/api/products", async (_req, res) => {
  try {
    res.json({ products: await getProducts() });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/dashboard", async (_req, res) => {
  try {
    const results = await Promise.allSettled([
      getProducts(),
      getInventory(),
      getSales(45),
      getForecasts(30),
    ]);
    const products = results[0].status === "fulfilled" ? results[0].value : [];
    const inventory = results[1].status === "fulfilled" ? results[1].value : [];
    const sales = results[2].status === "fulfilled" ? results[2].value : [];
    const forecasts = results[3].status === "fulfilled" ? results[3].value : [];
    const forecastError =
      results[3].status === "rejected"
        ? results[3].reason?.message || "預測數據載入失敗"
        : null;
    const dbError =
      results[0].status === "rejected" ||
      results[1].status === "rejected" ||
      results[2].status === "rejected"
        ? "資料庫部分連線失敗"
        : null;

    const stockWarnings =
      products.length && forecasts.length
        ? calculateStockRecommendations(products, inventory, forecasts).filter(
            (item) => item.status !== "healthy",
          )
        : [];
    const trendSnapshot = forecastError
      ? []
      : buildTrendFromData(sales, forecasts, "all", 14);
    const forecastRows = normalizeForecastRows(forecasts);
    const todayForecast = forecastRows
      .filter((row) => row.date === fmt(today))
      .reduce((sum, row) => sum + row.predictedSales, 0);
    const normalizedSales = normalizeSalesRows(sales);
    const currentMonth = fmt(today).slice(0, 7);
    const monthSales = normalizedSales
      .filter((row) => row.date.startsWith(currentMonth))
      .reduce((sum, row) => sum + row.quantity, 0);
    const target = todayForecast * 30;
    const monthlyAchievementRate =
      target > 0 ? clamp((monthSales / target) * 100, 0, 160) : 0;
    const alerts = stockWarnings.slice(0, 5).map((item) => ({
      level: item.status === "shortage" ? "critical" : "warning",
      title: item.status === "shortage" ? "庫存不足風險" : "庫存過剩風險",
      message: `${item.productName} 建議訂購 ${item.recommendedOrderQty}，可用庫存 ${item.available}`,
    }));

    res.json({
      metrics: {
        todayForecast: round(todayForecast),
        monthlyAchievementRate: round(monthlyAchievementRate, 1),
        activeAlerts: alerts.length,
      },
      stockWarnings,
      trendSnapshot,
      alerts,
      forecastError,
      dbError,
      generatedAt: new Date().toISOString(),
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/forecast", async (req, res) => {
  try {
    const productId = String(req.query.productId || "all");
    const days = clamp(Number(req.query.days || 14), 14, 30);
    const [sales, forecasts, featureWeights, nonlinearEvents] =
      await Promise.all([
        getSales(60, productId),
        getForecasts(days, productId),
        selectRows("feature_weights", "*", (query) => {
          let next = query.limit(100);
          if (productId !== "all") next = next.eq("product_id", productId);
          return next;
        }),
        selectRows("nonlinear_events", "*", (query) => {
          let next = query.order("event_date", { ascending: false }).limit(20);
          if (productId !== "all") next = next.eq("product_id", productId);
          return next;
        }),
      ]);

    res.json({
      productId,
      days,
      series: buildTrendFromData(sales, forecasts, productId, days),
      featureWeights: normalizeFeatureWeights(featureWeights),
      nonlinearEvents: normalizeEvents(nonlinearEvents),
      modelNote: "所有資料皆來自 Supabase；若沒有預測資料，圖表會顯示空狀態。",
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/stock-control", async (_req, res) => {
  try {
    const [products, inventory, forecasts] = await Promise.all([
      getProducts(),
      getInventory(),
      getForecasts(30),
    ]);
    res.json({
      recommendations: calculateStockRecommendations(
        products,
        inventory,
        forecasts,
      ),
      stability: calculateStability(forecasts),
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/stock-control/simulate", async (req, res) => {
  try {
    const {
      productId = "all",
      promotionActive = false,
      priceChangePct = 0,
    } = req.body || {};
    const pricePct = Number(priceChangePct);
    if (!Number.isFinite(pricePct) || pricePct < -100 || pricePct > 500) {
      return res.status(400).json({
        error: "參數設定錯誤：價格調整百分比須介於 -100% 至 500% 之間",
      });
    }
    const forecasts = normalizeForecastRows(
      await getForecasts(14, String(productId)),
    );
    const promotionLift = promotionActive ? 1.18 : 1;
    const priceElasticity = 1 - Number(priceChangePct) * 0.012;
    const simulated = forecasts.map((row) => ({
      date: row.date,
      basePredictedSales: round(row.predictedSales),
      predictedSales: round(
        row.predictedSales * promotionLift * priceElasticity,
      ),
      lowerBound: row.lowerBound
        ? round(row.lowerBound * promotionLift * priceElasticity)
        : null,
      upperBound: row.upperBound
        ? round(row.upperBound * promotionLift * priceElasticity)
        : null,
    }));

    res.json({
      productId,
      assumptions: { promotionActive, priceChangePct: Number(priceChangePct) },
      simulated,
      summary: {
        baseDemand: round(
          forecasts.reduce((sum, row) => sum + row.predictedSales, 0),
        ),
        simulatedDemand: round(
          simulated.reduce((sum, row) => sum + row.predictedSales, 0),
        ),
        recommendation: simulated.length
          ? "情境結果依 Supabase forecasts 表重新換算"
          : "Supabase 尚無可模擬的 forecasts 資料",
      },
    });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/stock-control/purchase-orders", async (req, res) => {
  try {
    const { items = [] } = req.body || {};
    const cleanItems = items.filter((item) => Number(item.quantity) > 0);
    const { data, error } = await supabase
      .from("purchase_orders")
      .insert({
        status: "draft",
        items: cleanItems,
        created_at: new Date().toISOString(),
      })
      .select()
      .single();

    if (error) throw new Error(`purchase_orders: ${error.message}`);
    res.status(201).json({ order: data, persisted: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/feature-monitor", async (_req, res) => {
  try {
    const results = await Promise.allSettled([
      selectRows("weather_features", "*", (query) =>
        query.order("observed_at", { ascending: false }).limit(10),
      ),
      selectRows("promotions", "*", (query) =>
        query.order("start_date", { ascending: false }).limit(10),
      ),
      selectRows("holidays", "*", (query) =>
        query.order("date", { ascending: true }).limit(20),
      ),
      selectRows("model_runs", "*", (query) =>
        query.order("created_at", { ascending: false }).limit(5),
      ),
    ]);
    const weather =
      results[0].status === "fulfilled" ? results[0].value : [];
    const promotions =
      results[1].status === "fulfilled" ? results[1].value : [];
    const holidays =
      results[2].status === "fulfilled" ? results[2].value : [];
    const modelRuns =
      results[3].status === "fulfilled" ? results[3].value : [];

    res.json({
      externalFactors: {
        weather,
        holidays: normalizeHolidays(holidays),
        promotions,
        errors: {
          weather:
            results[0].status === "rejected"
              ? "同步失敗：" + (results[0].reason?.message || "連線異常")
              : null,
          promotions:
            results[1].status === "rejected"
              ? "同步失敗：" + (results[1].reason?.message || "連線異常")
              : null,
          holidays:
            results[2].status === "rejected"
              ? "同步失敗：" + (results[2].reason?.message || "連線異常")
              : null,
        },
      },
      modelHealth: normalizeModelHealth(modelRuns[0]),
    });
  } catch (error) {
    handleError(res, error);
  }
});

export default app;

if (
  process.env.NODE_ENV !== "production" ||
  process.env.RUN_EXPRESS_SERVER === "true"
) {
  app.listen(port, () => {
    console.log(`Server running on port ${port}`);
  });
}
