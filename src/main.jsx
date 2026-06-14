import React, { useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import {
  AlertTriangle,
  BarChart3,
  Boxes,
  CheckCircle2,
  CloudSun,
  Gauge,
  LineChart as LineChartIcon,
  PackageCheck,
  RefreshCcw,
  ShoppingCart,
  Sparkles,
  TrendingUp,
} from "lucide-react";
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Legend,
  Line,
  LineChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import "./styles.css";

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || "/api";

const interfaces = [
  {
    id: "dashboard",
    label: "決策管理總覽儀表板",
    shortLabel: "決策總覽",
    icon: Gauge,
    description:
      "讓管理者於登入首頁後，能在 10 秒內掌握全局，檢視核心指標、預測進貨預警及銷量趨勢，並即時發現潛在異常。",
  },
  {
    id: "forecast",
    label: "銷量預測分析中心",
    shortLabel: "銷量預測",
    icon: LineChartIcon,
    description:
      "檢視長短期銷量趨勢、特徵權重及非線性銷售波動，以視覺化圖表深入理解 AI 預測結果與背後推導原因。",
  },
  {
    id: "stock",
    label: "科學化進貨與庫存決策",
    shortLabel: "進貨決策",
    icon: Boxes,
    description:
      "將預測數據轉化為執行動作，包含檢視智慧訂單、執行模擬情境分析以輔助定價，及查看預測穩定性以制定備貨策略。",
  },
  {
    id: "monitor",
    label: "資料特徵監控介面",
    shortLabel: "資料監控",
    icon: CloudSun,
    description:
      "檢視並確認系統輸入之外部數據是否正常同步，並監控後台模型運作與權重更新狀態。",
  },
];

const statusLabel = {
  shortage: "庫存不足",
  overstock: "庫存過剩",
  healthy: "正常",
};

const statusClass = {
  shortage: "danger",
  overstock: "warning",
  healthy: "success",
};

function formatNumber(value) {
  return new Intl.NumberFormat("zh-TW").format(Math.round(Number(value || 0)));
}

function round(value, digits = 2) {
  const factor = 10 ** digits;
  return Math.round(Number(value || 0) * factor) / factor;
}

function formatDecimal(value, digits = 2) {
  return new Intl.NumberFormat("zh-TW", {
    maximumFractionDigits: digits,
    minimumFractionDigits: digits,
  }).format(Number(value || 0));
}

async function api(path, options = {}) {
  const response = await fetch(`${API_BASE_URL}${path}`, {
    headers: { "Content-Type": "application/json" },
    ...options,
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok)
    throw new Error(payload.error || `API request failed: ${response.status}`);
  return payload;
}

function useLocalLstmData() {
  return useAsyncData(async () => {
    const response = await fetch("/data/local-lstm-dashboard.json");
    if (!response.ok) {
      throw new Error(`本機 LSTM 資料讀取失敗：${response.status}`);
    }
    return response.json();
  }, []);
}

function useAsyncData(loader, deps = []) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    data: null,
  });

  useEffect(() => {
    let mounted = true;
    setState((previous) => ({ ...previous, loading: true, error: null }));
    loader()
      .then(
        (data) => mounted && setState({ loading: false, error: null, data }),
      )
      .catch(
        (error) =>
          mounted &&
          setState({ loading: false, error: error.message, data: null }),
      );
    return () => {
      mounted = false;
    };
  }, deps);

  return state;
}

function buildLocalForecastSeries(rows = []) {
  const map = new Map();
  rows.forEach((row) => {
    const current = map.get(row.forecast_date) || {
      date: row.forecast_date,
      predictedSales: 0,
      riskCount: 0,
    };
    current.predictedSales += Number(row.predicted_units_sold || 0);
    current.riskCount += row.stockout_risk ? 1 : 0;
    map.set(row.forecast_date, current);
  });
  return [...map.values()].sort((a, b) => a.date.localeCompare(b.date));
}

