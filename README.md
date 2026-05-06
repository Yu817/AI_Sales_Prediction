# 零售銷量預測與決策管理系統 (AI Sales Prediction & Decision Dashboard)

![License](https://img.shields.io/badge/license-MIT-blue.svg)
![React](https://img.shields.io/badge/frontend-React-61dafb.svg)
![Node](https://img.shields.io/badge/backend-Node.js-339933.svg)
![Supabase](https://img.shields.io/badge/database-Supabase-3ecf8e.svg)

本專案是一個整合「大數據分析」與「科學化決策」的智慧零售管理平台。透過串接 Supabase 資料庫，將歷史銷售數據轉化為具體的銷售預測與採購建議，協助管理者在 10 秒內掌握全局，並進行精準的庫存配置。

## 核心功能

### 📊 決策管理總覽 (Executive Dashboard)
- **核心指標看板**：即時檢視今日預計銷量、本月銷量達成率與系統異動警示。
- **智慧進貨預警**：自動計算庫存不足商品，提供 7 日需求預估與建議訂購量。
- **銷售趨勢快照**：14 天銷售曲線圖，整合歷史實績與未來預測趨勢。

### 📈 銷量預測中心 (Forecasting Center)
- **長短期趨勢分析**：視覺化呈現歷史銷售、模型預測值及置信區間（Confidence Interval）。
- **多維度特徵權重**：拆解氣候、節慶、促銷及價格等因素對銷售的貢獻度。
- **非線性變動追蹤**：監控突發事件（如寒流、促銷首日）對銷售波動的影響。

### 📦 科學化庫存決策 (Inventory Control)
- **智慧訂單建議**：依據模型信心分數（Confidence Score）提供採購建議。
- **模擬情境分析**：可動態調整價格、促銷狀態，即時預測不同策略下的銷售變化。
- **系統穩定性報告**：評估預測穩定性，提供動態安全庫存建議。

### ☁️ 資料特徵監控 (Feature Monitoring)
- **外部環境因子**：即時同步氣候數據、節慶行事曆與促銷排程。
- **模型運行狀態**：監控自動化模型的訓練健康度、優化器狀態及權重更新紀錄。

## 技術架構

- **前端框架**: React + Vite
- **後端環境**: Node.js + Express
- **資料儲存**: Supabase (PostgreSQL)
- **圖表庫**: Recharts
- **UI 組件**: Tailwind CSS + Lucide React

## 快速啟動

1. **安裝依賴套件**
   ```bash
   npm install
   ```

2. **設定環境變數**
   參考 `.env.example` 建立 `.env` 檔案，填入您的 Supabase URL 與 API Key。

3. **初始化資料庫**
   將 `supabase/schema_seed.sql` 的內容複製到 Supabase SQL Editor 中執行，建立所需的資料表與示範數據。

4. **啟動專案**
   ```bash
   npm run dev
   ```
   - 前端訪問: `http://localhost:5173`
   - 後端 API: `http://localhost:4000/api`

## 未來發展
- [ ] 整合真實 LSTM 深度學習模型進行即時推論。
- [ ] 自動化氣候與節慶 API 同步排程。
- [ ] 支援多門市權限管理與比對功能。

---
*本系統旨在提供零售業者科學化的決策支持，優化資源配置並減少庫存損耗。*
