(function () {
  'use strict'
  // All payload data is rendered with textContent / SVG attributes only. Never innerHTML.
  var $ = function (id) { return document.getElementById(id) }
  var TIERS = ['flash', 'clef', 'omni', 'jev', 'unknown']
  var timer = null
  var feed = [] // newest first
  var next = null

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
  function tierColor(t) { return 'var(--' + (TIERS.indexOf(t) >= 0 ? t : 'unknown') + ')' }
  function pill(t) { var s = el('span', 'pill t-' + (TIERS.indexOf(t) >= 0 ? t : 'unknown'), t || 'none'); return s }
  function fmtTime(ts) { var d = new Date(ts); return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' }) + ' ' + d.toLocaleTimeString() }

  // Auth is the Cloudflare Access cookie, sent same-origin. No tokens live in this page.
  function api(path) {
    return fetch(path, { credentials: 'same-origin' }).then(function (r) {
      if (r.status === 401 || r.status === 403 || r.redirected) { stop(); $('status').textContent = 'session expired: reload to log in again'; throw new Error('unauthorized') }
      if (!r.ok) throw new Error('HTTP ' + r.status)
      return r.json()
    })
  }

  function stop() { if (timer) { clearInterval(timer); timer = null } }

  function barRows(host, entries, opts) {
    clear(host)
    if (!entries.length) { host.appendChild(el('p', 'muted', 'No data')); return }
    var max = Math.max.apply(null, entries.map(function (e) { return e[1] })) || 1
    entries.forEach(function (e) {
      var row = el('div', 'row')
      var l = el('span', 'lbl', e[0]); l.title = e[0]
      var bar = el('div', 'bar'), i = el('i', opts && opts.warn && opts.warn(e[0]) ? 'warn' : '')
      i.style.width = Math.max(2, (e[1] / max) * 100) + '%'
      bar.appendChild(i)
      row.appendChild(l); row.appendChild(bar); row.appendChild(el('span', '', e[2] != null ? e[2] : e[1]))
      host.appendChild(row)
    })
  }

  function renderKpis(s) {
    var host = $('kpis'); clear(host)
    ;[['Calls', s.total], ['Errors', s.errors], ['Free %', s.freePercent + '%'], ['Neurons', s.neurons]].forEach(function (k) {
      var d = el('div', 'kpi'); d.appendChild(el('b', '', k[1])); d.appendChild(el('span', 'muted', k[0])); host.appendChild(d)
    })
  }

  function renderMix(t) {
    var host = $('mix'); clear(host)
    var b = t.buckets
    if (!b.length) { host.appendChild(el('p', 'muted', 'No data')); return }
    var W = 600, H = 160, L = 28, B = 16, n = b.length
    var max = 1
    b.forEach(function (x) { var s = 0; for (var k in x.counts) s += x.counts[k]; if (s > max) max = s })
    var s = svg('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Routing mix over time' })
    var bw = (W - L) / n
    b.forEach(function (x, i) {
      var y = H - B
      TIERS.forEach(function (tier) {
        var c = x.counts[tier]; if (!c) return
        var h = (c / max) * (H - B - 4)
        y -= h
        s.appendChild(svg('rect', { x: L + i * bw + 1, y: y, width: Math.max(1, bw - 2), height: h, fill: tierColor(tier) }))
      })
    })
    s.appendChild(svg('text', { x: 0, y: 10 }, max))
    s.appendChild(svg('text', { x: 0, y: H - B }, 0))
    var fmt = t.bucketMs < 86400000 ? function (ts) { return new Date(ts).getHours() + 'h' } : function (ts) { var d = new Date(ts); return (d.getMonth() + 1) + '/' + d.getDate() }
    s.appendChild(svg('text', { x: L, y: H - 3 }, fmt(b[0].t)))
    s.appendChild(svg('text', { x: W - 30, y: H - 3 }, fmt(b[n - 1].t)))
    host.appendChild(s)
    var lg = $('mixlegend'); clear(lg)
    TIERS.forEach(function (tier) { var sp = el('span', '', tier); sp.style.setProperty('--c', tierColor(tier)); lg.appendChild(sp) })
  }

  function renderBudget(b) {
    var host = $('budget'); clear(host)
    var pct = Math.min(100, (b.serverNeurons / b.freeTier) * 100)
    var bar = el('div', 'bar'), i = el('i', pct > 80 ? 'warn' : ''); i.style.width = pct + '%'; bar.appendChild(i)
    host.appendChild(bar)
    var dl = el('dl')
    ;[['serverNeurons', b.serverNeurons + ' / ' + b.freeTier], ['spendLimitErrors', b.spendLimitErrors], ['quotaErrors', b.quotaErrors],
      ['skip-Clef', b.skipClef ? b.skipClef + (b.skipClefUntil ? ' until ' + b.skipClefUntil : '') : 'inactive (this isolate)'],
      ['lastLimitAt', b.lastLimitAt || 'never'], ['resetsAt', b.resetsAt]].forEach(function (r) {
      dl.appendChild(el('dt', '', r[0])); dl.appendChild(el('dd', '', r[1]))
    })
    host.appendChild(dl)
  }

  function renderLatency(lat) {
    var host = $('latency'); clear(host)
    var tiers = Object.keys(lat)
    if (!tiers.length) { host.appendChild(el('p', 'muted', 'No data')); return }
    var max = Math.max.apply(null, tiers.map(function (t) { return lat[t].p90 })) || 1
    tiers.forEach(function (t) {
      var row = el('div', 'row'); row.appendChild(pill(t))
      var bar = el('div', 'bar'), i = el('i'); i.style.width = Math.max(2, lat[t].p90 / max * 100) + '%'; i.style.background = tierColor(t)
      bar.appendChild(i); row.appendChild(bar); row.appendChild(el('span', '', lat[t].p50 + ' / ' + lat[t].p90 + ' ms'))
      host.appendChild(row)
    })
  }

  function renderShadow(sh) {
    var host = $('shadow'); clear(host)
    var ks = Object.keys(sh)
    if (!ks.length) { host.appendChild(el('p', 'muted', 'No shadow pairs in window')); return }
    barRows(host, ks.map(function (k) {
      var a = Math.round((1 - sh[k].disagreementRate) * 1000) / 10
      return [k, a, a + '% (' + sh[k].pairs + ')']
    }), { warn: function () { return false } })
  }

  function renderStats(s) {
    renderKpis(s); renderLatency(s.latency); renderShadow(s.shadow)
    var fb = Object.keys(s.fallbacks).map(function (k) { return [k, s.fallbacks[k]] }).sort(function (a, b) { return b[1] - a[1] })
    barRows($('fallbacks'), fb, { warn: function (k) { return /spend-limit|quota/.test(k) } })
    var rr = Object.keys(s.routeReasons || {}).map(function (k) { return [k, s.routeReasons[k]] }).sort(function (a, b) { return b[1] - a[1] }).slice(0, 12)
    barRows($('routes'), rr, { warn: function (k) { return k.indexOf('+emergency-paid') >= 0 } })
    fillSelect($('f-fallback'), 'fallback: any', Object.keys(s.fallbacks))
  }

  function fillSelect(sel, first, values) {
    var cur = sel.value, have = {}
    for (var i = 1; i < sel.options.length; i++) have[sel.options[i].value] = 1
    values.forEach(function (v) { if (!have[v]) { var o = el('option', '', v); o.value = v; sel.appendChild(o) } })
    sel.value = cur
  }

  function filterQuery(extra) {
    var q = ['slim=1', 'limit=50']
    var f = { decision: $('f-decision').value, servedBy: $('f-served').value, fallbackReason: $('f-fallback').value, status: $('f-status').value }
    for (var k in f) if (f[k]) q.push(k + '=' + encodeURIComponent(f[k]))
    if (extra) q.push(extra)
    return q.join('&')
  }

  function renderFeed() {
    var tb = document.querySelector('#feed tbody'); clear(tb)
    feed.forEach(function (c) {
      var tr = el('tr')
      tr.appendChild(el('td', '', fmtTime(c.ts)))
      tr.appendChild(el('td', '', c.decision || '-'))
      var td = el('td'); td.appendChild(pill(c.served_by)); tr.appendChild(td)
      tr.appendChild(el('td', '', c.latency_ms))
      tr.appendChild(el('td', c.status === 'error' ? 's-error' : '', c.status))
      tr.appendChild(el('td', 'wrap', c.fallback_reason || c.route_reason || ''))
      tr.addEventListener('click', function () { openDrawer(c.id) })
      tb.appendChild(tr)
    })
    $('more').hidden = next == null
    fillSelect($('f-decision'), 'decision: any', feed.map(function (c) { return c.decision }).filter(Boolean))
  }

  function loadFeed() {
    return api('/v1/calls?' + filterQuery()).then(function (r) { feed = r.calls; next = r.next; renderFeed() })
  }
  function loadMore() {
    if (next == null) return
    return api('/v1/calls?' + filterQuery('before=' + next)).then(function (r) { feed = feed.concat(r.calls); next = r.next; renderFeed() })
  }

  function openDrawer(id) {
    api('/v1/calls/' + encodeURIComponent(id)).then(function (c) {
      $('d-title').textContent = (c.decision || 'call') + ' - ' + c.id
      var dl = $('d-meta'); clear(dl)
      ;['ts', 'agent', 'mode', 'session', 'router_pick', 'served_by', 'route_reason', 'model', 'input_tokens', 'neurons', 'latency_ms', 'fallback_reason', 'status', 'error', 'replay'].forEach(function (k) {
        if (c[k] == null || c[k] === '') return
        dl.appendChild(el('dt', '', k)); dl.appendChild(el('dd', '', k === 'ts' ? new Date(c.ts).toISOString() : c[k]))
      })
      ;['state', 'questions', 'answers'].forEach(function (k) { $('d-' + k).textContent = JSON.stringify(c[k], null, 2) })
      $('drawer').hidden = false
    }).catch(function () {})
  }

  function refresh() {
    var days = $('days').value
    $('status').textContent = 'updating...'
    return Promise.all([
      api('/v1/stats?days=' + days).then(renderStats),
      api('/v1/timeline?days=' + days).then(renderMix),
      api('/v1/budget').then(renderBudget),
      loadFeed(),
    ]).then(function () { $('status').textContent = 'updated ' + new Date().toLocaleTimeString() })
      .catch(function (e) { if (e.message !== 'unauthorized') $('status').textContent = 'error: ' + e.message })
  }

  function start() {
    refresh(); stop()
    if ($('live').checked) timer = setInterval(refresh, 5000)
  }

  $('days').addEventListener('change', refresh)
  $('live').addEventListener('change', function () { stop(); if (this.checked) timer = setInterval(refresh, 5000) })
  ;['f-decision', 'f-served', 'f-fallback', 'f-status'].forEach(function (id) { $(id).addEventListener('change', loadFeed) })
  $('more').addEventListener('click', loadMore)
  $('d-close').addEventListener('click', function () { $('drawer').hidden = true })
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') $('drawer').hidden = true })

  start()
})()