function toLocalForecastChartRows(local, days = 14) {
  if (!local) return [];
  const rmse = Number(local.metrics.overall_rmse_units || 0);
  return buildLocalForecastSeries(local.latestForecast)
    .slice(0, days)
    .map((row) => ({
      date: row.date,
      actualSales: null,
      predictedSales: round(row.predictedSales),
      lowerBound: round(Math.max(0, row.predictedSales - rmse)),
      upperBound: round(row.predictedSales + rmse),
      riskCount: row.riskCount,
    }));
}

function localStatusFromRecommendation(row) {
  return row.stockout_risk_next_7_days ? "shortage" : "healthy";
}

function localRecommendations(local) {
  if (!local) return [];
  return [...local.replenishment]
    .sort((a, b) => b.recommended_order_qty - a.recommended_order_qty)
    .map((item) => ({
      productId: `${item["Store ID"]}-${item["Product ID"]}`,
      productName: item["Product ID"],
      category: item["Store ID"],
      available: Number(item.latest_inventory_level || 0),
      sevenDayDemand: Number(item.predicted_7_day_demand || 0),
      safetyStock: Number(item.safety_stock_2_days || 0),
      recommendedOrderQty: Number(item.recommended_order_qty || 0),
      status: localStatusFromRecommendation(item),
      confidence: 0.35,
      firstStockoutDate: item.first_stockout_date,
    }));
}

function buildLocalDashboardData(local) {
  if (!local) return null;
  const recommendations = localRecommendations(local);
  const trendSnapshot = toLocalForecastChartRows(local, 7);
  const todayForecast = trendSnapshot[0]?.predictedSales || 0;
  const alerts = [
    {
      level: "warning",
      title: "資料訊號不足",
      message: `LSTM MAE ${formatDecimal(local.metrics.overall_mae_units)} 高於 Demand Forecast baseline ${formatDecimal(local.metrics.baseline_demand_forecast_mae_units)}，代表目前 CSV 資料主要訊號集中於 Demand Forecast。`,
    },
    {
      level: "info",
      title: "欄位政策已調整",
      message: `已排除 ${local.metrics.feature_policy.excluded_from_lstm_inputs.join("、")}，較符合專題預測模型設定。`,
    },
  ];

  return {
    metrics: {
      todayForecast,
      monthlyAchievementRate: 0,
      activeAlerts: recommendations.filter((item) => item.status !== "healthy").length,
      lstmMae: local.metrics.overall_mae_units,
      baselineMae: local.metrics.baseline_demand_forecast_mae_units,
    },
    trendSnapshot,
    stockWarnings: recommendations.filter((item) => item.status !== "healthy").slice(0, 12),
    alerts,
    forecastError: null,
    source: "local-lstm",
  };
}

function buildLocalForecastCenterData(local) {
  if (!local) return null;
  const excluded = local.metrics.feature_policy.excluded_from_lstm_inputs;
  return {
    series: toLocalForecastChartRows(local, 7),
    featureWeights: [
      {
        name: "Demand Forecast baseline",
        contribution: Math.round(local.metrics.baseline_demand_forecast_mae_units),
        direction: "baseline",
      },
      {
        name: "LSTM MAE",
        contribution: Math.round(local.metrics.overall_mae_units),
        direction: "model_error",
      },
      {
        name: "可用特徵數",
        contribution: local.metrics.input_shape[1],
        direction: "feature_count",
      },
      {
        name: "排除欄位數",
        contribution: excluded.length,
        direction: "excluded",
      },
    ],
    nonlinearEvents: [
      {
        date: local.generatedAt.slice(0, 10),
        productName: "資料欄位調整",
        type: "Demand Forecast 移為 baseline",
        impact: `LSTM MAE ${formatDecimal(local.metrics.overall_mae_units)}`,
        response: "需補強 POS 交易、天氣、節慶、顧客行為等真實特徵",
      },
      {
        date: local.generatedAt.slice(0, 10),
        productName: "模型輸入政策",
        type: "排除不適用欄位",
        impact: excluded.join("、"),
        response: "避免既有預測欄位造成模型目的不清",
      },
    ],
    modelNote:
      "此頁已依原銷量預測分析中心介面顯示本機 LSTM 結果；特徵權重區目前顯示欄位政策與 baseline 比較。",
  };
}

