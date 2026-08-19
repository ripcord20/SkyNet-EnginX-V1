// traffic.js — Interface Traffic Live Monitor (ApexCharts edition, modernized)

// Helper: append ?device_id=N otomatis kalau MikrotikSelector tersedia.
// Konsisten dengan halaman /monitoring/pppoe — semua call mikrotik
// menghormati device yg dipilih user.
function _withDev(url) {
  return (window.MikrotikSelector && typeof window.MikrotikSelector.withDevice === 'function')
    ? window.MikrotikSelector.withDevice(url)
    : url;
}

const TrafficPage = {
  interfaces: [],
  selected: new Set(),
  apexChart: null,
  pollTimer: null,

  // Warna untuk per-interface chart (palet kaya, high-contrast)
  perIfColors: ['#2563eb','#ea580c','#16a34a','#dc2626','#0891b2','#d97706','#7c3aed','#db2777'],

  INTERVAL: 2000,        // default 2s — grafik live lebih rapat
  MAX_PTS: 30,           // default 1m window (60s / 2s = 30 pts)
  timeMin: 1,            // active time range (minutes)
  chartMode: 'aggregate',// 'aggregate' | 'per-interface'
  POLL_CAP: 24,          // max interface per tick (selaras backend)

  buf: { rx:[], tx:[], ts:[] },  // aggregate buffer
  bufPer: {},                    // per-interface buffer { name: { rx:[], tx:[], ts:[] } }
  lastPush: 0,
  _eventsBound: false,           // guard supaya bindEvents tidak dobel saat reset
  _pollInFlight: false,
  _lastSocket: 0,
  _sock: null,
  _resizeObs: null,
  _resizeTimer: null,
  _liveTimer: null,

  async init() {
    this.bindEvents();
    this.bindChartResize();
    this.bindSocket();
    await this.loadInterfaces();
    await this.pollTraffic();
    this.startPolling();
    this.bindTimeRange();
    this.bindChartMode();
  },

  chartHeight() {
    const w = window.innerWidth || 1200;
    if (w <= 480) return 200;
    if (w <= 768) return 240;
    return 360;
  },

  chartRangeMs() {
    return Math.max(1, this.timeMin) * 60 * 1000;
  },

  animSpeed() {
    return Math.max(280, Math.min(this.INTERVAL, 1200));
  },

  // Nama yang di-poll: interface ter-track dulu (untuk grafik), lalu running.
  pollNames() {
    const selected = Array.from(this.selected);
    const running = this.interfaces
      .filter(i => i.running && !i.disabled && !this.selected.has(i.name))
      .map(i => i.name);
    return [...selected, ...running].slice(0, this.POLL_CAP);
  },

  setLive(on) {
    const chip = document.getElementById('chartLiveChip');
    if (chip) chip.style.display = on && this.selected.size ? 'inline-flex' : 'none';
    if (this._liveTimer) clearTimeout(this._liveTimer);
    if (on) {
      this._liveTimer = setTimeout(() => {
        const el = document.getElementById('chartLiveChip');
        if (el) el.style.display = 'none';
      }, Math.max(this.INTERVAL * 3, 6000));
    }
  },

  applyChartHeight() {
    const h = this.chartHeight();
    const area = document.getElementById('mainChart');
    const empty = document.getElementById('emptyChart');
    if (area) area.style.height = h + 'px';
    if (empty) empty.style.height = h + 'px';
    return h;
  },

  // Reset state untuk device baru — dipanggil dari MikrotikSelector.onChange.
  // Hentikan polling lama, buang buffer & chart, lalu re-init data untuk device baru.
  async resetForDevice() {
    if (this.pollTimer) { clearInterval(this.pollTimer); this.pollTimer = null; }
    this.interfaces = [];
    this.selected.clear();
    this.buf    = { rx:[], tx:[], ts:[] };
    this.bufPer = {};
    this.lastPush = 0;
    this._lastSocket = 0;
    this._pollInFlight = false;
    if (this._sock && this._sock.connected) {
      try { this._sock.emit('interface:stop_monitor'); } catch (_) {}
    }
    if (this.apexChart) {
      try { this.apexChart.destroy(); } catch(_) {}
      this.apexChart = null;
    }
    // Re-render kosong supaya UI tidak nampak data lama
    const grid = document.getElementById('ifaceGrid');
    if (grid) grid.innerHTML = '<div class="loading-state">Memuat interface...</div>';
    const cnt = document.getElementById('ifaceCount');
    if (cnt) cnt.textContent = '— interface';
    // Reload data device baru
    await this.loadInterfaces();
    await this.pollTraffic();
    this.startPolling();
  },

  async loadInterfaces() {
    const data = await App.api(_withDev('/mikrotik/interfaces'));
    if (data?.success) {
      this.interfaces = data.data;
      this.renderCards();
      this.updateSummary();
      document.getElementById('ifaceCount').textContent = `${this.interfaces.length} interface`;
    } else {
      document.getElementById('ifaceGrid').innerHTML =
        `<div class="loading-state" style="color:#dc2626;">
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>
          <br>${data?.message || 'Gagal memuat interface'}
        </div>`;
    }
  },

  applyTrafficStats(stats, requestedNames) {
    const list = Array.isArray(stats) ? stats : [];
    const statsMap = {};
    list.forEach(s => { if (s && s.name) statsMap[s.name] = s; });
    const requested = requestedNames ? new Set(requestedNames) : null;

    this.interfaces.forEach(iface => {
      const s = statsMap[iface.name];
      if (s) {
        iface._rxBps = s.rxBitsPerSecond || 0;
        iface._txBps = s.txBitsPerSecond || 0;
      } else if (!requested || requested.has(iface.name)) {
        iface._rxBps = 0;
        iface._txBps = 0;
      }
    });

    this.updateCards(statsMap);
    this.pushChartData(list);
    this.updateSummary();
    this.setLive(true);
  },

  async pollTraffic() {
    if (this._pollInFlight) return;
    // Socket sudah mengirim tick baru — jangan dobel REST di tick yang sama
    if (this._lastSocket && (Date.now() - this._lastSocket) < Math.max(700, this.INTERVAL * 0.65)) {
      return;
    }
    this._pollInFlight = true;
    try {
      const names = this.pollNames();
      const url = names.length
        ? `/mikrotik/interfaces/monitor-selected?names=${encodeURIComponent(names.join(','))}`
        : '/mikrotik/interfaces/monitor';
      const data = await App.api(_withDev(url));
      if (!data?.success) return;
      this.applyTrafficStats(Array.isArray(data.data) ? data.data : [], names);
    } catch (e) {
      console.warn('pollTraffic', e);
    } finally {
      this._pollInFlight = false;
    }
  },

  startPolling() {
    const sel = document.getElementById('pollInterval');
    const interval = parseInt(sel && sel.value, 10) || 2000;
    this.INTERVAL = interval;
    this.MAX_PTS = Math.max(20, Math.ceil(this.timeMin * 60 * 1000 / this.INTERVAL));
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => this.pollTraffic(), interval);
    this.syncSocketMonitor();
    if (this.apexChart) {
      try {
        this.apexChart.updateOptions({
          chart: { animations: { enabled: true, easing: 'linear', dynamicAnimation: { speed: this.animSpeed() } } }
        }, false, false);
      } catch (_) {}
    }
  },

  renderCards() {
    const grid = document.getElementById('ifaceGrid');
    if (!this.interfaces.length) {
      grid.innerHTML = `<div class="loading-state">Tidak ada interface ditemukan</div>`;
      return;
    }

    // Reset sparkline buffer per card (supaya fresh on re-render)
    if (!this._cardSpark) this._cardSpark = {};

    grid.innerHTML = this.interfaces.map((iface) => {
      const sel = this.selected.has(iface.name);
      const up  = iface.running;
      const id  = safeid(iface.name);
      return `
        <div class="iface-card ${sel ? 'selected' : ''} ${!up ? 'card-down' : ''}"
             id="icard-${id}" onclick="TrafficPage.toggleSelect('${esc(iface.name)}')">
          <div class="iface-top">
            <span class="iface-dot ${up ? 'dot-up' : 'dot-down'}"></span>
            <span class="iface-name" title="${esc(iface.name)}">${esc(iface.name)}</span>
            <span class="iface-type-badge">${esc(iface.type)}</span>
            <span class="track-tag ${sel ? 'active' : ''}" id="trk-${id}">
              ${sel
                ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>Tracked'
                : 'Track'}
            </span>
          </div>
          ${iface.comment ? `<div class="iface-comment" title="${esc(iface.comment)}">${esc(iface.comment)}</div>` : ''}
          <div class="iface-rates">
            <div class="rate-cell">
              <div class="rate-head">
                <span class="rate-arrow arrow-rx"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="19 12 12 19 5 12"/><line x1="12" y1="5" x2="12" y2="19"/></svg></span>
                <span class="rate-lbl">RX</span>
              </div>
              <div><span class="rate-val rx rx-rate-${id}">0.00</span><span class="rate-unit">Mbps</span></div>
              <div class="rate-spark"><svg viewBox="0 0 100 18" preserveAspectRatio="none">
                <path class="rsp-fill" id="csp-rx-fill-${id}" d="" fill="#1d4ed8" opacity=".14"/>
                <path class="rsp-line" id="csp-rx-line-${id}" d="" stroke="#1d4ed8"/>
              </svg></div>
            </div>
            <div class="rate-cell">
              <div class="rate-head">
                <span class="rate-arrow arrow-tx"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="5 12 12 5 19 12"/><line x1="12" y1="19" x2="12" y2="5"/></svg></span>
                <span class="rate-lbl">TX</span>
              </div>
              <div><span class="rate-val tx tx-rate-${id}">0.00</span><span class="rate-unit">Mbps</span></div>
              <div class="rate-spark"><svg viewBox="0 0 100 18" preserveAspectRatio="none">
                <path class="rsp-fill" id="csp-tx-fill-${id}" d="" fill="#c2410c" opacity=".14"/>
                <path class="rsp-line" id="csp-tx-line-${id}" d="" stroke="#c2410c"/>
              </svg></div>
            </div>
          </div>
          <div class="iface-footer">
            <span class="iface-mac" title="${esc(iface.macAddress) || ''}">${esc(iface.macAddress) || 'MAC: —'}</span>
            <span class="status-pill ${up ? 'pill-running' : 'pill-down'}">${up ? 'Running' : 'Down'}</span>
          </div>
        </div>`;
    }).join('');
  },

  updateCards(statsMap) {
    if (!this._cardSpark) this._cardSpark = {};

    Object.entries(statsMap).forEach(([name, s]) => {
      const rxMbps = s.rxBitsPerSecond / 1_000_000;
      const txMbps = s.txBitsPerSecond / 1_000_000;
      const id = safeid(name);
      const rxEl = document.querySelector(`.rx-rate-${id}`);
      const txEl = document.querySelector(`.tx-rate-${id}`);
      // Format: nilai > 100 Mbps → 0 desimal, > 10 Mbps → 1 desimal, sisanya 2 desimal
      const fmt = v => v >= 100 ? v.toFixed(0) : v >= 10 ? v.toFixed(1) : v.toFixed(2);
      if (rxEl) rxEl.textContent = fmt(rxMbps);
      if (txEl) txEl.textContent = fmt(txMbps);

      // Push ke buffer per-card (max 20 points)
      if (!this._cardSpark[name]) this._cardSpark[name] = { rx:[], tx:[] };
      const buf = this._cardSpark[name];
      buf.rx.push(rxMbps); buf.tx.push(txMbps);
      while (buf.rx.length > 20) buf.rx.shift();
      while (buf.tx.length > 20) buf.tx.shift();

      // Render sparkline
      this.renderCardSpark(id, 'rx', buf.rx);
      this.renderCardSpark(id, 'tx', buf.tx);
    });
  },

  renderCardSpark(id, key, vals) {
    if (!vals || vals.length < 2) return;
    const W = 100, H = 18;
    const mn = 0; // baseline dari 0, jadi nilai rendah kelihatan rendah
    const mx = Math.max(...vals, 0.01);
    const rng = mx - mn || 1;
    const pts = vals.map((v, i) => [
      (i / (vals.length - 1)) * W,
      H - ((v - mn) / rng) * (H - 3) - 1.5
    ]);
    // Smooth bezier
    const d = pts.reduce((acc, [x, y], i) => {
      if (!i) return `M${x.toFixed(1)},${y.toFixed(1)}`;
      const [px, py] = pts[i - 1];
      const cx = (px + x) / 2;
      return acc + ` C${cx.toFixed(1)},${py.toFixed(1)} ${cx.toFixed(1)},${y.toFixed(1)} ${x.toFixed(1)},${y.toFixed(1)}`;
    }, '');
    const fp = pts[0], lp = pts[pts.length - 1];
    const fill = d + ` L${lp[0].toFixed(1)},${H} L${fp[0].toFixed(1)},${H} Z`;

    const lineEl = document.getElementById(`csp-${key}-line-${id}`);
    const fillEl = document.getElementById(`csp-${key}-fill-${id}`);
    if (lineEl) lineEl.setAttribute('d', d);
    if (fillEl) fillEl.setAttribute('d', fill);
  },

  updateSummary() {
    const running = this.interfaces.filter(i => i.running).length;
    const down    = this.interfaces.filter(i => !i.running && !i.disabled).length;
    let totalRx = 0, totalTx = 0;
    this.interfaces.forEach(i => {
      totalRx += (i._rxBps || 0) / 1_000_000;
      totalTx += (i._txBps || 0) / 1_000_000;
    });
    document.getElementById('sumRunning').textContent = running;
    document.getElementById('sumDown').textContent    = down;
    document.getElementById('sumRx').textContent      = totalRx.toFixed(1);
    document.getElementById('sumTx').textContent      = totalTx.toFixed(1);
  },

  toggleSelect(name) {
    if (this.selected.has(name)) {
      this.selected.delete(name);
      delete this.bufPer[name];
    } else {
      if (this.selected.size >= 8) { alert('Maksimal 8 interface untuk live chart'); return; }
      this.selected.add(name);
    }
    this.recomputeAggregateBuf();
    this.updateSelectionUI();
    this.toggleChartVisibility();
    this.refreshPerIfLegend();
    this.syncSocketMonitor();
    if (this.selected.size) {
      if (this.apexChart) this.updateChartSeries();
      else this.createChart();
    }
  },

  // Rebuild aggregate series dari buffer per-interface yang masih di-track
  // supaya grafik tidak reset setiap kali user klik Track.
  recomputeAggregateBuf() {
    const names = Array.from(this.selected);
    if (!names.length) {
      this.buf = { rx: [], tx: [], ts: [] };
      return;
    }
    const tsSet = new Set();
    names.forEach(n => {
      const b = this.bufPer[n];
      if (b && b.ts) b.ts.forEach(t => tsSet.add(t));
    });
    const ts = Array.from(tsSet).sort((a, b) => a - b).slice(-this.MAX_PTS);
    const rx = [], tx = [];
    ts.forEach(t => {
      let sRx = 0, sTx = 0;
      names.forEach(n => {
        const b = this.bufPer[n];
        if (!b) return;
        const idx = b.ts.indexOf(t);
        if (idx >= 0) {
          sRx += b.rx[idx] || 0;
          sTx += b.tx[idx] || 0;
        }
      });
      rx.push(sRx); tx.push(sTx);
    });
    this.buf = { rx, tx, ts };
  },

  updateSelectionUI() {
    document.getElementById('selectedCount').textContent = `${this.selected.size} selected untuk live chart`;
    this.interfaces.forEach(iface => {
      const card = document.getElementById(`icard-${safeid(iface.name)}`);
      if (!card) return;
      const sel = this.selected.has(iface.name);
      card.classList.toggle('selected', sel);
      const tag = card.querySelector('.track-tag');
      if (tag) {
        tag.className = `track-tag ${sel ? 'active' : ''}`;
        tag.innerHTML = sel
          ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><polyline points="20 6 9 17 4 12"/></svg>Tracked'
          : 'Track';
      }
    });
  },

  toggleChartVisibility() {
    const chartEl  = document.getElementById('mainChart');
    const emptyMsg = document.getElementById('emptyChart');
    this.applyChartHeight();
    if (this.selected.size > 0) {
      if (chartEl) chartEl.style.display  = 'block';
      if (emptyMsg) emptyMsg.style.display = 'none';
      ['tc-rx-cur','tc-tx-cur','tc-rx-avg','tc-tx-avg','tc-rx-max','tc-tx-max'].forEach(id => {
        const el = document.getElementById(id); if (el && !this.buf.rx.length) el.textContent = '0';
      });
    } else {
      if (chartEl) chartEl.style.display  = 'none';
      if (emptyMsg) emptyMsg.style.display = 'flex';
      if (this.apexChart) { try { this.apexChart.destroy(); } catch(e) {} this.apexChart = null; }
      this.setLive(false);
    }
  },

  // ── Push data ke buffer + chart ────────────────────────────
  pushChartData(statsArray) {
    if (!this.selected.size) return;

    // Aggregate sum
    let sumRx = 0, sumTx = 0;
    statsArray.forEach(s => {
      if (!this.selected.has(s.name)) return;
      sumRx += (s.rxBitsPerSecond || 0);
      sumTx += (s.txBitsPerSecond || 0);
    });

    const now = Date.now();
    this.buf.rx.push(sumRx);
    this.buf.tx.push(sumTx);
    this.buf.ts.push(now);
    while (this.buf.rx.length > this.MAX_PTS) {
      this.buf.rx.shift(); this.buf.tx.shift(); this.buf.ts.shift();
    }

    // Per-interface buffer
    this.selected.forEach(name => {
      if (!this.bufPer[name]) this.bufPer[name] = { rx:[], tx:[], ts:[] };
      const s = statsArray.find(x => x.name === name);
      this.bufPer[name].rx.push(s ? (s.rxBitsPerSecond || 0) : 0);
      this.bufPer[name].tx.push(s ? (s.txBitsPerSecond || 0) : 0);
      this.bufPer[name].ts.push(now);
      while (this.bufPer[name].rx.length > this.MAX_PTS) {
        this.bufPer[name].rx.shift();
        this.bufPer[name].tx.shift();
        this.bufPer[name].ts.shift();
      }
    });

    // Bersihkan interface yang tidak lagi di-select
    Object.keys(this.bufPer).forEach(name => {
      if (!this.selected.has(name)) delete this.bufPer[name];
    });

    this.lastPush = now;

    if (!this.apexChart) {
      this.createChart();
    } else {
      this.updateChartSeries();
    }

    this.updateChartStats();
  },

  // ── Series builder ─────────────────────────────────────────
  buildSeries() {
    if (this.chartMode === 'per-interface') {
      const series = [];
      const names = Array.from(this.selected);
      names.forEach((name, idx) => {
        const b = this.bufPer[name];
        if (!b) return;
        const color = this.perIfColors[idx % this.perIfColors.length];
        series.push({
          name: `${name} ↓`,
          data: b.rx.map((v, i) => [b.ts[i], v]),
          color
        });
        series.push({
          name: `${name} ↑`,
          data: b.tx.map((v, i) => [b.ts[i], -v]),  // TX negatif (mirrored)
          color
        });
      });
      return series;
    }
    // aggregate mode
    return [
      { name: 'RX Download', data: this.buf.rx.map((v, i) => [this.buf.ts[i], v]),  color: '#06b6d4' },
      { name: 'TX Upload',   data: this.buf.tx.map((v, i) => [this.buf.ts[i], -v]), color: '#f59e0b' }
    ];
  },

  // ── Annotations: peak & avg lines ──────────────────────────
  buildAnnotations() {
    if (this.chartMode === 'per-interface') return { yaxis: [], points: [] };
    if (!this.buf.rx.length) return { yaxis: [], points: [] };

    const rxMax = Math.max(...this.buf.rx);
    const txMax = Math.max(...this.buf.tx);
    const rxAvg = this.buf.rx.reduce((a,b)=>a+b,0) / this.buf.rx.length;
    const txAvg = this.buf.tx.reduce((a,b)=>a+b,0) / this.buf.tx.length;

    const rxPeakIdx = this.buf.rx.indexOf(rxMax);
    const txPeakIdx = this.buf.tx.indexOf(txMax);

    const yaxis = [];
    if (rxAvg > 0) {
      yaxis.push({
        y: rxAvg,
        borderColor: '#06b6d4',
        strokeDashArray: 4,
        opacity: 0.6,
        label: {
          borderColor: '#06b6d4',
          style: { color: '#fff', background: '#06b6d4', fontSize: '10px', fontWeight: 700 },
          text: `avg ↓ ${bpsShort(rxAvg)}`,
          position: 'left',
          offsetX: 70
        }
      });
    }
    if (txAvg > 0) {
      yaxis.push({
        y: -txAvg,
        borderColor: '#f59e0b',
        strokeDashArray: 4,
        opacity: 0.6,
        label: {
          borderColor: '#f59e0b',
          style: { color: '#fff', background: '#f59e0b', fontSize: '10px', fontWeight: 700 },
          text: `avg ↑ ${bpsShort(txAvg)}`,
          position: 'left',
          offsetX: 70
        }
      });
    }

    const points = [];
    if (rxMax > 0 && this.buf.ts[rxPeakIdx]) {
      points.push({
        x: this.buf.ts[rxPeakIdx],
        y: rxMax,
        marker: { size: 6, fillColor: '#fff', strokeColor: '#06b6d4', strokeWidth: 2.5, radius: 2 },
        label: {
          borderColor: '#06b6d4',
          offsetY: -6,
          style: { color: '#fff', background: '#06b6d4', fontSize: '10px', fontWeight: 700, padding: { left:6, right:6, top:2, bottom:2 } },
          text: `peak ${bpsShort(rxMax)}`
        }
      });
    }
    if (txMax > 0 && this.buf.ts[txPeakIdx]) {
      points.push({
        x: this.buf.ts[txPeakIdx],
        y: -txMax,
        marker: { size: 6, fillColor: '#fff', strokeColor: '#f59e0b', strokeWidth: 2.5, radius: 2 },
        label: {
          borderColor: '#f59e0b',
          offsetY: 18,
          style: { color: '#fff', background: '#f59e0b', fontSize: '10px', fontWeight: 700, padding: { left:6, right:6, top:2, bottom:2 } },
          text: `peak ${bpsShort(txMax)}`
        }
      });
    }

    return { yaxis, points };
  },

  createChart() {
    const el = document.getElementById('mainChart');
    if (!el) return;
    el.innerHTML = '';

    const series = this.buildSeries();
    const ann = this.buildAnnotations();

    const options = {
      chart: {
        type: 'area',
        height: this.applyChartHeight(),
        width: '100%',
        background: 'transparent',
        toolbar: { show: false },
        fontFamily: "'Plus Jakarta Sans', sans-serif",
        zoom: { enabled: false },
        animations: {
          enabled: true,
          easing: 'linear',
          dynamicAnimation: { speed: this.animSpeed() }
        },
        sparkline: { enabled: false },
        redrawOnParentResize: true,
        redrawOnWindowResize: true,
        dropShadow: {
          enabled: true,
          top: 2,
          left: 0,
          blur: 4,
          color: '#0f172a',
          opacity: 0.08
        }
      },
      theme: { mode: 'light' },
      series,
      colors: series.map(s => s.color),
      fill: {
        type: 'gradient',
        gradient: {
          type: 'vertical',
          shadeIntensity: 1,
          opacityFrom: 0.45,
          opacityTo: 0.02,
          stops: [0, 95]
        }
      },
      stroke: {
        curve: 'smooth',
        width: 2.2,
        lineCap: 'round'
      },
      dataLabels: { enabled: false },
      legend: { show: false },
      grid: {
        borderColor: '#eef2f7',
        strokeDashArray: 3,
        xaxis: { lines: { show: false } },
        yaxis: { lines: { show: true } },
        padding: { top: 10, right: 14, bottom: 0, left: 8 }
      },
      xaxis: {
        type: 'datetime',
        range: this.chartRangeMs(),
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8', fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 600 },
          datetimeUTC: false,
          format: 'HH:mm:ss',
          rotate: window.innerWidth <= 768 ? -35 : 0,
          hideOverlappingLabels: true
        },
        axisBorder: { show: false },
        axisTicks: { show: false },
        crosshairs: {
          show: true,
          stroke: { color: '#cbd5e1', width: 1, dashArray: 3 }
        }
      },
      yaxis: {
        tickAmount: window.innerWidth <= 768 ? 4 : 5,
        forceNiceScale: true,
        labels: {
          style: { fontSize: '10px', colors: '#94a3b8', fontFamily: 'Plus Jakarta Sans, sans-serif', fontWeight: 600 },
          maxWidth: window.innerWidth <= 480 ? 56 : 72,
          // TX negatif, tampilkan nilai absolut
          formatter: v => bpsShort(Math.abs(v))
        }
      },
      tooltip: {
        theme: 'light',
        shared: true,
        intersect: false,
        followCursor: true,
        x: { format: 'HH:mm:ss' },
        y: {
          formatter: (v, { seriesIndex, w }) => {
            const n = w.globals.seriesNames[seriesIndex] || '';
            return bps(Math.abs(v)) + ' ' + (/↑|TX/i.test(n) ? '↑' : '↓');
          }
        },
        style: { fontSize: '11px', fontFamily: 'Plus Jakarta Sans, sans-serif' },
        marker: { show: true }
      },
      markers: {
        size: 0,
        hover: { size: 5, sizeOffset: 3 },
        strokeWidth: 0
      },
      annotations: ann
    };

    this.apexChart = new ApexCharts(el, options);
    this.apexChart.render();
  },

  updateChartSeries() {
    if (!this.apexChart) return;
    try {
      const series = this.buildSeries();
      this.apexChart.updateSeries(series, true);

      if (this.chartMode === 'aggregate') {
        this.apexChart.updateOptions({
          annotations: this.buildAnnotations(),
          colors: series.map(s => s.color)
        }, false, false);
      } else {
        this.apexChart.updateOptions({
          annotations: { yaxis: [], points: [] },
          colors: series.map(s => s.color)
        }, false, false);
      }
    } catch (e) {
      console.warn('chart update failed, recreate', e);
      try { this.apexChart.destroy(); } catch(_) {}
      this.apexChart = null;
      this.createChart();
    }
  },

  updateChartStats() {
    const s = (arr) => {
      if (!arr.length) return { cur: 0, avg: 0, max: 0 };
      let sum = 0, max = 0;
      arr.forEach(v => { sum += v; if (v > max) max = v; });
      return { cur: arr[arr.length - 1], avg: sum / arr.length, max };
    };
    const rxS = s(this.buf.rx), txS = s(this.buf.tx);
    const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = bpsShort(v); };
    set('tc-rx-cur', rxS.cur); set('tc-rx-avg', rxS.avg); set('tc-rx-max', rxS.max);
    set('tc-tx-cur', txS.cur); set('tc-tx-avg', txS.avg); set('tc-tx-max', txS.max);
  },

  // ── Time range 1m / 5m / 10m / 30m ──────────────────────────
  setTimeRange(min) {
    this.timeMin = min;
    this.MAX_PTS = Math.max(20, Math.ceil(min * 60 * 1000 / this.INTERVAL));
    while (this.buf.rx.length > this.MAX_PTS) {
      this.buf.rx.shift(); this.buf.tx.shift(); this.buf.ts.shift();
    }
    Object.values(this.bufPer).forEach(b => {
      while (b.rx.length > this.MAX_PTS) {
        b.rx.shift(); b.tx.shift(); b.ts.shift();
      }
    });
    document.querySelectorAll('.tc-time-btn').forEach(btn => {
      btn.classList.toggle('active', +btn.dataset.min === min);
    });
    if (this.apexChart) {
      try {
        this.apexChart.updateOptions({ xaxis: { range: this.chartRangeMs() } }, false, false);
      } catch (_) {}
      this.updateChartSeries();
    }
  },

  bindTimeRange() {
    document.querySelectorAll('.tc-time-btn').forEach(btn => {
      btn.addEventListener('click', () => this.setTimeRange(+btn.dataset.min));
    });
  },

  // ── Chart mode toggle: Aggregate / Per Interface ───────────
  bindChartMode() {
    document.querySelectorAll('.tc-mode-btn').forEach(btn => {
      btn.addEventListener('click', () => {
        const mode = btn.dataset.mode;
        if (mode === this.chartMode) return;
        this.chartMode = mode;
        document.querySelectorAll('.tc-mode-btn').forEach(b => {
          b.classList.toggle('active', b.dataset.mode === mode);
        });
        const statsEl = document.getElementById('chartAggStats');
        if (statsEl) statsEl.style.display = mode === 'aggregate' ? '' : 'none';
        const legendEl = document.getElementById('chartPerIfLegend');
        if (legendEl) legendEl.style.display = mode === 'per-interface' ? '' : 'none';
        this.refreshPerIfLegend();
        if (this.apexChart) {
          try { this.apexChart.destroy(); } catch(e) {}
          this.apexChart = null;
          this.createChart();
        }
      });
    });
  },

  refreshPerIfLegend() {
    const legendEl = document.getElementById('chartPerIfLegend');
    if (!legendEl) return;
    const names = Array.from(this.selected);
    legendEl.innerHTML = names.map((n, i) => {
      const c = this.perIfColors[i % this.perIfColors.length];
      return `<span class="per-if-chip"><span class="per-if-swatch" style="background:${c}"></span>${esc(n)}</span>`;
    }).join('');
  },

  bindEvents() {
    if (this._eventsBound) return;   // jangan dobel — penting karena init() bisa dipanggil ulang via resetForDevice indirect (kalau ada bug)
    this._eventsBound = true;
    document.getElementById('btnRefresh').addEventListener('click', async () => {
      await this.loadInterfaces();
      await this.pollTraffic();
    });
    document.getElementById('btnSelectAll').addEventListener('click', () => {
      this.selected.clear();
      this.interfaces.filter(i => i.running).slice(0, 8).forEach(i => this.selected.add(i.name));
      this.recomputeAggregateBuf();
      if (this.apexChart) { try { this.apexChart.destroy(); } catch(e) {} this.apexChart = null; }
      this.updateSelectionUI();
      this.toggleChartVisibility();
      this.refreshPerIfLegend();
      this.syncSocketMonitor();
      if (this.selected.size) this.createChart();
    });
    document.getElementById('btnClearAll').addEventListener('click', () => {
      this.selected.clear();
      this.buf = { rx:[], tx:[], ts:[] };
      this.bufPer = {};
      this.updateSelectionUI();
      this.toggleChartVisibility();
      this.refreshPerIfLegend();
      this.syncSocketMonitor();
    });
    document.getElementById('pollInterval').addEventListener('change', () => this.startPolling());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      this._lastSocket = 0;
      this.pollTraffic();
      this.syncSocketMonitor();
    });
  },

  bindChartResize() {
    const host = document.getElementById('mainChartSection') || document.getElementById('mainChart');
    if (!host) return;
    const onResize = () => {
      clearTimeout(this._resizeTimer);
      this._resizeTimer = setTimeout(() => {
        if (!this.apexChart) { this.applyChartHeight(); return; }
        try {
          this.apexChart.updateOptions({
            chart: { height: this.applyChartHeight() },
            xaxis: { range: this.chartRangeMs() }
          }, false, false);
        } catch (_) {
          try { this.apexChart.resize(); } catch (__) {}
        }
      }, 80);
    };
    window.addEventListener('resize', onResize);
    window.addEventListener('orientationchange', onResize);
    if (typeof ResizeObserver !== 'undefined' && !this._resizeObs) {
      try {
        this._resizeObs = new ResizeObserver(onResize);
        this._resizeObs.observe(host);
      } catch (_) {}
    }
  },

  bindSocket() {
    if (this._sock) return;
    const sock = (window.App && App.socket)
      || (typeof io === 'function' ? io({ auth: { token: App.token }, transports: ['websocket', 'polling'] }) : null);
    if (!sock) return;
    this._sock = sock;
    sock.on('interface:traffic_update', (payload) => {
      if (window.MikrotikSelector && window.MikrotikSelector.getSelectedId) {
        const activeId = String(window.MikrotikSelector.getSelectedId() || '');
        const msgId = String((payload && (payload.device_id || payload.deviceId)) || '');
        if (activeId && msgId && activeId !== msgId) return;
      }
      const stats = (payload && payload.data) || [];
      this._lastSocket = Date.now();
      this.applyTrafficStats(stats, this.pollNames());
    });
    sock.on('connect', () => this.syncSocketMonitor());
  },

  syncSocketMonitor() {
    if (!this._sock || !this._sock.connected) return;
    const names = this.pollNames();
    this._sock.emit('interface:stop_monitor');
    if (!names.length) return;
    const deviceId = window.MikrotikSelector && window.MikrotikSelector.getSelectedId
      ? window.MikrotikSelector.getSelectedId()
      : null;
    this._sock.emit('interface:start_monitor', {
      interfaces: names,
      interval: Math.max(this.INTERVAL, 2000),
      device_id: deviceId ? parseInt(deviceId, 10) : null
    });
  }
};

// ── Format helpers ──────────────────────────────────────────
function bps(v, dec) {
  v = +v || 0; dec = dec === undefined ? 2 : dec;
  if (v >= 1e9) return (v / 1e9).toFixed(dec) + ' Gbps';
  if (v >= 1e6) return (v / 1e6).toFixed(dec) + ' Mbps';
  if (v >= 1e3) return (v / 1e3).toFixed(dec) + ' Kbps';
  return Math.round(v) + ' bps';
}
function bpsShort(v) { return bps(v, 1); }

function esc(s)    { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function safeid(s) { return String(s||'').replace(/[^a-zA-Z0-9]/g,'_'); }

document.addEventListener('DOMContentLoaded', () => {
  App.init();
  if (window.MikrotikSelector) {
    window.MikrotikSelector.init({
      mountId: 'mtSelectorMount',
      selectId: 'mikrotikSelector',
      onReady: () => {
        // Selector siap — initial load aman dijalankan
        TrafficPage.init();
      },
      onChange: () => {
        // User pilih device lain — reset state lalu load ulang
        TrafficPage.resetForDevice();
      }
    });
  } else {
    // Fallback kalau selector script gagal load
    TrafficPage.init();
  }
});