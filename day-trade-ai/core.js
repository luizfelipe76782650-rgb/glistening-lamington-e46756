(function (root, factory) {
  var api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  else root.TradeCore = api;
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  // ---------------------------------------------------------------------
  // Config
  // ---------------------------------------------------------------------

  var CONF = {
    SWING_K: 2,
    OB_IMPULSE_ATR: 1.25,
    OB_MAX_ZONES: 8,
    FVG_MAX_ZONES: 8,
    SWEEP_LOOKBACK: 6,
    ACCEPT_CORE: 3, // min core confluences (sweep/zone/pattern) to emit
    SCORE_MIN: 80,
    REQUIRE_ZONE_OR_SWEEP: true, // every signal must have a zone retest or liquidity sweep
    SL_ATR: 1.3,
    TP_ATR: 2.4,
    RR: 2.4 / 1.3,
    MC_SIMS: 2000,
    MC_RISK_PCT: 1,
    ZONE_TOUCH_ATR: 0.6, // max distance (x ATR) from a zone to count as a retest
  };

  // ---------------------------------------------------------------------
  // Indicators
  // ---------------------------------------------------------------------

  function emaSeries(values, period) {
    var k = 2 / (period + 1);
    var out = new Array(values.length);
    if (!values.length) return out;
    out[0] = values[0];
    for (var i = 1; i < values.length; i++) out[i] = values[i] * k + out[i - 1] * (1 - k);
    return out;
  }

  function smaSeries(values, period) {
    var out = new Array(values.length).fill(0);
    var sum = 0;
    for (var i = 0; i < values.length; i++) {
      sum += values[i];
      if (i >= period) sum -= values[i - period];
      if (i >= period - 1) out[i] = sum / period;
    }
    return out;
  }

  function rsiSeries(values, period) {
    var out = new Array(values.length).fill(50);
    if (values.length < 2) return out;
    var avgGain = 0;
    var avgLoss = 0;
    for (var i = 1; i < values.length; i++) {
      var change = values[i] - values[i - 1];
      var gain = Math.max(change, 0);
      var loss = Math.max(-change, 0);
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

  function atrSeries(candles, period) {
    var out = new Array(candles.length).fill(0);
    if (!candles.length) return out;
    var atr = candles[0].high - candles[0].low || 1e-9;
    out[0] = atr;
    for (var i = 1; i < candles.length; i++) {
      var c = candles[i];
      var pc = candles[i - 1];
      var tr = Math.max(c.high - c.low, Math.abs(c.high - pc.close), Math.abs(c.low - pc.close));
      atr = i < period ? (atr * i + tr) / (i + 1) : (atr * (period - 1) + tr) / period;
      out[i] = atr;
    }
    return out;
  }

  function clamp(v, lo, hi) {
    return Math.max(lo, Math.min(hi, v));
  }

  // ---------------------------------------------------------------------
  // Swings / structure (fractal pivots)
  // ---------------------------------------------------------------------

  function findSwings(candles, k) {
    k = k || CONF.SWING_K;
    var highs = [];
    var lows = [];
    var n = candles.length;
    for (var i = k; i < n - k; i++) {
      var isHigh = true;
      var isLow = true;
      var hi = candles[i].high;
      var lo = candles[i].low;
      for (var j = i - k; j <= i + k; j++) {
        if (j === i) continue;
        if (candles[j].high >= hi) isHigh = false;
        if (candles[j].low <= lo) isLow = false;
      }
      if (isHigh) highs.push({ i: i, time: candles[i].time, price: hi });
      if (isLow) lows.push({ i: i, time: candles[i].time, price: lo });
    }
    return { highs: highs, lows: lows };
  }

  function structureFrom(swings) {
    var highs = swings.highs;
    var lows = swings.lows;
    if (!highs.length || !lows.length) return null;
    var h1 = highs[highs.length - 1];
    var h0 = highs[highs.length - 2] || h1;
    var l1 = lows[lows.length - 1];
    var l0 = lows[lows.length - 2] || l1;
    var higherHighs = h1.price > h0.price;
    var higherLows = l1.price > l0.price;
    var lowerHighs = h1.price < h0.price;
    var lowerLows = l1.price < l0.price;
    var trend = "range";
    if (higherHighs && higherLows) trend = "bull";
    else if (lowerHighs && lowerLows) trend = "bear";
    return {
      trend: trend,
      higherHighs: higherHighs,
      higherLows: higherLows,
      lowerHighs: lowerHighs,
      lowerLows: lowerLows,
      lastHigh: h1,
      lastLow: l1,
      prevHigh: h0,
      prevLow: l0,
    };
  }

  // BOS (same direction as trend) / CHoCH (first opposite reaction)
  function detectEvents(candles, swings, i) {
    var st = structureFrom(swings);
    var out = { bos: null, choch: null, structure: st };
    if (!st) return out;
    var price = candles[i].close;
    var lastHigh = st.lastHigh;
    var lastLow = st.lastLow;
    var recentHigh = i - lastHigh.i <= CONF.SWEEP_LOOKBACK + 2;
    var recentLow = i - lastLow.i <= CONF.SWEEP_LOOKBACK + 2;

    if (recentHigh && price > lastHigh.price) {
      out.bos = { kind: "BOS", dir: "buy", level: lastHigh.price, time: candles[i].time, prior: st.trend };
      if (st.trend === "bear") out.choch = { kind: "CHoCH", dir: "buy", level: lastHigh.price, time: candles[i].time, prior: st.trend };
    }
    if (recentLow && price < lastLow.price) {
      out.bos = { kind: "BOS", dir: "sell", level: lastLow.price, time: candles[i].time, prior: st.trend };
      if (st.trend === "bull") out.choch = { kind: "CHoCH", dir: "sell", level: lastLow.price, time: candles[i].time, prior: st.trend };
    }
    return out;
  }

  // Liquidity sweep: wick beyond a recent swing then close back inside
  function detectSweep(candles, swings, i) {
    var c = candles[i];
    var lows = [];
    var highs = [];
    for (var j = 0; j < swings.lows.length; j++) {
      var s = swings.lows[j];
      if (i - s.i > CONF.SWEEP_LOOKBACK && s.i !== i) break;
      if (s.i < i) lows.push(s);
    }
    for (var k = 0; k < swings.highs.length; k++) {
      var sh = swings.highs[k];
      if (i - sh.i > CONF.SWEEP_LOOKBACK && sh.i !== i) break;
      if (sh.i < i) highs.push(sh);
    }
    var lastLow = lows.length ? lows[lows.length - 1] : null;
    var lastHigh = highs.length ? highs[highs.length - 1] : null;
    // sweep of sell-side lows (buy stop hunt): price dives below, closes back above
    if (lastLow && c.low < lastLow.price && c.close > lastLow.price) {
      return { dir: "buy", level: lastLow.price, time: c.time, side: "low" };
    }
    // sweep of buy-side highs (sell stop hunt)
    if (lastHigh && c.high > lastHigh.price && c.close < lastHigh.price) {
      return { dir: "sell", level: lastHigh.price, time: c.time, side: "high" };
    }
    return null;
  }

  // ---------------------------------------------------------------------
  // Order Blocks (last base candle before impulsive move)
  // ---------------------------------------------------------------------

  function detectOrderBlocks(candles, atr, limit) {
    var n = candles.length;
    var bulls = [];
    var bears = [];
    var start = Math.max(2, n - (limit || 150));
    for (var i = start; i < n - 1; i++) {
      var base = candles[i];
      var impulseC = candles[i + 1];
      var a = atr[i] || (base.high - base.low) || 1e-9;
      var move = impulseC.close - impulseC.open;
      var body = Math.abs(move);
      if (body < CONF.OB_IMPULSE_ATR * a) continue;
      var strength = clamp(body / (2.5 * a), 0.2, 1);
      if (move > 0) {
        bulls.push({ i: i, time: base.time, top: base.high, bottom: base.low, strength: strength });
      } else {
        bears.push({ i: i, time: base.time, top: base.high, bottom: base.low, strength: strength });
      }
    }
    return {
      bull: bulls.slice(-CONF.OB_MAX_ZONES),
      bear: bears.slice(-CONF.OB_MAX_ZONES),
    };
  }

  // ---------------------------------------------------------------------
  // Fair Value Gaps (3-candle imbalance)
  // ---------------------------------------------------------------------

  function detectFVGs(candles, limit) {
    var n = candles.length;
    var bulls = [];
    var bears = [];
    var start = Math.max(1, n - (limit || 150));
    for (var i = start; i < n - 1; i++) {
      var prevH = candles[i - 1].high;
      var nextL = candles[i + 1].low;
      if (nextL > prevH) bulls.push({ i: i, time: candles[i].time, top: nextL, bottom: prevH, size: nextL - prevH });
      var prevL = candles[i - 1].low;
      var nextH = candles[i + 1].high;
      if (nextH < prevL) bears.push({ i: i, time: candles[i].time, top: prevL, bottom: nextH, size: prevL - nextH });
    }
    // mark filled (price closed beyond the far edge later) and drop near-zero gaps
    function markFilled(list, dir) {
      return list
        .filter(function (z) {
          if (!(z.size > 0)) return false;
          if (dir < 0) z.filled = false; // placeholder, computed below
          return true;
        })
        .slice(-CONF.FVG_MAX_ZONES);
    }
    bulls = markFilled(bulls, 1);
    bears = markFilled(bears, -1);
    var keptB = [];
    for (var b = 0; b < bulls.length; b++) {
      var z = bulls[b];
      var filled = false;
      for (var c = z.i + 1; c < n; c++) {
        if (candles[c].low <= z.bottom) { filled = true; break; }
      }
      z.filled = filled;
      if (!filled || n - z.i <= 6) keptB.push(z);
    }
    var keptS = [];
    for (var s = 0; s < bears.length; s++) {
      var zs = bears[s];
      var fS = false;
      for (var c2 = zs.i + 1; c2 < n; c2++) {
        if (candles[c2].high >= zs.top) { fS = true; break; }
      }
      zs.filled = fS;
      if (!fS || n - zs.i <= 6) keptS.push(zs);
    }
    return { bull: keptB.slice(-CONF.FVG_MAX_ZONES), bear: keptS.slice(-CONF.FVG_MAX_ZONES) };
  }

  // ---------------------------------------------------------------------
  // Candlestick patterns
  // ---------------------------------------------------------------------

  function detectPattern(candles, i) {
    var out = [];
    if (i < 0 || i >= candles.length) return out;
    var c = candles[i];
    var range = c.high - c.low;
    var body = Math.abs(c.close - c.open);
    var bull = c.close > c.open;
    if (range <= 0) return out;
    var upperWick = c.high - Math.max(c.open, c.close);
    var lowerWick = Math.min(c.open, c.close) - c.low;
    var upperBody = Math.max(c.open, c.close);

    function push(name, dir, strength) {
      out.push({ name: name, dir: dir, strength: strength });
    }

    if (i >= 1) {
      var p = candles[i - 1];
      var pBody = Math.abs(p.close - p.open);
      // engulfing
      if (pBody > 0 && body > pBody && ((p.close < p.open && c.close > c.open && c.open <= p.close && c.close >= p.open))) {
        push("Engolfo de alta", "buy", 2);
      }
      if (pBody > 0 && body > pBody && ((p.close > p.open && c.close < c.open && c.open >= p.close && c.close <= p.open))) {
        push("Engolfo de baixa", "sell", 2);
      }
      // inside bar
      if (range < p.high - p.low && c.high < p.high && c.low > p.low) {
        push(c.close > p.close ? "Inside bar (breakout altista)" : "Inside bar (breakout baixista)", bull ? "buy" : "sell", 1);
      }
    }

    // pin bar / hammer / shooting star
    if (lowerWick >= 2 * body && lowerWick >= 2 * upperWick && body > 0) {
      push(c.close > c.open ? "Martelo" : "Martelo (fundo)", "buy", 2);
    }
    if (upperWick >= 2 * body && upperWick >= 2 * lowerWick && body > 0) {
      push(c.close < c.open ? "Estrela cadente" : "Estrela cadente (topo)", "sell", 2);
    }
    // doji
    if (body <= 0.1 * range && body > 0) {
      push("Doji", null, 0);
    }

    if (i >= 2) {
      var c2 = candles[i];
      var c1 = candles[i - 1];
      var c0 = candles[i - 2];
      var b0 = Math.abs(c0.close - c0.open);
      var b1 = Math.abs(c1.close - c1.open);
      var r0 = c0.high - c0.low;
      // morning star: big red, small indecision, strong green closing into first body
      if (c0.close < c0.open && b0 > 0.5 * r0 && b1 <= 0.4 * r0 && c2.close > c2.open && c2.close > c0.close && c2.close > (c0.open + c0.close) / 2) {
        push("Estrela da manhã", "buy", 3);
      }
      var r0s = c0.high - c0.low;
      if (c0.close > c0.open && b0 > 0.5 * r0s && b1 <= 0.4 * r0s && c2.close < c2.open && c2.close < c0.close && c2.close < (c0.open + c0.close) / 2) {
        push("Estrela da tarde", "sell", 3);
      }
      // three soldiers / crows
      if (
        c2.close > c2.open && c1.close > c1.open && c0.close > c0.open &&
        c1.close > c0.close && c2.close > c1.close &&
        c2.close > Math.max(c1.high, c0.high) - (c1.high - c1.low) * 0.1
      ) {
        push("Três soldados brancos", "buy", 3);
      }
      if (
        c2.close < c2.open && c1.close < c1.open && c0.close < c0.open &&
        c1.close < c0.close && c2.close < c1.close
      ) {
        push("Três corvos negros", "sell", 3);
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // RSI divergence against recent swings
  // ---------------------------------------------------------------------

  function detectDivergence(candles, rsi, swings) {
    var out = { buy: null, sell: null };
    var lows = swings.lows;
    var highs = swings.highs;
    if (lows.length >= 2) {
      var l0 = lows[lows.length - 1];
      var l1 = lows[lows.length - 2];
      var r0 = rsi[l0.i];
      var r1 = rsi[l1.i];
      if (l0.price < l1.price && r0 > r1 && r0 < 62 && candles.length - l0.i <= 14) {
        out.buy = { time: candles[l0.i].time, price: l0.price, strengths: "RSI" };
      }
    }
    if (highs.length >= 2) {
      var h0 = highs[highs.length - 1];
      var h1 = highs[highs.length - 2];
      var rh0 = rsi[h0.i];
      var rh1 = rsi[h1.i];
      if (h0.price > h1.price && rh0 < rh1 && rh0 > 38 && candles.length - h0.i <= 14) {
        out.sell = { time: candles[h0.i].time, price: h0.price };
      }
    }
    return out;
  }

  // ---------------------------------------------------------------------
  // Snapshot builder
  // ---------------------------------------------------------------------

  function analyze(candles, atr, rsi) {
    var swings = findSwings(candles, CONF.SWING_K);
    var structure = structureFrom(swings);
    var events = detectEvents(candles, swings, candles.length - 1);
    var sweep = detectSweep(candles, swings, candles.length - 1);
    var ob = detectOrderBlocks(candles, atr);
    var fvg = detectFVGs(candles);
    var patterns = detectPattern(candles, candles.length - 1);
    var divergence = detectDivergence(candles, rsi, swings);
    return {
      swings: swings,
      structure: structure,
      events: events,
      sweep: sweep,
      ob: ob,
      fvg: fvg,
      patterns: patterns,
      divergence: divergence,
    };
  }

  // ---------------------------------------------------------------------
  // Confluence scorer → signal
  // ---------------------------------------------------------------------

  function zoneNear(snap, kind, dir, price, atrNow) {
    // kind: "ob"|"fvg". Returns the nearest valid zone or null
    var zones = snap[kind][dir];
    var best = null;
    var bestDist = Infinity;
    for (var i = 0; i < zones.length; i++) {
      var z = zones[i];
      if (z.filled && dir === "sell" && z.touched) continue;
      var toTop = z.top - price;
      var toBottom = price - z.bottom;
      var dist = toTop >= 0 ? toTop : toBottom >= 0 ? toBottom : 0; // distance to enter
      if (dir === "buy" && z.filled && z.bottom < price) continue; // already busted
      if (dist < bestDist) {
        bestDist = dist;
        best = z;
      }
    }
    if (!best) return null;
    var cushion = Math.abs(best.top - best.bottom);
    if (bestDist > Math.max(CONF.ZONE_TOUCH_ATR * atrNow, cushion * 0.4)) return null;
    return best;
  }

  function buildSignal(candles, atr, rsi, ema21, snap, htfTrend) {
    var n = candles.length;
    var i = n - 1;
    var c = candles[i];
    var price = c.close;
    if (n < 25) return null;
    var atrNow = atr[i] || (c.high - c.low) || price * 0.004;

    var reasons = [];
    var buy = { score: 30, core: 0, candies: [] };
    var sell = { score: 30, core: 0, candies: [] };

    function add(set, by, reason, coreWeight, zoneSweep) {
      set.score += by;
      if (coreWeight) set.core += coreWeight;
      if (zoneSweep) set.hasZoneSweep = true;
      set.candies.push(reason);
    }

    // --- Structure / trend -------------------------------------------------
    var st = snap.structure;
    if (st) {
      if (st.trend === "bull") add(buy, 8, "Tendência de alta (HH/HL)", false);
      if (st.trend === "bear") add(sell, 8, "Tendência de baixa (LL/LH)", false);
    }
    if (ema21 && ema21.length === n) {
      var e = ema21[i] || price;
      if (price > e) add(buy, 6, "Preço acima da EMA21", false);
      else add(sell, 6, "Preço abaixo da EMA21", false);
    }

    // --- Higher-timeframe trend confluence ----------------------------------
    // Trading against a higher timeframe's trend is one of the most common
    // ways an otherwise-valid setup fails, so this carries real weight.
    if (htfTrend === "bull") { add(buy, 10, "A favor da tendência maior (HTF)", false); add(sell, -14, "Contra a tendência maior (HTF)", false); }
    if (htfTrend === "bear") { add(sell, 10, "A favor da tendência maior (HTF)", false); add(buy, -14, "Contra a tendência maior (HTF)", false); }
    // structural break events
    var ev = snap.events;
    if (ev.choch) {
      add(ev.choch.dir === "buy" ? buy : sell, 12, "CHoCH " + (ev.choch.dir === "buy" ? "altista" : "baixista"), true);
    } else if (ev.bos) {
      add(ev.bos.dir === "buy" ? buy : sell, 10, "BOS " + (ev.bos.dir === "buy" ? "altista" : "baixista"), true);
    }

    // --- Liquidity sweep ----------------------------------------------------
    if (snap.sweep) {
      var sw = snap.sweep;
      add(sw.dir === "buy" ? buy : sell, 15, sw.dir === "buy" ? "Sweep de liquidez (stop loss do lado baixo)" : "Sweep de liquidez (stop loss do lado alto)", 1, true);
    }

    // --- Order block / FVG retest ------------------------------------------
    var obBuy = zoneNear(snap, "ob", "bull", price, atrNow);
    if (obBuy) add(buy, 18, "Reteste de Order Block comprador", 1, true);
    var obSell = zoneNear(snap, "ob", "bear", price, atrNow);
    if (obSell) add(sell, 18, "Reteste de Order Block vendedor", 1, true);
    var fvgBuy = zoneNear(snap, "fvg", "bull", price, atrNow);
    if (fvgBuy) add(buy, 16, "Reteste de Fair Value Gap (desequilíbrio altista)", 1, true);
    var fvgSell = zoneNear(snap, "fvg", "bear", price, atrNow);
    if (fvgSell) add(sell, 16, "Reteste de Fair Value Gap (desequilíbrio baixista)", 1, true);

    // --- Patterns ------------------------------------------------------------
    for (var p = 0; p < snap.patterns.length; p++) {
      var pat = snap.patterns[p];
      if (!pat.dir) continue;
      var pts = pat.strength * 8;
      add(pat.dir === "buy" ? buy : sell, pts, pat.name, pat.strength >= 3 ? 2 : 1);
    }

    // --- RSI divergence ------------------------------------------------------
    if (snap.divergence.buy) add(buy, 10, "Divergência altista de RSI (fundos)", false);
    if (snap.divergence.sell) add(sell, 10, "Divergência baixista de RSI (topos)", false);

    // --- RSI level -----------------------------------------------------------
    if (rsi && rsi.length === n) {
      var r = rsi[i];
      if (r < 30) add(buy, 6, "RSI sobrevendido", false);
      if (r > 70) add(sell, 6, "RSI sobrecomprado", false);
      if (r > 78) add(buy, -10, "RSI extremo (atraso) — evita compra", false);
      if (r < 22) add(sell, -10, "RSI extremo (atraso) — evita venda", false);
    }

    // --- Volume --------------------------------------------------------------
    var vols = candles.slice(Math.max(0, i - 19), i + 1).map(function (x) { return x.volume || 0; });
    var volAvg = vols.reduce(function (a, b) { return a + b; }, 0) / vols.length || 1;
    if ((c.volume || 0) > volAvg * 1.3) add(c.close > c.open ? buy : sell, 6, "Volume acima da média 20", false);

    var best = null;
    var buyScore = Math.round(clamp(buy.score, 30, 97));
    var sellScore = Math.round(clamp(sell.score, 30, 97));
    var buyOk = buy.core >= CONF.ACCEPT_CORE && buyScore >= CONF.SCORE_MIN && (!CONF.REQUIRE_ZONE_OR_SWEEP || buy.hasZoneSweep);
    var sellOk = sell.core >= CONF.ACCEPT_CORE && sellScore >= CONF.SCORE_MIN && (!CONF.REQUIRE_ZONE_OR_SWEEP || sell.hasZoneSweep);
    if (buyOk && sellOk) {
      // both directions hot → pick the dominant one or skip (whipsaw guard)
      if (buyScore - sellScore >= 10) sellOk = false;
      else if (sellScore - buyScore >= 10) buyOk = false;
      else return null;
    }
    if (buyOk) best = { side: "buy", score: buyScore, reasons: buy.candies };
    else if (sellOk) best = { side: "sell", score: sellScore, reasons: sell.candies };
    if (!best) return null;

    // setup label
    var kinds = [];
    var lower = best.reasons.map(function (r) { return r.toLowerCase(); });
    if (best.side === "buy") {
      if (lower.some(function (r) { return r.indexOf("sweep") >= 0; })) kinds.push("Sweep");
      if (lower.some(function (r) { return r.indexOf("order block") >= 0; })) kinds.push("OB");
      if (lower.some(function (r) { return r.indexOf("fvg") >= 0; })) kinds.push("FVG");
      if (lower.some(function (r) { return r.indexOf("choch") >= 0; })) kinds.push("CHoCH");
      if (lower.some(function (r) { return r.indexOf("bos") >= 0; })) kinds.push("BOS");
      if (lower.some(function (r) { return r.indexOf("engolfo") >= 0; })) kinds.push("Engolfo");
      if (lower.some(function (r) { return r.indexOf("martelo") >= 0 || r.indexOf("estrela da manhã") >= 0 || r.indexOf("soldados") >= 0; })) kinds.push("Reversão");
    } else {
      if (lower.some(function (r) { return r.indexOf("sweep") >= 0; })) kinds.push("Sweep");
      if (lower.some(function (r) { return r.indexOf("order block") >= 0; })) kinds.push("OB");
      if (lower.some(function (r) { return r.indexOf("fvg") >= 0; })) kinds.push("FVG");
      if (lower.some(function (r) { return r.indexOf("choch") >= 0; })) kinds.push("CHoCH");
      if (lower.some(function (r) { return r.indexOf("bos") >= 0; })) kinds.push("BOS");
      if (lower.some(function (r) { return r.indexOf("engolfo") >= 0; })) kinds.push("Engolfo");
      if (lower.some(function (r) { return r.indexOf("estrela cadente") >= 0 || r.indexOf("estrela da tarde") >= 0 || r.indexOf("corvos") >= 0; })) kinds.push("Reversão");
    }
    var setup = kinds.join(" + ") || "Setup clássico";

    var sl = best.side === "buy" ? price - CONF.SL_ATR * atrNow : price + CONF.SL_ATR * atrNow;
    var tp = best.side === "buy" ? price + CONF.TP_ATR * atrNow : price - CONF.TP_ATR * atrNow;

    return {
      side: best.side,
      entry: price,
      sl: sl,
      tp: tp,
      confidence: best.score,
      reasons: best.reasons.slice(0, 6),
      setup: setup,
      symbol: snap.symbol || "",
      timeframe: snap.timeframe || "",
    };
  }

  function tierName(confidence) {
    if (confidence >= 90) return "FORTE";
    if (confidence >= 80) return "MÉDIO";
    return "FRACA";
  }

  // ---------------------------------------------------------------------
  // Monte Carlo (bootstrap of real trade outcomes, fixed RR, 1% risk)
  // ---------------------------------------------------------------------

  function monteCarlo(wins, opts) {
    opts = opts || {};
    var sims = opts.simulations || CONF.MC_SIMS;
    var risk = (opts.riskPct || CONF.MC_RISK_PCT) / 100;
    var rr = opts.rr || CONF.RR;
    var n = wins.length;
    if (!n) return null;
    var winsCount = 0;
    for (var i = 0; i < n; i++) if (wins[i]) winsCount++;

    var winRate = winsCount / n;
    var lossesCount = n - winsCount;
    var profitFactor = lossesCount ? (winsCount * rr) / lossesCount : Infinity;
    var edgeR = winRate * rr - (1 - winRate);

    var dds = [];
    var losRuns = [];
    var profits = 0;
    var worstRun = 0;

    for (var s = 0; s < sims; s++) {
      var bal = 100;
      var peak = 100;
      var maxDD = 0;
      var streak = 0;
      var runMax = 0;
      for (var t = 0; t < n; t++) {
        var win = wins[Math.floor(Math.random() * n)];
        if (win) {
          bal *= 1 + rr * risk;
          streak = 0;
        } else {
          bal *= 1 - risk;
          streak++;
          if (streak > runMax) runMax = streak;
        }
        if (bal > peak) peak = bal;
        var dd = (peak - bal) / peak * 100;
        if (dd > maxDD) maxDD = dd;
      }
      dds.push(maxDD);
      losRuns.push(runMax);
      if (bal > 100) profits++;
      if (runMax > worstRun) worstRun = runMax;
    }

    dds.sort(function (a, b) { return a - b; });
    losRuns.sort(function (a, b) { return a - b; });
    var dd95 = dds[Math.floor(dds.length * 0.95)] || 0;
    var run95 = losRuns[Math.floor(losRuns.length * 0.95)] || 0;
    var avgDD = dds.reduce(function (a, b) { return a + b; }, 0) / dds.length;

    return {
      n: n,
      winRate: winRate,
      edgeR: edgeR,
      profitFactor: profitFactor,
      pProfit: profits / sims,
      avgMaxDD: avgDD,
      dd95: dd95,
      run95: run95,
      worstRun: worstRun,
      sims: sims,
    };
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  return {
    CONF: CONF,
    clamp: clamp,
    emaSeries: emaSeries,
    smaSeries: smaSeries,
    rsiSeries: rsiSeries,
    atrSeries: atrSeries,
    findSwings: findSwings,
    structureFrom: structureFrom,
    detectEvents: detectEvents,
    detectSweep: detectSweep,
    detectOrderBlocks: detectOrderBlocks,
    detectFVGs: detectFVGs,
    detectPattern: detectPattern,
    detectDivergence: detectDivergence,
    analyze: analyze,
    zoneNear: zoneNear,
    buildSignal: buildSignal,
    tierName: tierName,
    monteCarlo: monteCarlo,
  };
});