function buildLocalFeatureMonitorData(local) {
  if (!local) return null;
  const futureFeatures = local.metrics.feature_policy.future_known_features || [];
  return {
    externalFactors: {
      weather: futureFeatures
        .filter((name) => name.startsWith("Weather Condition_"))
        .map((name) => ({
          region: name.replace("Weather Condition_", ""),
          temperature: "-",
          rainfall_probability: 0,
        })),
      holidays: [
        {
          date: local.generatedAt.slice(0, 10),
          name: "Holiday/Promotion 欄位已納入",
          expectedImpact: "可作為未來促銷/節慶條件",
        },
      ],
      promotions: [
        {
          name: "Discount / Price 情境欄位",
          status: "可用",
          start_date: local.rawSummary.dateStart,
          end_date: local.rawSummary.dateEnd,
        },
      ],
      errors: {},
    },
    modelHealth: {
      status: local.metrics.device === "cuda" ? "green" : "yellow",
      label: local.metrics.device === "cuda" ? "GPU 模型可用" : "CPU 模型可用",
      lastRunAt: local.generatedAt,
      optimizer: "Adam",
      weightUpdated: true,
      note: `${local.metrics.framework} ${local.metrics.torch_version}，輸入形狀 ${local.metrics.input_shape.join(" × ")}`,
    },
  };
}

function Card({ title, icon: Icon, children, action }) {
  return (
    <section className="card">
      <div className="card-header">
        <div>
          <p className="eyebrow">Decision Intelligence</p>
          <h2>{title}</h2>
        </div>
        <div className="card-actions">
          {action}
          {Icon && <Icon size={22} />}
        </div>
      </div>
      {children}
    </section>
  );
}

function EmptyState({ message = "目前沒有資料" }) {
  return <div className="empty-state">{message}</div>;
}

function LoadingPanel() {
  return (
    <div className="empty-state loading">
      <RefreshCcw size={18} /> 資料載入中...
    </div>
  );
}

function ErrorPanel({ message }) {
  return <div className="empty-state error">讀取失敗：{message}</div>;
}

function MetricCard({
  title,
  value,
  suffix,
  description,
  icon: Icon,
  tone = "blue",
}) {
  return (
    <div className={`metric-card ${tone}`}>
      <div className="metric-icon">{Icon && <Icon size={22} />}</div>
      <p>{title}</p>
      <strong>
        {value}
        {suffix}
      </strong>
      <span>{description}</span>
    </div>
  );
}

function ForecastChart({ data, height = 330 }) {
  if (!data?.length)
    return <EmptyState message="Supabase 目前沒有可顯示的銷售或預測資料" />;

  return (
    <ResponsiveContainer width="100%" height={height}>
      <LineChart
        data={data}
        margin={{ top: 16, right: 16, left: 0, bottom: 8 }}
      >
        <CartesianGrid strokeDasharray="3 3" stroke="#dbe4f0" />
        <XAxis dataKey="date" tick={{ fontSize: 11 }} minTickGap={18} />
        <YAxis tick={{ fontSize: 12 }} />
        <Tooltip />
        <Legend />
        <Line
          type="monotone"
          dataKey="actualSales"
          name="歷史銷量"
          stroke="#2563eb"
          strokeWidth={3}
          dot={false}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="predictedSales"
          name="AI 預測值"
          stroke="#f97316"
          strokeWidth={3}
          dot={false}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="upperBound"
          name="置信區間上緣"
          stroke="#fb923c"
          strokeDasharray="5 5"
          dot={false}
          connectNulls={false}
        />
        <Line
          type="monotone"
          dataKey="lowerBound"
          name="置信區間下緣"
          stroke="#fdba74"
          strokeDasharray="5 5"
          dot={false}
          connectNulls={false}
        />
      </LineChart>
    </ResponsiveContainer>
  );
}

