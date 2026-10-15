(function () {
  'use strict'
  // All payload data is rendered with textContent / SVG attributes only. Never innerHTML.
  var $ = function (id) { return document.getElementById(id) }
  var TIERS = ['flash', 'clef', 'omni', 'jev', 'unknown']
  var timer = null
  var days = '7'
  var feed = [] // newest first
  var next = null
  var last = { stats: null, tl: null, lat: null }
  var loaded = false
  var openToken = 0
  var lastFocus = null

  function el(tag, cls, text) {
    var e = document.createElement(tag)
    if (cls) e.className = cls
    if (text != null) e.textContent = String(text)
    return e
  }
  function svg(tag, attrs, text) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag)
    for (var k in attrs) e.setAttribute(k, attrs[k])
    if (text != null) e.textContent = String(text)
    return e
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild) }
  function tierKey(t) { return TIERS.indexOf(t) >= 0 ? t : 'unknown' }
  function tierColor(t) { return 'var(--' + tierKey(t) + ')' }
  function pill(t) { return el('span', 'pill t-' + tierKey(t), t || 'none') }
  function num(n) { return typeof n === 'number' ? n.toLocaleString() : String(n) }
  function pad(n) { return n < 10 ? '0' + n : '' + n }
  function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate() }
  function fmtTime(ts) {
    var d = new Date(ts), t = pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds())
    return sameDay(d, new Date()) ? t : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + t
  }
  function empty(host, msg) { clear(host); host.appendChild(el('div', 'empty', msg)) }
  function skeleton(host, rows, cls) {
    clear(host)
    for (var i = 0; i < rows; i++) { var s = el('div', 'skel' + (cls ? ' ' + cls : '')); if (!cls) s.style.width = 100 - (i * 13) % 40 + '%'; host.appendChild(s) }
  }

  function setStatus(state, text) {
    $('chip').setAttribute('data-state', state)
    if (text != null) $('status').textContent = text
  }

  // Auth is the Cloudflare Access cookie, sent same-origin. No tokens live in this page.
  function api(path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.redirected) { stop(); setStatus('error', 'session expired'); showBanner('Your session expired. Reload the page to sign in again.', 'Reload', function () { location.reload() }); failPlaceholders(); throw new Error('unauthorized') }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  var bannerFn = null
  function showBanner(msg, label, fn) { $('banner-msg').textContent = msg; $('banner-act').textContent = label; bannerFn = fn; $('banner').hidden = false }
  function hideBanner() { $('banner').hidden = true }
  function failPlaceholders() {
    if (loaded) return
    sigs = {}; kp = null
    ;['mix', 'budget', 'latency', 'shadow', 'fallbacks', 'routes'].forEach(function (id) { empty($(id), 'Could not load this panel.') })
    clear($('kpis'))
    var tb = document.querySelector('#feed tbody'); clear(tb)
    var tr = el('tr'), td = el('td', 'empty-row', 'Could not load calls.'); td.colSpan = 6; tr.appendChild(td); tb.appendChild(tr)
    $('feedcount').textContent = 'Unavailable'
  }

  function stop() { if (timer) { clearInterval(timer); timer = null } }

  // Tooltip: one shared element, filled with textContent, positioned near the pointer.
  var tip = $('tip')
  function showTip(x, y, head, rows, total) {
    clear(tip)
    tip.appendChild(el('div', 't-head', head))
    rows.forEach(function (r) {
      var d = el('div', 't-row'); d.style.setProperty('--c', r[2])
      d.appendChild(el('span', '', r[0])); d.appendChild(el('b', '', r[1])); tip.appendChild(d)
    })
    if (total != null) { var t = el('div', 't-total'); t.appendChild(el('span', '', 'Total')); t.appendChild(el('b', '', total)); tip.appendChild(t) }
    tip.hidden = false
    var w = tip.offsetWidth, h = tip.offsetHeight
    var left = x + 14 + w > window.innerWidth - 8 ? x - w - 14 : x + 14
    var top = Math.min(Math.max(8, y - h / 2), window.innerHeight - h - 8)
    tip.style.left = Math.max(8, left) + 'px'; tip.style.top = top + 'px'
  }
  function hideTip() { tip.hidden = true }

  // ---- shared filter state: one source of truth for the feed, chips, selects, highlights and the URL hash ----
  var F = { decision: '', servedBy: '', fallbackReason: '', status: '', since: 0, before: 0 }
  var hoverDec = null, sigs = {}
  function memo(key, sig, fn) { if (sigs[key] === sig) return false; sigs[key] = sig; fn(); return true }
  function qa(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)) }
  function activate(node, fn) {
    node.addEventListener('click', fn)
    node.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fn(e) } })
  }
  function asButton(node, label, fn) { node.setAttribute('tabindex', '0'); node.setAttribute('role', 'button'); node.setAttribute('aria-label', label); node.classList.add('clickable'); activate(node, fn) }
  function isTime(k) { return k === 'since' || k === 'before' }
  function sameFilter(patch) { return Object.keys(patch).every(function (k) { return F[k] === patch[k] }) }

  // Dim everything that does not match the active (or hovered) filter. Charts stay window-wide; only emphasis changes.
  function applyHighlights() {
    var dec = hoverDec || F.decision
    qa('[data-f]').forEach(function (n) {
      var p = n.getAttribute('data-f').split(':'), k = p[0], v = p.slice(1).join(':')
      var cur = k === 'decision' && hoverDec ? hoverDec : F[k], on = cur === v
      n.classList.toggle('is-sel', F[k] === v)
      n.classList.toggle('dim', !!cur && !on)
      if (n.getAttribute('role') === 'button' || n.tagName === 'BUTTON') n.setAttribute('aria-pressed', F[k] === v ? 'true' : 'false')
    })
    qa('[data-dec]').forEach(function (n) { n.classList.toggle('dim', !!dec && n.getAttribute('data-dec') !== dec) })
    var hasSel = !!F.since
    qa('.bk').forEach(function (n) { n.classList.toggle('sel', hasSel && Number(n.getAttribute('data-t')) === F.since) })
    qa('#mix svg').forEach(function (n) { n.classList.toggle('has-sel', hasSel) })
  }

  function reasonLabel(name) {
    var parts = name.split('+'), l = el('span', 'lbl', parts[0]); l.title = name
    parts.slice(1).forEach(function (p) { l.appendChild(el('span', 'sfx' + (/emergency|spend|quota|jev/.test(p) ? ' hot' : ''), '+' + p)) })
    return l
  }

  function barRows(host, entries, opts) {
    clear(host)
    if (!entries.length) { empty(host, opts && opts.empty || 'No data in this window'); return }
    var max = Math.max.apply(null, entries.map(function (e) { return e[1] })) || 1
    entries.forEach(function (e) {
      var row = el('div', 'srow'), hd = el('div', 'srow-h')
      hd.appendChild(reasonLabel(e[0])); hd.appendChild(el('span', 'val', e[2] != null ? e[2] : num(e[1]))); row.appendChild(hd)
      var cls = opts && opts.cls ? opts.cls(e) : ''
      var bar = el('div', 'bar'), i = el('i', cls)
      i.style.width = Math.max(2, (e[1] / max) * 100) + '%'
      bar.appendChild(i); row.appendChild(bar)
      if (opts && opts.f) {
        row.setAttribute('data-f', opts.f + ':' + e[0])
        var patch = {}; patch[opts.f] = e[0]
        asButton(row, 'Filter the feed by ' + e[0], function () { filterBy(patch) })
        if (opts.f === 'decision') {
          row.addEventListener('mouseenter', function () { hoverDec = e[0]; applyHighlights() })
          row.addEventListener('mouseleave', function () { hoverDec = null; applyHighlights() })
        }
      }
      host.appendChild(row)
    })
    applyHighlights()
  }

  function tlTotals(tl) {
    var tot = {}, series = [], freeSeries = []
    ;(tl && tl.buckets || []).forEach(function (b) {
      var s = 0, f = 0
      for (var k in b.counts) { tot[k] = (tot[k] || 0) + b.counts[k]; s += b.counts[k]; if (k !== 'jev') f += b.counts[k] }
      series.push(s); freeSeries.push(s ? f / s : null)
    })
    return { tot: tot, series: series }
  }

  function sparkline(values, color) {
    var n = values.length
    if (n < 2) return null
    var max = Math.max.apply(null, values) || 1, W = 100, H = 28
    var pts = values.map(function (v, i) { return [i / (n - 1) * W, H - 2 - (v / max) * (H - 6)] })
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2) }).join(' ')
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, preserveAspectRatio: 'none', class: 'spark', 'aria-hidden': 'true' })
    s.appendChild(svg('path', { class: 'area', d: d + ' L' + W + ' ' + H + ' L0 ' + H + ' Z', fill: color }))
    s.appendChild(svg('path', { class: 'line', d: d, stroke: color }))
    return s
  }

  var kp = null
  function daysLabel() { return $('days').querySelector('[aria-pressed=true]').textContent }
  function kshell(tag, label) {
    var r = el(tag, 'kpi'); if (tag === 'button') r.type = 'button'
    var v = el('span', 'k-val'), s = el('span', 'k-sub')
    r.appendChild(el('span', 'k-label', label)); r.appendChild(v); r.appendChild(s)
    return { root: r, val: v, sub: s }
  }
  function setVal(k, value, unit) { clear(k.val); k.val.appendChild(document.createTextNode(String(value))); if (unit) k.val.appendChild(el('small', '', unit)) }

  function buildKpis() {
    var host = $('kpis'); clear(host); kp = {}
    kp.calls = kshell('div', 'Calls'); kp.viz = el('div', 'k-viz'); kp.calls.root.appendChild(kp.viz)
    kp.free = kshell('div', 'Served free'); kp.share = el('div', 'share'); kp.free.root.appendChild(kp.share)
    kp.err = kshell('button', 'Errors')
    kp.err.root.setAttribute('data-f', 'status:error'); kp.err.root.setAttribute('aria-pressed', 'false'); kp.err.root.title = 'Filter the feed to errors'
    kp.err.root.addEventListener('click', function () { filterBy({ status: 'error' }) })
    kp.neu = kshell('button', 'Neurons')
    kp.neu.root.setAttribute('aria-expanded', $('budgetwrap').classList.contains('open') ? 'true' : 'false'); kp.neu.root.setAttribute('aria-controls', 'budgetwrap'); kp.neu.root.title = 'Show today\'s budget details'
    kp.neu.root.appendChild(el('span', 'chev'))
    kp.nbar = el('div', 'bar'); kp.nfill = el('i'); kp.nbar.appendChild(kp.nfill); kp.nline = el('span', 'k-sub nline')
    var nm = el('div', 'nmeter'); nm.appendChild(kp.nbar); nm.appendChild(kp.nline); kp.neu.root.appendChild(nm)
    kp.neu.root.addEventListener('click', function () {
      var open = $('budgetwrap').classList.toggle('open')
      kp.neu.root.setAttribute('aria-expanded', open ? 'true' : 'false')
    })
    ;[kp.calls, kp.free, kp.err, kp.neu].forEach(function (k) { host.appendChild(k.root) })
  }

  function renderKpis() {
    var s = last.stats; if (!s) return
    if (!kp) buildKpis()
    var t = tlTotals(last.tl), rate = s.total ? Math.round(s.errors / s.total * 1000) / 10 : 0
    setVal(kp.calls, num(s.total)); kp.calls.sub.textContent = 'in the last ' + daysLabel()
    memo('spark', t.series.join(','), function () { clear(kp.viz); var sp = sparkline(t.series, 'var(--accent)'); if (sp) kp.viz.appendChild(sp) })
    setVal(kp.free, s.freePercent, '%'); kp.free.sub.textContent = 'flash, clef and omni instead of Jev'
    memo('share', JSON.stringify(t.tot), function () {
      clear(kp.share)
      var sum = 0; for (var k in t.tot) sum += t.tot[k]
      TIERS.forEach(function (tier) {
        if (!t.tot[tier]) return
        var real = tier !== 'unknown', i = el(real ? 'button' : 'i')
        i.style.width = t.tot[tier] / sum * 100 + '%'; i.style.background = tierColor(tier); i.title = tier + ' ' + num(t.tot[tier]) + (real ? ', click to filter the feed' : '')
        if (real) { i.type = 'button'; i.setAttribute('data-f', 'servedBy:' + tier); i.setAttribute('aria-label', 'Filter the feed to ' + tier + ' calls'); i.addEventListener('click', function () { filterBy({ servedBy: tier }) }) }
        kp.share.appendChild(i)
      })
      kp.share.hidden = !sum
    })
    setVal(kp.err, num(s.errors)); kp.err.sub.textContent = s.total ? rate + '% of calls' : 'no calls yet'; kp.err.root.classList.toggle('bad', !!s.errors)
    setVal(kp.neu, num(s.neurons)); kp.neu.sub.textContent = 'Workers AI usage in window'
    var b = last.budget
    if (b) {
      var pc = Math.min(100, b.serverNeurons / b.freeTier * 100), lim = (b.spendLimitErrors || 0) + (b.quotaErrors || 0)
      var lvl = pc > 90 ? 'bad' : (pc > 80 || lim > 0) ? 'warn' : ''
      kp.nfill.className = lvl; kp.nfill.style.width = Math.max(pc, pc > 0 ? 2 : 0) + '%'
      kp.nline.textContent = num(Math.round(b.serverNeurons * 10) / 10) + ' / ' + num(b.freeTier) + ' today  ·  ' + (Math.round(pc * 10) / 10) + '%' + (lim > 0 ? '  ·  limit errors' : '')
      kp.neu.root.setAttribute('data-level', lvl)
    }
  }

  // ---- routing mix chart ----
  function niceMax(m) {
    if (m <= 4) return 4
    var p = Math.pow(10, Math.floor(Math.log10(m))), f = m / p
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 5 ? 5 : 10) * p
  }
  function bucketLabel(ms, ts) {
    var d = new Date(ts)
    return ms < 86400000 ? pad(d.getHours()) + ':00' : d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
  }

  // The API's bucket starts are not guaranteed aligned, so snap them to the bucket grid, merge, and fill empty
  // buckets so the x-axis is a continuous, evenly spaced time line.
  function regroup(t) {
    var ms = t.bucketMs, by = {}, lo = Infinity, hi = -Infinity
    t.buckets.forEach(function (x) {
      var k = Math.floor(x.t / ms) * ms, c = by[k] || (by[k] = {})
      for (var tier in x.counts) c[tier] = (c[tier] || 0) + x.counts[tier]
      if (k < lo) lo = k; if (k > hi) hi = k
    })
    var out = []
    for (var k = lo; k <= hi && out.length < 400; k += ms) out.push({ t: k, counts: by[k] || {} })
    return out
  }

  function renderMix(t) {
    last.tl = t
    var host = $('mix'), b = regroup(t), W = Math.max(280, host.clientWidth || 600)
    memo('mix', W + '|' + t.bucketMs + '|' + JSON.stringify(b), function () { drawMix(host, t, b, W) })
    renderKpis()
  }

  function drawMix(host, t, b, W) {
    clear(host)
    var lg = $('mixlegend'); clear(lg)
    if (!b.length) { empty(host, 'No successful calls in this window yet'); return }
    TIERS.forEach(function (tier) {
      var real = tier !== 'unknown', bt = el(real ? 'button' : 'span', real ? 'lg' : '', tier)
      bt.style.setProperty('--c', tierColor(tier))
      if (real) { bt.type = 'button'; bt.setAttribute('data-f', 'servedBy:' + tier); bt.setAttribute('aria-pressed', 'false'); bt.title = 'Filter the feed to ' + tier + ' calls'; bt.addEventListener('click', function () { filterBy({ servedBy: tier }) }) }
      lg.appendChild(bt)
    })
    var H = W < 500 ? 170 : 250, L = 34, B = 22, T = 8, R = 4, n = b.length
    var max = 1
    b.forEach(function (x) { var s = 0; for (var k in x.counts) s += x.counts[k]; if (s > max) max = s })
    var top = niceMax(max)
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'group', tabindex: '0', 'aria-label': 'Routing mix over time, stacked by serving tier. Use the left and right arrow keys to browse buckets and Enter to filter the feed to one bucket.' })
    var ph = H - B - T, bw = (W - L - R) / n
    for (var g = 0; g <= 4; g++) {
      var y = T + ph - g / 4 * ph
      s.appendChild(svg('line', { x1: L, x2: W - R, y1: y, y2: y, class: g ? 'grid-line' : 'axis-line' }))
      s.appendChild(svg('text', { x: L - 6, y: y + 3.5, 'text-anchor': 'end' }, Math.round(g / 4 * top)))
    }
    var hover = svg('rect', { class: 'hover-col', y: T, height: ph, width: bw, visibility: 'hidden' })
    s.appendChild(hover)
    var gap = bw > 6 ? 1.5 : bw > 3 ? 1 : 0
    b.forEach(function (x, i) {
      var gk = svg('g', { class: 'bk', 'data-t': x.t })
      gk.appendChild(svg('rect', { class: 'bk-bg', x: L + i * bw, y: T, width: bw, height: ph }))
      var yy = T + ph
      TIERS.forEach(function (tier) {
        var c = x.counts[tier]; if (!c) return
        var h = Math.max(1, c / top * ph)
        yy -= h
        gk.appendChild(svg('rect', { x: L + i * bw + gap / 2, y: yy, width: Math.max(1, bw - gap), height: h, fill: tierColor(tier), rx: bw > 8 ? 1.5 : 0 }))
      })
      s.appendChild(gk)
    })
    var ticks = Math.min(n, W < 500 ? 4 : 7)
    var prevLabel = null
    for (var k = 0; k < ticks; k++) {
      var idx = ticks === 1 ? 0 : Math.round(k * (n - 1) / (ticks - 1))
      var label = bucketLabel(t.bucketMs, b[idx].t)
      if (label === prevLabel) continue
      prevLabel = label
      var anchor = k === 0 ? 'start' : k === ticks - 1 ? 'end' : 'middle'
      var cx = L + idx * bw + bw / 2
      s.appendChild(svg('text', { x: k === 0 ? L : k === ticks - 1 ? W - R : cx, y: H - 6, 'text-anchor': anchor }, label))
    }
    var hit = svg('rect', { class: 'hit', x: L, y: T, width: W - L - R, height: ph })
    function bucketTip(i, px, py) {
      var x = b[i], tot = 0, rows = []
      TIERS.forEach(function (tier) { var c = x.counts[tier]; if (c) { tot += c; rows.push([tier, num(c), tierColor(tier)]) } })
      hover.setAttribute('x', L + i * bw); hover.setAttribute('visibility', 'visible')
      var d = new Date(x.t)
      showTip(px, py, d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + (t.bucketMs < 86400000 ? ' ' + pad(d.getHours()) + ':00' : '') + '  (click to filter the feed)', rows.length ? rows : [['no calls', '0', 'var(--faint)']], rows.length ? num(tot) : null)
    }
    function idxAt(e) { var r = s.getBoundingClientRect(); return Math.max(0, Math.min(n - 1, Math.floor((e.clientX - r.left - L) / bw))) }
    function pick(i) { filterBy({ since: b[i].t, before: b[i].t + t.bucketMs }) }
    hit.addEventListener('pointermove', function (e) { bucketTip(idxAt(e), e.clientX, e.clientY) })
    hit.addEventListener('pointerleave', function () { hover.setAttribute('visibility', 'hidden'); hideTip() })
    hit.addEventListener('click', function (e) { pick(idxAt(e)) })
    s.appendChild(hit)
    var kbi = -1
    function kshow() { var r = s.getBoundingClientRect(); bucketTip(kbi, r.left + L + (kbi + 0.5) * bw, r.top + T + 30) }
    s.addEventListener('focus', function () { if (kbi < 0) kbi = n - 1; kshow() })
    s.addEventListener('blur', function () { hover.setAttribute('visibility', 'hidden'); hideTip() })
    s.addEventListener('keydown', function (e) {
      if (e.key === 'ArrowLeft') kbi = Math.max(0, kbi - 1)
      else if (e.key === 'ArrowRight') kbi = Math.min(n - 1, kbi + 1)
      else if (e.key === 'Home') kbi = 0
      else if (e.key === 'End') kbi = n - 1
      else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); if (kbi >= 0) pick(kbi); return }
      else return
      e.preventDefault(); kshow()
    })
    host.appendChild(s)
    applyHighlights()
  }

  function renderBudget(b) {
    last.budget = b
    memo('budget', JSON.stringify(b), function () { drawBudget(b) })
    renderKpis()
  }

  function drawBudget(b) {
    var host = $('budget'); clear(host)
    var pct = Math.min(100, (b.serverNeurons / b.freeTier) * 100)
    var top = el('div', 'b-top')
    top.appendChild(el('b', '', num(b.serverNeurons)))
    top.appendChild(el('span', '', '/ ' + num(b.freeTier) + ' neurons today'))
    top.appendChild(el('span', 'pct', (Math.round(pct * 10) / 10) + '%'))
    host.appendChild(top)
    var bar = el('div', 'bar big'), i = el('i', pct > 90 ? 'bad' : pct > 80 ? 'warn' : ''); i.style.width = Math.max(pct, pct > 0 ? 1 : 0) + '%'; bar.appendChild(i)
    host.appendChild(bar)
    var dl = el('dl', 'b-grid')
    ;[['serverNeurons', num(b.serverNeurons)], ['spendLimitErrors', b.spendLimitErrors], ['quotaErrors', b.quotaErrors],
      ['skip-Clef', b.skipClef ? b.skipClef + (b.skipClefUntil ? ' until ' + b.skipClefUntil : '') : 'inactive (this isolate)'],
      ['lastLimitAt', b.lastLimitAt || 'never'], ['resetsAt', b.resetsAt]].forEach(function (r) {
      var p = el('div', 'b-pair'); p.appendChild(el('dt', '', r[0])); p.appendChild(el('dd', '', r[1])); dl.appendChild(p)
    })
    host.appendChild(dl)
  }

  // ---- latency: range / dot plot on one shared linear ms axis ----
  function niceStep(max, n) {
    var raw = max / n, p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p
    return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * p
  }
  function fmtMs(v) { return v >= 1000 ? (Math.round(v / 100) / 10) + 's' : String(v) }
  function jitter(id) { var h = 0; for (var i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) % 1000; return h / 1000 - 0.5 }

  function renderLatency(lat) {
    last.lat = lat
    var host = $('latency'), W0 = Math.max(280, host.clientWidth || 560)
    memo('lat', W0 + '|' + JSON.stringify(lat) + '|' + feed.map(function (c) { return c.id }).join(','), function () { drawLatency(host, lat) })
  }

  function drawLatency(host, lat) {
    clear(host)
    var tiers = Object.keys(lat)
    if (!tiers.length) { empty(host, 'No latency data in this window'); $('lat-key').hidden = true; return }
    $('lat-key').hidden = false
    tiers.sort(function (a, b) { return TIERS.indexOf(tierKey(a)) - TIERS.indexOf(tierKey(b)) })
    var pts = feed.filter(function (c) { return isNum(c.latency_ms) && c.served_by })
    $('lat-sub').textContent = 'p50 and p90 per tier, in milliseconds. Faint dots: ' + pts.length + ' loaded call' + (pts.length === 1 ? '' : 's') + ', click one to open it'
    var vals = pts.map(function (c) { return c.latency_ms }).sort(function (a, b) { return a - b })
    var p98 = vals.length ? vals[Math.min(vals.length - 1, Math.floor(vals.length * 0.98))] : 0
    var maxV = Math.max(p98, Math.max.apply(null, tiers.map(function (t) { return lat[t].p90 }))) || 1

    var W = Math.max(280, host.clientWidth || 560), L = 60, R = 16, RH = 56, TOP = 4, AX = 26
    var plotW = W - L - R, nt = Math.max(2, Math.min(7, Math.floor(plotW / 72)))
    var step = niceStep(maxV, nt), dmax = Math.ceil(maxV / step) * step
    var X = function (v) { return L + Math.min(v, dmax) / dmax * plotW }
    var H = TOP + tiers.length * RH + AX
    var summary = tiers.map(function (t) { return t + ' p50 ' + lat[t].p50 + ' ms, p90 ' + lat[t].p90 + ' ms' }).join('; ')
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, width: W, height: H, role: 'img', 'aria-label': 'Latency per tier. ' + summary })

    for (var v = 0; v <= dmax + 1e-9; v += step) {
      var gx = X(v)
      s.appendChild(svg('line', { x1: gx, x2: gx, y1: TOP, y2: H - AX, class: v ? 'grid-line' : 'axis-line' }))
      s.appendChild(svg('text', { x: gx, y: H - 8, 'text-anchor': v === 0 ? 'start' : v >= dmax - 1e-9 ? 'end' : 'middle' }, fmtMs(Math.round(v * 100) / 100)))
    }
    s.appendChild(svg('text', { x: 0, y: H - 8 }, 'ms'))

    var hits = [], tierHits = []
    tiers.forEach(function (t, ri) {
      var top = TOP + ri * RH, cy = top + 36, col = tierColor(t), p50 = lat[t].p50, p90 = lat[t].p90
      if (ri) s.appendChild(svg('line', { x1: 0, x2: W - R, y1: top, y2: top, class: 'grid-line' }))
      var grp = svg('g', { class: 'trow', 'data-f': 'servedBy:' + tierKey(t) }); s.appendChild(grp)
      grp.appendChild(svg('circle', { cx: 5, cy: cy, r: 4, fill: col }))
      grp.appendChild(svg('text', { x: 15, y: cy + 4, class: 'tier-lbl' }, t))
      var th = svg('rect', { x: 0, y: top + 6, width: L - 6, height: RH - 12, class: 'hitc', 'data-f': 'servedBy:' + tierKey(t) })
      asButton(th, 'Filter the feed to ' + t + ' calls', function () { filterBy({ servedBy: tierKey(t) }) })
      tierHits.push(th)
      pts.filter(function (c) { return tierKey(c.served_by) === tierKey(t) }).forEach(function (c) {
        var cx = X(c.latency_ms), y = cy + jitter(c.id) * 22
        grp.appendChild(svg('circle', { cx: cx, cy: y, r: 2.6, fill: col, class: 'sd', 'data-dec': c.decision || '' }))
        hits.push({ cx: cx, cy: y, r: 7, call: c })
      })
      grp.appendChild(svg('line', { x1: X(p50), x2: X(p90), y1: cy, y2: cy, stroke: col, 'stroke-width': 2, 'stroke-linecap': 'round' }))
      grp.appendChild(svg('line', { x1: X(p90), x2: X(p90), y1: cy - 6, y2: cy + 6, stroke: col, 'stroke-width': 2, 'stroke-linecap': 'round' }))
      grp.appendChild(svg('circle', { cx: X(p50), cy: cy, r: 5, fill: col, stroke: 'var(--card)', 'stroke-width': 2 }))
      var gap = X(p90) - X(p50)
      if (p50 === p90 || gap < 4) grp.appendChild(svg('text', { x: Math.min(X(p50), W - R - 12), y: cy - 16, 'text-anchor': X(p50) > W - R - 40 ? 'end' : 'middle', class: 'lat-lbl' }, num(p50)))
      else {
        grp.appendChild(svg('text', { x: X(p50), y: cy - 16, 'text-anchor': gap < 40 ? 'end' : 'middle', class: 'lat-lbl' }, num(p50)))
        grp.appendChild(svg('text', { x: X(p90), y: cy - 16, 'text-anchor': X(p90) > W - R - 30 ? 'end' : gap < 40 ? 'start' : 'middle', class: 'lat-lbl' }, num(p90)))
      }
      hits.push({ cx: X(p50), cy: cy, r: 9, stat: t })
    })
    hits.forEach(function (h) {
      var c = svg('circle', { cx: h.cx, cy: h.cy, r: h.r, class: 'hitc' + (h.call ? '' : ' nopt') })
      c.addEventListener('pointermove', function (e) {
        if (h.call) showTip(e.clientX, e.clientY, (h.call.decision || 'call') + '  ' + fmtTime(h.call.ts), [[h.call.served_by, num(h.call.latency_ms) + ' ms', tierColor(h.call.served_by)]], null)
        else showTip(e.clientX, e.clientY, h.stat, [['p50', num(lat[h.stat].p50) + ' ms', tierColor(h.stat)], ['p90', num(lat[h.stat].p90) + ' ms', tierColor(h.stat)]], null)
      })
      c.addEventListener('pointerleave', hideTip)
      if (h.call) c.addEventListener('click', function () { hideTip(); lastFocus = null; openDrawer(h.call.id) })
      if (h.call) c.setAttribute('data-dec', h.call.decision || '')
      s.appendChild(c)
    })
    tierHits.forEach(function (n) { s.appendChild(n) })
    host.appendChild(s)
    applyHighlights()
  }

  // ---- route reasons: one stacked bar per decision ----
  var KINDS = [['plain', 'Direct'], ['esc', 'Escalated'], ['paid', 'Emergency paid'], ['other', 'Fallback / other']]
  function parseRoute(reason) {
    var m = /^static:([^+]+)(?:\+(.+))?$/.exec(reason)
    if (!m) return { dec: 'other', kind: 'other' }
    var sfx = m[2] || ''
    return { dec: m[1], kind: !sfx ? 'plain' : /escalat/.test(sfx) ? 'esc' : /emergency|paid/.test(sfx) ? 'paid' : 'other' }
  }

  var routeAll = false
  function renderRoutes(rr) {
    memo('routes', JSON.stringify(rr) + routeAll, function () { drawRoutes($('routes'), rr) })
  }

  function drawRoutes(host, rr) {
    clear(host)
    var lg = $('routelegend'); clear(lg)
    var by = {}
    Object.keys(rr || {}).forEach(function (r) {
      var p = parseRoute(r), d = by[p.dec] || (by[p.dec] = { dec: p.dec, total: 0, kinds: {} })
      var k = d.kinds[p.kind] || (d.kinds[p.kind] = { n: 0, reasons: [] })
      k.n += rr[r]; k.reasons.push([r, rr[r]]); d.total += rr[r]
    })
    var rows = Object.keys(by).map(function (k) { return by[k] }).sort(function (a, b) {
      if (a.dec === 'other' !== (b.dec === 'other')) return a.dec === 'other' ? 1 : -1
      return b.total - a.total
    })
    if (!rows.length) { empty(host, 'No routed calls in this window'); return }
    KINDS.forEach(function (k) { var sp = el('span', '', k[1]); sp.style.setProperty('--c', 'var(--r-' + k[0] + ')'); lg.appendChild(sp) })
    var totals = rows.map(function (r) { return r.total }).sort(function (a, b) { return b - a })
    var sum = totals.reduce(function (a, b) { return a + b }, 0)
    var broken = totals.length > 1 && totals[0] > totals[1] * 1.25
    var scale = broken ? totals[1] : totals[0]
    var shown = routeAll || rows.length <= 8 ? rows : rows.slice(0, 8)
    shown.forEach(function (r) {
      var row = el('div', 'rrow'), l = el('span', 'lbl', r.dec); l.title = r.dec; row.appendChild(l)
      var tr = el('div', 'rtrack'), bar = el('div', 'rbar'), parts = []
      KINDS.forEach(function (k) {
        var d = r.kinds[k[0]]; if (!d) return
        parts.push(k[1] + ' ' + num(d.n))
        var seg = el('i'); seg.style.setProperty('--c', 'var(--r-' + k[0] + ')'); seg.style.flex = d.n + ' 1 0'
        seg.addEventListener('pointermove', function (e) {
          showTip(e.clientX, e.clientY, r.dec + ': ' + k[1], d.reasons.slice().sort(function (a, b) { return b[1] - a[1] }).map(function (x) { return [x[0], num(x[1]), 'var(--r-' + k[0] + ')'] }), d.reasons.length > 1 ? num(d.n) : null)
        })
        seg.addEventListener('pointerleave', hideTip)
        if (r.dec !== 'other') seg.addEventListener('click', function (e) {
          e.stopPropagation()
          var patch = { decision: r.dec }
          var sfx = d.reasons.map(function (x) { var m = /\+(.+)$/.exec(x[0]); return m ? m[1] : '' })
          if (k[0] === 'other' && sfx.length && sfx.every(function (x) { return x && x === sfx[0] }) && last.stats && last.stats.fallbacks && sfx[0] in last.stats.fallbacks) patch.fallbackReason = sfx[0]
          filterBy(patch)
        })
        bar.appendChild(seg)
      })
      var frac = Math.min(1, r.total / scale)
      bar.style.width = 'calc((100% - 50px) * ' + frac + ')'
      if (r.total > scale) { var br = el('s', 'brk'); br.title = 'Bar shortened so the smaller decisions stay readable'; bar.appendChild(br) }
      bar.setAttribute('role', 'img'); bar.setAttribute('aria-label', r.dec + ': ' + num(r.total) + ' calls. ' + parts.join(', '))
      tr.appendChild(bar); tr.appendChild(el('span', 'rtot', num(r.total))); row.appendChild(tr)
      row.appendChild(el('span', 'rshare', (Math.round(r.total / sum * 1000) / 10) + '%'))
      if (r.dec !== 'other') {
        row.setAttribute('data-f', 'decision:' + r.dec)
        asButton(row, 'Filter the feed to ' + r.dec + ', ' + num(r.total) + ' calls', function () { filterBy({ decision: r.dec }) })
        row.addEventListener('mouseenter', function () { hoverDec = r.dec; applyHighlights() })
        row.addEventListener('mouseleave', function () { hoverDec = null; applyHighlights() })
        row.addEventListener('focus', function () { hoverDec = r.dec; applyHighlights() })
        row.addEventListener('blur', function () { hoverDec = null; applyHighlights() })
      }
      host.appendChild(row)
    })
    var foot = el('div', 'rfoot')
    if (broken) foot.appendChild(el('span', 'rnote', 'Bars scale to the second-largest decision; a slanted cut marks a shortened bar. Shares are of all routed calls.'))
    if (rows.length > 8) {
      var tg = el('button', 'ghost more', routeAll ? 'Show top 8' : 'Show all ' + rows.length); tg.type = 'button'
      tg.addEventListener('click', function () { routeAll = !routeAll; renderRoutes(last.stats.routeReasons) })
      foot.appendChild(tg)
    }
    if (foot.firstChild) host.appendChild(foot)
    applyHighlights()
  }

  function renderShadow(sh) {
    memo('shadow', JSON.stringify(sh), function () {
      var host = $('shadow'); clear(host)
      var ks = Object.keys(sh)
      if (!ks.length) { empty(host, 'No shadow pairs in this window'); return }
      barRows(host, ks.map(function (k) {
        var a = Math.round((1 - sh[k].disagreementRate) * 1000) / 10
        return [k, a, a + '%  (' + num(sh[k].pairs) + ')']
      }), { f: 'decision', cls: function (e) { return e[1] < 70 ? 'bad' : e[1] < 90 ? 'warn' : '' } })
    })
  }

  function renderStats(s) {
    last.stats = s
    renderKpis(); renderLatency(s.latency); renderShadow(s.shadow)
    memo('fallbacks', JSON.stringify(s.fallbacks) + '|' + s.total, function () {
      var share = function (n) { return num(n) + (s.total ? '  ·  ' + (Math.round(n / s.total * 1000) / 10) + '%' : '') }
      var fb = Object.keys(s.fallbacks).map(function (k) { return [k, s.fallbacks[k], share(s.fallbacks[k])] }).sort(function (a, b) { return b[1] - a[1] })
      barRows($('fallbacks'), fb, { f: 'fallbackReason', empty: 'No fallbacks: every call stayed on its first-choice tier', cls: function (e) { return /spend-limit|quota/.test(e[0]) ? 'warn' : '' } })
    })
    renderRoutes(s.routeReasons)
    fillSelect($('f-fallback'), Object.keys(s.fallbacks))
    var decs = {}; Object.keys(s.routeReasons || {}).forEach(function (r) { var p = parseRoute(r); if (p.dec !== 'other') decs[p.dec] = 1 })
    fillSelect($('f-decision'), Object.keys(decs).sort())
    applyHighlights()
  }

  function fillSelect(sel, values) {
    var cur = sel.value, have = {}
    for (var i = 1; i < sel.options.length; i++) have[sel.options[i].value] = 1
    values.forEach(function (v) { if (!have[v]) { have[v] = 1; var o = el('option', '', v); o.value = v; sel.appendChild(o) } })
    sel.value = cur
  }

  // ---- filters: select boxes, chips and the URL hash all mirror F ----
  var SELECTS = { 'f-decision': 'decision', 'f-served': 'servedBy', 'f-fallback': 'fallbackReason', 'f-status': 'status' }
  var FKEYS = ['decision', 'servedBy', 'fallbackReason', 'status', 'since', 'before']
  function anyFilter() { return FKEYS.some(function (k) { return !!F[k] }) }
  function syncSelects() {
    Object.keys(SELECTS).forEach(function (id) {
      var sel = $(id), v = F[SELECTS[id]]
      if (v) fillSelect(sel, [v])
      sel.value = v || ''
    })
  }
  function fmtStamp(t) { var d = new Date(t); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) }
  function rangeLabel() {
    var a = F.since, b = F.before
    if (!a && !b) return ''
    if (a && b && b - a === 86400000) return new Date(a).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })
    if (a && b && b - a === 3600000) return new Date(a).toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + pad(new Date(a).getHours()) + ':00 to ' + pad(new Date(b).getHours()) + ':00'
    return a && b ? fmtStamp(a) + ' to ' + fmtStamp(b) : a ? 'since ' + fmtStamp(a) : 'before ' + fmtStamp(b)
  }
  function clearKeys(keys) { keys.forEach(function (k) { F[k] = isTime(k) ? 0 : '' }) }

  function renderFilterChips() {
    var h = $('chips'); clear(h)
    var items = []
    ;[['decision', 'decision'], ['servedBy', 'served by'], ['fallbackReason', 'fallback'], ['status', 'status']].forEach(function (p) { if (F[p[0]]) items.push([p[1] + ': ' + F[p[0]], [p[0]]]) })
    var rl = rangeLabel(); if (rl) items.push(['time: ' + rl, ['since', 'before']])
    if (!items.length) { h.hidden = true; return }
    h.hidden = false
    items.forEach(function (it) {
      var b = el('button', 'chip'); b.type = 'button'; b.appendChild(document.createTextNode(it[0])); b.appendChild(el('span', 'x', '×'))
      b.setAttribute('aria-label', 'Remove filter ' + it[0])
      b.addEventListener('click', function () { clearKeys(it[1]); filtersChanged(false) })
      h.appendChild(b)
    })
    var ca = el('button', 'ghost', 'Clear all'); ca.type = 'button'
    ca.addEventListener('click', function () { clearKeys(FKEYS); filtersChanged(false) })
    h.appendChild(ca)
    h.appendChild(el('span', 'scope', 'Charts above cover the whole window. Only the feed is filtered.'))
  }

  function writeHash() {
    var p = []
    FKEYS.forEach(function (k) { if (F[k]) p.push(k + '=' + encodeURIComponent(F[k])) })
    if (days !== '7') p.push('days=' + days)
    try { history.replaceState(null, '', location.pathname + location.search + (p.length ? '#' + p.join('&') : '')) } catch (e) {}
  }
  function readHash() {
    var p = new URLSearchParams(location.hash.replace(/^#/, ''))
    FKEYS.forEach(function (k) { var v = p.get(k) || ''; F[k] = isTime(k) ? (Number(v) || 0) : v })
    if (F.status !== 'ok' && F.status !== 'error') F.status = ''
    var d = p.get('days'); days = d === '1' || d === '30' || d === '90' ? d : '7'
    qa('#days button').forEach(function (x) { x.setAttribute('aria-pressed', x.getAttribute('data-days') === days ? 'true' : 'false') })
  }

  function maybeScroll() {
    var c = $('feedcard'), r = c.getBoundingClientRect()
    if (r.top > window.innerHeight - 120 || r.bottom < 80) c.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' })
  }

  function filtersChanged(scroll) {
    syncSelects(); renderFilterChips(); applyHighlights(); writeHash()
    var p = loadFeed()
    p.then(function () { if (scroll) maybeScroll() }, fail)
  }
  function filterBy(patch) {
    if (sameFilter(patch)) clearKeys(Object.keys(patch))
    else Object.keys(patch).forEach(function (k) { F[k] = patch[k] })
    filtersChanged(true)
  }
  function setFilters(patch) { Object.keys(patch).forEach(function (k) { F[k] = patch[k] }); filtersChanged(true) }

  function feedQuery(beforeOverride) {
    var q = ['slim=1', 'limit=50']
    ;['decision', 'servedBy', 'fallbackReason', 'status'].forEach(function (k) { if (F[k]) q.push(k + '=' + encodeURIComponent(F[k])) })
    if (F.since) q.push('since=' + F.since)
    var b = beforeOverride != null ? beforeOverride : F.before
    if (b) q.push('before=' + b)
    return q.join('&')
  }

  var selectedId = null, feedTok = 0
  function renderFeed() {
    var tb = document.querySelector('#feed tbody')
    memo('feed', anyFilter() + '|' + feed.map(function (c) { return c.id }).join(','), function () {
      clear(tb)
      if (!feed.length) {
        var tr0 = el('tr'), td0 = el('td', 'empty-row', anyFilter() ? 'No calls match these filters.' : 'No calls recorded yet.'); td0.colSpan = 6
        tr0.appendChild(td0); tb.appendChild(tr0)
      }
      feed.forEach(function (c) {
        var tr = el('tr', c.id === selectedId ? 'sel' : '')
        tr.tabIndex = 0; tr.setAttribute('role', 'button'); tr.setAttribute('aria-label', 'Open call ' + c.id)
        tr.dataset.id = c.id; tr.setAttribute('data-dec', c.decision || '')
        tr.appendChild(el('td', 'mono dim', fmtTime(c.ts)))
        tr.appendChild(el('td', '', c.decision || '-'))
        var td = el('td'); td.appendChild(pill(c.served_by)); tr.appendChild(td)
        tr.appendChild(el('td', 'num mono', num(c.latency_ms)))
        var st = el('td'); st.appendChild(el('span', 'st ' + (c.status === 'error' ? 's-error' : 's-ok'), c.status)); tr.appendChild(st)
        var lt = el('td', 'wrap')
        if (c.fallback_reason) lt.appendChild(el('span', 'tag', c.fallback_reason))
        else lt.appendChild(el('span', 'mono dim', c.route_reason || ''))
        tr.appendChild(lt)
        var open = function () { lastFocus = tr; openDrawer(c.id) }
        tr.addEventListener('click', open)
        tr.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open() } })
        tb.appendChild(tr)
      })
    })
    if (last.lat) renderLatency(last.lat)
    $('more').hidden = next == null
    $('feedcount').textContent = feed.length + ' call' + (feed.length === 1 ? '' : 's') + ' loaded' + (next != null ? ', more available' : '') + (anyFilter() ? ', filtered' : '')
    fillSelect($('f-decision'), feed.map(function (c) { return c.decision }).filter(Boolean))
    syncSelects(); applyHighlights()
  }

  function loadFeed() {
    var t = ++feedTok
    return api('/v1/calls?' + feedQuery()).then(function (r) { if (t !== feedTok) return; feed = r.calls; next = r.next; renderFeed() })
  }
  function loadMore() {
    if (next == null) return
    $('more').disabled = true
    var t = feedTok
    return api('/v1/calls?' + feedQuery(next)).then(function (r) { if (t !== feedTok) return; feed = feed.concat(r.calls); next = r.next; renderFeed() })
      .catch(function () {}).then(function () { $('more').disabled = false })
  }

  // ---- drawer ----
  var JSON_RE = /("(?:\\.|[^"\\])*")(\s*:)?|\b(true|false|null)\b|-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/g
  function renderJson(pre, v) {
    clear(pre)
    if (v === undefined) { pre.appendChild(el('span', 'j-p', 'none')); return }
    var txt = JSON.stringify(v, null, 2), pos = 0, m
    JSON_RE.lastIndex = 0
    while ((m = JSON_RE.exec(txt))) {
      if (m.index > pos) pre.appendChild(document.createTextNode(txt.slice(pos, m.index)))
      var cls = m[1] ? (m[2] ? 'j-k' : 'j-s') : m[3] ? 'j-b' : 'j-n'
      if (m[1] && m[2]) { pre.appendChild(el('span', 'j-k', m[1])); pre.appendChild(el('span', 'j-p', m[2])) }
      else pre.appendChild(el('span', cls, m[0]))
      pos = m.index + m[0].length
    }
    if (pos < txt.length) pre.appendChild(document.createTextNode(txt.slice(pos)))
  }

  // Per-viewer view preference (Visual / JSON per section). localStorage only, never required.
  var views = { decisions: 'visual', state: 'visual' }
  try { ['decisions', 'state'].forEach(function (k) { var v = localStorage.getItem('viz.view.' + k); if (v === 'json' || v === 'visual') views[k] = v }) } catch (e) {}
  var cur = null

  function pct(p) { return (p * 100).toFixed(p > 0 && p < 0.1 ? 1 : 0) + '%' }
  function isNum(v) { return typeof v === 'number' && isFinite(v) }
  function clampP(v) { return isNum(v) ? Math.max(0, Math.min(1, v)) : 0 }
  function isObj(v) { return v !== null && typeof v === 'object' }

  // Long text: clamped to ~6 lines with a Show more toggle.
  function longText(s) {
    var w = el('div', 'longstr'), pre = el('pre', 'clampable', s)
    var lines = s.split('\n').length
    if (lines > 6 || s.length > 480) {
      pre.classList.add('clamp')
      var b = el('button', 'ghost more', 'Show more'); b.type = 'button'; b.setAttribute('aria-expanded', 'false')
      b.addEventListener('click', function () {
        var on = pre.classList.toggle('clamp'); b.textContent = on ? 'Show more' : 'Show less'; b.setAttribute('aria-expanded', on ? 'false' : 'true')
      })
      w.appendChild(pre); w.appendChild(b)
    } else w.appendChild(pre)
    return w
  }

  function scalar(v) {
    if (v === null) return el('span', 'v-null', 'null')
    if (typeof v === 'string') return el('span', 'v-s', v === '' ? '(empty string)' : v)
    return el('span', typeof v === 'boolean' ? 'v-b' : 'v-n', String(v))
  }

  function treeNode(key, v, depth) {
    if (isObj(v)) {
      var arr = Array.isArray(v), keys = arr ? null : Object.keys(v), n = arr ? v.length : keys.length
      if (!n) { var r0 = el('div', 'kv'); r0.appendChild(el('span', 'k', key)); r0.appendChild(el('span', 'v-null', arr ? '[]' : '{}')); return r0 }
      var d = el('details', 'node'); if (depth < 2) d.open = true
      var sm = el('summary'); sm.appendChild(el('span', 'k', key)); sm.appendChild(el('span', 'meta', arr ? n + (n === 1 ? ' item' : ' items') : n + (n === 1 ? ' key' : ' keys'))); d.appendChild(sm)
      var kids = el('div', 'kids')
      ;(arr ? v.map(function (_, i) { return i }) : keys).forEach(function (k) { kids.appendChild(treeNode(arr ? '[' + k + ']' : k, v[k], depth + 1)) })
      d.appendChild(kids); return d
    }
    if (typeof v === 'string' && (v.indexOf('\n') >= 0 || v.length > 90)) {
      var b = el('div', 'blk'), h = el('div', 'bh'); h.appendChild(el('span', 'k', key)); h.appendChild(el('span', 'meta', num(v.length) + ' chars')); b.appendChild(h); b.appendChild(longText(v)); return b
    }
    var r = el('div', 'kv'); r.appendChild(el('span', 'k', key)); r.appendChild(scalar(v)); return r
  }

  function renderState(host, st) {
    if (st === undefined || st === null) { host.appendChild(el('div', 'empty', 'No state recorded for this call.')); return }
    var box = el('div', 'tree')
    if (isObj(st)) {
      var arr = Array.isArray(st)
      if (!(arr ? st.length : Object.keys(st).length)) { host.appendChild(el('div', 'empty', arr ? 'Empty list' : 'Empty object')); return }
      ;(arr ? st.map(function (_, i) { return i }) : Object.keys(st)).forEach(function (k) { box.appendChild(treeNode(arr ? '[' + k + ']' : k, st[k], 1)) })
    } else box.appendChild(treeNode('value', st, 1))
    host.appendChild(box)
  }

  function confOpacity(c) { return isNum(c) ? 0.35 + 0.65 * clampP(c) : 1 }
  function confidence(c) {
    if (!isNum(c)) return null
    var w = el('div', 'conf' + (c < 0.6 ? ' low' : '')); w.appendChild(el('span', '', 'confidence'))
    var bar = el('div', 'bar'), i = el('i'); i.style.width = clampP(c) * 100 + '%'; i.style.opacity = confOpacity(c); bar.appendChild(i)
    w.appendChild(bar); w.appendChild(el('b', '', pct(c))); return w
  }

  function optRow(name, p, picked, desc, conf) {
    var r = el('div', 'opt' + (picked ? ' pick' : ''))
    var top = el('div', 'opt-top')
    var nm = el('span', 'on', name); if (desc) nm.title = desc
    top.appendChild(nm)
    var bar = el('div', 'bar'), i = el('i'); i.style.width = Math.max(p > 0 ? 2 : 0, clampP(p) * 100) + '%'; if (picked) i.style.opacity = confOpacity(conf); bar.appendChild(i); top.appendChild(bar)
    top.appendChild(el('span', 'pc', isNum(p) ? pct(p) : '-'))
    r.appendChild(top)
    if (desc) r.appendChild(el('div', 'crit', desc))
    return r
  }

  function critText(v) { return typeof v === 'string' ? v : isObj(v) ? JSON.stringify(v) : v == null ? '' : String(v) }

  function answerView(q, a) {
    var w = el('div', 'ans')
    if (a === null || a === undefined) { w.appendChild(el('div', 'noans', 'No answer recorded.')); return { el: w, res: '', crit: false, low: false } }
    var type = (q && q.type) || a.type, res = '', crit = false
    if (type === 'noul' && isNum(a.noul)) {
      var p = clampP(a.noul), band = p <= 0.2 ? 'sno' : p < 0.35 ? 'lno' : p <= 0.65 ? 'mid' : p < 0.8 ? 'lyes' : 'syes'
      var words = { sno: 'Strong no', lno: 'Leans no', mid: 'Uncertain', lyes: 'Leans yes', syes: 'Strong yes' }
      var top = el('div', 'noul-top'); top.appendChild(el('b', 'big', pct(p)))
      top.appendChild(el('span', 'verdict ' + band, words[band])); w.appendChild(top)
      var m = el('div', 'dmeter ' + band); m.setAttribute('role', 'meter'); m.setAttribute('aria-valuemin', '0'); m.setAttribute('aria-valuemax', '1'); m.setAttribute('aria-valuenow', String(p)); m.setAttribute('aria-valuetext', pct(p) + ' yes, ' + words[band]); m.setAttribute('aria-label', 'Probability of yes')
      var f = el('i'); f.style.left = Math.min(p, 0.5) * 100 + '%'; f.style.width = Math.abs(p - 0.5) * 100 + '%'; m.appendChild(f); m.appendChild(el('s')); w.appendChild(m)
      var sc = el('div', 'scale'); sc.appendChild(el('span', '', 'no')); sc.appendChild(el('span', '', 'yes')); w.appendChild(sc)
    } else if (type === 'choice' && typeof a.choice === 'string') {
      res = a.choice
      var cr = q && isObj(q.criteria) && !Array.isArray(q.criteria) ? q.criteria : {}, probs = isObj(a.probabilities) ? a.probabilities : {}
      var names = Object.keys(cr); Object.keys(probs).forEach(function (k) { if (names.indexOf(k) < 0) names.push(k) }); if (names.indexOf(a.choice) < 0) names.unshift(a.choice)
      var list = el('div', 'opts')
      names.forEach(function (n) { var d = critText(cr[n]); if (d) crit = true; list.appendChild(optRow(n, probs[n], n === a.choice, d, a.confidence)) })
      w.appendChild(list); var cf = confidence(a.confidence); if (cf) w.appendChild(cf)
    } else if (type === 'score' && isNum(a.score)) {
      var crA = q && Array.isArray(q.criteria) ? q.criteria : [], legend = isObj(a.legend) ? a.legend : {}, pr = isObj(a.probabilities) ? a.probabilities : {}
      var label = function (i) { return legend[i] != null ? critText(legend[i]) : critText(crA[i]) }
      var near = Math.round(a.score)
      var st = el('div', 'noul-top'); st.appendChild(el('b', 'big', a.score.toFixed(2)))
      var nl = label(near); if (nl) st.appendChild(el('span', 'verdict score', nl)); w.appendChild(st)
      var idx = Object.keys(pr).sort(function (x, y) { return x - y })
      if (idx.length) {
        var ls = el('div', 'opts')
        idx.forEach(function (k) { var lb = label(k); ls.appendChild(optRow(k + (lb ? '  ' + lb : ''), pr[k], Number(k) === near, '', a.confidence)) })
        w.appendChild(ls)
      }
      var cf2 = confidence(a.confidence); if (cf2) w.appendChild(cf2)
    } else {
      w.appendChild(el('div', 'noans', 'Unrecognised answer shape, see the JSON view.'))
    }
    return { el: w, res: res, crit: crit, low: isNum(a.confidence) && a.confidence < 0.6 }
  }

  function legend() {
    var d = el('details', 'legend-pop'), sm = el('summary', '', 'How to read the colours'); d.appendChild(sm)
    d.appendChild(el('p', '', 'Colour shows which way an answer leans and how sure it is. It does not say whether the answer is good or bad.'))
    var sc = el('div', 'lg-scale')
    ;[['sno', 'Strong no, 20% or less'], ['lno', 'Leans no'], ['mid', 'Uncertain, 35 to 65%'], ['lyes', 'Leans yes'], ['syes', 'Strong yes, 80% or more']].forEach(function (b) { sc.appendChild(el('span', 'verdict ' + b[0], b[1])) })
    d.appendChild(sc)
    d.appendChild(el('p', '', 'Yes/no meters grow from the centre: left for no, right for yes. For choice and score answers the winning bar fades as confidence drops, and anything under 60% is flagged Low confidence.'))
    return d
  }

  function renderDecisions(host, qs, as) {
    var ids = isObj(qs) ? Object.keys(qs) : []
    if (isObj(as)) Object.keys(as).forEach(function (k) { if (ids.indexOf(k) < 0) ids.push(k) })
    if (!ids.length) { host.appendChild(el('div', 'empty', 'No questions recorded for this call.')); return }
    host.appendChild(legend())
    ids.forEach(function (id) {
      var q = isObj(qs) ? qs[id] : null, a = isObj(as) ? as[id] : null
      var card = el('article', 'dcard')
      var hd = el('div', 'dh2'); hd.appendChild(el('span', 'qid', id))
      var type = (q && q.type) || (a && a.type) || ''
      if (type) hd.appendChild(el('span', 'tbadge', type))
      var av = answerView(q, a)
      if (av.low) { var lf = el('span', 'lowflag', 'Low confidence'); lf.title = 'Confidence is below 60%'; hd.appendChild(lf) }
      hd.appendChild(el('span', 'res', av.res)); card.appendChild(hd)
      if (q && q.instructions != null) {
        var ins = q.instructions
        if (typeof ins === 'string') card.appendChild(longInstr(ins))
        else card.appendChild(longText(JSON.stringify(ins, null, 2)))
      }
      card.appendChild(av.el)
      if (av.crit) {
        var tg = el('button', 'ghost more', 'Show criteria'); tg.type = 'button'; tg.setAttribute('aria-expanded', 'false')
        tg.addEventListener('click', function () { var on = card.classList.toggle('show-crit'); tg.textContent = on ? 'Hide criteria' : 'Show criteria'; tg.setAttribute('aria-expanded', on ? 'true' : 'false') })
        card.appendChild(tg)
      }
      host.appendChild(card)
    })
  }

  function longInstr(s) {
    var w = el('div', 'instr'), p = el('p', s.length > 160 ? 'clamp2' : '', s)
    w.appendChild(p)
    if (s.length > 160) {
      var b = el('button', 'ghost more', 'Show more'); b.type = 'button'; b.setAttribute('aria-expanded', 'false')
      b.addEventListener('click', function () { var on = p.classList.toggle('clamp2'); b.textContent = on ? 'Show more' : 'Show less'; b.setAttribute('aria-expanded', on ? 'false' : 'true') })
      w.appendChild(b)
    }
    return w
  }

  function jsonBlock(host, label, v) {
    if (label) host.appendChild(el('div', 'jl', label))
    var pre = el('pre'); renderJson(pre, v); host.appendChild(pre)
  }

  function renderSection(sec) {
    var host = $('d-' + sec); clear(host)
    var mode = views[sec]
    Array.prototype.forEach.call(document.querySelectorAll('.seg[data-sec="' + sec + '"] button'), function (b) { b.setAttribute('aria-pressed', b.getAttribute('data-mode') === mode ? 'true' : 'false') })
    if (!cur) return
    if (mode === 'json') {
      if (sec === 'state') jsonBlock(host, '', cur.state)
      else { jsonBlock(host, 'questions', cur.questions); jsonBlock(host, 'answers', cur.answers) }
    } else if (sec === 'state') renderState(host, cur.state)
    else renderDecisions(host, cur.questions, cur.answers)
  }

  function linkChip(node, label, patch) {
    var b = el('button', 'chiplink'); b.type = 'button'; b.appendChild(node); b.title = 'Filter the feed to ' + label
    b.addEventListener('click', function () { setFilters(patch); closeDrawer() })
    return b
  }
  function renderChips(c) {
    var h = $('d-chips'); clear(h)
    if (c.decision) h.appendChild(linkChip(el('span', 'dchip', c.decision), 'decision ' + c.decision, { decision: c.decision }))
    if (c.served_by) h.appendChild(linkChip(pill(c.served_by), c.served_by + ' calls', { servedBy: c.served_by }))
    h.appendChild(el('span', 'st ' + (c.status === 'error' ? 's-error' : 's-ok'), c.status))
    if (isNum(c.latency_ms)) h.appendChild(el('span', 'mono', num(c.latency_ms) + ' ms'))
    if (isNum(c.neurons)) h.appendChild(el('span', 'mono', (Math.round(c.neurons * 100) / 100) + ' neurons'))
    if (c.fallback_reason) h.appendChild(linkChip(el('span', 'tag', c.fallback_reason), 'fallback ' + c.fallback_reason, { fallbackReason: c.fallback_reason }))
    if (c.ts) h.appendChild(el('span', 'mono', fmtTime(c.ts)))
  }

  function showDrawer() {
    $('scrim').hidden = false; $('drawer').hidden = false
    $('d-close').focus()
  }
  var closeTimer = null
  function finishClose() {
    closeTimer = null
    $('drawer').hidden = true; $('scrim').hidden = true
    $('drawer').classList.remove('closing'); $('scrim').classList.remove('closing')
  }
  function closeDrawer() {
    if ($('drawer').hidden || closeTimer) return
    openToken++
    $('drawer').classList.add('closing'); $('scrim').classList.add('closing')
    closeTimer = setTimeout(finishClose, 170)
    selectedId = null; cur = null
    Array.prototype.forEach.call(document.querySelectorAll('tbody tr.sel'), function (r) { r.classList.remove('sel') })
    if (lastFocus && document.body.contains(lastFocus)) lastFocus.focus()
  }

  function openDrawer(id) {
    if (closeTimer) { clearTimeout(closeTimer); finishClose() }
    var token = ++openToken
    selectedId = id; cur = null
    Array.prototype.forEach.call(document.querySelectorAll('tbody tr'), function (r) { r.classList.toggle('sel', r.dataset.id === id) })
    $('d-title').textContent = 'Call'; $('d-sub').textContent = id
    clear($('d-chips'))
    var dl = $('d-meta'); skeleton(dl, 5)
    skeleton($('d-decisions'), 4); skeleton($('d-state'), 3)
    showDrawer()
    api('/v1/calls/' + encodeURIComponent(id)).then(function (c) {
      if (token !== openToken) return
      cur = c
      $('d-title').textContent = c.decision || 'call'
      $('d-sub').textContent = c.id
      renderChips(c)
      clear(dl)
      ;['ts', 'agent', 'mode', 'session', 'router_pick', 'served_by', 'route_reason', 'model', 'input_tokens', 'neurons', 'latency_ms', 'fallback_reason', 'status', 'error', 'replay'].forEach(function (k) {
        if (c[k] == null || c[k] === '') return
        dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', k === 'ts' ? new Date(c.ts).toISOString() : c[k]))
      })
      renderSection('decisions'); renderSection('state')
    }).catch(function () {
      if (token !== openToken) return
      clear(dl); dl.appendChild(el('dt', '', 'error')); dl.appendChild(el('dd', '', 'Could not load this call. Close and try again.'))
      clear($('d-decisions')); clear($('d-state'))
    })
  }

  function fail(e) {
    if (e && e.message === 'unauthorized') return
    var m = e && e.message || 'error'
    setStatus('error', 'error: ' + m); showBanner('Could not refresh data (' + m + '). ' + (loaded ? 'Showing the last loaded data.' : ''), 'Retry', refresh); failPlaceholders()
  }

  function refresh() {
    var d = days
    setStatus('busy', loaded ? null : 'loading')
    return Promise.all([
      api('/v1/stats?days=' + d).then(renderStats),
      api('/v1/timeline?days=' + d).then(renderMix),
      api('/v1/budget').then(renderBudget),
      loadFeed(),
    ]).then(function () {
      loaded = true; hideBanner()
      setStatus($('live').checked ? 'live' : 'idle', 'updated ' + new Date().toLocaleTimeString())
    }).catch(fail)
  }

  function startTimer() { stop(); if ($('live').checked) timer = setInterval(refresh, 5000) }

  // ---- wiring ----
  qa('#days button').forEach(function (b) {
    b.addEventListener('click', function () {
      days = b.getAttribute('data-days')
      qa('#days button').forEach(function (x) { x.setAttribute('aria-pressed', x === b ? 'true' : 'false') })
      writeHash(); refresh()
    })
  })
  $('live').addEventListener('change', function () { startTimer(); if (!this.checked) setStatus('idle') ; else refresh() })
  Object.keys(SELECTS).forEach(function (id) { $(id).addEventListener('change', function () { F[SELECTS[id]] = $(id).value; filtersChanged(false) }) })
  window.addEventListener('hashchange', function () { readHash(); syncSelects(); renderFilterChips(); applyHighlights(); refresh() })
  $('more').addEventListener('click', loadMore)
  $('banner-act').addEventListener('click', function () { if (bannerFn) bannerFn() })
  $('d-close').addEventListener('click', closeDrawer)
  $('scrim').addEventListener('click', closeDrawer)
  document.addEventListener('keydown', function (e) {
    if ($('drawer').hidden) return
    if (e.key === 'Escape') { closeDrawer(); return }
    if (e.key === 'Tab') { // keep focus inside the dialog
      var f = $('drawer').querySelectorAll('button:not([disabled])')
      if (!f.length) return
      var first = f[0], lastEl = f[f.length - 1]
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); lastEl.focus() }
      else if (!e.shiftKey && document.activeElement === lastEl) { e.preventDefault(); first.focus() }
    }
  })
  Array.prototype.forEach.call(document.querySelectorAll('.seg[data-sec] button'), function (b) {
    b.addEventListener('click', function () {
      var sec = b.parentNode.getAttribute('data-sec'), mode = b.getAttribute('data-mode')
      views[sec] = mode
      try { localStorage.setItem('viz.view.' + sec, mode) } catch (e) {}
      renderSection(sec)
    })
  })
  Array.prototype.forEach.call(document.querySelectorAll('button.copy'), function (b) {
    b.addEventListener('click', function () {
      if (!cur) return
      var sec = b.getAttribute('data-sec'), txt = JSON.stringify(sec === 'state' ? cur.state : { questions: cur.questions, answers: cur.answers }, null, 2)
      var done = function (ok) { b.textContent = ok ? 'Copied' : 'Copy failed'; setTimeout(function () { b.textContent = 'Copy JSON' }, 1400) }
      if (navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(txt).then(function () { done(true) }, function () { done(false) })
      else done(false)
    })
  })
  var rz = null
  window.addEventListener('resize', function () { clearTimeout(rz); rz = setTimeout(function () { if (last.tl) renderMix(last.tl); if (last.lat) renderLatency(last.lat) }, 120) })

  skeleton($('mix'), 1, 'tall'); skeleton($('budget'), 5)
  ;['latency', 'shadow', 'fallbacks', 'routes'].forEach(function (id) { skeleton($(id), 4) })
  var kph = $('kpis'); for (var i = 0; i < 4; i++) { var k = el('div', 'kpi'); k.appendChild(el('div', 'skel', '')); k.appendChild(el('div', 'skel num')); kph.appendChild(k) }
  readHash(); syncSelects(); renderFilterChips()
  refresh(); startTimer()
})()
