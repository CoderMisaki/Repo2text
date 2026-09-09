importScripts('https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js');

const BINARY_EXTENSIONS = [
    '.png', '.jpg', '.jpeg', '.gif', '.svg', '.ico', '.webp', '.bmp', '.tiff',
    '.mp3', '.mp4', '.wav', '.ogg', '.avi', '.mov', '.mkv', '.webm', '.flac', '.aac',
    '.tar', '.gz', '.rar', '.7z', '.exe', '.dll', '.so', '.bin',
    '.pdf', '.ttf', '.otf', '.woff', '.woff2', '.eot', '.pyc', '.sqlite3',
    '.class', '.jar', '.apk', '.iso', '.dmg', '.ds_store', '.wasm', '.node', '.obj', '.lock'
];

const EXCLUDED_DIRS = [
    '.git/', '__macosx/', '.idea/', '.vscode/', 'node_modules/', 'dist/', 'build/',
    'coverage/', '.next/', '.nuxt/', 'target/', 'vendor/', '__pycache__/', '.cache/'
];

const NESTED_ZIP_EXTS = ['.zip'];
const MAX_NESTED_DEPTH = 2;
const SUSPICIOUS_RATIO = 500;
const SUSPICIOUS_MIN_UNCOMPRESSED = 80 * 1024 * 1024;
const MAX_UNCOMPRESSED_WARN = 1024 * 1024 * 1024;

let currentJobId = null;
let cancelled = false;
let pendingConfirmResolve = null;

function isIncluded(path) {
    const p = path.toLowerCase();
    if (EXCLUDED_DIRS.some(dir => p.includes(`/${dir}`) || p.startsWith(dir))) return false;
    const match = p.match(/\.[0-9a-z]+$/);
    if (match && BINARY_EXTENSIONS.includes(match[0])) return false;
    if (p.endsWith('/')) return false;
    return true;
}

function countLines(text) {
    let lines = 1;
    for (let i = 0; i < text.length; i++) {
        if (text.charCodeAt(i) === 10) lines++;
    }
    return lines;
}

function getEntrySize(entry) {
    try {
        if (entry._data && typeof entry._data.uncompressedSize === 'number') return entry._data.uncompressedSize;
        if (entry._data && typeof entry._data.compressedSize === 'number') return entry._data.compressedSize;
    } catch (e) {}
    return 0;
}

function buildHeader(zipName, entries) {
    const total = entries.length;
    let header = `/**\n * 📦 ARCHIVE SOURCE CODE\n * File:     ${zipName}\n * Total:    ${total} File\n */\n\n`;
    header += `// --- DAFTAR ISI ---\n`;
    for (let i = 0; i < total; i++) {
        header += `// [${String(i + 1).padStart(3, '0')}] ${entries[i].path}\n`;
    }
    header += `// ------------------\n\n`;
    return header;
}

function estimateTotalBytes(entries) {
    let total = 0;
    for (const e of entries) total += e.size;
    return total;
}

function checkSecurity(entries, compressedSize) {
    const totalUncompressed = estimateTotalBytes(entries);
    const totalCompressed = compressedSize || totalUncompressed;
    const ratio = totalCompressed > 0 ? totalUncompressed / totalCompressed : 0;
    const maxEntrySize = entries.reduce((m, e) => Math.max(m, e.size), 0);
    const suspiciousRatio = ratio > SUSPICIOUS_RATIO && totalUncompressed > SUSPICIOUS_MIN_UNCOMPRESSED;
    const hugeSingle = maxEntrySize > MAX_UNCOMPRESSED_WARN;
    const hugeTotal = totalUncompressed > MAX_UNCOMPRESSED_WARN;
    return {
        suspicious: suspiciousRatio || hugeSingle || hugeTotal,
        totalUncompressed,
        totalCompressed,
        ratio: Math.round(ratio),
        maxEntrySize,
        reason: suspiciousRatio
            ? 'Rasio kompresi sangat ekstrem'
            : hugeSingle
                ? 'Ada file tunggal sangat besar'
                : hugeTotal
                    ? 'Total ukuran sangat besar'
                    : ''
    };
}

