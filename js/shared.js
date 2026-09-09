/**
 * Repo2Text Ultra — shared pure functions (main thread + worker).
 * No DOM. Safe to importScripts().
 */
(function (root) {
  'use strict';

  var R2T = root.R2T || (root.R2T = {});

  var BINARY_EXTENSIONS = [
    '.png', '.jpg', '.jpeg', '.gif', '.ico', '.webp', '.bmp', '.tiff', '.tif',
    '.mp3', '.mp4', '.wav', '.ogg', '.flac', '.avi', '.mov', '.mkv', '.webm',
    '.exe', '.dll', '.so', '.dylib', '.bin', '.o', '.obj', '.a', '.lib',
    '.pdf', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pyc', '.pyo', '.sqlite3', '.sqlite', '.db',
    '.class', '.jar', '.apk', '.ipa', '.iso', '.dmg', '.ds_store', '.ico',
    '.wasm', '.lockb', '.pak', '.dat', '.binpb', '.parquet', '.npy', '.npz',
    '.woff', '.map.bin'
  ];

  var ARCHIVE_EXTENSIONS = ['.zip', '.tar', '.gz', '.tgz', '.rar', '.7z', '.bz2', '.xz'];

  var SOURCE_EXTENSIONS = [
    '.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.html', '.htm', '.css', '.scss', '.sass', '.less',
    '.json', '.jsonc', '.xml', '.yaml', '.yml', '.md', '.markdown', '.txt', '.svg'
  ];

  var PROGRAMMING_EXTENSIONS = [
    '.py', '.pyi', '.java', '.kt', '.kts', '.go', '.rs', '.php', '.rb', '.swift',
    '.c', '.h', '.cpp', '.hpp', '.cc', '.cxx', '.hh', '.cs', '.dart', '.lua',
    '.sh', '.bash', '.zsh', '.ps1', '.sql', '.r', '.m', '.mm', '.scala', '.groovy',
    '.pl', '.pm', '.ex', '.exs', '.erl', '.hs', '.clj', '.cljs', '.vim', '.el',
    '.toml', '.ini', '.cfg', '.conf', '.properties', '.gradle', '.cmake', '.make', '.mk',
    '.dockerfile', '.gitignore', '.gitattributes', '.editorconfig', '.env',
    '.vue', '.svelte', '.astro', '.prisma', '.graphql', '.proto', '.tf', '.hcl',
    '.nix', '.zig', '.nim', '.v', '.sol', '.asm', '.s', '.f90', '.jl', '.coffee',
    '.bat', '.cmd', '.fish', '.lock', '.sum', '.mod', '.cabal', '.csproj', '.fs', '.fsx',
    '.jsp', '.asp', '.aspx', '.erb', '.ejs', '.hbs', '.mustache', '.pug', '.jade',
    '.rst', '.adoc', '.tex', '.bib', '.csv', '.tsv', '.po', '.pot', '.strings'
  ];

  var ALWAYS_EXCLUDE_DIRS = ['__macosx', '.git', '.idea', '.vscode'];

  var GENERATED_DIRS = [
    'node_modules', 'dist', 'build', 'coverage', '.next', '.nuxt', 'target',
    'vendor', '__pycache__', '.cache', '.svn', '.hg',
    'bower_components', '.turbo', '.output', '.parcel-cache', '.svelte-kit'
  ];

  var PRIORITY_NAMES = {
    'readme': 0, 'readme.md': 0, 'readme.txt': 0, 'readme.rst': 0,
    'package.json': 1, 'composer.json': 1, 'go.mod': 1, 'cargo.toml': 1,
    'pyproject.toml': 1, 'requirements.txt': 1, 'index.html': 1, 'index.js': 1,
    'index.ts': 1, 'main.py': 1, 'main.go': 1, 'main.rs': 1, 'app.js': 1,
    'app.ts': 1, 'app.py': 1, 'dockerfile': 1, 'makefile': 1, 'license': 1,
    'licence': 1, 'cmakelists.txt': 1
  };

  var TEXT_MIME_HINT = /^(text\/|application\/(json|xml|javascript|typescript|x-sh|toml|yaml|sql))/i;

  var MAX_NESTED_DEPTH = 2;
  var CLIPBOARD_LIMIT_MOBILE = 500000;
  var CLIPBOARD_LIMIT_DESKTOP = 1500000;
  var MAX_PATH_LEN = 2048;
  var MAX_URL_LEN = 2000;
  var MAX_JSON_CHARS = 8 * 1024 * 1024;

  var ALLOWED_REPO_HOSTS = {
    'github.com': 'github',
    'www.github.com': 'github',
    'codeberg.org': 'codeberg',
    'www.codeberg.org': 'codeberg'
  };

  var ALLOWED_FETCH_HOSTS = {
    'github.com': 1,
    'www.github.com': 1,
    'api.github.com': 1,
    'raw.githubusercontent.com': 1,
    'codeload.github.com': 1,
    'codeberg.org': 1,
    'www.codeberg.org': 1,
    'api.allorigins.win': 1,
    'api.codetabs.com': 1
  };

  var BOMB = {
    warnRatio: 80,
    hardRatio: 800,
    warnUncompressed: 256 * 1024 * 1024,
    hardUncompressed: 1024 * 1024 * 1024,
    warnEntries: 30000,
    hardEntries: 250000,
    singleEntryWarn: 80 * 1024 * 1024
  };

  function formatBytes(bytes) {
    if (!bytes || bytes < 0) bytes = 0;
    if (bytes >= 1073741824) return (bytes / 1073741824).toFixed(2) + ' GB';
    if (bytes >= 1048576) return (bytes / 1048576).toFixed(1) + ' MB';
    if (bytes >= 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return bytes + ' B';
  }

  function formatDuration(ms) {
    if (!isFinite(ms) || ms < 0) return '--:--';
    var s = Math.round(ms / 1000);
    var h = Math.floor(s / 3600);
    var m = Math.floor((s % 3600) / 60);
    var sec = s % 60;
    if (h > 0) return h + ':' + String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
    return String(m).padStart(2, '0') + ':' + String(sec).padStart(2, '0');
  }

  function countLines(text) {
    if (!text) return 1;
    var lines = 1;
    for (var i = 0; i < text.length; i++) {
      if (text.charCodeAt(i) === 10) lines++;
    }
    return lines;
  }

  function extOf(path) {
    var p = path.toLowerCase();
    var base = p.split('/').pop() || p;
    if (base.startsWith('.') && base.indexOf('.', 1) === -1) return base;
    var m = base.match(/\.[0-9a-z._]+$/);
    return m ? m[0] : '';
  }

  function compoundExt(path) {
    var p = path.toLowerCase();
    if (p.endsWith('.tar.gz') || p.endsWith('.tar.bz2') || p.endsWith('.tar.xz')) {
      return p.slice(p.lastIndexOf('.tar.'));
    }
    return extOf(path);
  }

  function stripControls(s) {
    s = String(s == null ? '' : s);
    try { return s.replace(/\p{Cc}/gu, ''); } catch (e) { return s.replace(/[\x00-\x1F\x7F]/g, ''); }
  }

  function sanitizePath(path) {
    if (path == null) return '';
    var p = stripControls(String(path)).replace(/\0/g, '').replace(/\\/g, '/');
    if (/%(?:2e|2f|5c|00)/i.test(p)) {
      try { p = decodeURIComponent(p.replace(/\+/g, ' ')); } catch (e) { /* keep raw */ }
      p = stripControls(p).replace(/\0/g, '').replace(/\\/g, '/');
    }
    p = p.replace(/^\/+/, '').replace(/^file:\/\//i, '');
    var parts = p.split('/');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var seg = parts[i];
      if (!seg || seg === '.') continue;
      if (seg === '..') { if (out.length) out.pop(); continue; }
      if (seg === '~' || seg === '...' ) continue;
      if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(seg)) continue;
      seg = seg.replace(/[:*?"<>|]/g, '_');
      out.push(seg);
    }
    p = out.join('/');
    if (p.length > MAX_PATH_LEN) p = p.slice(0, MAX_PATH_LEN);
    return p;
  }

  function safeUiText(s, max) {
    s = stripControls(s);
    max = max || 400;
    if (s.length > max) s = s.slice(0, max) + '…';
    return s;
  }

  function safeFilename(name) {
    var s = stripControls(name || 'code').replace(/[^\w.\-]+/g, '_').replace(/^\.+/g, '');
    if (!s) s = 'code';
    return s.slice(0, 80);
  }

  function isGitName(s) {
    return typeof s === 'string' && /^[A-Za-z0-9._-]{1,100}$/.test(s) && s !== '.' && s !== '..';
  }

  function sanitizeRef(ref) {
    if (ref == null || ref === '') return null;
    var s = stripControls(ref).replace(/^\/+|\/+$/g, '');
    if (!s || s.length > 256) return null;
    if (s.indexOf('..') !== -1) return null;
    if (!/^[A-Za-z0-9._\-\/]+$/.test(s)) return null;
    return s;
  }

  function encodeGitPath(p) {
    return String(p || '').split('/').filter(Boolean).map(function (seg) {
      return encodeURIComponent(seg);
    }).join('/');
  }

  function normalizeHost(host) {
    host = String(host || '').toLowerCase();
    if (host.charCodeAt(host.length - 1) === 46) host = host.slice(0, -1);
    return host;
  }

  function parseHttpUrl(urlStr) {
    if (!urlStr || typeof urlStr !== 'string' || urlStr.length > MAX_URL_LEN) return null;
    var trimmed = urlStr.trim();
    if (!/^https:\/\//i.test(trimmed)) return null;
    var url;
    try { url = new URL(trimmed); } catch (e) { return null; }
    if (url.protocol !== 'https:') return null;
    if (url.username || url.password) return null;
    if (url.port && url.port !== '443') return null;
    var host = normalizeHost(url.hostname);
    if (!host || host.indexOf(':') !== -1) return null;
    if (/[^a-z0-9.-]/.test(host)) return null;
    return { url: url, host: host };
  }

  function isAllowedFetchUrl(urlStr) {
    var parsed = parseHttpUrl(urlStr);
    if (!parsed) return false;
    return !!ALLOWED_FETCH_HOSTS[parsed.host];
  }

  function safeJsonParse(text) {
    if (text == null) throw new Error('JSON kosong');
    if (typeof text !== 'string') {
      if (text instanceof ArrayBuffer) text = new TextDecoder('utf-8', { fatal: false }).decode(text);
      else if (text && text.buffer) text = new TextDecoder('utf-8', { fatal: false }).decode(text);
      else text = String(text);
    }
    if (text.length > MAX_JSON_CHARS) throw new Error('Respons JSON terlalu besar.');
    return JSON.parse(text, function (key, value) {
      if (key === '__proto__' || key === 'constructor' || key === 'prototype') return undefined;
      return value;
    });
  }

  function pathSegments(path) {
    return sanitizePath(path).toLowerCase().split('/').filter(Boolean);
  }

  function isGeneratedPath(path, extraDirs) {
    var segs = pathSegments(path);
    var dirs = extraDirs || GENERATED_DIRS;
    for (var i = 0; i < segs.length - 0; i++) {
      if (ALWAYS_EXCLUDE_DIRS.indexOf(segs[i]) !== -1) return true;
    }
    for (var d = 0; d < dirs.length; d++) {
      var name = String(dirs[d]).replace(/\/$/, '').toLowerCase();
      if (!name) continue;
      if (segs.indexOf(name) !== -1) return true;
    }
    return false;
  }

  function isAlwaysExcluded(path) {
    var segs = pathSegments(path);
    var base = segs[segs.length - 1] || '';
    if (base === '.ds_store' || base === 'thumbs.db' || base === 'desktop.ini') return true;
    for (var i = 0; i < segs.length; i++) {
      if (ALWAYS_EXCLUDE_DIRS.indexOf(segs[i]) !== -1) return true;
    }
    return false;
  }

  function isBinaryExt(path) {
    var ext = extOf(path);
    if (!ext) return false;
    if (ARCHIVE_EXTENSIONS.indexOf(ext) !== -1) return false;
    if (ext === '.svg') return false;
    return BINARY_EXTENSIONS.indexOf(ext) !== -1;
  }

  function isArchivePath(path) {
    var p = path.toLowerCase();
    if (p.endsWith('.tar.gz') || p.endsWith('.tar.bz2') || p.endsWith('.tgz')) return true;
    var ext = extOf(p);
    return ARCHIVE_EXTENSIONS.indexOf(ext) !== -1;
  }

  function isIncluded(path, options) {
    options = options || {};
    var clean = sanitizePath(path);
    if (!clean || clean.endsWith('/')) return false;
    if (isAlwaysExcluded(clean)) return false;
    if (options.skipGenerated !== false && isGeneratedPath(clean, options.generatedDirs)) return false;
    if (isBinaryExt(clean)) return false;
    if (isArchivePath(clean)) return !!options.extractNested;
    return true;
  }

  function priorityScore(path, size) {
    var base = (sanitizePath(path).split('/').pop() || '').toLowerCase();
    if (PRIORITY_NAMES[base] != null) return PRIORITY_NAMES[base];
    if (/^readme(\.|$)/.test(base)) return 0;
    var sz = size || 0;
    if (/\.(md|json|toml|yml|yaml|txt|html)$/.test(base) && sz < 32768) return 2;
    if (sz < 16384) return 3;
    if (sz < 65536) return 4;
    if (sz < 262144) return 5;
    if (sz < 1048576) return 6;
    return 7 + Math.min(25, Math.floor(sz / (1024 * 1024)));
  }

  function looksBinaryBytes(u8, sample) {
    if (!u8 || !u8.length) return false;
    var n = Math.min(u8.length, sample || 8192);
    var nulls = 0;
    var ctrl = 0;
    for (var i = 0; i < n; i++) {
      var c = u8[i];
      if (c === 0) {
        nulls++;
        if (nulls > 2) return true;
      } else if (c < 8 || (c > 13 && c < 32 && c !== 27)) {
        ctrl++;
      }
    }
    if (n > 64 && ctrl / n > 0.25) return true;
    return false;
  }

  function decodeText(u8) {
    if (!u8) return { text: '', encoding: 'utf-8', binary: false };
    if (u8.length >= 3 && u8[0] === 0xEF && u8[1] === 0xBB && u8[2] === 0xBF) {
      return {
        text: new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(3)),
        encoding: 'utf-8-bom',
        binary: false
      };
    }
    if (u8.length >= 2 && u8[0] === 0xFF && u8[1] === 0xFE) {
      try {
        return {
          text: new TextDecoder('utf-16le', { fatal: false }).decode(u8.subarray(2)),
          encoding: 'utf-16le',
          binary: false
        };
      } catch (e) { /* fallthrough */ }
    }
    if (u8.length >= 2 && u8[0] === 0xFE && u8[1] === 0xFF) {
      try {
        return {
          text: new TextDecoder('utf-16be', { fatal: false }).decode(u8.subarray(2)),
          encoding: 'utf-16be',
          binary: false
        };
      } catch (e) { /* fallthrough */ }
    }
    if (looksBinaryBytes(u8)) {
      return { text: '', encoding: 'binary', binary: true };
    }
    var utf8 = new TextDecoder('utf-8', { fatal: false }).decode(u8);
    var bad = 0;
    var probe = Math.min(utf8.length, 20000);
    for (var i = 0; i < probe; i++) {
      if (utf8.charCodeAt(i) === 0xFFFD) bad++;
    }
    if (probe > 32 && bad / probe > 0.02) {
      return { text: '', encoding: 'binary', binary: true };
    }
    return { text: utf8, encoding: 'utf-8', binary: false };
  }

  function readMagic(u8, n) {
    n = n || 16;
    var out = [];
    var len = Math.min(n, u8 && u8.length || 0);
    for (var i = 0; i < len; i++) out.push(u8[i]);
    return out;
  }

  function detectFormat(name, magic) {
    var n = (name || '').toLowerCase();
    var m = magic || [];
    if (m.length >= 4 && m[0] === 0x50 && m[1] === 0x4B && (m[2] === 0x03 || m[2] === 0x05 || m[2] === 0x07) && (m[3] === 0x04 || m[3] === 0x06 || m[3] === 0x08)) {
      return 'zip';
    }
    if (m.length >= 2 && m[0] === 0x1F && m[1] === 0x8B) {
      if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
      return 'gz';
    }
    if (m.length >= 6 && m[0] === 0x37 && m[1] === 0x7A && m[2] === 0xBC && m[3] === 0xAF && m[4] === 0x27 && m[5] === 0x1C) {
      return '7z';
    }
    if (m.length >= 7 && m[0] === 0x52 && m[1] === 0x61 && m[2] === 0x72 && m[3] === 0x21 && m[4] === 0x1A && m[5] === 0x07) {
      return 'rar';
    }
    if (m.length >= 262) {
      var ustar = true;
      var sig = [0x75, 0x73, 0x74, 0x61, 0x72];
      for (var i = 0; i < 5; i++) if (m[257 + i] !== sig[i]) ustar = false;
      if (ustar) return 'tar';
    }
    if (n.endsWith('.tar.gz') || n.endsWith('.tgz')) return 'tar.gz';
    if (n.endsWith('.tar')) return 'tar';
    if (n.endsWith('.gz')) return 'gz';
    if (n.endsWith('.zip')) return 'zip';
    if (n.endsWith('.7z')) return '7z';
    if (n.endsWith('.rar')) return 'rar';
    if (n.endsWith('.bz2') || n.endsWith('.xz')) return 'unsupported';
    return 'unknown';
  }

  function parseOctal(bytes, start, len) {
    var s = '';
    for (var i = 0; i < len; i++) {
      var c = bytes[start + i];
      if (!c || c === 32) continue;
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    s = s.trim();
    if (!s) return 0;
    return parseInt(s, 8) || 0;
  }

  function tarCString(bytes, start, len) {
    var out = [];
    for (var i = 0; i < len; i++) {
      var c = bytes[start + i];
      if (!c) break;
      out.push(c);
    }
    if (!out.length) return '';
    return new TextDecoder('utf-8', { fatal: false }).decode(new Uint8Array(out));
  }

  function isZeroBlock(bytes, off) {
    var end = Math.min(off + 512, bytes.length);
    for (var i = off; i < end; i++) if (bytes[i] !== 0) return false;
    return true;
  }

  function parseTarBuffer(u8, onEntry) {
    var offset = 0;
    var entries = [];
    var longName = null;
    var guard = 0;
    var maxSteps = Math.ceil(u8.length / 512) + 8;
    while (offset + 512 <= u8.length && guard++ < maxSteps) {
      if (isZeroBlock(u8, offset)) break;
      var size = parseOctal(u8, offset + 124, 12);
      if (size < 0) size = 0;
      var typeflag = u8[offset + 156] ? String.fromCharCode(u8[offset + 156]) : '0';
      var name = tarCString(u8, offset, 100);
      var prefix = tarCString(u8, offset + 345, 155);
      var full = prefix ? (prefix.replace(/\/$/, '') + '/' + name) : name;
      if (longName) { full = longName; longName = null; }
      var dataStart = offset + 512;
      var dataEnd = dataStart + size;
      if (dataEnd > u8.length) break;
      var next = dataStart + (size === 0 ? 0 : Math.ceil(size / 512) * 512);
      if (typeflag === 'L' || typeflag === 'K') {
        longName = new TextDecoder('utf-8', { fatal: false }).decode(u8.subarray(dataStart, dataEnd)).replace(/\0/g, '');
        offset = next;
        continue;
      }
      if (typeflag === '0' || typeflag === '\0' || typeflag === '') {
        var data = u8.subarray(dataStart, dataEnd);
        var item = { path: full, data: data, size: size };
        entries.push(item);
        if (onEntry) onEntry(item);
      }
      offset = next;
    }
    return entries;
  }

  function analyzeArchiveMeta(entries, compressedTotal) {
    var totalUncompressed = 0;
    var fileCount = 0;
    var maxEntry = 0;
    for (var i = 0; i < entries.length; i++) {
      var sz = entries[i].uncompressedSize || 0;
      totalUncompressed += sz;
      if (sz > maxEntry) maxEntry = sz;
      if (!entries[i].directory) fileCount++;
    }
    var ratio = compressedTotal > 0 ? (totalUncompressed / compressedTotal) : 1;
    var level = 'ok';
    var reason = '';
    if (fileCount >= BOMB.hardEntries || (ratio >= BOMB.hardRatio && totalUncompressed >= BOMB.warnUncompressed) || totalUncompressed >= BOMB.hardUncompressed) {
      level = 'block';
      reason = 'Archive bomb terdeteksi (rasio/jumlah entri/ukuran tidak wajar). Proses dihentikan demi keamanan perangkat.';
    } else if (fileCount >= BOMB.warnEntries || (ratio >= BOMB.warnRatio && totalUncompressed >= BOMB.warnUncompressed) || maxEntry >= BOMB.singleEntryWarn) {
      level = 'warn';
      reason = 'Arsip mencurigakan: rasio kompresi ' + ratio.toFixed(1) + '×, ' + fileCount + ' file, tak terkompresi ~' + formatBytes(totalUncompressed) + '. Lanjutkan dengan hati-hati?';
    }
    return {
      level: level,
      reason: reason,
      ratio: ratio,
      totalUncompressed: totalUncompressed,
      fileCount: fileCount,
      maxEntry: maxEntry,
      compressedTotal: compressedTotal || 0
    };
  }

  function fileBanner(path) {
    var line = '// ' + '─'.repeat(76) + '\n';
    return '\n' + line + '// 📄 PATH: ' + path + '\n' + line + '\n';
  }

  function buildHeader(kind, meta, files) {
    var lines;
    if (kind === 'archive') {
      lines = [
        '/**',
        ' * 📦 ARCHIVE SOURCE CODE',
        ' * File:     ' + (meta.fileName || ''),
        ' * Total:    ' + files.length + ' File',
        ' */',
        ''
      ];
    } else {
      lines = [
        '/**',
        ' * 🚀 REPOSITORY SOURCE CODE',
        ' * Source:   ' + (meta.sourceUrl || ''),
        ' * Platform: ' + String(meta.platform || '').toUpperCase(),
        ' * Files:    ' + files.length,
        ' */',
        ''
      ];
    }
    lines.push('// --- DAFTAR ISI ---');
    for (var i = 0; i < files.length; i++) {
      var num = String(i + 1).padStart(3, '0');
      lines.push('// [' + num + '] ' + files[i].path);
    }
    lines.push('// ------------------');
    lines.push('');
    return lines.join('\n');
  }

  function buildSkippedNote(skipped) {
    if (!skipped || !skipped.length) return '';
    var note = '\n// ⚠️ ' + skipped.length + ' file dilewati:\n';
    for (var i = 0; i < skipped.length; i++) {
      var s = skipped[i];
      note += '// - ' + (s.path || s) + (s.reason ? ' (' + s.reason + ')' : '') + '\n';
    }
    return note;
  }

  function parseRepoUrl(urlStr) {
    try {
      var raw = String(urlStr || '').trim();
      if (/\/\.\.(?:\/|$)/.test(raw) || /[<>"']/.test(raw)) return null;
      var parsed = parseHttpUrl(raw.replace(/\/+$/, ''));
      if (!parsed) return null;
      var platform = ALLOWED_REPO_HOSTS[parsed.host];
      if (!platform) return null;
      var parts = parsed.url.pathname.split('/').filter(function (p) { return p; });
      if (parts.length < 2) return null;
      var owner = decodeURIComponent(parts[0]);
      var repo = decodeURIComponent(parts[1]).replace(/\.git$/i, '');
      if (!isGitName(owner) || !isGitName(repo)) return null;
      var branch = null;
      if (platform === 'github' && parts.length >= 4 && parts[2] === 'tree') {
        branch = sanitizeRef(parts.slice(3).map(decodeURIComponent).join('/'));
      } else if (platform === 'codeberg' && parts.length >= 5 && parts[2] === 'src' && parts[3] === 'branch') {
        branch = sanitizeRef(parts.slice(4).map(decodeURIComponent).join('/'));
      }
      return {
        platform: platform,
        owner: owner,
        repo: repo,
        branch: branch,
        original: 'https://' + parsed.host + '/' + owner + '/' + repo + (branch ? (platform === 'github' ? '/tree/' : '/src/branch/') + branch : '')
      };
    } catch (e) { /* ignore */ }
    return null;
  }

  function deviceProfile() {
    var cores = 4;
    try { cores = root.navigator && root.navigator.hardwareConcurrency || 4; } catch (e) {}
    var mem = 0;
    try { mem = root.navigator && root.navigator.deviceMemory || 0; } catch (e) {}
    var ua = '';
    try { ua = (root.navigator && root.navigator.userAgent) || ''; } catch (e) {}
    var mobile = /Mobi|Android|iPhone|iPad|iPod/i.test(ua);
    var min = 1;
    var max = 6;
    var start = 2;
    if (mobile) {
      max = Math.min(3, Math.max(1, Math.floor(cores / 2) || 1));
      start = 1;
    } else {
      max = Math.min(6, Math.max(2, cores - 1));
      start = Math.min(3, max);
    }
    if (mem && mem <= 2) { max = 1; start = 1; }
    if (mem && mem >= 8 && !mobile) {
      max = Math.min(6, Math.max(3, cores - 1));
      start = Math.min(4, max);
    }
    return { cores: cores, mem: mem, mobile: mobile, min: min, max: max, start: start };
  }

  function memoryPressure() {
    try {
      var m = root.performance && root.performance.memory;
      if (!m || !m.jsHeapSizeLimit) return 0;
      return m.usedJSHeapSize / m.jsHeapSizeLimit;
    } catch (e) {
      return 0;
    }
  }

  R2T.shared = {
    BINARY_EXTENSIONS: BINARY_EXTENSIONS,
    ARCHIVE_EXTENSIONS: ARCHIVE_EXTENSIONS,
    SOURCE_EXTENSIONS: SOURCE_EXTENSIONS,
    PROGRAMMING_EXTENSIONS: PROGRAMMING_EXTENSIONS,
    GENERATED_DIRS: GENERATED_DIRS,
    ALWAYS_EXCLUDE_DIRS: ALWAYS_EXCLUDE_DIRS,
    MAX_NESTED_DEPTH: MAX_NESTED_DEPTH,
    CLIPBOARD_LIMIT_MOBILE: CLIPBOARD_LIMIT_MOBILE,
    CLIPBOARD_LIMIT_DESKTOP: CLIPBOARD_LIMIT_DESKTOP,
    BOMB: BOMB,
    formatBytes: formatBytes,
    formatDuration: formatDuration,
    countLines: countLines,
    extOf: extOf,
    compoundExt: compoundExt,
    sanitizePath: sanitizePath,
    isGeneratedPath: isGeneratedPath,
    isAlwaysExcluded: isAlwaysExcluded,
    isBinaryExt: isBinaryExt,
    isArchivePath: isArchivePath,
    isIncluded: isIncluded,
    priorityScore: priorityScore,
    looksBinaryBytes: looksBinaryBytes,
    decodeText: decodeText,
    readMagic: readMagic,
    detectFormat: detectFormat,
    parseTarBuffer: parseTarBuffer,
    analyzeArchiveMeta: analyzeArchiveMeta,
    fileBanner: fileBanner,
    buildHeader: buildHeader,
    buildSkippedNote: buildSkippedNote,
    parseRepoUrl: parseRepoUrl,
    deviceProfile: deviceProfile,
    memoryPressure: memoryPressure,
    TEXT_MIME_HINT: TEXT_MIME_HINT,
    ALLOWED_REPO_HOSTS: ALLOWED_REPO_HOSTS,
    ALLOWED_FETCH_HOSTS: ALLOWED_FETCH_HOSTS,
    MAX_PATH_LEN: MAX_PATH_LEN,
    MAX_URL_LEN: MAX_URL_LEN,
    stripControls: stripControls,
    safeUiText: safeUiText,
    safeFilename: safeFilename,
    isGitName: isGitName,
    sanitizeRef: sanitizeRef,
    encodeGitPath: encodeGitPath,
    isAllowedFetchUrl: isAllowedFetchUrl,
    safeJsonParse: safeJsonParse,
    parseHttpUrl: parseHttpUrl
  };

  try {
    Object.freeze(ALLOWED_REPO_HOSTS);
    Object.freeze(ALLOWED_FETCH_HOSTS);
    Object.freeze(R2T.shared);
  } catch (e) { /* ignore */ }
})(typeof self !== 'undefined' ? self : this);
