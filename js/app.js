/**
 * Repo2Text Ultra — main thread.
 * UI, job manager, virtual viewer, network pipeline, export.
 */
(function (global) {
  'use strict';

  try {
    if (global.self !== global.top) {
      global.top.location.replace(global.location.href);
      return;
    }
  } catch (frameErr) {
    try { global.document.documentElement.innerHTML = ''; } catch (e2) {}
    return;
  }

  var S = (global.R2T && global.R2T.shared) || {};
  var PROFILE = S.deviceProfile ? S.deviceProfile() : { min: 1, max: 4, start: 2, mobile: false, cores: 4 };

  var PROXIES = [
    { id: 'direct', wrap: function (u) { return u; } },
    { id: 'allorigins', wrap: function (u) { return 'https://api.allorigins.win/raw?url=' + encodeURIComponent(u); } },
    { id: 'codetabs', wrap: function (u) { return 'https://api.codetabs.com/v1/proxy?quest=' + encodeURIComponent(u); } }
  ];

  var HISTORY_KEY = 'repoHistory';
  var HISTORY_LIMIT = 10;
  var VIEW_BUFFER = 50;
  var MAX_SPACER = 8000000;
  var LINE_PROBE = 20.8;

  var jobSeq = 0;
  var currentJob = null;
  var lastBlobUrl = null;
  var toastTimer = 0;
  var confirmResolver = null;
  var currentSourceName = 'code';
  var thumbRaf = 0;
  var viewRaf = 0;
  var progressRaf = 0;
  var isDragging = false;
  var startY = 0;
  var startScrollTop = 0;
  var metrics = { filesPerSec: 0, bytesPerSec: 0, queueLength: 0, workerUtil: 0 };

  /* ------------------------------------------------------------------ */
  /* DOM                                                                */
  /* ------------------------------------------------------------------ */
  var $ = function (id) { return document.getElementById(id); };

  var els = {};
  function cacheEls() {
    els.tabUrl = $('tabUrl');
    els.tabZip = $('tabZip');
    els.urlSection = $('urlSection');
    els.zipSection = $('zipSection');
    els.repoUrl = $('repoUrl');
    els.fetchBtn = $('fetchBtn');
    els.btnText = $('btnText');
    els.zipFileInput = $('zipFileInput');
    els.dropZone = $('dropZone');
    els.historyCard = $('historyCard');
    els.historyList = $('historyList');
    els.statusContainer = $('statusContainer');
    els.statusTitle = $('statusTitle');
    els.statusText = $('statusText');
    els.progressBar = $('progressBar');
    els.progressPercent = $('progressPercent');
    els.statFiles = $('statFiles');
    els.statBytes = $('statBytes');
    els.statSpeed = $('statSpeed');
    els.statEta = $('statEta');
    els.cancelBtn = $('cancelBtn');
    els.outputContainer = $('outputContainer');
    els.fileCountBadge = $('fileCountBadge');
    els.liveBadge = $('liveBadge');
    els.scrollArea = $('scrollArea');
    els.scrollTrack = $('scrollTrack');
    els.scrollThumb = $('scrollThumb');
    els.resultText = $('resultText');
    els.virtualSizer = $('virtualSizer');
    els.lineCount = $('lineCount');
    els.sizeCount = $('sizeCount');
    els.skippedPanel = $('skippedPanel');
    els.skippedSummary = $('skippedSummary');
    els.skippedList = $('skippedList');
    els.toastMsg = $('toastMsg');
    els.toastText = $('toastText');
    els.safetyModal = $('safetyModal');
    els.confirmModal = $('confirmModal');
    els.confirmTitle = $('confirmTitle');
    els.confirmText = $('confirmText');
    els.confirmYes = $('confirmYes');
    els.confirmNo = $('confirmNo');
    els.optSkipGenerated = $('optSkipGenerated');
    els.optNested = $('optNested');
  }

  function filterOptions() {
    return {
      skipGenerated: !!(els.optSkipGenerated && els.optSkipGenerated.checked),
      extractNested: !!(els.optNested && els.optNested.checked),
      generatedDirs: S.GENERATED_DIRS
    };
  }

  /* ------------------------------------------------------------------ */
  /* Chunk store                                                        */
  /* ------------------------------------------------------------------ */
  function ChunkStore() { this.reset(); }
  ChunkStore.prototype.reset = function () {
    this.kind = 'archive';
    this.meta = {};
    this.files = [];
    this.skipped = [];
    this.header = '';
    this.headerLines = 0;
    this.footer = '';
    this.footerLines = 0;
    this.totalBytes = 0;
    this.contentLines = 0;
    this.displayLines = 0;
    this.readyCount = 0;
    this.expectedTotal = 0;
  };
  ChunkStore.prototype._bannerLines = function (path) {
    return S.countLines(S.fileBanner(path));
  };
  ChunkStore.prototype._fileDisplayLines = function (file) {
    var banner = S.fileBanner(file.path);
    var b = S.countLines(banner);
    var t = file.lineCount || S.countLines(file.text || '');
    var extra = 1;
    if (banner.charCodeAt(banner.length - 1) === 10) b -= 1;
    return b + t + extra;
  };
  ChunkStore.prototype.addFile = function (file) {
    var displayLines = this._fileDisplayLines(file);
    file.displayLines = displayLines;
    var idx = 0;
    var linesBefore = this.headerLines;
    while (idx < this.files.length && this.files[idx].path < file.path) {
      linesBefore += this.files[idx].displayLines;
      idx++;
    }
    if (idx < this.files.length && this.files[idx].path === file.path) {
      var old = this.files[idx];
      this.totalBytes -= old.byteLength || 0;
      this.contentLines -= old.lineCount || 0;
      this.displayLines -= old.displayLines || 0;
      this.files[idx] = file;
    } else {
      this.files.splice(idx, 0, file);
      this.readyCount++;
    }
    this.totalBytes += file.byteLength || (file.text ? file.text.length : 0);
    this.contentLines += file.lineCount || S.countLines(file.text || '');
    this.displayLines += displayLines;
    return { idx: idx, linesBefore: linesBefore, displayLines: displayLines };
  };
  ChunkStore.prototype.setHeader = function (text) {
    this.displayLines -= this.headerLines;
    this.header = text || '';
    this._headerOff = null;
    this.headerLines = this.header ? S.countLines(this.header) : 0;
    this.displayLines += this.headerLines;
  };
  ChunkStore.prototype.setFooter = function (text) {
    this.displayLines -= this.footerLines;
    this.footer = text || '';
    this.footerLines = this.footer ? S.countLines(this.footer) : 0;
    this.displayLines += this.footerLines;
  };
  ChunkStore.prototype.addSkipped = function (item) {
    this.skipped.push(item);
  };
  ChunkStore.prototype.ordered = function () { return this.files; };
  ChunkStore.prototype.buildParts = function (pure) {
    var parts = [];
    var files = this.files;
    if (!pure) {
      parts.push(S.buildHeader(this.kind, this.meta, files));
      parts.push('\n');
    }
    for (var i = 0; i < files.length; i++) {
      if (!pure) parts.push(S.fileBanner(files[i].path));
      parts.push(files[i].text == null ? '' : files[i].text);
      parts.push(pure ? '\n\n' : '\n');
    }
    if (!pure) parts.push(S.buildSkippedNote(this.skipped));
    return parts;
  };
  ChunkStore.prototype.payloadChars = function (pure) {
    var n = 0;
    var files = this.files;
    if (!pure) n += 400 + files.length * 40;
    for (var i = 0; i < files.length; i++) {
      n += (files[i].text ? files[i].text.length : 0) + (pure ? 2 : 80 + (files[i].path ? files[i].path.length : 0));
    }
    return n;
  };

  var store = new ChunkStore();

  /* ------------------------------------------------------------------ */
  /* Virtual viewer                                                     */
  /* ------------------------------------------------------------------ */
  function buildOffsets(str) {
    var count = 1;
    for (var i = 0; i < str.length; i++) if (str.charCodeAt(i) === 10) count++;
    var o = new Uint32Array(count);
    o[0] = 0;
    var k = 1;
    for (var j = 0; j < str.length; j++) if (str.charCodeAt(j) === 10) o[k++] = j + 1;
    return o;
  }

  function sliceLines(str, start, end, offsets) {
    if (!str || start >= end) return '';
    if (!offsets) offsets = buildOffsets(str);
    var last = offsets.length - 1;
    var a = offsets[Math.max(0, Math.min(start, last))];
    var b = end >= offsets.length ? str.length : offsets[end];
    return str.slice(a, b);
  }

  function extractFileLines(file, localStart, localEnd) {
    if (localEnd <= localStart) return '';
    if (!file._banner) file._banner = S.fileBanner(file.path);
    var banner = file._banner;
    var body = (file.text == null ? '' : file.text) + '\n';
    if (!file._bannerOff) file._bannerOff = buildOffsets(banner);
    var bOff = file._bannerOff;
    var bannerJoinLines = banner.charCodeAt(banner.length - 1) === 10 ? bOff.length - 1 : bOff.length;
    var parts = [];
    if (localStart < bannerJoinLines) {
      parts.push(sliceLines(banner, localStart, Math.min(localEnd, bannerJoinLines), bOff));
    }
    if (localEnd > bannerJoinLines) {
      if (!file._bodyOff) file._bodyOff = buildOffsets(body);
      var cs = Math.max(0, localStart - bannerJoinLines);
      var ce = localEnd - bannerJoinLines;
      parts.push(sliceLines(body, cs, ce, file._bodyOff));
    }
    return parts.join('');
  }

  function measureLineHeight() {
    var probe = document.createElement('pre');
    probe.className = 'virtual-window';
    probe.style.position = 'absolute';
    probe.style.visibility = 'hidden';
    probe.style.left = '-9999px';
    probe.textContent = 'A\nB\nC';
    document.body.appendChild(probe);
    var h = probe.getBoundingClientRect().height;
    document.body.removeChild(probe);
    if (h > 10) LINE_PROBE = h / 3;
    return LINE_PROBE;
  }

  var viewer = {
    startLine: 0,
    endLine: 0,
    totalLines: 1,
    lineHeight: 20.8,
    placeholder: 'Hasil kode akan muncul di sini...',
    attached: false
  };

  function totalDisplayLines() {
    var n = store.displayLines;
    return n > 0 ? n : 1;
  }

  function spacerHeight() {
    var lines = totalDisplayLines();
    var h = lines * viewer.lineHeight + 40;
    return Math.min(h, MAX_SPACER);
  }

  function lineFromScroll(scrollTop) {
    var lines = totalDisplayLines();
    var sh = spacerHeight();
    var ch = els.scrollArea.clientHeight || 1;
    if (sh <= ch || lines <= 1) return 0;
    if (sh < MAX_SPACER - 1) return Math.max(0, Math.floor(scrollTop / viewer.lineHeight));
    var maxScroll = sh - ch;
    return Math.floor((scrollTop / maxScroll) * Math.max(0, lines - 1));
  }

  function collectVisibleText(start, end) {
    var parts = [];
    var line = 0;
    if (store.header) {
      if (end > line && start < line + store.headerLines) {
        var hs = Math.max(0, start - line);
        var he = Math.min(store.headerLines, end - line);
        if (!store._headerOff) store._headerOff = buildOffsets(store.header);
        parts.push(sliceLines(store.header, hs, he, store._headerOff));
      }
      line += store.headerLines;
    }
    for (var i = 0; i < store.files.length; i++) {
      if (line >= end) break;
      var f = store.files[i];
      var dl = f.displayLines;
      if (line + dl <= start) { line += dl; continue; }
      var ls = Math.max(0, start - line);
      var le = Math.min(dl, end - line);
      parts.push(extractFileLines(f, ls, le));
      line += dl;
    }
    if (store.footer && line < end) {
      if (start < line + store.footerLines) {
        var fs = Math.max(0, start - line);
        var fe = Math.min(store.footerLines, end - line);
        parts.push(sliceLines(store.footer, fs, fe, buildOffsets(store.footer)));
      }
    }
    return parts.join('');
  }

  function renderViewer() {
    viewRaf = 0;
    if (!els.resultText) return;
    if (!store.readyCount && !store.header) {
      els.resultText.textContent = viewer.placeholder;
      els.resultText.style.transform = 'translate3d(0,0,0)';
      els.virtualSizer.style.height = '100%';
      scheduleThumb();
      return;
    }
    var lines = totalDisplayLines();
    viewer.totalLines = lines;
    var ch = els.scrollArea.clientHeight || 400;
    var visible = Math.ceil(ch / viewer.lineHeight) + 2;
    var start = Math.max(0, lineFromScroll(els.scrollArea.scrollTop) - VIEW_BUFFER);
    var end = Math.min(lines, start + visible + VIEW_BUFFER * 2);
    if (end <= start) end = Math.min(lines, start + visible);
    viewer.startLine = start;
    viewer.endLine = end;
    var text = collectVisibleText(start, end);
    els.resultText.textContent = text || ' ';
    var y = start * viewer.lineHeight;
    if (spacerHeight() >= MAX_SPACER) {
      y = (start / Math.max(1, lines)) * spacerHeight();
    }
    els.resultText.style.transform = 'translate3d(0,' + y + 'px,0)';
    els.virtualSizer.style.height = spacerHeight() + 'px';
    var w = Math.max(els.scrollArea.clientWidth, els.resultText.scrollWidth);
    els.virtualSizer.style.width = w + 'px';
    scheduleThumb();
  }

  function scheduleRender() {
    if (viewRaf) return;
    viewRaf = requestAnimationFrame(renderViewer);
  }

  function adjustScrollLines(deltaLines) {
    if (!deltaLines) return;
    els.scrollArea.scrollTop += deltaLines * viewer.lineHeight;
  }

  /* ------------------------------------------------------------------ */
  /* Custom scrollbar                                                   */
  /* ------------------------------------------------------------------ */
  function updateThumb() {
    var area = els.scrollArea;
    var track = els.scrollTrack;
    var thumb = els.scrollThumb;
    if (!area || !track || !thumb) return;
    var maxScroll = area.scrollHeight - area.clientHeight;
    if (maxScroll <= 0) {
      thumb.style.transform = 'translate3d(0,0,0)';
      return;
    }
    var ratio = area.clientHeight / area.scrollHeight;
    var thumbH = Math.max(48, Math.min(track.clientHeight, track.clientHeight * ratio));
    thumb.style.height = thumbH + 'px';
    var maxThumb = Math.max(0, track.clientHeight - thumbH);
    var pct = area.scrollTop / maxScroll;
    thumb.style.transform = 'translate3d(0,' + (pct * maxThumb) + 'px,0)';
  }

  function scheduleThumb() {
    if (thumbRaf) return;
    thumbRaf = requestAnimationFrame(function () {
      thumbRaf = 0;
      updateThumb();
    });
  }

  function selectVisibleText() {
    var range = document.createRange();
    range.selectNodeContents(els.resultText);
    var sel = window.getSelection();
    sel.removeAllRanges();
    sel.addRange(range);
    els.scrollArea.focus({ preventScroll: true });
  }

  /* ------------------------------------------------------------------ */
  /* UI helpers                                                         */
  /* ------------------------------------------------------------------ */
  function showToast(message, warn) {
    els.toastText.textContent = message;
    els.toastMsg.classList.toggle('warn', !!warn);
    els.toastMsg.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { els.toastMsg.classList.remove('show'); }, 3200);
  }

  function showModal() { els.safetyModal.classList.add('show'); }
  function closeModal() { els.safetyModal.classList.remove('show'); }

  function confirmAction(title, text) {
    return new Promise(function (resolve) {
      confirmResolver = resolve;
      els.confirmTitle.textContent = title || 'Konfirmasi';
      els.confirmText.textContent = text || '';
      els.confirmModal.classList.add('show');
    });
  }

  function finishConfirm(ok) {
    els.confirmModal.classList.remove('show');
    var r = confirmResolver;
    confirmResolver = null;
    if (r) r(!!ok);
  }

  function setBusy(busy) {
    if (els.fetchBtn) els.fetchBtn.disabled = !!busy;
    if (els.btnText) els.btnText.textContent = busy ? 'Memproses...' : 'Ekstrak Kode';
  }

  function resetIdleUi() {
    els.statusContainer.style.display = 'none';
    els.liveBadge.classList.remove('show');
    setBusy(false);
  }

  function showProgress(title, sub) {
    els.statusContainer.style.display = 'block';
    if (title) els.statusTitle.textContent = title;
    if (sub) els.statusText.textContent = sub;
  }

  function updateSkippedUi() {
    if (!store.skipped.length) {
      els.skippedPanel.classList.remove('show');
      return;
    }
    els.skippedPanel.classList.add('show');
    els.skippedSummary.textContent = store.skipped.length + ' file dilewati';
    while (els.skippedList.firstChild) els.skippedList.removeChild(els.skippedList.firstChild);
    var max = Math.min(store.skipped.length, 80);
    for (var i = 0; i < max; i++) {
      var s = store.skipped[i];
      var li = document.createElement('li');
      li.textContent = (s.path || s) + (s.reason ? ' — ' + s.reason : '');
      els.skippedList.appendChild(li);
    }
    if (store.skipped.length > max) {
      var more = document.createElement('li');
      more.textContent = '… +' + (store.skipped.length - max) + ' lainnya';
      els.skippedList.appendChild(more);
    }
  }

  function updateCounts() {
    els.fileCountBadge.textContent = String(store.readyCount);
    els.lineCount.textContent = store.contentLines.toLocaleString() + ' baris';
    els.sizeCount.textContent = S.formatBytes(store.totalBytes);
    updateSkippedUi();
  }

  function applyProgress(job) {
    if (!job || job.cancelled) return;
    var total = job.total || 0;
    var done = job.processed + (job.skipped || 0);
    var pct = total > 0 ? Math.min(99, Math.round((done / total) * 100)) : (job.indeterminate ? 0 : 0);
    if (job.finished) pct = 100;
    els.progressBar.style.width = pct + '%';
    els.progressPercent.textContent = pct + '%';
    if (job.currentPath) els.statusText.textContent = job.currentPath;
    var elapsed = Math.max(1, performance.now() - job.startedAt);
    var bps = job.bytes * 1000 / elapsed;
    var fps = (job.processed || 0) * 1000 / elapsed;
    metrics.filesPerSec = fps;
    metrics.bytesPerSec = bps;
    metrics.queueLength = Math.max(0, (job.total || 0) - done);
    els.statFiles.textContent = done.toLocaleString() + ' / ' + (total ? total.toLocaleString() : '?') + ' files';
    els.statBytes.textContent = S.formatBytes(job.bytes) + ' processed';
    els.statSpeed.textContent = S.formatBytes(bps) + '/s';
    var remain = total > done && bps > 0 ? ((total - done) / Math.max(fps, 0.01)) * 1000 : 0;
    if (!total || total <= done) remain = 0;
    els.statEta.textContent = 'ETA ' + S.formatDuration(remain);
  }

  function scheduleProgress(job) {
    if (progressRaf) return;
    progressRaf = requestAnimationFrame(function () {
      progressRaf = 0;
      applyProgress(job || currentJob);
    });
  }

  function revealEditor(live) {
    els.outputContainer.style.display = 'block';
    if (live) els.liveBadge.classList.add('show');
    else els.liveBadge.classList.remove('show');
    scheduleRender();
    updateCounts();
  }

  /* ------------------------------------------------------------------ */
  /* Job manager                                                        */
  /* ------------------------------------------------------------------ */
  function isLive(jobId) {
    return currentJob && currentJob.id === jobId && !currentJob.cancelled;
  }

  function terminateWorker(w) {
    if (!w) return;
    try { w.postMessage({ type: 'cancel' }); } catch (e) {}
    try { w.terminate(); } catch (e2) {}
  }

  function cancelJob(userInitiated) {
    if (!currentJob) {
      if (userInitiated) resetIdleUi();
      return;
    }
    var job = currentJob;
    job.cancelled = true;
    try { job.abort.abort(); } catch (e) {}
    terminateWorker(job.worker);
    job.worker = null;
    if (job.pool) {
      for (var i = 0; i < job.pool.length; i++) terminateWorker(job.pool[i]);
      job.pool = null;
    }
    currentJob = null;
    if (userInitiated) {
      store.reset();
      scheduleRender();
      els.outputContainer.style.display = 'none';
      resetIdleUi();
      showToast('Ekstraksi dibatalkan');
    }
  }

  function createJob(kind) {
    cancelJob(false);
    store.reset();
    store.kind = kind === 'repo' ? 'repo' : 'archive';
    var id = ++jobSeq;
    var ac = new AbortController();
    currentJob = {
      id: id,
      kind: kind,
      abort: ac,
      cancelled: false,
      worker: null,
      pool: null,
      startedAt: performance.now(),
      processed: 0,
      skipped: 0,
      total: 0,
      bytes: 0,
      currentPath: '',
      firstShown: false,
      finished: false,
      networkConc: PROFILE.start,
      latencies: []
    };
    return currentJob;
  }

  function ingestFile(job, msg) {
    if (!isLive(job.id)) return;
    if (!msg || typeof msg !== 'object') return;
    var path = S.sanitizePath(msg.path);
    if (!path) return;
    var text = typeof msg.text === 'string' ? msg.text : '';
    var info = store.addFile({
      order: msg.order,
      path: path,
      text: text,
      lineCount: msg.lineCount,
      byteLength: msg.byteLength,
      encoding: msg.encoding
    });
    job.processed++;
    job.bytes += msg.byteLength || 0;
    if (info.linesBefore < viewer.startLine) adjustScrollLines(info.displayLines);
    if (!job.firstShown) {
      job.firstShown = true;
      revealEditor(true);
      els.scrollArea.scrollTop = 0;
    } else {
      scheduleRender();
    }
    updateCounts();
    scheduleProgress(job);
  }

  function ingestSkipped(job, msg) {
    if (!isLive(job.id)) return;
    store.addSkipped({
      path: S.safeUiText(msg && msg.path, 300),
      reason: S.safeUiText(msg && msg.reason, 160)
    });
    job.skipped++;
    updateSkippedUi();
    scheduleProgress(job);
  }

  function spawnArchiveWorker(job) {
    var w = new Worker('js/worker.js');
    w.onmessage = function (ev) { handleWorkerMessage(job, w, ev.data || {}); };
    w.onerror = function (err) {
      if (!isLive(job.id)) return;
      failJob(job, 'Worker error: ' + (err && err.message ? err.message : 'unknown'));
    };
    job.worker = w;
    return w;
  }

  function continueWorker(job) {
    if (!isLive(job.id) || !job.worker) return;
    var pressure = S.memoryPressure();
    if (pressure > 0.82) {
      try { job.worker.postMessage({ type: 'pause', jobId: job.id }); } catch (e) {}
      setTimeout(function () {
        if (!isLive(job.id) || !job.worker) return;
        try { job.worker.postMessage({ type: 'resume', jobId: job.id }); } catch (e2) {}
        try { job.worker.postMessage({ type: 'continue', jobId: job.id }); } catch (e3) {}
      }, 200);
      return;
    }
    try { job.worker.postMessage({ type: 'continue', jobId: job.id }); } catch (e4) {}
  }

  async function handleWorkerMessage(job, worker, msg) {
    if (!msg || typeof msg !== 'object' || typeof msg.type !== 'string') return;
    if (msg.jobId != null && msg.jobId !== job.id && msg.type !== 'boot' && msg.type !== 'ready') return;
    if (!isLive(job.id) && msg.type !== 'boot') return;

    switch (msg.type) {
      case 'boot':
      case 'ready':
        return;
      case 'started':
        showProgress('Menganalisis arsip...', currentSourceName);
        return;
      case 'format':
        if (msg.depth > 0) {
          els.statusTitle.textContent = 'Nested archive detected';
          els.statusText.textContent = S.safeUiText(msg.name + ' (' + msg.format + ')', 240);
        }
        return;
      case 'meta':
        if (msg.bomb && msg.bomb.level === 'warn') {
          /* decision handled separately */
        }
        return;
      case 'decision':
        if (msg.kind === 'suspicious') {
          var ok = await confirmAction('Arsip mencurigakan', S.safeUiText((msg.payload && msg.payload.reason) || 'Rasio kompresi ekstrem. Lanjutkan?', 500));
          if (!isLive(job.id)) return;
          try { worker.postMessage({ type: 'decision-result', jobId: job.id, proceed: ok }); } catch (e) {}
        }
        return;
      case 'plan':
        job.total = msg.total || 0;
        store.expectedTotal = job.total;
        els.fileCountBadge.textContent = String(job.total);
        els.statusTitle.textContent = 'Mengekstrak konten...';
        scheduleProgress(job);
        return;
      case 'current':
        job.currentPath = S.safeUiText(msg.path || '', 240);
        scheduleProgress(job);
        return;
      case 'file':
        ingestFile(job, msg);
        return;
      case 'skipped':
        ingestSkipped(job, msg);
        return;
      case 'nested':
        els.statusTitle.textContent = 'Nested archive detected';
        els.statusText.textContent = S.safeUiText(msg.path, 240);
        return;
      case 'await-continue':
        continueWorker(job);
        return;
      case 'warning':
        showToast(S.safeUiText(msg.message, 180), true);
        return;
      case 'error':
        if (msg.fatal) failJob(job, S.safeUiText(msg.message, 300));
        else {
          ingestSkipped(job, { path: msg.path || '?', reason: msg.message });
        }
        return;
      case 'cancelled':
        return;
      case 'done':
        completeJob(job);
        return;
      default:
        return;
    }
  }

  function failJob(job, message) {
    if (!isLive(job.id)) return;
    job.cancelled = true;
    terminateWorker(job.worker);
    job.worker = null;
    currentJob = null;
    resetIdleUi();
    setBusy(false);
    alert('Gagal mengekstrak: ' + S.safeUiText(message, 300));
  }

  function completeJob(job) {
    if (!isLive(job.id)) return;
    if (!store.readyCount) {
      failJob(job, store.kind === 'archive'
        ? 'Tidak ditemukan file teks yang dapat dibaca di dalam arsip.'
        : 'Tidak ada file teks ditemukan.');
      return;
    }
    job.finished = true;
    var files = store.ordered();
    var header = S.buildHeader(store.kind, store.meta, files);
    var prevTop = els.scrollArea.scrollTop;
    store.setHeader(header + '\n');
    if (store.skipped.length) store.setFooter(S.buildSkippedNote(store.skipped));
    if (prevTop > 0) els.scrollArea.scrollTop = prevTop + store.headerLines * viewer.lineHeight;
    terminateWorker(job.worker);
    job.worker = null;
    if (job.pool) {
      for (var i = 0; i < job.pool.length; i++) terminateWorker(job.pool[i]);
      job.pool = null;
    }
    applyProgress(job);
    els.progressBar.style.width = '100%';
    els.progressPercent.textContent = '100%';
    els.statusTitle.textContent = 'Selesai';
    revealEditor(false);
    scheduleRender();
    updateCounts();
    els.statusContainer.style.display = 'none';
    setBusy(false);
    var msg = store.skipped.length ? 'Ekstraksi selesai (beberapa file dilewati)' : (store.kind === 'archive' && !store.meta.sourceUrl ? 'Ekstraksi ZIP Selesai!' : 'Ekstraksi Selesai!');
    showToast(msg);
    if (store.meta && store.meta.sourceUrl) saveToHistory(store.meta.sourceUrl);
    if (localStorage.getItem('r2tDebug') === '1') {
      var elapsed = performance.now() - job.startedAt;
      console.debug('[R2T metrics]', {
        ms: Math.round(elapsed),
        files: store.readyCount,
        filesPerSec: metrics.filesPerSec,
        bytesPerSec: metrics.bytesPerSec,
        skipped: store.skipped.length,
        bytes: store.totalBytes
      });
    }
    currentJob = null;
  }

  /* ------------------------------------------------------------------ */
  /* Archive pipeline                                                   */
  /* ------------------------------------------------------------------ */
  async function processArchiveFile(file) {
    var name = file && file.name ? file.name : 'archive';
    var lower = name.toLowerCase();
    if (/\.(7z|rar|bz2|xz)$/.test(lower) && !/\.tar\.gz$/.test(lower)) {
      alert('Format ' + lower.replace(/^.*\./, '').toUpperCase() + ' tidak dapat diproses di browser ini. Gunakan ZIP, TAR, atau TAR.GZ.');
      return;
    }
    currentSourceName = S.safeFilename(name.replace(/\.(zip|tar|tgz|gz)$/i, '').replace(/\.tar$/i, '') || 'archive');
    var job = createJob('archive');
    store.meta = { fileName: name };
    setBusy(true);
    els.outputContainer.style.display = 'none';
    showProgress('Menganalisis file ZIP...', S.safeUiText(name, 180));
    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';
    applyProgress(job);

    var w;
    try {
      w = spawnArchiveWorker(job);
    } catch (err) {
      failJob(job, 'Web Worker tidak dapat dijalankan. Buka aplikasi lewat http(s), bukan file://. ' + err.message);
      return;
    }
    w.postMessage({
      type: 'open-archive',
      jobId: job.id,
      file: file,
      name: name,
      options: filterOptions()
    });
  }

  /* ------------------------------------------------------------------ */
  /* HTTP / GitHub / Codeberg                                           */
  /* ------------------------------------------------------------------ */
  function sleep(ms, signal) {
    return new Promise(function (resolve, reject) {
      var t = setTimeout(resolve, ms);
      if (signal) {
        if (signal.aborted) { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); return; }
        signal.addEventListener('abort', function () { clearTimeout(t); reject(Object.assign(new Error('aborted'), { name: 'AbortError' })); }, { once: true });
      }
    });
  }

  function classifyHttp(status) {
    if (status === 200 || status === 206 || status === 304) return 'ok';
    if (status === 301 || status === 302 || status === 303 || status === 307 || status === 308) return 'redirect';
    if (status === 429) return 'rate';
    if (status === 403) return 'forbid';
    if (status === 401) return 'auth';
    if (status === 404) return 'missing';
    if (status === 400) return 'bad';
    if (status === 408 || status === 409 || status === 500 || status === 502 || status === 503 || status === 504) return 'retry';
    return 'other';
  }

  async function fetchOnce(url, signal, asBuffer) {
    if (!S.isAllowedFetchUrl(url)) {
      var blocked = new Error('URL tidak diizinkan.');
      blocked.kind = 'bad';
      throw blocked;
    }
    var res = await fetch(url, {
      signal: signal,
      credentials: 'omit',
      mode: 'cors',
      redirect: 'follow',
      referrerPolicy: 'no-referrer'
    });
    var kind = classifyHttp(res.status);
    var retryAfter = res.headers.get('Retry-After');
    var remaining = res.headers.get('X-RateLimit-Remaining');
    if (kind === 'ok') {
      if (asBuffer) return { ok: true, buffer: await res.arrayBuffer(), res: res };
      return { ok: true, buffer: await res.arrayBuffer(), res: res };
    }
    var err = new Error('HTTP ' + res.status);
    err.status = res.status;
    err.kind = kind;
    err.retryAfter = retryAfter;
    err.remaining = remaining;
    try { err.body = await res.text(); } catch (e) { err.body = ''; }
    throw err;
  }

  async function fetchWithPolicy(url, opts) {
    opts = opts || {};
    var signal = opts.signal;
    var allowProxy = opts.allowProxy !== false;
    var maxRetry = opts.maxRetry || 3;
    var lastErr = null;
    if (!S.isAllowedFetchUrl(url)) throw new Error('URL tidak diizinkan.');
    var wrappers = allowProxy ? PROXIES : PROXIES.slice(0, 1);
    for (var p = 0; p < wrappers.length; p++) {
      var wrapped = wrappers[p].wrap(url);
      for (var attempt = 1; attempt <= maxRetry; attempt++) {
        if (signal && signal.aborted) throw Object.assign(new Error('aborted'), { name: 'AbortError' });
        try {
          var out = await fetchOnce(wrapped, signal, opts.asBuffer);
          return out;
        } catch (err) {
          if (err && err.name === 'AbortError') throw err;
          lastErr = err;
          var kind = err && err.kind;
          if (kind === 'missing') throw new Error('Tidak ditemukan (404).');
          if (kind === 'auth') throw new Error('Akses ditolak (401). Repositori mungkin private.');
          if (kind === 'bad') throw new Error('Permintaan tidak valid (400).');
          if (kind === 'rate' || kind === 'forbid') {
            var waitMs = 0;
            if (err.retryAfter) {
              var ra = Number(err.retryAfter);
              waitMs = isFinite(ra) ? (ra > 100 ? ra : ra * 1000) : 4000;
            } else {
              waitMs = Math.min(20000, 800 * Math.pow(2, attempt) + Math.random() * 300);
            }
            if (els.statusTitle) els.statusTitle.textContent = err.status === 429 ? 'Rate limit — menunggu…' : 'Akses dibatasi — mencoba lagi…';
            if (attempt >= maxRetry && p === wrappers.length - 1) {
              throw new Error(err.status === 429
                ? 'GitHub/API rate limit tercapai. Tunggu beberapa saat lalu coba lagi.'
                : 'Akses ditolak (403). Repositori private, atau rate limit API.');
            }
            await sleep(waitMs, signal);
            continue;
          }
          if (kind === 'retry') {
            await sleep(Math.min(12000, 400 * Math.pow(2, attempt) + Math.random() * 250), signal);
            continue;
          }
          break;
        }
      }
    }
    throw lastErr || new Error('Gagal mengunduh.');
  }

  function decodeBufferToText(buffer) {
    var u8 = new Uint8Array(buffer);
    var dec = S.decodeText(u8);
    return dec;
  }

  function adjustConc(job, latency, ok) {
    job.latencies.push(latency);
    if (job.latencies.length > 8) job.latencies.shift();
    var avg = 0;
    for (var i = 0; i < job.latencies.length; i++) avg += job.latencies[i];
    avg /= job.latencies.length;
    var max = Math.min(PROFILE.max, 6);
    var min = PROFILE.min;
    if (!ok || latency > 2500) job.networkConc = Math.max(min, job.networkConc - 1);
    else if (avg < 450 && S.memoryPressure() < 0.6 && job.latencies.length >= 4) {
      job.networkConc = Math.min(max, job.networkConc + 1);
    }
  }

  async function runAdaptiveQueue(job, items, handler) {
    var index = 0;
    var active = 0;
    var rejected = null;

    return new Promise(function (resolve, reject) {
      function pump() {
        if (!isLive(job.id)) { resolve(); return; }
        if (rejected) { reject(rejected); return; }
        var conc = job.networkConc || 1;
        while (active < conc && index < items.length) {
          (function (item, idx) {
            active++;
            var t0 = performance.now();
            Promise.resolve(handler(item, idx)).then(function () {
              adjustConc(job, performance.now() - t0, true);
            }).catch(function (err) {
              if (err && err.name === 'AbortError') return;
              if (err && err.fatal) { rejected = err; return; }
              ingestSkipped(job, { path: item.path, reason: err && err.message ? err.message : 'gagal diunduh' });
              adjustConc(job, performance.now() - t0, false);
            }).then(function () {
              active--;
              pump();
            });
          })(items[index], index);
          index++;
        }
        if (active === 0 && index >= items.length) resolve();
      }
      pump();
    });
  }

  async function fetchRepoTree(parsed, signal) {
    var apiUrl = parsed.platform === 'github'
      ? 'https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo
      : 'https://codeberg.org/api/v1/repos/' + parsed.owner + '/' + parsed.repo;

    var meta = await fetchWithPolicy(apiUrl, { signal: signal, allowProxy: true });
    var repoData = S.safeJsonParse(meta.buffer);
    var branch = S.sanitizeRef(parsed.branch || repoData.default_branch || 'main') || 'main';

    var treeRes = await fetchWithPolicy(apiUrl + '/git/trees/' + encodeURIComponent(branch) + '?recursive=1', { signal: signal, allowProxy: true });
    var treeData = S.safeJsonParse(treeRes.buffer);
    return { repoData: repoData, branch: branch, treeData: treeData, apiUrl: apiUrl };
  }

  function treeToFiles(parsed, branch, treeData, options) {
    var tree = (treeData && treeData.tree) || [];
    var files = [];
    for (var i = 0; i < tree.length; i++) {
      var item = tree[i];
      if (item.type === 'tree' || item.mode === '040000') continue;
      if (item.type !== 'blob' && item.type !== undefined) continue;
      if (!S.isIncluded(item.path, options) && !S.isArchivePath(item.path)) continue;
      files.push({
        path: item.path,
        size: item.size || 0,
        url: parsed.platform === 'github'
          ? 'https://raw.githubusercontent.com/' + parsed.owner + '/' + parsed.repo + '/' + branch + '/' + item.path
          : 'https://codeberg.org/' + parsed.owner + '/' + parsed.repo + '/raw/branch/' + branch + '/' + item.path
      });
    }
    files.sort(function (a, b) {
      var sa = S.priorityScore(a.path, a.size);
      var sb = S.priorityScore(b.path, b.size);
      if (sa !== sb) return sa - sb;
      return a.path < b.path ? -1 : a.path > b.path ? 1 : 0;
    });
    return files;
  }

  async function tryZipball(parsed, branch, signal) {
    var urls = [];
    var b = S.encodeGitPath(S.sanitizeRef(branch) || 'main');
    if (parsed.platform === 'github') {
      urls.push('https://codeload.github.com/' + parsed.owner + '/' + parsed.repo + '/zip/refs/heads/' + b);
      urls.push('https://api.github.com/repos/' + parsed.owner + '/' + parsed.repo + '/zipball/' + b);
    } else {
      urls.push('https://codeberg.org/' + parsed.owner + '/' + parsed.repo + '/archive/' + b + '.zip');
    }
    var lastErr = null;
    for (var i = 0; i < urls.length; i++) {
      try {
        var out = await fetchWithPolicy(urls[i], { signal: signal, allowProxy: true, maxRetry: 2 });
        if (out && out.buffer && out.buffer.byteLength > 100) {
          return new Blob([out.buffer], { type: 'application/zip' });
        }
      } catch (err) {
        if (err && err.name === 'AbortError') throw err;
        lastErr = err;
      }
    }
    throw lastErr || new Error('Gagal mengunduh zipball repositori.');
  }

  async function startRepoFetch() {
    var urlInput = els.repoUrl.value;
    var parsed = S.parseRepoUrl(urlInput);
    if (!parsed || parsed.platform === 'unknown') {
      alert('Tolong masukkan link GitHub atau Codeberg yang valid.');
      return;
    }

    currentSourceName = S.safeFilename(parsed.repo);
    var job = createJob('repo');
    store.meta = { sourceUrl: parsed.original || urlInput, platform: parsed.platform };
    store.kind = 'repo';
    setBusy(true);
    els.outputContainer.style.display = 'none';
    showProgress('Menghubungkan...', parsed.owner + '/' + parsed.repo);
    els.progressBar.style.width = '0%';
    els.progressPercent.textContent = '0%';

    try {
      var info = await fetchRepoTree(parsed, job.abort.signal);
      if (!isLive(job.id)) return;
      var options = filterOptions();
      var files = treeToFiles(parsed, info.branch, info.treeData, options);

      if (info.treeData && info.treeData.truncated) {
        els.statusTitle.textContent = 'Mengunduh arsip repositori…';
        var blob = await tryZipball(parsed, info.branch, job.abort.signal);
        if (!isLive(job.id)) return;
        var zipName = parsed.repo + '.zip';
        var named = (typeof File !== 'undefined')
          ? new File([blob], zipName, { type: 'application/zip' })
          : blob;
        var w = spawnArchiveWorker(job);
        store.kind = 'archive';
        store.meta.fileName = zipName;
        w.postMessage({ type: 'open-archive', jobId: job.id, file: named, name: zipName, options: options });
        return;
      }

      if (!files.length) throw new Error('Tidak ada file teks ditemukan.');

      job.total = files.length;
      store.expectedTotal = files.length;
      els.fileCountBadge.textContent = String(files.length);
      els.statusTitle.textContent = 'Mengunduh file…';
      scheduleProgress(job);

      await runAdaptiveQueue(job, files, async function (file) {
        if (!isLive(job.id)) return;
        job.currentPath = file.path;
        scheduleProgress(job);
        var out = await fetchWithPolicy(file.url, { signal: job.abort.signal, allowProxy: true, maxRetry: 3 });
        if (!isLive(job.id)) return;
        if (out.buffer && out.buffer.byteLength > 262144) {
          await new Promise(function (r) { setTimeout(r, 0); });
          if (!isLive(job.id)) return;
        }
        var dec = decodeBufferToText(out.buffer);
        if (dec.binary) {
          ingestSkipped(job, { path: file.path, reason: 'bukan teks (binary)' });
          return;
        }
        if (S.isArchivePath(file.path) && options.extractNested) {
          ingestSkipped(job, { path: file.path, reason: 'arsip remote dilewati (gunakan ZIP pipeline)' });
          return;
        }
        ingestFile(job, {
          order: 0,
          path: S.sanitizePath(file.path),
          text: dec.text,
          lineCount: S.countLines(dec.text),
          byteLength: out.buffer.byteLength,
          encoding: dec.encoding
        });
      });

      if (!isLive(job.id)) return;
      if (!store.readyCount) throw new Error('Tidak ada file teks yang berhasil diunduh.');
      completeJob(job);
    } catch (err) {
      if (err && err.name === 'AbortError') return;
      if (currentJob && currentJob.id === job.id) failJob(job, err && err.message ? err.message : String(err));
    } finally {
      if (!currentJob) setBusy(false);
    }
  }

  /* ------------------------------------------------------------------ */
  /* History / copy / download                                          */
  /* ------------------------------------------------------------------ */
  function getHistory() {
    try {
      var raw = localStorage.getItem(HISTORY_KEY);
      if (!raw) return [];
      var parsed = S.safeJsonParse(raw);
      if (!Array.isArray(parsed)) return [];
      var out = [];
      for (var i = 0; i < parsed.length && out.length < HISTORY_LIMIT; i++) {
        if (typeof parsed[i] !== 'string') continue;
        var ok = S.parseRepoUrl(parsed[i]);
        if (ok && ok.original) out.push(ok.original);
      }
      return out;
    } catch (e) { return []; }
  }

  function saveToHistory(url) {
    var parsed = S.parseRepoUrl(url);
    if (!parsed) return;
    url = parsed.original;
    var history = getHistory().filter(function (item) { return item !== url; });
    history.unshift(url);
    if (history.length > HISTORY_LIMIT) history = history.slice(0, HISTORY_LIMIT);
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
    renderHistory();
  }

  function deleteFromHistory(url, event) {
    if (event) event.stopPropagation();
    var history = getHistory().filter(function (item) { return item !== url; });
    try { localStorage.setItem(HISTORY_KEY, JSON.stringify(history)); } catch (e) {}
    renderHistory();
  }

  function renderHistory() {
    var history = getHistory();
    if (!history.length || (els.tabZip && els.tabZip.classList.contains('active'))) {
      els.historyCard.classList.remove('show');
      return;
    }
    els.historyCard.classList.add('show');
    while (els.historyList.firstChild) els.historyList.removeChild(els.historyList.firstChild);
    history.forEach(function (url) {
      var item = document.createElement('div');
      item.className = 'history-item';
      var link = document.createElement('div');
      link.className = 'history-link';
      link.textContent = url;
      link.addEventListener('click', function () { els.repoUrl.value = url; });
      var actions = document.createElement('div');
      actions.className = 'history-actions';
      var copyBtn = document.createElement('button');
      copyBtn.className = 'icon-btn';
      copyBtn.type = 'button';
      copyBtn.title = 'Salin Tautan';
      copyBtn.appendChild(cloneIcon('iconCopy'));
      copyBtn.addEventListener('click', function (e) { e.stopPropagation(); copyToClipboard(url, 'Tautan disalin!'); });
      var delBtn = document.createElement('button');
      delBtn.className = 'icon-btn delete';
      delBtn.type = 'button';
      delBtn.title = 'Hapus dari Riwayat';
      delBtn.appendChild(cloneIcon('iconDelete'));
      delBtn.addEventListener('click', function (e) { deleteFromHistory(url, e); });
      actions.appendChild(copyBtn);
      actions.appendChild(delBtn);
      item.appendChild(link);
      item.appendChild(actions);
      els.historyList.appendChild(item);
    });
  }

  function cloneIcon(id) {
    var tpl = document.getElementById(id);
    if (tpl && tpl.content) return tpl.content.firstElementChild.cloneNode(true);
    return document.createTextNode('');
  }

  function copyToClipboard(text, successMessage) {
    var fallbackCopy = function () {
      var tempTa = document.createElement('textarea');
      tempTa.value = text;
      tempTa.style.position = 'fixed';
      tempTa.style.opacity = '0';
      document.body.appendChild(tempTa);
      tempTa.select();
      document.execCommand('copy');
      document.body.removeChild(tempTa);
      showToast(successMessage);
    };
    if (navigator.clipboard && window.isSecureContext) {
      navigator.clipboard.writeText(text).then(function () { showToast(successMessage); }).catch(fallbackCopy);
    } else {
      fallbackCopy();
    }
  }

  function clipboardLimit() {
    return PROFILE.mobile ? S.CLIPBOARD_LIMIT_MOBILE : S.CLIPBOARD_LIMIT_DESKTOP;
  }

  function tooLargeForClipboard(pure) {
    return store.payloadChars(pure) > clipboardLimit();
  }

  function copyAllText() {
    if (!store.readyCount) return;
    if (tooLargeForClipboard(false)) { showModal(); return; }
    copyToClipboard(store.buildParts(false).join(''), 'Semua teks di kotak kode tersalin!');
  }

  function smartCopy() {
    if (!store.readyCount) return;
    if (tooLargeForClipboard(true)) { showModal(); return; }
    copyToClipboard(store.buildParts(true).join(''), 'Hanya Kode Murni yang Tersalin!');
  }

  function downloadText() {
    if (!store.readyCount) return;
    if (lastBlobUrl) {
      try { URL.revokeObjectURL(lastBlobUrl); } catch (e) {}
      lastBlobUrl = null;
    }
    var parts = store.buildParts(true);
    var blob = new Blob(parts, { type: 'text/plain;charset=utf-8' });
    var link = document.createElement('a');
    lastBlobUrl = URL.createObjectURL(blob);
    link.href = lastBlobUrl;
    link.download = S.safeFilename(currentSourceName) + '-purecode.txt';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function () {
      if (lastBlobUrl) { try { URL.revokeObjectURL(lastBlobUrl); } catch (e2) {} lastBlobUrl = null; }
    }, 4000);
    showToast('Mengunduh file...');
  }

  /* ------------------------------------------------------------------ */
  /* Mode / zip input                                                   */
  /* ------------------------------------------------------------------ */
  function switchMode(mode) {
    if (mode === 'url') {
      els.tabUrl.classList.add('active');
      els.tabZip.classList.remove('active');
      els.urlSection.classList.remove('hidden');
      els.zipSection.classList.add('hidden');
      renderHistory();
    } else {
      els.tabZip.classList.add('active');
      els.tabUrl.classList.remove('active');
      els.urlSection.classList.add('hidden');
      els.zipSection.classList.remove('hidden');
      els.historyCard.classList.remove('show');
    }
  }

  function handleZipSelect(event) {
    var file = event.target.files && event.target.files[0];
    if (file) processArchiveFile(file);
    event.target.value = '';
  }

  function startFetch() { startRepoFetch(); }
  function processZipFile(file) { return processArchiveFile(file); }
  function cancelCurrentJob() { cancelJob(true); }

  /* ------------------------------------------------------------------ */
  /* Events                                                             */
  /* ------------------------------------------------------------------ */
  function bindEvents() {
    if (els.tabUrl) els.tabUrl.addEventListener('click', function () { switchMode('url'); });
    if (els.tabZip) els.tabZip.addEventListener('click', function () { switchMode('zip'); });
    if (els.fetchBtn) els.fetchBtn.addEventListener('click', function () { startFetch(); });
    if (els.zipFileInput) els.zipFileInput.addEventListener('change', handleZipSelect);
    if (els.cancelBtn) els.cancelBtn.addEventListener('click', function () { cancelCurrentJob(); });
    var saveBtn = $('btnSaveTxt');
    var copyAllBtn = $('btnCopyAll');
    var copyPureBtn = $('copyBtn');
    var closeSafety = $('btnCloseSafety');
    if (saveBtn) saveBtn.addEventListener('click', function () { downloadText(); });
    if (copyAllBtn) copyAllBtn.addEventListener('click', function () { copyAllText(); });
    if (copyPureBtn) copyPureBtn.addEventListener('click', function () { smartCopy(); });
    if (closeSafety) closeSafety.addEventListener('click', function () { closeModal(); });

    var dropZone = els.dropZone;
    dropZone.addEventListener('click', function () {
      if (els.zipFileInput) els.zipFileInput.click();
    });
    ['dragenter', 'dragover'].forEach(function (eventName) {
      dropZone.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.add('dragover');
      }, false);
    });
    ['dragleave', 'drop'].forEach(function (eventName) {
      dropZone.addEventListener(eventName, function (e) {
        e.preventDefault();
        e.stopPropagation();
        dropZone.classList.remove('dragover');
      }, false);
    });
    dropZone.addEventListener('drop', function (e) {
      var files = e.dataTransfer && e.dataTransfer.files;
      if (files && files.length > 0) processArchiveFile(files[0]);
    });

    els.scrollArea.addEventListener('pointerdown', function () {
      els.scrollArea.focus({ preventScroll: true });
    });
    els.scrollArea.addEventListener('keydown', function (e) {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
        e.preventDefault();
        if (tooLargeForClipboard(false)) { showModal(); return; }
        copyAllText();
      }
    });
    els.scrollArea.addEventListener('scroll', function () {
      if (!isDragging) scheduleThumb();
      scheduleRender();
    }, { passive: true });

    els.scrollThumb.addEventListener('touchstart', function (e) {
      isDragging = true;
      els.scrollThumb.classList.add('dragging');
      startY = e.touches[0].clientY;
      startScrollTop = els.scrollArea.scrollTop;
      e.preventDefault();
    }, { passive: false });

    document.addEventListener('touchmove', function (e) {
      if (!isDragging) return;
      e.preventDefault();
      var deltaY = e.touches[0].clientY - startY;
      var maxThumbTop = els.scrollTrack.clientHeight - els.scrollThumb.clientHeight;
      var maxScrollTop = els.scrollArea.scrollHeight - els.scrollArea.clientHeight;
      if (maxThumbTop <= 0 || maxScrollTop <= 0) return;
      els.scrollArea.scrollTop = startScrollTop + (deltaY / maxThumbTop) * maxScrollTop;
      var newY = Math.max(0, Math.min((startScrollTop / maxScrollTop) * maxThumbTop + deltaY, maxThumbTop));
      els.scrollThumb.style.transform = 'translate3d(0,' + newY + 'px,0)';
    }, { passive: false });

    document.addEventListener('touchend', function () {
      isDragging = false;
      els.scrollThumb.classList.remove('dragging');
    });

    els.scrollThumb.addEventListener('mousedown', function (e) {
      isDragging = true;
      els.scrollThumb.classList.add('dragging');
      startY = e.clientY;
      startScrollTop = els.scrollArea.scrollTop;
      e.preventDefault();
    });

    document.addEventListener('mousemove', function (e) {
      if (!isDragging) return;
      e.preventDefault();
      var deltaY = e.clientY - startY;
      var maxThumbTop = els.scrollTrack.clientHeight - els.scrollThumb.clientHeight;
      var maxScrollTop = els.scrollArea.scrollHeight - els.scrollArea.clientHeight;
      if (maxThumbTop <= 0 || maxScrollTop <= 0) return;
      els.scrollArea.scrollTop = startScrollTop + (deltaY / maxThumbTop) * maxScrollTop;
      var newY = Math.max(0, Math.min((startScrollTop / maxScrollTop) * maxThumbTop + deltaY, maxThumbTop));
      els.scrollThumb.style.transform = 'translate3d(0,' + newY + 'px,0)';
    });

    document.addEventListener('mouseup', function () {
      isDragging = false;
      els.scrollThumb.classList.remove('dragging');
    });

    els.confirmYes.addEventListener('click', function () { finishConfirm(true); });
    els.confirmNo.addEventListener('click', function () { finishConfirm(false); });

    els.repoUrl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); startFetch(); }
    });

    window.addEventListener('resize', function () { scheduleRender(); scheduleThumb(); }, { passive: true });
  }

  function init() {
    cacheEls();
    measureLineHeight();
    viewer.lineHeight = LINE_PROBE;
    bindEvents();
    renderHistory();
    scheduleThumb();
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();

  global.switchMode = switchMode;
  global.handleZipSelect = handleZipSelect;
  global.startFetch = startFetch;
  global.downloadText = downloadText;
  global.copyAllText = copyAllText;
  global.smartCopy = smartCopy;
  global.closeModal = closeModal;
  global.cancelCurrentJob = cancelCurrentJob;
  global.processZipFile = processZipFile;
  global.deleteFromHistory = deleteFromHistory;
  global.renderHistory = renderHistory;
  global.showToast = showToast;
  global.showModal = showModal;
})(window);