async function processNestedZip(buffer, prefix, depth, jobId, emit) {
    if (depth > MAX_NESTED_DEPTH) {
        emit('nestedSkipped', { path: prefix, reason: 'Kedalaman nested archive melebihi batas aman' });
        return;
    }
    let nestedZip;
    try {
        nestedZip = await JSZip.loadAsync(buffer);
    } catch (e) {
        emit('nestedSkipped', { path: prefix, reason: 'Nested archive corrupt atau tidak didukung' });
        return;
    }

    const nestedEntries = [];
    nestedZip.forEach((relativePath, zipEntry) => {
        if (!zipEntry.dir && isIncluded(relativePath)) {
            nestedEntries.push({ path: relativePath, entry: zipEntry, size: getEntrySize(zipEntry) });
        }
    });
    nestedEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

    for (const item of nestedEntries) {
        if (cancelled) return;
        const fullPath = prefix + '/' + item.path;
        const ext = item.path.toLowerCase().match(/\.[0-9a-z]+$/);
        const extStr = ext ? ext[0] : '';

        if (NESTED_ZIP_EXTS.includes(extStr) && item.size < 50 * 1024 * 1024) {
            try {
                const nestedBuffer = await item.entry.async('arraybuffer');
                await processNestedZip(nestedBuffer, fullPath, depth + 1, jobId, emit);
                continue;
            } catch (e) {
                emit('nestedSkipped', { path: fullPath, reason: 'Gagal membaca nested archive' });
                continue;
            }
        }

        let content;
        try {
            content = await item.entry.async('string');
        } catch (e) {
            emit('skipped', { path: fullPath, reason: 'Gagal membaca isi file: ' + e.message });
            continue;
        }
        if (content.length > 0 && content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

        emit('chunk', {
            path: fullPath,
            content: content,
            lines: countLines(content),
            bytes: item.size || content.length
        });
    }
}

async function handleZipStart(data) {
    const { jobId, file, zipName } = data;
    currentJobId = jobId;
    cancelled = false;
    pendingConfirmResolve = null;

    try {
        const zip = new JSZip();
        const loadedZip = await zip.loadAsync(file);

        const allEntries = [];
        const nestedCandidates = [];
        loadedZip.forEach((relativePath, zipEntry) => {
            if (!zipEntry.dir && isIncluded(relativePath)) {
                const ext = relativePath.toLowerCase().match(/\.[0-9a-z]+$/);
                const extStr = ext ? ext[0] : '';
                if (NESTED_ZIP_EXTS.includes(extStr)) {
                    nestedCandidates.push({ path: relativePath, entry: zipEntry, size: getEntrySize(zipEntry) });
                } else {
                    allEntries.push({ path: relativePath, entry: zipEntry, size: getEntrySize(zipEntry) });
                }
            }
        });

        allEntries.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
        nestedCandidates.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);

        const total = allEntries.length;
        if (total === 0 && nestedCandidates.length === 0) {
            postMessage({ type: 'error', jobId, message: 'Tidak ditemukan file teks yang dapat dibaca di dalam ZIP.' });
            return;
        }

        const fileSize = file.size || 0;
        const security = checkSecurity([...allEntries, ...nestedCandidates], fileSize);
        if (security.suspicious) {
            const confirmed = await new Promise((resolve) => {
                pendingConfirmResolve = resolve;
                postMessage({
                    type: 'securityCheck',
                    jobId,
                    reason: security.reason,
                    totalUncompressed: security.totalUncompressed,
                    ratio: security.ratio,
                    maxEntrySize: security.maxEntrySize
                });
            });
            if (!confirmed) {
                postMessage({ type: 'cancelled', jobId, reason: 'Dibatalkan oleh pengguna karena potensi archive bomb.' });
                return;
            }
        }

        const header = buildHeader(zipName, allEntries);
        const totalAll = total + nestedCandidates.length;
        postMessage({ type: 'header', jobId, header, totalFiles: totalAll, totalBytes: estimateTotalBytes([...allEntries, ...nestedCandidates]) });

        const processOrder = allEntries.slice().sort((a, b) => a.size - b.size);
        const processed = new Set();
        let processedCount = 0;
        let processedBytes = 0;
        const totalBytes = estimateTotalBytes([...allEntries, ...nestedCandidates]);

        for (const item of processOrder) {
            if (cancelled) return;
            if (processed.has(item.path)) continue;
            processed.add(item.path);

            let content;
            try {
                content = await item.entry.async('string');
            } catch (e) {
                postMessage({ type: 'skipped', jobId, path: item.path, reason: 'Gagal membaca isi file: ' + e.message });
                processedCount++;
                postMessage({ type: 'progress', jobId, processedFiles: processedCount, totalFiles: totalAll, processedBytes, totalBytes, currentPath: item.path });
                continue;
            }
            if (content.length > 0 && content.charCodeAt(0) === 0xFEFF) content = content.slice(1);

            postMessage({
                type: 'chunk',
                jobId,
                index: allEntries.indexOf(item),
                path: item.path,
                content,
                lines: countLines(content),
                bytes: item.size || content.length
            });

            processedCount++;
            processedBytes += item.size || content.length;
            postMessage({ type: 'progress', jobId, processedFiles: processedCount, totalFiles: totalAll, processedBytes, totalBytes, currentPath: item.path });
        }

        for (const nested of nestedCandidates) {
            if (cancelled) return;
            if (processed.has(nested.path)) continue;
            processed.add(nested.path);

            try {
                const nestedBuffer = await nested.entry.async('arraybuffer');
                await processNestedZip(nestedBuffer, nested.path.replace(/\.zip$/i, ''), 1, jobId, (kind, info) => {
                    if (kind === 'chunk') {
                        postMessage({
                            type: 'chunk',
                            jobId,
                            index: total + nestedCandidates.indexOf(nested),
                            path: info.path,
                            content: info.content,
                            lines: info.lines,
                            bytes: info.bytes
                        });
                    } else if (kind === 'skipped') {
                        postMessage({ type: 'skipped', jobId, path: info.path, reason: info.reason });
                    } else if (kind === 'nestedSkipped') {
                        postMessage({ type: 'skipped', jobId, path: info.path, reason: info.reason });
                    }
                });
            } catch (e) {
                postMessage({ type: 'skipped', jobId, path: nested.path, reason: 'Gagal membaca nested archive: ' + e.message });
            }
            processedCount++;
            processedBytes += nested.size || 0;
            postMessage({ type: 'progress', jobId, processedFiles: processedCount, totalFiles: totalAll, processedBytes, totalBytes, currentPath: nested.path });
        }

        if (cancelled) return;
        postMessage({ type: 'complete', jobId });
    } catch (e) {
        if (cancelled) return;
        postMessage({ type: 'error', jobId, message: 'Gagal mengekstrak ZIP: ' + e.message });
    }
}

self.onmessage = function (e) {
    const data = e.data;
    if (data.type === 'cancel') {
        cancelled = true;
        if (pendingConfirmResolve) {
            pendingConfirmResolve(false);
            pendingConfirmResolve = null;
        }
        return;
    }
    if (data.type === 'confirm') {
        if (pendingConfirmResolve) {
            pendingConfirmResolve(data.continue);
            pendingConfirmResolve = null;
        }
        return;
    }
    if (data.type === 'startZip') {
        handleZipStart(data).catch(err => {
            postMessage({ type: 'error', jobId: data.jobId, message: err.message });
        });
    }
};