function DashboardView() {
  const { loading, error, data } = useAsyncData(() => api("/dashboard"), []);
  const localState = useLocalLstmData();
  const localDashboard = useMemo(
    () => buildLocalDashboardData(localState.data),
    [localState.data],
  );
  const viewData = data?.metrics ? data : localDashboard;
  if ((loading || localState.loading) && !viewData) return <LoadingPanel />;
  if (error && !viewData) return <ErrorPanel message={error} />;
  if (!viewData?.metrics)
    return (
      <ErrorPanel message="/api/dashboard 回傳格式不正確，請確認 Vercel API 路由是否正常" />
    );

  return (
    <div className="view-grid">
      {error && viewData.source === "local-lstm" && (
        <div className="empty-state error">
          Supabase API 暫時無法讀取：{error}。目前先顯示本機 LSTM 分析結果。
        </div>
      )}

      <Card title="核心指標看板" icon={BarChart3}>
        <div className="metrics-grid">
          <MetricCard
            title={viewData.source === "local-lstm" ? "最近 7 天首日預測" : "今日預計銷量"}
            value={formatNumber(viewData.metrics.todayForecast)}
            suffix=" 件"
            description="由 LSTM 預測模型彙整"
            icon={TrendingUp}
            tone="blue"
          />
          <MetricCard
            title={viewData.source === "local-lstm" ? "LSTM MAE" : "本月銷量達成率"}
            value={
              viewData.source === "local-lstm"
                ? formatDecimal(viewData.metrics.lstmMae)
                : viewData.metrics.monthlyAchievementRate
            }
            suffix={viewData.source === "local-lstm" ? " 件" : "%"}
            description={
              viewData.source === "local-lstm"
                ? "不使用 Demand Forecast 作為輸入"
                : "以本月累積銷量 / 預估月目標計算"
            }
            icon={BarChart3}
            tone="green"
          />
          <MetricCard
            title={viewData.source === "local-lstm" ? "Baseline MAE" : "系統偵測異動警示"}
            value={
              viewData.source === "local-lstm"
                ? formatDecimal(viewData.metrics.baselineMae)
                : viewData.metrics.activeAlerts
            }
            suffix={viewData.source === "local-lstm" ? " 件" : " 則"}
            description={
              viewData.source === "local-lstm"
                ? "Demand Forecast 僅作比較基準"
                : "庫存、模型與銷售波動警示"
            }
            icon={AlertTriangle}
            tone="orange"
          />
        </div>
      </Card>

      <Card title="14 天銷量預測曲線（趨勢快照）" icon={LineChartIcon}>
        {viewData.forecastError ? (
          <div className="empty-state error">
            預測數據載入失敗：{viewData.forecastError}，請稍後再試
          </div>
        ) : (
          <ForecastChart data={viewData.trendSnapshot} height={300} />
        )}
      </Card>

      <Card title="自動化進貨預警" icon={ShoppingCart}>
        {viewData.forecastError ? (
          <div className="empty-state error">
            預測數據載入失敗：無法計算進貨預警，請稍後再試
          </div>
        ) : (
          <>
            <div className="table-wrap">
              <table>
                <thead>
                  <tr>
                    <th>產品</th>
                    <th>狀態</th>
                    <th>可用庫存</th>
                    <th>7 日需求</th>
                    <th>建議進貨</th>
                  </tr>
                </thead>
                <tbody>
                  {viewData.stockWarnings.map((item) => (
                    <tr key={item.productId}>
                      <td>
                        {item.productName}
                        <span>{item.category}</span>
                      </td>
                      <td>
                        <span className={`pill ${statusClass[item.status]}`}>
                          {statusLabel[item.status]}
                        </span>
                      </td>
                      <td>{formatNumber(item.available)}</td>
                      <td>{formatNumber(item.sevenDayDemand)}</td>
                      <td>
                        <strong>{formatNumber(item.recommendedOrderQty)}</strong>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {!viewData.stockWarnings.length && (
              <EmptyState message="目前指標正常，無須進貨" />
            )}
          </>
        )}
      </Card>

      <Card title="異動警示中心" icon={AlertTriangle}>
        <div className="alert-list">
          {viewData.alerts.map((alert, index) => (
            <div
              className={`alert-item ${alert.level}`}
              key={`${alert.title}-${index}`}
            >
              <strong>{alert.title}</strong>
              <p>{alert.message}</p>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}

function ForecastCenter() {
  const productsState = useAsyncData(() => api("/products"), []);
  const localState = useLocalLstmData();
  const [productId, setProductId] = useState("all");
  const [days, setDays] = useState(14);
  const { loading, error, data } = useAsyncData(
    () => api(`/forecast?productId=${productId}&days=${days}`),
    [productId, days],
  );

  const products = productsState.data?.products || [];
  const localForecast = useMemo(
    () => buildLocalForecastCenterData(localState.data),
    [localState.data],
  );
  const viewData = data?.series ? data : localForecast;
  const barColors = [
    "#2563eb",
    "#0ea5e9",
    "#22c55e",
    "#f97316",
    "#ef4444",
    "#8b5cf6",
  ];

  return (
    <div className="view-grid">
      <Card
        title="長短期趨勢圖"
        icon={LineChartIcon}
        action={
          <div className="controls-inline">
            <select
              value={productId}
              onChange={(event) => setProductId(event.target.value)}
            >
              <option value="all">全站產品</option>
              {products.map((product) => (
                <option value={product.id} key={product.id}>
                  {product.name}
                </option>
              ))}
            </select>
            <select
              value={days}
              onChange={(event) => setDays(Number(event.target.value))}
            >
              <option value={14}>14 天</option>
              <option value={21}>21 天</option>
              <option value={30}>30 天</option>
            </select>
          </div>
        }
      >
        {loading && !viewData && <LoadingPanel />}
        {error && viewData && (
          <div className="empty-state error">
            Supabase API 暫時無法讀取：{error}。目前顯示本機 LSTM 預測結果。
          </div>
        )}
        {error && !viewData && <ErrorPanel message={error} />}
        {viewData && <ForecastChart data={viewData.series} height={360} />}
        {viewData?.modelNote && <p className="hint">{viewData.modelNote}</p>}
      </Card>

      <div className="two-column">
        <Card title="多維度特徵權重視圖" icon={Sparkles}>
          {viewData?.featureWeights?.length ? (
            <ResponsiveContainer width="100%" height={300}>
              <BarChart
                data={viewData.featureWeights}
                layout="vertical"
                margin={{ top: 12, right: 20, left: 20, bottom: 12 }}
              >
                <CartesianGrid strokeDasharray="3 3" />
                <XAxis type="number" unit="%" />
                <YAxis type="category" dataKey="name" width={92} />
                <Tooltip />
                <Bar dataKey="contribution" name="貢獻度">
                  {viewData.featureWeights.map((entry, index) => (
                    <Cell
                      key={entry.name}
                      fill={barColors[index % barColors.length]}
                    />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          ) : (
            <EmptyState message="Supabase feature_weights 表目前沒有資料" />
          )}
        </Card>

        <Card title="非線性變動追蹤" icon={AlertTriangle}>
          <div className="timeline">
            {!viewData?.nonlinearEvents?.length && (
              <EmptyState message="Supabase nonlinear_events 表目前沒有資料" />
            )}
            {viewData?.nonlinearEvents?.map((event) => (
              <div
                className="timeline-item"
                key={`${event.date}-${event.type}`}
              >
                <span>{event.date}</span>
                <strong>
                  {event.productName}｜{event.type}
                </strong>
                <p>
                  {event.impact}，{event.response}
                </p>
              </div>
            ))}
          </div>
        </Card>
      </div>
    </div>
  );
}

function StockControl() {
  const { loading, error, data } = useAsyncData(
    () => api("/stock-control"),
    [],
  );
  const localState = useLocalLstmData();
  const productsState = useAsyncData(() => api("/products"), []);
  const [simForm, setSimForm] = useState({
    productId: "all",
    promotionActive: false,
    priceChangePct: 0,
  });
  const [simulation, setSimulation] = useState(null);
  const [orderResult, setOrderResult] = useState(null);
  const localRecommendationsData = useMemo(
    () => localRecommendations(localState.data),
    [localState.data],
  );
  const localStability = useMemo(() => {
    if (!localState.data) return null;
    const ratio =
      localState.data.metrics.baseline_demand_forecast_mae_units > 0
        ? localState.data.metrics.overall_mae_units /
          localState.data.metrics.baseline_demand_forecast_mae_units
        : 0;
    return {
      confidenceBandAvg: formatDecimal(localState.data.metrics.overall_rmse_units),
      volatilityScore: formatDecimal(ratio, 1),
      bufferSuggestion:
        "目前 CSV 在排除 Demand Forecast 後訊號不足，建議正式系統補強 POS 與顧客行為特徵",
      riskLevel: "high",
    };
  }, [localState.data]);

  const orderItems = useMemo(
    () =>
      (data?.recommendations || localRecommendationsData)
        ?.filter((item) => item.recommendedOrderQty > 0)
        .map((item) => ({
          productId: item.productId,
          productName: item.productName,
          quantity: item.recommendedOrderQty,
        })) || [],
    [data, localRecommendationsData],
  );

  async function runSimulation() {
    try {
      const result = await api("/stock-control/simulate", {
        method: "POST",
        body: JSON.stringify(simForm),
      });
      setSimulation(result);
    } catch (error) {
      setSimulation({ error: error.message });
    }
  }

  async function createPurchaseOrder() {
    try {
      const result = await api("/stock-control/purchase-orders", {
        method: "POST",
        body: JSON.stringify({ items: orderItems }),
      });
      setOrderResult(result);
    } catch (error) {
      setOrderResult({ error: error.message });
    }
  }

  const recommendations = data?.recommendations || localRecommendationsData;
  const stability = data?.stability || localStability;
  if (loading && !recommendations.length) return <LoadingPanel />;
  if (error && !recommendations.length) return <ErrorPanel message={error} />;

  return (
    <div className="view-grid">
      {error && recommendations.length > 0 && (
        <div className="empty-state error">
          Supabase API 暫時無法讀取：{error}。目前先顯示本機 LSTM 補貨建議。
        </div>
      )}

      <Card
        title="智慧訂單建議"
        icon={PackageCheck}
        action={
          <button
            className="primary"
            onClick={createPurchaseOrder}
            disabled={!orderItems.length}
          >
            一鍵產生採購單
          </button>
        }
      >
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>產品</th>
                <th>庫存狀態</th>
                <th>可用庫存</th>
                <th>安全庫存</th>
                <th>建議訂購量</th>
                <th>信心分數</th>
              </tr>
            </thead>
            <tbody>
              {recommendations.map((item) => (
                <tr key={item.productId}>
                  <td>
                    {item.productName}
                    <span>{item.category}</span>
                  </td>
                  <td>
                    <span className={`pill ${statusClass[item.status]}`}>
                      {statusLabel[item.status]}
                    </span>
                  </td>
                  <td>{formatNumber(item.available)}</td>
                  <td>{formatNumber(item.safetyStock)}</td>
                  <td>
                    {item.confidence < 0.5 ? (
                      <span className="pill warning">需人工評估</span>
                    ) : (
                      <strong>{formatNumber(item.recommendedOrderQty)}</strong>
                    )}
                  </td>
                  <td>
                    {item.confidence < 0.5 ? (
                      <span className="pill danger">
                        {Math.round(item.confidence * 100)}%
                      </span>
                    ) : (
                      <>{Math.round(item.confidence * 100)}%</>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {orderResult?.order && (
          <p className="success-message">
            採購單已建立：{orderResult.order.id || orderResult.order.created_at}
            （已寫入 Supabase）
          </p>
        )}
        {orderResult?.error && (
          <p className="error-message">採購單建立失敗：{orderResult.error}</p>
        )}
      </Card>

      <div className="two-column">
        <Card title="模擬情境分析" icon={Sparkles}>
          <div className="form-grid">
            <label>
              產品
              <select
                value={simForm.productId}
                onChange={(event) =>
                  setSimForm({ ...simForm, productId: event.target.value })
                }
              >
                <option value="all">全站產品</option>
                {productsState.data?.products?.map((product) => (
                  <option value={product.id} key={product.id}>
                    {product.name}
                  </option>
                ))}
              </select>
            </label>
            <label>
              價格調整（%）
              <input
                type="number"
                value={simForm.priceChangePct}
                onChange={(event) =>
                  setSimForm({
                    ...simForm,
                    priceChangePct: Number(event.target.value),
                  })
                }
              />
            </label>
            <label className="check-row">
              <input
                type="checkbox"
                checked={simForm.promotionActive}
                onChange={(event) =>
                  setSimForm({
                    ...simForm,
                    promotionActive: event.target.checked,
                  })
                }
              />
              啟用促銷狀態
            </label>
            <button className="primary" onClick={runSimulation}>
              重新運算情境
            </button>
          </div>
          {simulation?.error && (
            <div className="empty-state error">
              {simulation.error}
            </div>
          )}
          {simulation && !simulation.error && (
            <>
              <div className="simulation-summary">
                <span>
                  原始需求：{formatNumber(simulation.summary.baseDemand)}
                </span>
                <span>
                  模擬需求：{formatNumber(simulation.summary.simulatedDemand)}
                </span>
              </div>
              <ResponsiveContainer width="100%" height={240}>
                <AreaChart data={simulation.simulated}>
                  <CartesianGrid strokeDasharray="3 3" />
                  <XAxis dataKey="date" tick={{ fontSize: 11 }} />
                  <YAxis />
                  <Tooltip />
                  <Area
                    type="monotone"
                    dataKey="basePredictedSales"
                    name="原始預測"
                    stroke="#94a3b8"
                    fill="#cbd5e1"
                  />
                  <Area
                    type="monotone"
                    dataKey="predictedSales"
                    name="情境預測"
                    stroke="#f97316"
                    fill="#fed7aa"
                  />
                </AreaChart>
              </ResponsiveContainer>
              <p className="hint">{simulation.summary.recommendation}</p>
            </>
          )}
          {!data && (
            <p className="hint">
              目前顯示本機 LSTM 補貨建議；情境模擬需連接 POS/促銷資料庫後才可即時重算。
            </p>
          )}
        </Card>

        <Card title="穩定性報告" icon={CheckCircle2}>
          <div className={`stability ${stability?.riskLevel || "medium"}`}>
            <strong>{stability?.bufferSuggestion}</strong>
            <p>平均置信區間寬度：{stability?.confidenceBandAvg}%</p>
            <p>預測波動分數：{stability?.volatilityScore}%</p>
          </div>
        </Card>
      </div>
    </div>
  );
}

function FeatureMonitor() {
  const { loading, error, data } = useAsyncData(
    () => api("/feature-monitor"),
    [],
  );
  const localState = useLocalLstmData();
  const localMonitor = useMemo(
    () => buildLocalFeatureMonitorData(localState.data),
    [localState.data],
  );
  const viewData = data?.externalFactors ? data : localMonitor;
  if ((loading || localState.loading) && !viewData) return <LoadingPanel />;
  if (error && !viewData) return <ErrorPanel message={error} />;

  return (
    <div className="view-grid">
      {error && viewData && (
        <div className="empty-state error">
          Supabase API 暫時無法讀取：{error}。目前顯示本機 LSTM 欄位監控結果。
        </div>
      )}
      <Card title="外部因子監控站" icon={CloudSun}>
        <h3 className="sub-heading">氣候指數</h3>
        {viewData.externalFactors.errors?.weather ? (
          <div className="empty-state error">
            {viewData.externalFactors.errors.weather}
          </div>
        ) : viewData.externalFactors.weather.length ? (
          <div className="factor-grid">
            {viewData.externalFactors.weather.map((item, index) => (
              <div
                className="factor-card"
                key={`${item.region || item.city}-${index}`}
              >
                <strong>{item.region || item.city || "未知區域"}</strong>
                <p>{item.temperature ?? item.temp}°C</p>
                <span>
                  降雨機率{" "}
                  {item.rainfall_probability ?? item.rainProbability ?? 0}%
                </span>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState message="目前無氣候資料" />
        )}

        <h3 className="sub-heading">節慶行事曆</h3>
        {viewData.externalFactors.errors?.holidays ? (
          <div className="empty-state error">
            {viewData.externalFactors.errors.holidays}
          </div>
        ) : viewData.externalFactors.holidays.length ? (
          <div className="timeline compact">
            {viewData.externalFactors.holidays.map((holiday) => (
              <div className="timeline-item" key={holiday.date}>
                <span>{holiday.date}</span>
                <strong>{holiday.name}</strong>
                <p>預估影響 {holiday.expectedImpact}</p>
              </div>
            ))}
          </div>
        ) : (
          <EmptyState message="目前無節慶資料" />
        )}

        <h3 className="sub-heading">促銷活動排程</h3>
        {viewData.externalFactors.errors?.promotions ? (
          <div className="empty-state error">
            {viewData.externalFactors.errors.promotions}
          </div>
        ) : viewData.externalFactors.promotions.length ? (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>活動</th>
                  <th>狀態</th>
                  <th>期間</th>
                </tr>
              </thead>
              <tbody>
                {viewData.externalFactors.promotions.map((promo, index) => (
                  <tr key={`${promo.name}-${index}`}>
                    <td>{promo.name}</td>
                    <td>
                      <span className="pill blue">{promo.status}</span>
                    </td>
                    <td>
                      {promo.start_date} ~ {promo.end_date}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="目前無促銷活動" />
        )}
      </Card>

      <Card title="模型運行健康度" icon={Gauge}>
        <div className={`health-light ${viewData.modelHealth.status}`}>
          <span />
          <div>
            <strong>{viewData.modelHealth.label}</strong>
            <p>
              最後執行：
              {viewData.modelHealth.lastRunAt
                ? new Date(viewData.modelHealth.lastRunAt).toLocaleString("zh-TW")
                : "Supabase 尚無紀錄"}
            </p>
            <p>
              優化器：{viewData.modelHealth.optimizer || "Supabase 尚無紀錄"}
              ｜權重更新：
              {viewData.modelHealth.weightUpdated ? "已完成" : "未完成"}
            </p>
            <small>{viewData.modelHealth.note}</small>
          </div>
        </div>
      </Card>
    </div>
  );
}

function App() {
  const [active, setActive] = useState("dashboard");
  const ActiveIcon =
    interfaces.find((item) => item.id === active)?.icon || Gauge;

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">
            <Sparkles size={24} />
          </div>
          <div>
            <strong>AI 決策管理</strong>
            <span>Supabase Analytics</span>
          </div>
        </div>
        <nav>
          {interfaces.map(({ id, shortLabel, icon: Icon }) => (
            <button
              key={id}
              className={active === id ? "active" : ""}
              onClick={() => setActive(id)}
            >
              <Icon size={18} /> {shortLabel}
            </button>
          ))}
        </nav>
      </aside>

      <main>
        <header className="hero">
          <div>
            <p className="eyebrow">Management Console</p>
            <h1>
              <ActiveIcon size={30} />{" "}
              {interfaces.find((item) => item.id === active)?.label}
            </h1>
            <span>
              {interfaces.find((item) => item.id === active)?.description}
            </span>
          </div>
        </header>

        {active === "dashboard" && <DashboardView />}
        {active === "forecast" && <ForecastCenter />}
        {active === "stock" && <StockControl />}
        {active === "monitor" && <FeatureMonitor />}
      </main>
    </div>
  );
}

createRoot(document.getElementById("root")).render(<App />);
