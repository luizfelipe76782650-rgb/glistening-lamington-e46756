(() => {
  "use strict";

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------

  const T = window.TradeCore;

  const SYMBOLS = [
    { value: "BTCUSDT", label: "BTC/USDT", short: "BTC", icon: "🟠", assetClass: "crypto", binance: "BTCUSDT", coinbase: "BTC-USD" },
    { value: "PAXGUSDT", label: "XAU/USD (Ouro, via token PAXG)", short: "XAU", icon: "🥇", assetClass: "commodities", binance: "PAXGUSDT", coinbase: "PAXG-USD" },
    { value: "ETHUSDT", label: "ETH/USDT", short: "ETH", icon: "Ξ", assetClass: "crypto", binance: "ETHUSDT", coinbase: "ETH-USD" },
    { value: "SOLUSDT", label: "SOL/USDT", short: "SOL", icon: "◎", assetClass: "crypto", binance: "SOLUSDT", coinbase: "SOL-USD" },
    { value: "BNBUSDT", label: "BNB/USDT", short: "BNB", icon: "🔶", assetClass: "crypto", binance: "BNBUSDT" },
  ];

  const TIMEFRAMES = [
    { value: "1m", label: "1 minuto" },
    { value: "3m", label: "3 minutos" },
    { value: "5m", label: "5 minutos" },
    { value: "15m", label: "15 minutos" },
    { value: "30m", label: "30 minutos" },
    { value: "1h", label: "1 hora" },
    { value: "2h", label: "2 horas" },
    { value: "4h", label: "4 horas" },
    { value: "6h", label: "6 horas" },
    { value: "1d", label: "1 dia" },
    { value: "1w", label: "1 semana" },
    { value: "1M", label: "1 mês" },
  ];

  const GRANULARITY_SEC = {
    "1m": 60, "3m": 180, "5m": 300, "15m": 900, "30m": 1800,
    "1h": 3600, "2h": 7200, "4h": 14400, "6h": 21600,
    "1d": 86400, "1w": 604800, "1M": 2592000,
  };

  // Coinbase only supports a fixed set of granularities
  const COINBASE_GRAN = { "1m": 60, "5m": 300, "15m": 900, "1h": 3600, "6h": 21600, "1d": 86400 };

  const FETCH_TIMEOUT_MS = 7000;
  const WS_OPEN_TIMEOUT_MS = 7000;
  const RECONNECT_DELAY_MS = 8000;

  const EMA_FAST = 9;
  const EMA_SLOW = 21;
  const RSI_PERIOD = 14;
  const ATR_PERIOD = 14;
  const MIN_CANDLES_TO_EVALUATE = 25;
  const COOLDOWN_CANDLES = 2;
  const MAX_MARKERS = 80;

  function symbolInfo(value) {
    return SYMBOLS.find((s) => s.value === value) || { short: value, icon: "📈", assetClass: "crypto" };
  }

  function tierName(confidence) {
    return T.tierName(confidence);
  }

  function tierLabel(confidence) {
    return ` ${tierName(confidence)}`;
  }

  const els = {
    statusDot: document.getElementById("statusDot"),
    statusShort: document.getElementById("statusShort"),
    statusLine: document.getElementById("statusLine"),
    statusDot2: document.getElementById("statusDot2"),
    symbolSeg: document.getElementById("symbolSeg"),
    timeframeSeg: document.getElementById("timeframeSeg"),
    soundToggle: document.getElementById("soundToggle"),
    signalCard: document.getElementById("signalCard"),
    metPrice: document.getElementById("metPrice"),
    metSignals: document.getElementById("metSignals"),
    metWinrate: document.getElementById("metWinrate"),
    metEdge: document.getElementById("metEdge"),
    metDD: document.getElementById("metDD"),
    symName: document.getElementById("symName"),
    symDot: document.getElementById("symDot"),
    priceIcon: document.getElementById("priceIcon"),
    historyList: document.getElementById("historyList"),
    toast: document.getElementById("toast"),

    mktTrend: document.getElementById("mktTrend"),
    mktStructure: document.getElementById("mktStructure"),
    mktEvent: document.getElementById("mktEvent"),
    mktZones: document.getElementById("mktZones"),
    mktPattern: document.getElementById("mktPattern"),
    mktRsi: document.getElementById("mktRsi"),
    mktRsiMini: document.getElementById("mktRsiMini"),
    mktPatternMini: document.getElementById("mktPatternMini"),

    mcCount: document.getElementById("mcCount"),
    mcWinrate: document.getElementById("mcWinrate"),
    mcEdge: document.getElementById("mcEdge"),
    mcPF: document.getElementById("mcPF"),
    mcPProfit: document.getElementById("mcPProfit"),
    mcDD: document.getElementById("mcDD"),
    mcRun: document.getElementById("mcRun"),
    mcRisk: document.getElementById("mcRisk"),
  };

  // ---------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------

  const state = {
    symbol: SYMBOLS[0].value,
    timeframe: "5m",
    candles: [],
    forming: null,
    ema9: [],
    ema21: [],
    rsi: [],
    atr: [],
    markers: [],
    openSignals: [],
    closedSignals: [],
    closedR: [], // results per closed trade (bool = win)
    lastSignalIndex: -1e4,
    soundEnabled: false,
    audioCtx: null,
    ws: null,
    reconnectTimer: null,
    activeProvider: null,
    avoidProvider: null,
    lastSnap: null,
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
  // Indicator math (delegated to TradeCore)
  // ---------------------------------------------------------------------

  function recomputeIndicators() {
    const closes = state.candles.map((c) => c.close);
    state.ema9 = T.emaSeries(closes, EMA_FAST);
    state.ema21 = T.emaSeries(closes, EMA_SLOW);
    state.rsi = T.rsiSeries(closes, RSI_PERIOD);
    state.atr = T.atrSeries(state.candles, ATR_PERIOD);
  }

  // ---------------------------------------------------------------------
  // Signal engine (SMC + price action + patterns, scored by confluence)
  // ---------------------------------------------------------------------

  function currentSnapshot() {
    recomputeIndicators();
    return T.analyze(state.candles, state.atr, state.rsi);
  }

  function fireSignal(signal) {
    state.openSignals.push(signal);
    state.lastSignalIndex = state.candles.length - 1;
    state.markers.push({
      time: signal.time,
      position: signal.side === "buy" ? "belowBar" : "aboveBar",
      color: signal.side === "buy" ? "#2ee6a6" : "#ef5350",
      shape: signal.side === "buy" ? "arrowUp" : "arrowDown",
      text: `${signal.side === "buy" ? "COMPRA" : "VENDA"}${tierLabel(signal.confidence)} ${signal.confidence}%`,
    });
    if (state.markers.length > MAX_MARKERS) state.markers.shift();
    candleSeries.setMarkers(state.markers);
    renderZones();

    renderSignalCard(signal);
    addHistoryItem(signal);
    playAlertSound(signal.side);
    showToast(
      `${signal.side === "buy" ? "🟢 ENTRADA DE COMPRA" : "🔴 ENTRADA DE VENDA"} — ${signal.setup} — ${formatPrice(signal.entry)} (confiança ${signal.confidence}%)`
    );
  }

  function evaluateCurrentCandle() {
    if (state.candles.length < MIN_CANDLES_TO_EVALUATE) return;
    const snap = currentSnapshot();
    state.lastSnap = snap;
    renderZones();

    if (state.candles.length - state.lastSignalIndex < COOLDOWN_CANDLES) {
      updateAnalysisPanel(snap, state.rsi[state.rsi.length - 1]);
      return;
    }
    const sig = T.buildSignal(state.candles, state.atr, state.rsi, state.ema21, snap);
    if (sig) {
      const i = state.candles.length - 1;
      sig.time = state.candles[i].time;
      sig.id = `${sig.time}-${sig.side}`;
      sig.symbol = state.symbol;
      sig.timeframe = state.timeframe;
      fireSignal(sig);
    }
    updateAnalysisPanel(snap, state.rsi[state.rsi.length - 1]);
  }

  function resolveAgainstHistory(signal, start) {
    let status = "open";
    for (let j = start; j < state.candles.length; j++) {
      const c = state.candles[j];
      if (signal.side === "buy") {
        if (c.high >= signal.tp) { status = "win"; break; }
        if (c.low <= signal.sl) { status = "loss"; break; }
      } else {
        if (c.low <= signal.tp) { status = "win"; break; }
        if (c.high >= signal.sl) { status = "loss"; break; }
      }
    }
    return status;
  }

  function backfillHistoricalSignals() {
    const n = state.candles.length;
    let lastSignalIndex = -COOLDOWN_CANDLES - 1;
    let lastSignal = null;

    for (let i = MIN_CANDLES_TO_EVALUATE; i < n; i++) {
      if (i - lastSignalIndex < COOLDOWN_CANDLES) continue;
      const sub = state.candles.slice(0, i + 1);
      const closes = sub.map((c) => c.close);
      const a = T.atrSeries(sub, ATR_PERIOD);
      const rsi = T.rsiSeries(closes, RSI_PERIOD);
      const e21 = T.emaSeries(closes, EMA_SLOW);
      const snap = T.analyze(sub, a, rsi);
      const sig = T.buildSignal(sub, a, rsi, e21, snap);
      if (!sig) continue;

      lastSignalIndex = i;
      sig.time = sub[i].time;
      sig.id = `${sig.time}-${sig.side}`;
      sig.symbol = state.symbol;
      sig.timeframe = state.timeframe;

      sig.status = resolveAgainstHistory(sig, i + 1);

      state.markers.push({
        time: sig.time,
        position: sig.side === "buy" ? "belowBar" : "aboveBar",
        color: sig.side === "buy" ? "#2ee6a6" : "#ef5350",
        shape: sig.side === "buy" ? "arrowUp" : "arrowDown",
        text: `${sig.side === "buy" ? "COMPRA" : "VENDA"}${tierLabel(sig.confidence)} ${sig.confidence}%`,
      });

      addHistoryItem(sig);
      if (sig.status === "open") {
        state.openSignals.push(sig);
      } else {
        state.closedSignals.push(sig);
        state.closedR.push(sig.status === "win");
        updateHistoryItemResult(sig);
      }
      lastSignal = sig;
    }

    if (state.markers.length > MAX_MARKERS) state.markers = state.markers.slice(-MAX_MARKERS);
    candleSeries.setMarkers(state.markers);
    renderZones();
    updateStats();
    updateMonteCarlo();
    if (lastSignal) renderSignalCard(lastSignal);
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
        state.closedR.push(result === "win");
        updateHistoryItemResult(s);
        updateStats();
        updateMonteCarlo();
      } else {
        stillOpen.push(s);
      }
    }
    state.openSignals = stillOpen;
  }

  // ---------------------------------------------------------------------
  // Zone markers (Order Blocks / FVGs) merged with signal markers
  // ---------------------------------------------------------------------

  function buildZoneMarkers(snap) {
    const out = [];
    const pick = (zones) => zones.slice(-5);
    function push(zones, label, color, position) {
      pick(zones).forEach((z) => {
        if (z && z.time) out.push({ time: z.time, position: position, color: color, shape: "circle", text: label });
      });
    }
    push(snap.ob.bull, "OB+", "#2ee6a6", "belowBar");
    push(snap.ob.bear, "OB−", "#ef5350", "aboveBar");
    push(snap.fvg.bull, "FVG+", "#4f8cff", "belowBar");
    push(snap.fvg.bear, "FVG−", "#f5b942", "aboveBar");
    return out;
  }

  function renderZones() {
    if (!state.lastSnap || !state.candles.length) return;
    const zoneMk = buildZoneMarkers(state.lastSnap);
    const merged = [...zoneMk, ...state.markers];
    merged.sort((a, b) => a.time - b.time);
    candleSeries.setMarkers(merged.slice(-160));
  }

  // ---------------------------------------------------------------------
  // Analysis panel
  // ---------------------------------------------------------------------

  function setText(el, v) {
    if (el) el.textContent = v;
  }

  function updateAnalysisPanel(snap, rsiNow) {
    const st = snap.structure;
    if (st && st.trend === "bull") setText(els.mktTrend, "Alta (HH/HL)");
    else if (st && st.trend === "bear") setText(els.mktTrend, "Baixa (LL/LH)");
    else setText(els.mktTrend, "Lateral");

    if (st) {
      const hl = st.lastHigh;
      const ll = st.lastLow;
      const hiTxt = hl ? `${formatPrice(hl.price)} @${new Date(hl.time * 1000).toLocaleTimeString("pt-BR")}` : "—";
      const loTxt = ll ? `${formatPrice(ll.price)} @${new Date(ll.time * 1000).toLocaleTimeString("pt-BR")}` : "—";
      setText(els.mktStructure, `Topo ${hiTxt} · Fundo ${loTxt}`);
    } else {
      setText(els.mktStructure, "—");
    }

    const ev = snap.events;
    if (ev.choch) {
      setText(els.mktEvent, `CHoCH ${ev.choch.dir === "buy" ? "altista" : "baixista"} @ ${new Date(ev.choch.time * 1000).toLocaleTimeString("pt-BR")}`);
    } else if (ev.bos) {
      setText(els.mktEvent, `BOS ${ev.bos.dir === "buy" ? "altista" : "baixista"} @ ${new Date(ev.bos.time * 1000).toLocaleTimeString("pt-BR")}`);
    } else if (snap.sweep) {
      setText(els.mktEvent, `Sweep de liquidez (${snap.sweep.dir === "buy" ? "lado baixo" : "lado alto"}) @ ${new Date(snap.sweep.time * 1000).toLocaleTimeString("pt-BR")}`);
    } else {
      setText(els.mktEvent, "Sem quebra estrutural recente");
    }

    setText(
      els.mktZones,
      `OB compra ${snap.ob.bull.length} · OB venda ${snap.ob.bear.length} · FVG+ ${snap.fvg.bull.length} · FVG− ${snap.fvg.bear.length}`
    );

    const pat = snap.patterns.find((p) => p.dir);
    setText(els.mktPattern, pat ? pat.name : "Sem padrão na última vela");
    setText(els.mktPatternMini, pat ? pat.name : "—");

    setText(els.mktRsi, rsiNow != null ? `RSI(14) = ${rsiNow.toFixed(1)}` : "—");
    setText(els.mktRsiMini, rsiNow != null ? rsiNow.toFixed(1) : "—");
  }

  // ---------------------------------------------------------------------
  // Monte Carlo panel
  // ---------------------------------------------------------------------

  function updateMonteCarlo() {
    const mc = T.monteCarlo(state.closedR);
    if (!mc) {
      setText(els.mcCount, "0 trades");
      setText(els.mcWinrate, "—");
      setText(els.mcEdge, "—");
      setText(els.mcPF, "—");
      setText(els.mcPProfit, "—");
      setText(els.mcDD, "—");
      setText(els.mcRun, "—");
      setText(els.mcRisk, `Risco fixo 1% · RR ${T.CONF.RR.toFixed(2)} · ${T.CONF.MC_SIMS} simulações`);
      setText(els.metEdge, "—");
      setText(els.metDD, "—");
      return;
    }
    setText(els.mcCount, `${mc.n} trades fechados`);
    setText(els.mcWinrate, `${(mc.winRate * 100).toFixed(1)}%`);
    setText(els.mcEdge, `${mc.edgeR >= 0 ? "+" : ""}${mc.edgeR.toFixed(2)} R`);
    setText(els.mcPF, mc.profitFactor === Infinity ? "∞" : mc.profitFactor.toFixed(2));
    setText(els.mcPProfit, `${(mc.pProfit * 100).toFixed(0)}%`);
    setText(els.mcDD, `médio ${mc.avgMaxDD.toFixed(1)}% · p95 ${mc.dd95.toFixed(1)}%`);
    setText(els.mcRun, `p95 ${mc.run95} seguidas · máx ${mc.worstRun}`);
    setText(els.mcRisk, `Risco fixo 1% · RR ${T.CONF.RR.toFixed(2)} · ${T.CONF.MC_SIMS} simulações`);
    setText(els.metEdge, `${mc.edgeR >= 0 ? "+" : ""}${mc.edgeR.toFixed(2)} R`);
    setText(els.metDD, `−${mc.dd95.toFixed(1)}%`);
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
    els.signalCard.className = `card signal-strip ${signal.side}`;
    const tagLabel = `${signal.side === "buy" ? "▲ ENTRADA COMPRA" : "▼ ENTRADA VENDA"}${tierLabel(signal.confidence)}`;
    const chips = (signal.reasons || [])
      .map((r) => `<span class="chip">${r}</span>`)
      .join("");
    els.signalCard.innerHTML = `
      <div class="signal-body">
        <span class="signal-tag ${signal.side}">${tagLabel}</span>
        <div class="signal-setup"><span>Setup</span>${signal.setup || "—"}</div>
        <div class="signal-price">${formatPrice(signal.entry)}</div>
        <div class="signal-grid">
          <div><span>Stop Loss</span>${formatPrice(signal.sl)}</div>
          <div><span>Alvo (TP)</span>${formatPrice(signal.tp)}</div>
          <div><span>Confiança</span>${signal.confidence}%</div>
          <div><span>Horário</span>${new Date(signal.time * 1000).toLocaleTimeString("pt-BR")}</div>
        </div>
        ${chips ? `<div class="signal-reasons">${chips}</div>` : ""}
      </div>
    `;
  }

  function addHistoryItem(signal) {
    if (els.historyList.querySelector(".history-empty")) {
      els.historyList.innerHTML = "";
    }
    const info = symbolInfo(signal.symbol);
    const tierLabelTxt = `${signal.side === "buy" ? "COMPRA" : "VENDA"}${tierLabel(signal.confidence)}`;
    const tr = document.createElement("tr");
    tr.id = `hist-${signal.id}`;
    tr.innerHTML = `
      <td class="pl">
        <div class="asset-cell">
          <span class="asset-icon">${info.icon}</span>
          <div>
            <div>${info.short}</div>
            <div class="asset-sub">${info.assetClass} • ${signal.timeframe}</div>
          </div>
        </div>
      </td>
      <td>
        <span class="tier-pill ${signal.side}">${tierLabelTxt}</span>
        <div class="asset-sub">${signal.setup || "—"}</div>
      </td>
      <td class="text-right">${formatPrice(signal.entry)}</td>
      <td class="text-right">${formatPrice(signal.sl)}</td>
      <td class="text-right">${formatPrice(signal.tp)}</td>
      <td class="text-right">${signal.confidence}%</td>
      <td class="text-right pr"><span class="result open">ABERTO</span></td>
    `;
    els.historyList.prepend(tr);
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
    setText(els.metSignals, total);
    if (state.closedSignals.length) {
      const wins = state.closedSignals.filter((s) => s.status === "win").length;
      setText(els.metWinrate, `${Math.round((wins / state.closedSignals.length) * 100)}%`);
    } else {
      setText(els.metWinrate, "—");
    }
  }

  function resetSignalUI() {
    state.markers = [];
    state.openSignals = [];
    state.closedSignals = [];
    state.closedR = [];
    state.lastSignalIndex = -1e4;
    state.lastSnap = null;
    candleSeries.setMarkers([]);
    els.signalCard.className = "card signal-strip";
    els.signalCard.innerHTML = `<div class="signal-card-empty">Aguardando o próximo sinal de entrada…</div>`;
    els.historyList.innerHTML = `<tr><td colspan="7"><div class="history-empty">Nenhuma entrada marcada ainda.</div></td></tr>`;
    updateStats();
    updateMonteCarlo();
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
    setText(els.statusShort, text);
    if (els.statusDot2) els.statusDot2.className = "status-dot" + (mode === "down" ? " down" : "");
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
  // Candle application
  // ---------------------------------------------------------------------

  function applyFormingCandle(candle) {
    setText(els.metPrice, formatPrice(candle.close));
    candleSeries.update(candle);
    checkOpenSignals(candle.close);
  }

  function applyClosedCandle(candle) {
    state.candles.push(candle);
    if (state.candles.length > 500) state.candles.shift();
    setText(els.metPrice, formatPrice(candle.close));
    candleSeries.update(candle);
    recomputeIndicators();

    const i = state.candles.length - 1;
    emaFastSeries.update({ time: candle.time, value: state.ema9[i] });
    emaSlowSeries.update({ time: candle.time, value: state.ema21[i] });
    rsiSeries.update({ time: candle.time, value: state.rsi[i] });

    checkOpenSignals(candle.close);
    evaluateCurrentCandle();
    setStatus(statusMessage(), "live");
  }

  function seedHistory(candles) {
    state.candles = candles;
    const info = symbolInfo(state.symbol);
    setText(els.symName, info.label);
    setText(els.symDot, info.icon);
    setText(els.priceIcon, info.icon);
    if (candles.length) setText(els.metPrice, formatPrice(candles[candles.length - 1].close));
    recomputeIndicators();
    candleSeries.setData(candles);
    emaFastSeries.setData(candles.map((c, i) => ({ time: c.time, value: state.ema9[i] })));
    emaSlowSeries.setData(candles.map((c, i) => ({ time: c.time, value: state.ema21[i] })));
    rsiSeries.setData(candles.map((c, i) => ({ time: c.time, value: state.rsi[i] })));
    priceChart.timeScale().fitContent();
    rsiChart.timeScale().fitContent();

    // initial zone + analysis render
    const snap = currentSnapshot();
    renderZones(snap);
    updateAnalysisPanel(snap, state.rsi[state.rsi.length - 1]);
  }

  function statusMessage() {
    const info = symbolInfo(state.symbol);
    const providerLabel = PROVIDERS[state.activeProvider] ? PROVIDERS[state.activeProvider].label : "?";
    const time = new Date().toLocaleTimeString("pt-BR");
    return `Ao vivo (${providerLabel}) — ${info.short} — ${state.timeframe} — atualizado às ${time}`;
  }

  // ---------------------------------------------------------------------
  // Live feed — tries Binance first, falls back to Coinbase automatically
  // if a corretora is unreachable from the visitor's network.
  // ---------------------------------------------------------------------

  function fetchJsonWithTimeout(url, ms) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return fetch(url, { signal: controller.signal }).finally(() => clearTimeout(timer));
  }

  const PROVIDERS = {
    binance: {
      label: "Binance",
      async fetchHistory(productSymbol, timeframe) {
        const url = `https://api.binance.com/api/v3/klines?symbol=${productSymbol}&interval=${timeframe}&limit=150`;
        const res = await fetchJsonWithTimeout(url, FETCH_TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw)) throw new Error("resposta inesperada");
        return raw.map((k) => ({
          time: Math.floor(k[0] / 1000),
          open: +k[1],
          high: +k[2],
          low: +k[3],
          close: +k[4],
          volume: +k[5],
        }));
      },
      connectStream(productSymbol, timeframe, handlers) {
        const stream = `${productSymbol.toLowerCase()}@kline_${timeframe}`;
        const ws = new WebSocket(`wss://stream.binance.com:9443/ws/${stream}`);
        ws.onopen = handlers.onOpen;
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
            if (k.x) handlers.onClosedCandle(candle);
            else handlers.onFormingCandle(candle);
          } catch (e) {
            // ignore malformed message
          }
        };
        ws.onerror = handlers.onError;
        ws.onclose = handlers.onClose;
        return ws;
      },
    },
    coinbase: {
      label: "Coinbase",
      async fetchHistory(productSymbol, timeframe) {
        const granularity = COINBASE_GRAN[timeframe];
        if (!granularity) throw new Error("timeframe não suportado pela Coinbase");
        const url = `https://api.exchange.coinbase.com/products/${productSymbol}/candles?granularity=${granularity}`;
        const res = await fetchJsonWithTimeout(url, FETCH_TIMEOUT_MS);
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const raw = await res.json();
        if (!Array.isArray(raw)) throw new Error("resposta inesperada");
        // Coinbase candle rows: [time, low, high, open, close, volume], newest first.
        return raw
          .map((c) => ({ time: +c[0], low: +c[1], high: +c[2], open: +c[3], close: +c[4], volume: +c[5] }))
          .sort((a, b) => a.time - b.time)
          .slice(-150);
      },
      connectStream(productSymbol, timeframe, handlers) {
        const granularity = COINBASE_GRAN[timeframe];
        if (!granularity) throw new Error("timeframe não suportado pela Coinbase");
        const ws = new WebSocket("wss://ws-feed.exchange.coinbase.com");
        let forming = null;
        ws.onopen = () => {
          ws.send(JSON.stringify({ type: "subscribe", product_ids: [productSymbol], channels: ["matches"] }));
          handlers.onOpen();
        };
        ws.onmessage = (event) => {
          try {
            const msg = JSON.parse(event.data);
            if (msg.type !== "match" && msg.type !== "last_match") return;
            const price = +msg.price;
            const size = +msg.size;
            const tSec = Math.floor(new Date(msg.time).getTime() / 1000);
            const bucket = Math.floor(tSec / granularity) * granularity;
            if (!forming || forming.time !== bucket) {
              if (forming) handlers.onClosedCandle(forming);
              forming = { time: bucket, open: price, high: price, low: price, close: price, volume: 0 };
            }
            forming.high = Math.max(forming.high, price);
            forming.low = Math.min(forming.low, price);
            forming.close = price;
            forming.volume += size;
            handlers.onFormingCandle(forming);
          } catch (e) {
            // ignore malformed message
          }
        };
        ws.onerror = handlers.onError;
        ws.onclose = handlers.onClose;
        return ws;
      },
    },
  };

  function stopLive() {
    if (state.reconnectTimer) {
      clearTimeout(state.reconnectTimer);
      state.reconnectTimer = null;
    }
    if (state.ws) {
      state.ws.onclose = null;
      state.ws.onerror = null;
      state.ws.close();
      state.ws = null;
    }
  }

  async function startLive() {
    stopLive();
    const info = symbolInfo(state.symbol);
    let providerIds = ["binance", "coinbase"].filter(
      (id) => !!info[id] && !(id === "coinbase" && !COINBASE_GRAN[state.timeframe])
    );
    if (state.avoidProvider && providerIds.length > 1) {
      providerIds = providerIds.filter((id) => id !== state.avoidProvider).concat(providerIds.filter((id) => id === state.avoidProvider));
    }
    const errors = [];

    for (const providerId of providerIds) {
      const provider = PROVIDERS[providerId];
      setStatus(`Conectando — ${provider.label} — ${info.short} (${state.timeframe})…`);
      try {
        const candles = await provider.fetchHistory(info[providerId], state.timeframe);
        if (!candles.length) throw new Error("nenhum candle retornado");
        seedHistory(candles);
        resetSignalUI();
        backfillHistoricalSignals();
        state.activeProvider = providerId;
        connectStream(providerId, info[providerId]);
        return;
      } catch (err) {
        console.warn(`[day-trade-ai] ${provider.label} failed:`, err);
        errors.push(`${provider.label}: ${err.message}`);
      }
    }

    scheduleReconnect(`Falha em ${info.short} — ${errors.join(" | ")}`);
  }

  function connectStream(providerId, productSymbol) {
    const provider = PROVIDERS[providerId];
    let opened = false;
    const openTimer = setTimeout(() => {
      if (!opened) {
        ws.onclose = null;
        ws.onerror = null;
        ws.close();
        state.avoidProvider = providerId;
        scheduleReconnect(`${provider.label} não respondeu em tempo (timeout).`);
      }
    }, WS_OPEN_TIMEOUT_MS);

    const ws = provider.connectStream(productSymbol, state.timeframe, {
      onOpen: () => {
        opened = true;
        state.avoidProvider = null;
        clearTimeout(openTimer);
        setStatus(statusMessage(), "live");
      },
      onClosedCandle: (candle) => applyClosedCandle(candle),
      onFormingCandle: (candle) => {
        applyFormingCandle(candle);
        setStatus(statusMessage(), "live");
      },
      onError: () => {
        clearTimeout(openTimer);
        state.avoidProvider = providerId;
        scheduleReconnect(`Conexão em tempo real com ${provider.label} falhou.`);
      },
      onClose: () => {
        clearTimeout(openTimer);
        state.avoidProvider = providerId;
        scheduleReconnect(`Conexão com ${provider.label} foi encerrada.`);
      },
    });
    state.ws = ws;
  }

  function scheduleReconnect(message) {
    if (state.reconnectTimer) return;
    showToast(`⚠️ ${message} Tentando de novo em ${RECONNECT_DELAY_MS / 1000}s…`);
    setStatus(`${message} Reconectando em ${RECONNECT_DELAY_MS / 1000}s…`, "down");
    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      startLive();
    }, RECONNECT_DELAY_MS);
  }

  // ---------------------------------------------------------------------
  // Controls wiring
  // ---------------------------------------------------------------------

  function renderSymbolPills() {
    els.symbolSeg.innerHTML = "";
    SYMBOLS.forEach((s) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = s.short;
      b.title = s.label;
      if (s.value === state.symbol) b.classList.add("on");
      b.addEventListener("click", () => {
        if (state.symbol === s.value) return;
        state.symbol = s.value;
        renderSymbolPills();
        updateSymHeader();
        startLive();
      });
      els.symbolSeg.appendChild(b);
    });
  }

  function renderTimeframePills() {
    els.timeframeSeg.innerHTML = "";
    TIMEFRAMES.forEach((t) => {
      const b = document.createElement("button");
      b.type = "button";
      b.textContent = t.value;
      b.title = t.label;
      if (t.value === state.timeframe) b.classList.add("on");
      b.addEventListener("click", () => {
        if (state.timeframe === t.value) return;
        state.timeframe = t.value;
        renderTimeframePills();
        startLive();
      });
      els.timeframeSeg.appendChild(b);
    });
  }

  function updateSymHeader() {
    const info = symbolInfo(state.symbol);
    setText(els.symName, info.label);
    setText(els.symDot, info.icon);
    setText(els.priceIcon, info.icon);
  }

  document.querySelectorAll(".fin-nav-item[data-scroll]").forEach((item) => {
    item.addEventListener("click", () => {
      const target = document.querySelector(item.dataset.scroll);
      if (target) {
        target.scrollIntoView({ behavior: "smooth", block: "start" });
        document.querySelectorAll(".fin-nav-item").forEach((n) => n.classList.remove("active"));
        item.classList.add("active");
      }
    });
  });

  // ---------------------------------------------------------------------
  // Boot
  // ---------------------------------------------------------------------

  renderSymbolPills();
  renderTimeframePills();
  updateSymHeader();
  startLive();

  // debug/test hook
  window.__dayTradeDebug = {
    candles: () => state.candles.length,
    markers: () => state.markers.length,
    openSignals: () => state.openSignals.length,
    status: () => els.statusLine.textContent,
    mktZones: () => (els.mktZones ? els.mktZones.textContent : ""),
    mktTrend: () => (els.mktTrend ? els.mktTrend.textContent : ""),
    mcEdge: () => (els.mcEdge ? els.mcEdge.textContent : ""),
    rsi: () => (state.rsi.length ? state.rsi[state.rsi.length - 1].toFixed(1) : "—"),
    provider: () => (state.activeProvider ? state.activeProvider : "?"),
  };
})();