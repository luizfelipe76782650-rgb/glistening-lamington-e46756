(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------

  const SYMBOLS = {
    demo: [
      { value: "DEMO-CRYPTO", label: "Cripto simulada (BTC-like)", base: 61000, vol: 0.0016 },
      { value: "DEMO-FX", label: "Forex simulado (EUR/USD)", base: 1.0852, vol: 0.00045 },
      { value: "DEMO-STOCK", label: "Ação simulada (PETR4-like)", base: 38.2, vol: 0.002 },
    ],
    binance: [
      { value: "BTCUSDT", label: "BTC/USDT" },
      { value: "ETHUSDT", label: "ETH/USDT" },
      { value: "SOLUSDT", label: "SOL/USDT" },
      { value: "BNBUSDT", label: "BNB/USDT" },
    ],
  };

  const DEMO_CANDLE_DURATION_MS = { "1m": 4000, "5m": 6000, "15m": 9000 };
  const TICK_MS = 350;

  const EMA_FAST = 9;
  const EMA_SLOW = 21;
  const RSI_PERIOD = 14;
  const ATR_PERIOD = 14;
  const MIN_CANDLES_TO_EVALUATE = 25;
  const CONFIDENCE_THRESHOLD = 50;
  const MAX_MARKERS = 80;

  const els = {
    statusDot: document.getElementById("statusDot"),
    statusLine: document.getElementById("statusLine"),
    sourceSelect: document.getElementById("sourceSelect"),
    symbolSelect: document.getElementById("symbolSelect"),
    timeframeSelect: document.getElementById("timeframeSelect"),
    soundToggle: document.getElementById("soundToggle"),
    signalCard: document.getElementById("signalCard"),
    statTotal: document.getElementById("statTotal"),
    statWinrate: document.getElementById("statWinrate"),
    statConfidence: document.getElementById("statConfidence"),
    historyList: document.getElementById("historyList"),
    toast: document.getElementById("toast"),
  };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const state = {
    source: "demo",
    symbol: SYMBOLS.demo[0].value,
    timeframe: "5m",
    candles: [], // closed candles
    forming: null, // in-progress candle
    ema9: [],
    ema21: [],
    rsi: [],
    atr: [],
    markers: [],
    openSignals: [],
    closedSignals: [],
    soundEnabled: false,
    audioCtx: null,
    demo: null, // { timer, price, drift, sinceDrift }
    ws: null,
    fallbackTriggered: false,
  };

  // ---------------------------------------------------------------------
  // Charts
  // ---------------------------------------------------------------------

  const chartOptsBase = {
    layout: { background: { color: "#11151f" }, textColor: "#8a92a6" },
    grid: {
      vertLines: { color: "#1b2130" },
      horzLines: { color: "#1b2130" },
    },
    timeScale: { borderColor: "#232a3a", timeVisible: true, secondsVisible: false },
    rightPriceScale: { borderColor: "#232a3a" },
    crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
  };

  const priceChart = LightweightCharts.createChart(
    document.getElementById("priceChart"),
    { ...chartOptsBase, height: 440 }
  );
  const candleSeries = priceChart.addCandlestickSeries({
    upColor: "#26a69a",
    downColor: "#ef5350",
    borderVisible: false,
    wickUpColor: "#26a69a",
    wickDownColor: "#ef5350",
  });
  const emaFastSeries = priceChart.addLineSeries({ color: "#4f8cff", lineWidth: 2, priceLineVisible: false });
  const emaSlowSeries = priceChart.addLineSeries({ color: "#f5b942", lineWidth: 2, priceLineVisible: false });

  const rsiChart = LightweightCharts.createChart(
    document.getElementById("rsiChart"),
    { ...chartOptsBase, height: 130 }
  );
  const rsiSeries = rsiChart.addLineSeries({ color: "#c792ea", lineWidth: 2, priceLineVisible: false });
  rsiSeries.createPriceLine({ price: 70, color: "#ef5350", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "70" });
  rsiSeries.createPriceLine({ price: 30, color: "#26a69a", lineWidth: 1, lineStyle: LightweightCharts.LineStyle.Dashed, axisLabelVisible: true, title: "30" });

  let syncing = false;
  function syncRange(source, target) {
    source.timeScale().subscribeVisibleLogicalRangeChange((range) => {
      if (syncing || !range) return;
      syncing = true;
      target.timeScale().setVisibleLogicalRange(range);
      syncing = false;
    });
  }
  syncRange(priceChart, rsiChart);
  syncRange(rsiChart, priceChart);

  window.addEventListener("resize", () => {
    priceChart.applyOptions({ width: document.getElementById("priceChart").clientWidth });
    rsiChart.applyOptions({ width: document.getElementById("rsiChart").clientWidth });
  });

  // ---------------------------------------------------------------------
  // Indicator math
  // ---------------------------------------------------------------------

  function emaSeries(values, period) {
    const k = 2 / (period + 1);
    const out = new Array(values.length);
    out[0] = values[0];
    for (let i = 1; i < values.length; i++) {
      out[i] = values[i] * k + out[i - 1] * (1 - k);
    }
    return out;
  }

  function rsiSeriesCalc(values, period) {
    const out = new Array(values.length).fill(50);
    if (values.length < 2) return out;
    let avgGain = 0;
    let avgLoss = 0;
    for (let i = 1; i < values.length; i++) {
      const change = values[i] - values[i - 1];
      const gain = Math.max(change, 0);
      const loss = Math.max(-change, 0);
      if (i <= period) {
        avgGain += gain;
        avgLoss += loss;
        if (i === period) {
          avgGain /= period;
          avgLoss /= period;
          out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
        }
      } else {
        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;
        out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
      }
    }
    return out;
  }

  function atrSeriesCalc(candles, period) {
    const out = new Array(candles.length).fill(0);
    if (candles.length < 2) return out;
    let atr = candles[0].high - candles[0].low;
    out[0] = atr;
    for (let i = 1; i < candles.length; i++) {
      const c = candles[i];
      const prevClose = candles[i - 1].close;
      const tr = Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
      atr = i < period ? (atr * i + tr) / (i + 1) : (atr * (period - 1) + tr) / period;
      out[i] = atr;
    }
    return out;
  }

  function recomputeIndicators() {
    const closes = state.candles.map((c) => c.close);
    state.ema9 = emaSeries(closes, EMA_FAST);
    state.ema21 = emaSeries(closes, EMA_SLOW);
    state.rsi = rsiSeriesCalc(closes, RSI_PERIOD);
    state.atr = atrSeriesCalc(state.candles, ATR_PERIOD);
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ---------------------------------------------------------------------
  // Signal engine
  // ---------------------------------------------------------------------

  function evaluateSignal() {
    const n = state.candles.length;
    if (n < MIN_CANDLES_TO_EVALUATE) return;

    const i = n - 1;
    const prevFast = state.ema9[i - 1];
    const prevSlow = state.ema21[i - 1];
    const fast = state.ema9[i];
    const slow = state.ema21[i];
    const rsi = state.rsi[i];
    const price = state.candles[i].close;
    const atr = state.atr[i] || price * 0.004;

    const volumes = state.candles.slice(Math.max(0, i - 19), i + 1).map((c) => c.volume || 0);
    const volAvg = volumes.reduce((a, b) => a + b, 0) / volumes.length || 1;
    const vol = state.candles[i].volume || volAvg;

    const crossUp = prevFast <= prevSlow && fast > slow;
    const crossDown = prevFast >= prevSlow && fast < slow;
    if (!crossUp && !crossDown) return;

    // Separation between the EMAs is ~0 right at the crossing candle by
    // definition, so it is not a useful confidence signal here. Instead use
    // the fast EMA's recent slope as a proxy for how strong the move into
    // the cross was.
    const lookback = Math.max(0, i - 3);
    const momentumBps = ((fast - state.ema9[lookback]) / price) * 10000;
    const volBonus = vol > volAvg * 1.1 ? 8 : vol < volAvg * 0.7 ? -4 : 0;

    let confidence;
    let side;
    if (crossUp) {
      side = "buy";
      const rsiBonus = rsi < 70 ? ((70 - rsi) / 70) * 12 : -8;
      const momentumBonus = clamp(momentumBps / 3, -8, 14);
      confidence = clamp(62 + rsiBonus + momentumBonus + volBonus, 30, 96);
    } else {
      side = "sell";
      const rsiBonus = rsi > 30 ? ((rsi - 30) / 70) * 12 : -8;
      const momentumBonus = clamp(-momentumBps / 3, -8, 14);
      confidence = clamp(62 + rsiBonus + momentumBonus + volBonus, 30, 96);
    }

    if (confidence < CONFIDENCE_THRESHOLD) return;

    const sl = side === "buy" ? price - atr * 1.5 : price + atr * 1.5;
    const tp = side === "buy" ? price + atr * 2.2 : price - atr * 2.2;

    const signal = {
      id: `${state.candles[i].time}-${side}`,
      time: state.candles[i].time,
      side,
      entry: price,
      sl,
      tp,
      confidence: Math.round(confidence),
      status: "open",
    };

    fireSignal(signal);
  }

  function fireSignal(signal) {
    state.openSignals.push(signal);
    state.markers.push({
      time: signal.time,
      position: signal.side === "buy" ? "belowBar" : "aboveBar",
      color: signal.side === "buy" ? "#2ee6a6" : "#ef5350",
      shape: signal.side === "buy" ? "arrowUp" : "arrowDown",
      text: `${signal.side === "buy" ? "COMPRA" : "VENDA"} ${signal.confidence}%`,
    });
    if (state.markers.length > MAX_MARKERS) state.markers.shift();
    candleSeries.setMarkers(state.markers);

    renderSignalCard(signal);
    addHistoryItem(signal);
    playAlertSound(signal.side);
    showToast(
      `${signal.side === "buy" ? "🟢 ENTRADA DE COMPRA" : "🔴 ENTRADA DE VENDA"} — ${formatPrice(signal.entry)} (confiança ${signal.confidence}%)`
    );
  }

  function checkOpenSignals(latestPrice) {
    if (!state.openSignals.length) return;
    const stillOpen = [];
    for (const s of state.openSignals) {
      let result = null;
      if (s.side === "buy") {
        if (latestPrice >= s.tp) result = "win";
        else if (latestPrice <= s.sl) result = "loss";
      } else {
        if (latestPrice <= s.tp) result = "win";
        else if (latestPrice >= s.sl) result = "loss";
      }
      if (result) {
        s.status = result;
        state.closedSignals.push(s);
        updateHistoryItemResult(s);
        updateStats();
      } else {
        stillOpen.push(s);
      }
    }
    state.openSignals = stillOpen;
  }

  // ---------------------------------------------------------------------
  // UI rendering
  // ---------------------------------------------------------------------

  function formatPrice(p) {
    if (p >= 1000) return p.toLocaleString("pt-BR", { maximumFractionDigits: 2 });
    if (p >= 1) return p.toFixed(2);
    return p.toFixed(5);
  }

  function renderSignalCard(signal) {
    els.signalCard.className = `signal-card ${signal.side}`;
    const tagLabel = signal.side === "buy" ? "▲ ENTRADA COMPRA" : "▼ ENTRADA VENDA";
    const barColor = signal.side === "buy" ? "#2ee6a6" : "#ef5350";
    els.signalCard.innerHTML = `
      <div class="signal-body">
        <span class="signal-tag ${signal.side}">${tagLabel}</span>
        <div class="signal-price">${formatPrice(signal.entry)}</div>
        <div class="signal-grid">
          <div><span>Stop Loss</span>${formatPrice(signal.sl)}</div>
          <div><span>Alvo (TP)</span>${formatPrice(signal.tp)}</div>
          <div><span>Confiança</span>${signal.confidence}%</div>
          <div><span>Horário</span>${new Date(signal.time * 1000).toLocaleTimeString("pt-BR")}</div>
        </div>
        <div class="signal-confidence-bar">
          <div class="signal-confidence-fill" style="width:${signal.confidence}%; background:${barColor}"></div>
        </div>
      </div>
    `;
  }

  function addHistoryItem(signal) {
    if (els.historyList.querySelector(".history-empty")) {
      els.historyList.innerHTML = "";
    }
    const row = document.createElement("div");
    row.className = "history-item";
    row.id = `hist-${signal.id}`;
    row.innerHTML = `
      <span class="side ${signal.side}">${signal.side === "buy" ? "COMPRA" : "VENDA"}</span>
      <span>${formatPrice(signal.entry)}</span>
      <span>${signal.confidence}%</span>
      <span>${new Date(signal.time * 1000).toLocaleTimeString("pt-BR")}</span>
      <span class="result open">ABERTO</span>
    `;
    els.historyList.prepend(row);
    updateStats();
  }

  function updateHistoryItemResult(signal) {
    const row = document.getElementById(`hist-${signal.id}`);
    if (!row) return;
    const badge = row.querySelector(".result");
    badge.textContent = signal.status === "win" ? "GANHO" : "PERDA";
    badge.className = `result ${signal.status}`;
  }

  function updateStats() {
    const total = state.openSignals.length + state.closedSignals.length;
    els.statTotal.textContent = total;
    if (state.closedSignals.length) {
      const wins = state.closedSignals.filter((s) => s.status === "win").length;
      els.statWinrate.textContent = `${Math.round((wins / state.closedSignals.length) * 100)}%`;
    } else {
      els.statWinrate.textContent = "—";
    }
    const all = [...state.openSignals, ...state.closedSignals];
    if (all.length) {
      const avg = all.reduce((a, s) => a + s.confidence, 0) / all.length;
      els.statConfidence.textContent = `${Math.round(avg)}%`;
    } else {
      els.statConfidence.textContent = "—";
    }
  }

  function resetSignalUI() {
    state.markers = [];
    state.openSignals = [];
    state.closedSignals = [];
    candleSeries.setMarkers([]);
    els.signalCard.className = "signal-card";
    els.signalCard.innerHTML = `<div class="signal-card-empty">Aguardando o próximo sinal de entrada…</div>`;
    els.historyList.innerHTML = `<div class="history-empty">Nenhuma entrada marcada ainda.</div>`;
    updateStats();
  }

  let toastTimer = null;
  function showToast(msg) {
    els.toast.textContent = msg;
    els.toast.classList.add("show");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => els.toast.classList.remove("show"), 4000);
  }

  function setStatus(text, mode) {
    els.statusLine.textContent = text;
    els.statusDot.className = "brand-dot" + (mode ? ` ${mode}` : "");
  }

  // ---------------------------------------------------------------------
  // Sound
  // ---------------------------------------------------------------------

  function ensureAudio() {
    if (!state.audioCtx) {
      state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
    }
    return state.audioCtx;
  }

  function playAlertSound(side) {
    if (!state.soundEnabled) return;
    const ctx = ensureAudio();
    const freqs = side === "buy" ? [660, 880] : [520, 390];
    let t = ctx.currentTime;
    freqs.forEach((f) => {
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.frequency.value = f;
      osc.type = "sine";
      gain.gain.setValueAtTime(0.001, t);
      gain.gain.exponentialRampToValueAtTime(0.15, t + 0.02);
      gain.gain.exponentialRampToValueAtTime(0.001, t + 0.18);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t);
      osc.stop(t + 0.2);
      t += 0.14;
    });
  }

  els.soundToggle.addEventListener("click", () => {
    state.soundEnabled = !state.soundEnabled;
    if (state.soundEnabled) ensureAudio();
    els.soundToggle.textContent = state.soundEnabled ? "🔔" : "🔕";
    els.soundToggle.classList.toggle("muted", !state.soundEnabled);
  });
  els.soundToggle.classList.add("muted");
  els.soundToggle.textContent = "🔕";

  // ---------------------------------------------------------------------
  // Candle application (shared by demo + live)
  // ---------------------------------------------------------------------

  function applyFormingCandle(candle) {
    candleSeries.update(candle);
    checkOpenSignals(candle.close);
  }

  function applyClosedCandle(candle) {
    state.candles.push(candle);
    if (state.candles.length > 500) state.candles.shift();
    candleSeries.update(candle);
    recomputeIndicators();

    const i = state.candles.length - 1;
    emaFastSeries.update({ time: candle.time, value: state.ema9[i] });
    emaSlowSeries.update({ time: candle.time, value: state.ema21[i] });
    rsiSeries.update({ time: candle.time, value: state.rsi[i] });

    checkOpenSignals(candle.close);
    evaluateSignal();
    setStatus(statusMessage(), state.source === "binance" ? "live" : undefined);
  }

  function seedHistory(candles) {
    state.candles = candles;
    recomputeIndicators();
    candleSeries.setData(candles);
    emaFastSeries.setData(candles.map((c, i) => ({ time: c.time, value: state.ema9[i] })));
    emaSlowSeries.setData(candles.map((c, i) => ({ time: c.time, value: state.ema21[i] })));
    rsiSeries.setData(candles.map((c, i) => ({ time: c.time, value: state.rsi[i] })));
    priceChart.timeScale().fitContent();
    rsiChart.timeScale().fitContent();
  }

  function statusMessage() {
    const symLabel = (SYMBOLS[state.source].find((s) => s.value === state.symbol) || {}).label || state.symbol;
    const src = state.source === "binance" ? "Ao vivo (Binance)" : "Simulação";
    const time = new Date().toLocaleTimeString("pt-BR");
    return `${src} — ${symLabel} — ${state.timeframe} — atualizado às ${time}`;
  }

  // ---------------------------------------------------------------------
  // Demo feed
  // ---------------------------------------------------------------------

  function stopDemo() {
    if (state.demo && state.demo.timer) clearInterval(state.demo.timer);
    state.demo = null;
  }

  function startDemo() {
    stopDemo();
    const cfg = SYMBOLS.demo.find((s) => s.value === state.symbol) || SYMBOLS.demo[0];
    const durationMs = DEMO_CANDLE_DURATION_MS[state.timeframe] || 5000;
    const nowSec = Math.floor(Date.now() / 1000);

    const seedCount = 60;
    let price = cfg.base;
    let drift = 0;
    const seeded = [];
    for (let i = 0; i < seedCount; i++) {
      const open = price;
      let high = open;
      let low = open;
      const steps = 6;
      for (let s = 0; s < steps; s++) {
        const step = gaussianRandom() * cfg.vol * price + drift * price;
        price = Math.max(price + step, price * 0.5);
        high = Math.max(high, price);
        low = Math.min(low, price);
      }
      const close = price;
      seeded.push({
        time: nowSec - (seedCount - i) * (durationMs / 1000),
        open,
        high,
        low,
        close,
        volume: Math.abs(close - open) * (50 + Math.random() * 100) + 20,
      });
      if (Math.random() < 0.12) drift = (Math.random() - 0.5) * cfg.vol * 3;
    }

    seedHistory(seeded);
    resetSignalUI();

    let forming = {
      time: seeded[seeded.length - 1].time + durationMs / 1000,
      open: price,
      high: price,
      low: price,
      close: price,
      volume: 0,
    };

    state.demo = { timer: null, price, drift, startedAt: Date.now() };

    state.demo.timer = setInterval(() => {
      const step = gaussianRandom() * cfg.vol * state.demo.price + state.demo.drift * state.demo.price;
      state.demo.price = Math.max(state.demo.price + step, state.demo.price * 0.5);
      forming.close = state.demo.price;
      forming.high = Math.max(forming.high, state.demo.price);
      forming.low = Math.min(forming.low, state.demo.price);
      forming.volume += Math.abs(step) * 40 + 2;

      applyFormingCandle(forming);
      setStatus(statusMessage());

      if (Date.now() - state.demo.startedAt >= durationMs) {
        applyClosedCandle(forming);
        if (Math.random() < 0.3) state.demo.drift = (Math.random() - 0.5) * cfg.vol * 3;
        state.demo.startedAt = Date.now();
        forming = {
          time: forming.time + durationMs / 1000,
          open: forming.close,
          high: forming.close,
          low: forming.close,
          close: forming.close,
          volume: 0,
        };
      }
    }, TICK_MS);
  }

  function gaussianRandom() {
    let u = 0;
    let v = 0;
    while (u === 0) u = Math.random();
    while (v === 0) v = Math.random();
    return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  // ---------------------------------------------------------------------
  // Binance live feed
  // ---------------------------------------------------------------------

  function stopLive() {
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.onerror = null;
      state.ws.close();
      state.ws = null;
    }
  }

  async function startLive() {
    stopDemo();
    stopLive();
    state.fallbackTriggered = false;
    setStatus(`Conectando à Binance — ${state.symbol} (${state.timeframe})…`);

    try {
      const url = `https://api.binance.com/api/v3/klines?symbol=${state.symbol}&interval=${state.timeframe}&limit=150`;
      const res = await fetch(url);
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      const raw = await res.json();
      if (!Array.isArray(raw)) throw new Error("Resposta inesperada");

      const candles = raw.map((k) => ({
        time: Math.floor(k[0] / 1000),
        open: +k[1],
        high: +k[2],
        low: +k[3],
        close: +k[4],
        volume: +k[5],
      }));

      seedHistory(candles);
      resetSignalUI();
      connectWebSocket();
    } catch (err) {
      handleLiveFailure(`Não foi possível conectar à Binance a partir desta rede (${err.message}). Usando modo Simulação.`);
    }
  }

  function connectWebSocket() {
    const stream = `${state.symbol.toLowerCase()}@kline_${state.timeframe}`;
    const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
    state.ws = ws;
    let opened = false;

    ws.onopen = () => {
      opened = true;
      setStatus(statusMessage(), "live");
    };

    ws.onmessage = (event) => {
      try {
        const msg = JSON.parse(event.data);
        const k = msg.k;
        if (!k) return;
        const candle = {
          time: Math.floor(k.t / 1000),
          open: +k.o,
          high: +k.h,
          low: +k.l,
          close: +k.c,
          volume: +k.v,
        };
        if (k.x) {
          applyClosedCandle(candle);
        } else {
          applyFormingCandle(candle);
          setStatus(statusMessage(), "live");
        }
      } catch (e) {
        // ignore malformed message
      }
    };

    ws.onerror = () => {
      if (!opened) handleLiveFailure("Conexão em tempo real com a Binance falhou. Usando modo Simulação.");
    };

    ws.onclose = () => {
      if (!opened && state.source === "binance" && !state.fallbackTriggered) {
        handleLiveFailure("Conexão com a Binance foi encerrada antes de abrir. Usando modo Simulação.");
      }
    };
  }

  function handleLiveFailure(message) {
    if (state.fallbackTriggered) return;
    state.fallbackTriggered = true;
    stopLive();
    showToast(`⚠️ ${message}`);
    state.source = "demo";
    els.sourceSelect.value = "demo";
    populateSymbolOptions();
    setStatus("Simulação em andamento (fallback automático)…", "down");
    startDemo();
  }

  // ---------------------------------------------------------------------
  // Controls wiring
  // ---------------------------------------------------------------------

  function populateSymbolOptions() {
    const list = SYMBOLS[state.source];
    els.symbolSelect.innerHTML = list.map((s) => `<option value="${s.value}">${s.label}</option>`).join("");
    state.symbol = list[0].value;
    els.symbolSelect.value = state.symbol;
  }

  function restart() {
    stopDemo();
    stopLive();
    if (state.source === "binance") {
      setStatus(`Conectando à Binance — ${state.symbol} (${state.timeframe})…`);
      startLive();
    } else {
      setStatus("Iniciando simulação…");
      startDemo();
    }
  }

  els.sourceSelect.addEventListener("change", () => {
    state.source = els.sourceSelect.value;
    populateSymbolOptions();
    restart();
  });

  els.symbolSelect.addEventListener("change", () => {
    state.symbol = els.symbolSelect.value;
    restart();
  });

  els.timeframeSelect.addEventListener("change", () => {
    state.timeframe = els.timeframeSelect.value;
    restart();
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  populateSymbolOptions();
  startDemo();
})();
