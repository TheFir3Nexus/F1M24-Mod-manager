const { app, BrowserWindow, ipcMain, dialog, shell } = require('electron');
const { Worker } = require('worker_threads');
const path = require('path');
const fs = require('fs');
const https = require('https');
const http = require('http');
const AdmZip = require('adm-zip');
const crypto = require('crypto');

// ── Extraction worker ─────────────────────────────────────────────────────────
// Runs ZIP/RAR extraction in a worker thread so the main process never blocks.
// filesToExtract: [{ archiveName, destPath }]
// onProgress: (done, total, file) => void
function runExtractionWorker(archivePath, filesToExtract, onProgress) {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'src', 'extract-worker.js');
    const ext = path.extname(archivePath).toLowerCase();
    const worker = new Worker(workerPath);
    worker.postMessage({ archivePath, filesToExtract, ext });
    worker.on('message', (msg) => {
      if (msg.type === 'progress') onProgress(msg.done, msg.total, msg.file);
      else if (msg.type === 'done') { worker.terminate(); resolve(); }
      else if (msg.type === 'error') { worker.terminate(); reject(new Error(msg.message)); }
    });
    worker.on('error', (e) => { worker.terminate(); reject(e); });
    worker.on('exit', (code) => { if (code !== 0) reject(new Error('Worker exited with code ' + code)); });
  });
}

// ── DPAPI-style cookie encryption using machine + user-bound key ──────────────
// We derive a key from a machine/user-specific secret so cookies are unreadable
// on other machines or by other Windows users even if they copy the file.

function getDerivedKey() {
  // Combine machine-specific identifiers to form an encryption key
  const userDataPath = app.getPath('userData');
  const secret = `f1m24-mod-manager:${process.env.USERNAME || ''}:${process.env.COMPUTERNAME || ''}:${userDataPath}`;
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptCookies(data) {
  try {
    const key = getDerivedKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv('aes-256-cbc', key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(data), 'utf8'), cipher.final()]);
    return JSON.stringify({ iv: iv.toString('hex'), data: encrypted.toString('hex') });
  } catch { return null; }
}

function decryptCookies(raw) {
  try {
    const { iv, data } = JSON.parse(raw);
    const key = getDerivedKey();
    const decipher = crypto.createDecipheriv('aes-256-cbc', key, Buffer.from(iv, 'hex'));
    const decrypted = Buffer.concat([decipher.update(Buffer.from(data, 'hex')), decipher.final()]);
    return JSON.parse(decrypted.toString('utf8'));
  } catch { return null; }
}

function cookieStorePath() {
  return path.join(app.getPath('userData'), 'session.enc');
}

async function persistSessionCookies(session) {
  try {
    if (!session || session.isDestroyed && session.isDestroyed()) return;
    const cookies = await session.cookies.get({ url: 'https://www.overtake.gg' });
    const relevant = cookies.filter(c => ['xf_user', 'xf_session', 'xf_csrf'].includes(c.name));
    if (!relevant.length) return;
    const encrypted = encryptCookies(relevant);
    if (encrypted) fs.writeFileSync(cookieStorePath(), encrypted, 'utf8');
  } catch (e) {
    console.log('[session] persist error:', e.message);
  }
}

async function restoreSessionCookies(session) {
  try {
    if (!session || session.isDestroyed && session.isDestroyed()) return;
    const storePath = cookieStorePath();
    if (!fs.existsSync(storePath)) return;
    const raw = fs.readFileSync(storePath, 'utf8');
    const cookies = decryptCookies(raw);
    if (!cookies) return;
    for (const c of cookies) {
      await session.cookies.set({
        url: 'https://www.overtake.gg',
        name: c.name,
        value: c.value,
        domain: c.domain || '.overtake.gg',
        path: c.path || '/',
        secure: c.secure || true,
        httpOnly: c.httpOnly || false,
        expirationDate: c.expirationDate,
      }).catch(() => {});
    }
    console.log('[session] restored', cookies.length, 'encrypted cookies');
  } catch (e) {
    console.log('[session] restore error:', e.message);
  }
}

function clearPersistedCookies() {
  try {
    const p = cookieStorePath();
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {}
}

const CACHE_VERSION = 2; // bump when file-listing logic changes
const DEFAULT_REPO_DIR = 'C:\\F1M24 Mod Manager';
let REPO_DIR = DEFAULT_REPO_DIR;

let modCache = null; // { mods: [], cachedAt: timestamp }
let modCacheInProgress = null; // promise while building

function loadRepoDir() {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (fs.existsSync(settingsPath)) {
    try {
      const s = JSON.parse(fs.readFileSync(settingsPath, 'utf8'));
      if (s.repoDir) REPO_DIR = s.repoDir;
    } catch {}
  }
}

// ── Window ──────────────────────────────────────────────────────────────────

let mainWindow;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 760,
    minWidth: 900,
    minHeight: 600,
    title: 'F1M24 Mod Manager',
    backgroundColor: '#0f0f0f',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    },
    titleBarStyle: 'hidden',
    titleBarOverlay: {
      color: '#0f0f0f',
      symbolColor: '#888888',
      height: 32
    }
  });
  mainWindow.loadFile('src/index.html');
  if (process.argv.includes('--dev')) mainWindow.webContents.openDevTools();
}

app.whenReady().then(async () => {
  loadRepoDir();
  // Electron 41 is stricter with certs — allow overtake.gg
  app.on('certificate-error', (event, webContents, url, error, cert, callback) => {
    if (url.includes('overtake.gg') || url.includes('overtake-data.community.forum')) {
      event.preventDefault();
      callback(true);
    } else {
      callback(false);
    }
  });
  createWindow();
  // Restore encrypted session cookies after window is ready
  mainWindow.webContents.once('did-finish-load', () => {
    try {
      restoreSessionCookies(mainWindow.webContents.session).catch(() => {});
    } catch {}
  });
});

app.on('before-quit', async () => {
  try {
    if (mainWindow && !mainWindow.isDestroyed() && mainWindow.webContents && !mainWindow.webContents.isDestroyed()) {
      await persistSessionCookies(mainWindow.webContents.session);
    }
  } catch {}
});

app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });

// ── Helpers ──────────────────────────────────────────────────────────────────

function ensureRepoDir() {
  if (!fs.existsSync(REPO_DIR)) fs.mkdirSync(REPO_DIR, { recursive: true });
}

function modFolderFor(name) {
  return path.join(REPO_DIR, name.replace(/[<>:"/\\|?*]/g, '_').trim());
}

function downloadFile(url, destPath) {
  return new Promise((resolve, reject) => {
    const proto = url.startsWith('https') ? https : http;
    const file = fs.createWriteStream(destPath);
    proto.get(url, res => {
      if (res.statusCode === 301 || res.statusCode === 302) {
        file.close();
        fs.unlinkSync(destPath);
        return downloadFile(res.headers.location, destPath).then(resolve).catch(reject);
      }
      if (res.statusCode !== 200) {
        file.close();
        fs.unlinkSync(destPath);
        return reject(new Error(`HTTP ${res.statusCode}`));
      }
      res.pipe(file);
      file.on('finish', () => file.close(resolve));
    }).on('error', err => {
      file.close();
      if (fs.existsSync(destPath)) fs.unlinkSync(destPath);
      reject(err);
    });
  });
}


// ── Fast ZIP central-directory reader ────────────────────────────────────────
// Reads ONLY the central directory at the end of the file — never loads
// compressed data into RAM.  Safe for archives of any size.
// Returns array of normalised entry paths, or null on failure/ZIP64.
function listZipEntriesFast(zipPath) {
  let fd;
  try {
    fd = fs.openSync(zipPath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    if (fileSize < 22) return null; // too small to be a valid ZIP

    // Read tail to find the End-Of-Central-Directory record
    const EOCD_SIG        = 0x06054b50;
    const ZIP64_LOC_SIG   = 0x07064b50;
    const ZIP64_EOCD_SIG  = 0x06064b50;
    const CD_SIG          = 0x02014b50;

    const tailSize  = Math.min(fileSize, 65558);
    const searchBuf = Buffer.allocUnsafe(tailSize);
    fs.readSync(fd, searchBuf, 0, tailSize, fileSize - tailSize);

    let eocdPos = -1;
    for (let i = tailSize - 22; i >= 0; i--) {
      if (searchBuf.readUInt32LE(i) === EOCD_SIG) { eocdPos = i; break; }
    }
    if (eocdPos < 0) return null;

    let cdSize   = searchBuf.readUInt32LE(eocdPos + 12);
    let cdOffset = searchBuf.readUInt32LE(eocdPos + 16);

    // ZIP64: try to resolve real offsets from the ZIP64 EOCD locator
    if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) {
      const locPos = eocdPos - 20;
      if (locPos >= 0 && searchBuf.readUInt32LE(locPos) === ZIP64_LOC_SIG) {
        // ZIP64 EOCD offset is at locPos+8 (8 bytes, but stay in 32-bit range)
        const z64OffLo = searchBuf.readUInt32LE(locPos + 8);
        const z64OffHi = searchBuf.readUInt32LE(locPos + 12);
        if (z64OffHi === 0 && z64OffLo < fileSize) {
          const z64Buf = Buffer.allocUnsafe(56);
          fs.readSync(fd, z64Buf, 0, 56, z64OffLo);
          if (z64Buf.readUInt32LE(0) === ZIP64_EOCD_SIG) {
            const cdSzLo  = z64Buf.readUInt32LE(40); const cdSzHi  = z64Buf.readUInt32LE(44);
            const cdOffLo = z64Buf.readUInt32LE(48); const cdOffHi = z64Buf.readUInt32LE(52);
            if (cdSzHi === 0 && cdOffHi === 0) { cdSize = cdSzLo; cdOffset = cdOffLo; }
          }
        }
      }
      // If still unresolved, give up
      if (cdOffset === 0xFFFFFFFF || cdSize === 0xFFFFFFFF) return null;
    }

    // Sanity checks to prevent bad-EOCD OOM
    if (cdSize === 0 || cdSize > fileSize || cdOffset >= fileSize ||
        cdOffset + cdSize > fileSize || cdSize > 64 * 1024 * 1024) return null;

    // Read the central directory block
    const cd = Buffer.allocUnsafe(cdSize);
    fs.readSync(fd, cd, 0, cdSize, cdOffset);

    const entries = [];
    let pos = 0;
    while (pos + 46 <= cdSize) {
      if (cd.readUInt32LE(pos) !== CD_SIG) break;
      const fnLen      = cd.readUInt16LE(pos + 28);
      const extraLen   = cd.readUInt16LE(pos + 30);
      const commentLen = cd.readUInt16LE(pos + 32);
      const extAttrs   = cd.readUInt32LE(pos + 38);
      // Directory: trailing slash OR DOS dir bit (bit 4 of low byte) OR Unix dir type
      const dosIsDir  = (extAttrs & 0x10) !== 0;
      const unixIsDir = (extAttrs >>> 16 & 0xF000) === 0x4000;
      if (!dosIsDir && !unixIsDir && fnLen > 0) {
        const name = cd.toString('utf8', pos + 46, pos + 46 + fnLen);
        if (!name.endsWith('/')) entries.push(name.replace(/\\/g, '/'));
      }
      pos += 46 + fnLen + extraLen + commentLen;
    }
    return entries;
  } catch (e) {
    console.log('[listZipEntriesFast] error:', e.message);
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch {}
  }
}

function classifyZip(zipPath) {
  try {
    let rawEntries = listZipEntriesFast(zipPath);

    // Fast reader failed (unusual ZIP format) — fall back to AdmZip for small files
    if (rawEntries === null) {
      const sizeMB = fs.statSync(zipPath).size / (1024 * 1024);
      if (sizeMB <= 200) {
        try {
          const zip = new AdmZip(zipPath);
          rawEntries = zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName);
        } catch { rawEntries = []; }
      } else {
        // Large file we can't list safely — default to 'pak' (most likely for big archives)
        console.log('[classifyZip] large/unusual ZIP, defaulting to pak:', path.basename(zipPath));
        return 'pak';
      }
    }

    const fileEntries = rawEntries.map(e => e.toLowerCase());
    console.log('[classifyZip]', path.basename(zipPath), 'entries:', fileEntries.slice(0, 8).join(', '));
    const hasPak = fileEntries.some(e => ['.pak','.ucas','.utoc','.ubulk','.uexp','.umap'].includes(path.extname(e)));
    const hasLua = fileEntries.some(e => path.extname(e) === '.lua');
    if (hasPak && hasLua) return 'mixed';
    if (hasPak) return 'pak';
    if (hasLua) return 'lua';
    if (fileEntries.some(e => e.endsWith('.zip') || e.endsWith('.rar'))) return 'pak';
    return 'unknown';
  } catch (e) {
    console.log('[classifyZip] error:', e.message);
    return 'unknown';
  }
}

async function classifyRar(rarPath) {
  try {
    const unrar = require('node-unrar-js');
    const buf = fs.readFileSync(rarPath);
    const extractor = await unrar.createExtractorFromData({ data: buf.buffer });
    const list = extractor.getFileList();
    const entries = [...list.fileHeaders].map(h => h.name.toLowerCase());
    const hasPak = entries.some(e => e.endsWith('.pak') || e.endsWith('.ucas') || e.endsWith('.utoc') || e.endsWith('.ubulk') || e.endsWith('.uexp') || e.endsWith('.umap'));
    const hasLua = entries.some(e => e.endsWith('.lua'));
    if (hasPak && hasLua) return 'mixed';
    if (hasPak) return 'pak';
    if (hasLua) return 'lua';
    return 'unknown';
  } catch (e) {
    console.log('[classifyRar] error:', e.message);
    return 'unknown';
  }
}

async function classifyArchive(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  if (ext === '.rar') return classifyRar(filePath);
  return classifyZip(filePath);
}

async function getRepoMods() {
  ensureRepoDir();
  const results = [];

  console.log('[repo] scanning:', REPO_DIR);
  const rootEntries = fs.readdirSync(REPO_DIR, { withFileTypes: true });
  console.log('[repo] root entries:', rootEntries.map(e => e.name + (e.isDirectory() ? '/' : '')).join(', '));

  // Migrate any flat files in root into named folders
  for (const entry of rootEntries) {
    if (!entry.isFile()) continue;
    if (!/\.(zip|rar)$/i.test(entry.name)) continue;
    const srcPath = path.join(REPO_DIR, entry.name);
    const folderName = entry.name.replace(/\.(zip|rar)$/i, '');
    const modDir = modFolderFor(folderName);
    if (!fs.existsSync(modDir)) fs.mkdirSync(modDir, { recursive: true });
    try {
      fs.renameSync(srcPath, path.join(modDir, entry.name));
      const oldMeta = srcPath + '.meta.json';
      if (fs.existsSync(oldMeta)) fs.renameSync(oldMeta, path.join(modDir, 'meta.json'));
      console.log('[repo] migrated flat file:', entry.name);
    } catch (e) { console.log('[repo] migrate error:', e.message); }
  }

  // Scan named subfolders
  const dirEntries = fs.readdirSync(REPO_DIR, { withFileTypes: true });
  for (const entry of dirEntries) {
    if (!entry.isDirectory()) continue;
    const modDir = path.join(REPO_DIR, entry.name);
    const allFiles = fs.readdirSync(modDir);
    console.log('[repo] folder:', entry.name, 'contains:', allFiles.join(', '));
    const files = allFiles.filter(f => /\.(zip|rar)$/i.test(f));
    console.log('[repo] archives in folder:', files.join(', ') || 'NONE');
    if (files.length === 0) continue;
    const f = files[0];
    const filePath = path.join(modDir, f);

    // Read meta.json once — use cached type if present to avoid re-reading large archives
    let icon = '';
    let cachedType = null;
    const metaPath = path.join(modDir, 'meta.json');
    try {
      if (fs.existsSync(metaPath)) {
        const meta = JSON.parse(fs.readFileSync(metaPath, 'utf8'));
        icon = meta.icon || '';
        cachedType = meta.type || null;
      }
    } catch {}

    let type;
    if (cachedType) {
      type = cachedType;
      console.log('[repo] using cached type for:', entry.name, '->', type);
    } else {
      type = await classifyArchive(filePath);
      // Persist the type into meta.json so future scans skip the archive read
      try {
        let meta = {};
        if (fs.existsSync(metaPath)) {
          try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
        }
        meta.type = type;
        fs.writeFileSync(metaPath, JSON.stringify(meta));
      } catch {}
    }
    console.log('[repo] adding mod:', entry.name, 'type:', type);
    // Mixed mods appear on both pages
    if (type === 'mixed') {
      results.push({ name: entry.name, zip: path.join(entry.name, f), type: 'pak', icon });
      results.push({ name: entry.name, zip: path.join(entry.name, f), type: 'lua', icon });
    } else {
      results.push({ name: entry.name, zip: path.join(entry.name, f), type, icon });
    }
  }
  console.log('[repo] total mods found:', results.length);
  return results;
}
// Base game pak files — never show these as installed mods
const GAME_PAK_BLOCKLIST = new Set([
  'global',
  'pakchunk0_s1-windows', 'pakchunk0_s2-windows', 'pakchunk0_s3-windows',
  'pakchunk0_s4-windows', 'pakchunk0-windows',
  'pakchunk1_s1-windows', 'pakchunk1_s2-windows', 'pakchunk1_s3-windows', 'pakchunk1_s4-windows',
  'pakchunk1_s5-windows', 'pakchunk1_s6-windows', 'pakchunk1_s7-windows',
  'pakchunk1-windows',
  'pakchunk2_s2-windows',
  'pakchunk3_s1-windows', 'pakchunk3-windows',
  'pakchunk4_s2-windows',  'pakchunk4_s5-windows',  'pakchunk4_s6-windows',
  'pakchunk4_s7-windows',  'pakchunk4_s8-windows',  'pakchunk4_s9-windows',
  'pakchunk4_s10-windows', 'pakchunk4_s11-windows', 'pakchunk4_s12-windows',
  'pakchunk4_s13optional-windows',
  'pakchunk4_s13-windows', 'pakchunk4_s14-windows', 'pakchunk4_s15-windows',
  'pakchunk4_s16-windows', 'pakchunk4_s17-windows', 'pakchunk4_s18-windows',
  'pakchunk4_s19-windows', 'pakchunk4_s20-windows', 'pakchunk4_s21-windows',
  'pakchunk4_s22-windows', 'pakchunk4_s23-windows', 'pakchunk4-windows',
]);

function getInstalledPak(gameDir) {
  const pakDir = path.join(gameDir, 'F1Manager24', 'Content', 'Paks');
  if (!fs.existsSync(pakDir)) return [];
  const names = new Set();
  const entries = fs.readdirSync(pakDir, { withFileTypes: true });
  entries.forEach(entry => {
    if (entry.isDirectory()) {
      // Only show if subfolder actually contains pak files (skips empty/leftover folders)
      if (!GAME_PAK_BLOCKLIST.has(entry.name.toLowerCase())) {
        try {
          const subDir = path.join(pakDir, entry.name);
          const hasPaks = fs.readdirSync(subDir).some(f =>
            ['.pak','.ucas','.utoc','.ubulk','.uexp','.umap'].includes(path.extname(f).toLowerCase())
          );
          if (hasPaks) names.add(entry.name);
        } catch {}
      }
    } else {
      // Legacy flat files
      const ext = path.extname(entry.name).toLowerCase();
      if (['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap'].includes(ext)) {
        const base = path.basename(entry.name, ext);
        if (!GAME_PAK_BLOCKLIST.has(base.toLowerCase())) names.add(base);
      }
    }
  });
  return Array.from(names);
}

// UE4SS built-in / system mod folders — never show these as installed mods
const UE4SS_BUILTIN_BLOCKLIST = new Set([
  'keybinds', 'bpml_genericfunctions', 'bpmodloadermod',
  'cheatmanagerenablermod', 'consolecommandsmod', 'consoleenablermod',
  'linetracemod', 'shared', 'splitscreenmod',
]);

function getInstalledLua(gameDir) {
  const modsDir = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64', 'ue4ss', 'Mods');
  if (!fs.existsSync(modsDir)) return [];
  return fs.readdirSync(modsDir).filter(f => {
    const full = path.join(modsDir, f);
    return fs.statSync(full).isDirectory() && !UE4SS_BUILTIN_BLOCKLIST.has(f.toLowerCase());
  });
}

// ── IPC Handlers ─────────────────────────────────────────────────────────────

ipcMain.handle('browse-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select F1 Manager 2024 game folder'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('save-setting', (_, key, value) => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }
  settings[key] = value;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  return true;
});

ipcMain.handle('load-settings', () => {
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  if (!fs.existsSync(settingsPath)) return {};
  try { return JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { return {}; }
});

ipcMain.handle('get-repo-dir', () => REPO_DIR);

ipcMain.handle('set-repo-dir', (_, newDir) => {
  if (!newDir || !fs.existsSync(newDir)) return false;
  REPO_DIR = newDir;
  // Persist to settings
  const settingsPath = path.join(app.getPath('userData'), 'settings.json');
  let settings = {};
  if (fs.existsSync(settingsPath)) {
    try { settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch {}
  }
  settings.repoDir = newDir;
  fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2));
  ensureRepoDir();
  return true;
});

ipcMain.handle('browse-repo-dir', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory'],
    title: 'Select Mod Repository Folder'
  });
  return result.canceled ? null : result.filePaths[0];
});

ipcMain.handle('get-repo-mods', () => getRepoMods());

ipcMain.handle('get-installed-pak', (_, gameDir) => getInstalledPak(gameDir));

ipcMain.handle('get-installed-lua', (_, gameDir) => getInstalledLua(gameDir));

ipcMain.handle('check-ue4ss', (_, gameDir) => {
  const win64 = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64');
  const hasDwmapi = fs.existsSync(path.join(win64, 'dwmapi.dll'));
  const hasFolder = fs.existsSync(path.join(win64, 'ue4ss'));
  return hasDwmapi && hasFolder;
});


// ── UE4SS helpers ─────────────────────────────────────────────────────────────

// Get zip entry list from any file path (not via modName/cache)
function getZipEntriesDirect(zipPath) {
  const fast = listZipEntriesFast(zipPath);
  if (fast !== null) return fast;
  // Fallback for small files only
  try {
    const sizeMB = fs.statSync(zipPath).size / (1024 * 1024);
    if (sizeMB <= 30) {
      const zip = new AdmZip(zipPath);
      return zip.getEntries().filter(e => !e.isDirectory).map(e => e.entryName.replace(/\\/g, '/'));
    }
  } catch {}
  return [];
}

// Build a filesToExtract list for UE4SS files from an entry list
function buildUE4SSExtractList(rawEntries, win64) {
  const entries = rawEntries.map(e => e.replace(/\\/g, '/'));
  const dwmapi  = entries.find(e => path.basename(e).toLowerCase() === 'dwmapi.dll');
  const root    = dwmapi ? (path.dirname(dwmapi) === '.' ? '' : path.dirname(dwmapi) + '/') : '';
  const list    = [];
  for (const name of entries) {
    if (root && !name.startsWith(root)) continue;
    const relative = root ? name.slice(root.length) : name;
    if (!relative || relative.toLowerCase().startsWith('ue4ss/mods/')) continue;
    const destPath = path.join(win64, relative);
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    list.push({ archiveName: name, destPath });
  }
  return list;
}

ipcMain.handle('install-ue4ss', async (event, gameDir, modName) => {
  const win64 = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64');
  if (!fs.existsSync(win64)) fs.mkdirSync(win64, { recursive: true });

  const send = (status, done = 0, total = 1) => {
    try { event.sender.send('ue4ss-install-progress', { status, done, total }); } catch {}
  };

  // ── Step 1: Check if the mod bundles UE4SS using the cached file list ────
  if (modName) {
    send('Checking for bundled UE4SS…');
    try {
      const { entries, archivePath } = await getArchiveFileList(modName);
      const ext = path.extname(archivePath).toLowerCase();
      const normalized = entries.map(e => e.replace(/\\/g, '/'));

      if (ext === '.rar') {
        // RAR: use existing RAR extraction logic
        const unrar = require('node-unrar-js');
        const buf   = fs.readFileSync(archivePath);
        const listExt = await unrar.createExtractorFromData({ data: buf.buffer });
        const list    = listExt.getFileList();
        let root = '';
        for (const h of list.fileHeaders) {
          const n = h.name.replace(/\\/g, '/');
          if (path.basename(n).toLowerCase() === 'dwmapi.dll') {
            root = path.dirname(n) === '.' ? '' : path.dirname(n) + '/'; break;
          }
        }
        const ext2 = await unrar.createExtractorFromData({ data: buf.buffer });
        const extracted = ext2.extract();
        let done = 0, total = entries.length;
        for (const file of extracted.files) {
          if (!file.fileHeader.flags.directory && file.extraction) {
            const n = file.fileHeader.name.replace(/\\/g, '/');
            if (root && !n.startsWith(root)) continue;
            const rel = root ? n.slice(root.length) : n;
            if (!rel || rel.toLowerCase().startsWith('ue4ss/mods/')) continue;
            const outPath = path.join(win64, rel);
            fs.mkdirSync(path.dirname(outPath), { recursive: true });
            fs.writeFileSync(outPath, Buffer.from(file.extraction));
            send(`Installing: ${path.basename(rel)}`, ++done, total);
          }
        }
        return true;
      }

      // ZIP: use fast reader result (no archive scan needed — list already in hand)
      if (normalized.some(e => path.basename(e).toLowerCase() === 'dwmapi.dll')) {
        const filesToExtract = buildUE4SSExtractList(normalized, win64);
        send('Installing bundled UE4SS…', 0, filesToExtract.length);
        await runExtractionWorker(archivePath, filesToExtract, (done, total, file) => {
          send(`Installing: ${file}`, done, total);
        });
        return true;
      }
    } catch (e) {
      console.log('[install-ue4ss] bundle check:', e.message);
    }
  }

  // ── Step 2: Download UE4SS directly from GitHub ──────────────────────────
  send('Fetching latest UE4SS release…');

  const releaseJson = await new Promise((resolve, reject) => {
    https.get('https://api.github.com/repos/UE4SS-RE/RE-UE4SS/releases/latest', {
      headers: { 'User-Agent': 'F1M24-Mod-Manager', 'Accept': 'application/vnd.github+json' }
    }, res => {
      if (res.statusCode !== 200) return reject(new Error('GitHub API: ' + res.statusCode));
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    }).on('error', reject);
  });

  const asset = (releaseJson.assets || []).find(a => /^UE4SS_v[\d.]+\.zip$/i.test(a.name)) ||
                (releaseJson.assets || []).find(a => a.name?.endsWith('.zip') && !a.name?.startsWith('z'));
  if (!asset) throw new Error('No UE4SS release zip found on GitHub');

  const tmpPath = path.join(app.getPath('temp'), 'ue4ss_install_' + Date.now() + '.zip');

  await new Promise((resolve, reject) => {
    const doGet = (url, depth = 0) => {
      if (depth > 5) return reject(new Error('Too many redirects'));
      const proto = url.startsWith('https') ? https : http;
      const file  = fs.createWriteStream(tmpPath);
      let downloaded = 0;
      proto.get(url, { headers: { 'User-Agent': 'F1M24-Mod-Manager' } }, res => {
        if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location) {
          file.close(); return doGet(res.headers.location, depth + 1);
        }
        if (res.statusCode !== 200) { file.close(); return reject(new Error('HTTP ' + res.statusCode)); }
        const total = parseInt(res.headers['content-length'] || String(asset.size || 0)) || asset.size || 1;
        res.on('data', chunk => {
          downloaded += chunk.length;
          send(`Downloading UE4SS ${releaseJson.tag_name || ''}…`, downloaded, total);
        });
        res.pipe(file);
        file.on('finish', () => file.close(resolve));
        file.on('error', reject);
      }).on('error', reject);
    };
    doGet(asset.browser_download_url);
  });

  // Extract downloaded archive
  send('Installing UE4SS…', 0, 10);
  try {
    const entries = getZipEntriesDirect(tmpPath);
    if (!entries.length) throw new Error('Could not read downloaded UE4SS archive');
    const filesToExtract = buildUE4SSExtractList(entries, win64);
    if (!filesToExtract.length) throw new Error('No UE4SS files found in archive');
    await runExtractionWorker(tmpPath, filesToExtract, (done, total, file) => {
      send(`Installing: ${file}`, done, total);
    });
  } finally {
    try { fs.unlinkSync(tmpPath); } catch {}
  }
  return true;
});


ipcMain.handle('download-zip', async (_, url, icon = '', displayName = '', pageUrl = '') => {
  ensureRepoDir();

  const session = mainWindow.webContents.session;

  // Check all domain variants for the xf_user cookie
  const byUrl = await session.cookies.get({ url: 'https://www.overtake.gg' });
  const byDomain = await session.cookies.get({ domain: 'overtake.gg' });
  const byDomainDot = await session.cookies.get({ domain: '.overtake.gg' });
  const allCookies = [...new Map([...byUrl, ...byDomain, ...byDomainDot].map(c => [c.name, c])).values()];

  console.log('[download] cookies:', allCookies.map(c => c.name).join(', ') || 'NONE');

  if (!allCookies.some(c => c.name === 'xf_user')) {
    throw new Error('Not logged in — please log in to Overtake.gg in Settings first');
  }

  const cookieHeader = allCookies.map(c => `${c.name}=${c.value}`).join('; ');

  const HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Referer': 'https://www.overtake.gg/',
    'Cookie': cookieHeader,
  };

  async function doDownload(downloadUrl, depth = 0) {
    if (depth > 10) throw new Error('Too many redirects');

    // Use 'follow' — Electron 41 cancels manual redirects
    const response = await session.fetch(downloadUrl, { headers: HEADERS, redirect: 'follow' });
    console.log('[download] status:', response.status, response.url || downloadUrl);

    if (response.status !== 200) throw new Error(`HTTP ${response.status}`);

    const contentType = response.headers.get('content-type') || '';
    console.log('[download] content-type:', contentType);

    // If HTML — it's the chooser page, parse real download link
    if (contentType.includes('text/html')) {
      const html = await response.text();
      const linkMatches = [...html.matchAll(/href="(\/downloads\/[^"]+\/version\/[^"]+\/download\?file=\d+)"/g)];
      if (!linkMatches.length) throw new Error('Got a chooser page but found no download links in it');
      const firstLink = 'https://www.overtake.gg' + linkMatches[0][1];
      return doDownload(firstLink, depth + 1);
    }

    // Binary file — save it
    const disposition = response.headers.get('content-disposition') || '';
    console.log('[download] content-disposition:', disposition);
    let filename = '';
    const fnMatch = disposition.match(/filename\*?=(?:UTF-8'')?["']?([^"';\r\n]+)["']?/i);
    if (fnMatch) filename = decodeURIComponent(fnMatch[1].trim());
    if (!filename) {
      const urlParts = downloadUrl.split('/');
      filename = urlParts[urlParts.length - 1].split('?')[0] || 'mod.zip';
    }

    const folderName = displayName || filename.replace(/\.[^.]+$/, '').trim() || 'Downloaded Mod';
    const modDir = modFolderFor(folderName);
    if (!fs.existsSync(modDir)) fs.mkdirSync(modDir, { recursive: true });
    const savePath = path.join(modDir, filename);
    console.log('[download] saving to:', savePath);

    // Stream to disk so large mods don't OOM
    const totalBytes = parseInt(response.headers.get('content-length') || '0');
    let downloadedBytes = 0;
    try { mainWindow.webContents.send('download-progress', { label: `Downloading ${filename}…`, downloaded: 0, total: totalBytes || 1 }); } catch {}
    const fileWriteStream = fs.createWriteStream(savePath);
    const rdr = response.body.getReader ? response.body.getReader() : null;
    if (rdr) {
      await new Promise((res2, rej2) => {
        const pump = () => rdr.read().then(({ done, value }) => {
          if (done) { fileWriteStream.end(); return; }
          downloadedBytes += value.length;
          if (totalBytes) { try { mainWindow.webContents.send('download-progress', { label: `Downloading ${filename}…`, downloaded: downloadedBytes, total: totalBytes }); } catch {} }
          if (!fileWriteStream.write(Buffer.from(value))) fileWriteStream.once('drain', pump); else pump();
        }).catch(rej2);
        fileWriteStream.on('finish', res2); fileWriteStream.on('error', rej2);
        pump();
      });
    } else {
      const buf = Buffer.from(await response.arrayBuffer());
      fs.writeFileSync(savePath, buf);
    }
    try { mainWindow.webContents.send('download-progress', { complete: true }); } catch {}

    const type = await classifyArchive(savePath);
    console.log('[download] classified as:', type);

    // Always write meta.json with icon + type so getRepoMods never re-reads the archive
    const existingMetaPath = path.join(modDir, 'meta.json');
    let existingMeta = {};
    try { if (fs.existsSync(existingMetaPath)) existingMeta = JSON.parse(fs.readFileSync(existingMetaPath, 'utf8')); } catch {}
    // Invalidate file-list cache for this mod (new archive replaces old)
    const freshMeta = { ...existingMeta, icon, type };
    delete freshMeta.fileList; delete freshMeta.cacheVersion;
    if (pageUrl) {
      freshMeta.overtakeUrl    = pageUrl;
      freshMeta.downloadedAt   = new Date().toISOString();
      // Try to grab version from the mod page (graceful fail)
      try {
        const pgRes  = await session.fetch(pageUrl, { headers: HEADERS });
        if (pgRes.ok) {
          const pgHtml = await pgRes.text();
          const vm = pgHtml.match(/<dt>Version<\/dt>\s*<dd>\s*([^\s<][^<]*?)\s*<\/dd>/);
          if (vm) freshMeta.overtakeVersion = vm[1].trim();
          const um = pgHtml.match(/resourceTabList[\s\S]{0,500}?datetime="([^"]+)"/);
          if (um) freshMeta.overtakeUpdatedAt = um[1];
        }
      } catch (_) {}
    }
    fs.writeFileSync(existingMetaPath, JSON.stringify(freshMeta));

    return { name: folderName, zip: path.join(folderName, filename), type };
  }

  return doDownload(url);
});

// ── Shared helper: read (and cache) the flat file list from an archive ──────
// For large RARs this is very slow, so we cache the list in meta.json.
async function getArchiveFileList(modName) {
  const modDir = path.join(REPO_DIR, modName);
  const files = fs.readdirSync(modDir).filter(f => /\.(zip|rar)$/i.test(f));
  if (!files.length) throw new Error('Archive not found for: ' + modName);
  const archivePath = path.join(modDir, files[0]);
  const ext = path.extname(archivePath).toLowerCase();

  // Check cache
  const metaPath = path.join(modDir, 'meta.json');
  let meta = {};
  try { if (fs.existsSync(metaPath)) meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch {}
  if (Array.isArray(meta.fileList) && meta.cacheVersion === CACHE_VERSION) {
    console.log('[fileList] cache hit for:', modName, '(' + meta.fileList.length + ' entries)');
    return { archivePath, ext, entries: meta.fileList };
  }

  // Read archive
  console.log('[fileList] reading archive for:', modName);
  let entries = [];
  if (ext === '.rar') {
    const unrar = require('node-unrar-js');
    const buf = fs.readFileSync(archivePath);
    const extractor = await unrar.createExtractorFromData({ data: buf.buffer });
    const list = extractor.getFileList();
    for (const h of list.fileHeaders) {
      if (!h.flags.directory) entries.push(h.name.replace(/\\/g, '/'));
    }
  } else {
    const fast = listZipEntriesFast(archivePath);
    if (fast !== null) {
      entries = fast;
    } else {
      // Fast reader failed — AdmZip fallback for files <= 200 MB
      const sizeMB = fs.statSync(archivePath).size / (1024 * 1024);
      if (sizeMB <= 200) {
        try {
          const zip = new AdmZip(archivePath);
          zip.getEntries().forEach(e => {
            if (!e.isDirectory) entries.push(e.entryName.replace(/\\/g, '/'));
          });
        } catch (admErr) {
          console.log('[fileList] AdmZip also failed:', admErr.message);
        }
      } else {
        // Large file — skip AdmZip (would OOM). Worker uses PowerShell for extraction.
        console.log('[fileList] large file, fast reader failed — worker will use PowerShell');
      }
    }
  }

  // Cache it
  try { meta.fileList = entries; meta.cacheVersion = CACHE_VERSION; fs.writeFileSync(metaPath, JSON.stringify(meta)); } catch {}
  return { archivePath, ext, entries };
}

ipcMain.handle('detect-pak-variants', async (_, modName) => {
  const modDir = path.join(REPO_DIR, modName);
  if (!fs.existsSync(modDir)) return null;
  const archiveFiles = fs.readdirSync(modDir).filter(f => /\.(zip|rar)$/i.test(f));
  if (!archiveFiles.length) return null;

  try {
  const PAK_EXTS = new Set(['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap']);
  const { entries: allEntries } = await getArchiveFileList(modName);

  const hasExe = allEntries.some(e => path.extname(e).toLowerCase() === '.exe');
  const pakEntries = allEntries.filter(e => PAK_EXTS.has(path.extname(e).toLowerCase()));

  if (!pakEntries.length && !hasExe) return null;

  // Find the index of 'F1Manager24' in the path — everything before it is the variant path
  // e.g. ADVANCED/EPIC VERSION/F1Manager24/Content/Paks/mod.pak
  // variant path = ADVANCED/EPIC VERSION
  function getVariantPath(entry) {
    const parts = entry.split('/');
    const f1idx = parts.findIndex(p => p.toLowerCase() === 'f1manager24');
    if (f1idx > 0) return parts.slice(0, f1idx).join('/');
    // Fallback: use everything except the last 2 parts (filename + immediate parent)
    if (parts.length > 2) return parts.slice(0, parts.length - 2).join('/');
    if (parts.length > 1) return parts[0];
    return '';
  }

  // Collect all unique variant paths
  const variantPaths = new Set();
  for (const e of pakEntries) {
    const vp = getVariantPath(e);
    if (vp) variantPaths.add(vp);
  }

  if (variantPaths.size <= 1) {
    return hasExe ? { variants: null, nested: false, hasExe } : null;
  }

  // Only show the variant picker when the same pak base name actually exists in multiple
  // variant folders — i.e. there is a genuine conflict the user needs to resolve.
  // If every pak file has a unique name across all folders, no choice is needed.
  const baseToVariantPaths = new Map();
  for (const e of pakEntries) {
    const vp = getVariantPath(e);
    const base = path.basename(e, path.extname(e)).toLowerCase();
    if (!baseToVariantPaths.has(base)) baseToVariantPaths.set(base, new Set());
    baseToVariantPaths.get(base).add(vp);
  }
  const hasConflictingNames = [...baseToVariantPaths.values()].some(paths => paths.size > 1);
  if (!hasConflictingNames) {
    return hasExe ? { variants: null, nested: false, hasExe } : null;
  }

  // Build nested tree from the variant paths
  // e.g. ['ADVANCED/EPIC VERSION', 'ADVANCED/STEAM VERSION', 'BASIC/EPIC VERSION', 'BASIC/STEAM VERSION']
  const tree = {};
  for (const vp of variantPaths) {
    const parts = vp.split('/');
    const top = parts[0];
    if (!tree[top]) tree[top] = [];
    tree[top].push(vp);
  }

  const hasNested = Object.values(tree).some(subs => subs.length > 1);

  if (hasNested) {
    return { variants: tree, nested: true, hasExe };
  }

  return { variants: Object.keys(tree), nested: false, hasExe };
  } catch (e) {
    console.log('[detect-pak-variants] error:', e.message);
    return null; // fall back to direct install
  }
});
ipcMain.handle('list-archive-contents', async (_, modName, targetType = 'pak', variantFolder = null) => {
  const PAK_EXTS = new Set(['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap']);
  const { entries: allEntries } = await getArchiveFileList(modName);

  if (targetType === 'pak') {
    let pakEntries = allEntries.filter(e => PAK_EXTS.has(path.extname(e).toLowerCase()) || path.extname(e).toLowerCase() === '.exe');
    // If a variant folder is selected, only return files from that folder
    if (variantFolder) {
      pakEntries = pakEntries.filter(e => e.replace(/\\/g, '/').startsWith(variantFolder + '/'));
    }
    return pakEntries;
  } else if (targetType === 'lua') {
    // Find lua root: go 2 levels up from the first .lua file
    let luaRoot = null;
    for (const e of allEntries) {
      const normalized = e.replace(/\\/g, '/');
      if (path.extname(normalized).toLowerCase() === '.lua') {
        const parts = normalized.split('/');
        if (parts.length >= 3) luaRoot = parts.slice(0, parts.length - 2).join('/');
        else if (parts.length === 2) luaRoot = parts[0];
        break;
      }
    }
    return allEntries
      .filter(e => !PAK_EXTS.has(path.extname(e).toLowerCase()))
      .filter(e => {
        const normalized = e.replace(/\\/g, '/');
        if (!luaRoot) return normalized.split('/').length >= 2;
        return normalized.startsWith(luaRoot + '/') || normalized.startsWith(luaRoot);
      })
      .map(e => {
        // Return path relative to luaRoot so modal shows clean names
        const normalized = e.replace(/\\/g, '/');
        if (luaRoot && normalized.startsWith(luaRoot + '/')) return normalized.slice(luaRoot.length + 1);
        if (luaRoot && normalized.startsWith(luaRoot)) return normalized.slice(luaRoot.length);
        return normalized;
      });
  }

  return allEntries;
});

ipcMain.handle('install-mod-selected', async (event, modName, gameDir, selectedFiles, targetType = 'pak') => {
  const modDir = path.join(REPO_DIR, modName);
  const archives = fs.readdirSync(modDir).filter(f => /\.(zip|rar)$/i.test(f));
  if (!archives.length) throw new Error('Archive not found for: ' + modName);
  const archivePath = path.join(modDir, archives[0]);
  const repoModFolder = path.basename(modDir);
  const ext = path.extname(archivePath).toLowerCase();
  const selected = new Set(selectedFiles.map(s => s.replace(/\\/g, '/')));

  const pakDir   = path.join(gameDir, 'F1Manager24', 'Content', 'Paks', repoModFolder);
  const win64Dir = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64');
  const luaDir   = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64', 'ue4ss', 'Mods');

  function destDirFor(name) {
    if (path.extname(name).toLowerCase() === '.exe') return win64Dir;
    return targetType === 'pak' ? pakDir : luaDir;
  }

  // Server-side guard: for pak installs only allow pak-type + exe files,
  // blocking any lua/txt/etc that might slip through from the frontend.
  const PAK_ALLOWED = new Set(['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap', '.exe']);
  const safeFiles = targetType === 'pak'
    ? selectedFiles.filter(f => PAK_ALLOWED.has(path.extname(f).toLowerCase()))
    : selectedFiles;

  // Build the list of { archiveName, destPath } for the worker
  const filesToExtract = safeFiles.map(name => {
    const normalized = name.replace(/\\/g, '/');
    const dest = destDirFor(normalized);
    fs.mkdirSync(dest, { recursive: true });
    return { archiveName: normalized, destPath: path.join(dest, path.basename(normalized)) };
  });

  await runExtractionWorker(archivePath, filesToExtract, (done, total, file) => {
    try { event.sender.send('install-progress', { done, total, file, modName }); } catch {}
  });
  return true;
});

ipcMain.handle('install-mod', async (event, modName, gameDir, targetType = null) => {
  let archivePath = null;

  // modName is the repo folder name — find the archive inside it
  const modDir = path.join(REPO_DIR, modName);
  if (fs.existsSync(modDir) && fs.statSync(modDir).isDirectory()) {
    const files = fs.readdirSync(modDir).filter(f => /\.(zip|rar)$/i.test(f));
    if (files.length > 0) archivePath = path.join(modDir, files[0]);
  }

  // Fallback: search all subfolders for a folder matching modName
  if (!archivePath) {
    const entries = fs.readdirSync(REPO_DIR, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      if (entry.name !== modName) continue;
      const dir = path.join(REPO_DIR, entry.name);
      const files = fs.readdirSync(dir).filter(f => /\.(zip|rar)$/i.test(f));
      if (files.length > 0) { archivePath = path.join(dir, files[0]); break; }
    }
  }

  if (!archivePath) throw new Error('Archive not found for: ' + modName);

  const repoModFolder = path.basename(path.dirname(archivePath));
  const ext = path.extname(archivePath).toLowerCase();
  const detectedType = await classifyArchive(archivePath);
  // For mixed mods, use targetType to decide what to install; otherwise use detected type
  const installType = targetType || (detectedType === 'mixed' ? 'pak' : detectedType);

  const PAK_EXTS = ['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap'];

  if (installType === 'pak') {
    const pakDir = path.join(gameDir, 'F1Manager24', 'Content', 'Paks', repoModFolder);
    const win64Dir = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64');
    if (!fs.existsSync(pakDir)) fs.mkdirSync(pakDir, { recursive: true });

    // Helper: given a full archive entry path, get the path relative to F1Manager24/
    function getRelativeToF1(entryPath) {
      const n = entryPath.replace(/\\/g, '/');
      const idx = n.toLowerCase().indexOf('/f1manager24/');
      if (idx >= 0) return n.slice(idx + '/f1manager24/'.length);
      return null;
    }

    // Collect the entries we want to extract
    const { entries: allEntries } = await getArchiveFileList(modName);
    const filesToExtract = [];
    for (const name of allEntries) {
      const n = name.replace(/\\/g, '/');
      const fileExt = path.extname(n).toLowerCase();
      if (PAK_EXTS.includes(fileExt)) {
        fs.mkdirSync(pakDir, { recursive: true });
        filesToExtract.push({ archiveName: n, destPath: path.join(pakDir, path.basename(n)) });
      } else if (fileExt === '.exe') {
        fs.mkdirSync(win64Dir, { recursive: true });
        filesToExtract.push({ archiveName: n, destPath: path.join(win64Dir, path.basename(n)) });
      }
    }
    await runExtractionWorker(archivePath, filesToExtract, (done, total, file) => {
      try { event.sender.send('install-progress', { done, total, file, modName }); } catch {}
    });

  } else if (installType === 'lua') {
    const modsDir = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64', 'ue4ss', 'Mods');
    if (!fs.existsSync(modsDir)) fs.mkdirSync(modsDir, { recursive: true });

    // Find the prefix to strip: everything ABOVE the mod folder.
    // The mod folder is the one directly containing the .lua file (or Scripts/ folder with .lua).
    // e.g. "custom mod/DRS Mod/Scripts/main.lua" → mod folder = "DRS Mod", strip prefix = "custom mod/"
    // e.g. "DRS Mod/Scripts/main.lua" → mod folder = "DRS Mod", strip prefix = ""
    function findStripPrefix(entries) {
      for (const e of entries) {
        const n = e.replace(/\\/g, '/');
        if (path.extname(n).toLowerCase() !== '.lua') continue;
        const parts = n.split('/');
        // parts[-1] = filename, parts[-2] = Scripts or mod folder, parts[-3+] = parents
        // The mod folder is parts[parts.length - 2] if lua is in a subfolder,
        // or parts[parts.length - 2] if lua is directly in mod folder
        // Strip prefix = everything before the mod folder
        if (parts.length >= 3) {
          // e.g. [wrapper, ModFolder, Scripts, main.lua] → strip "wrapper/"
          return parts.slice(0, parts.length - 3).join('/');
        } else {
          // e.g. [ModFolder, main.lua] or [ModFolder, Scripts, main.lua]
          return '';
        }
      }
      return '';
    }

    function extractLua(allNames, getContent) {
      const stripPrefix = findStripPrefix(allNames);
      console.log('[lua] stripPrefix:', JSON.stringify(stripPrefix));
      for (const name of allNames) {
        const n = name.replace(/\\/g, '/');
        if (PAK_EXTS.includes(path.extname(n).toLowerCase())) continue;
        // Must be under the strip prefix
        if (stripPrefix && !n.startsWith(stripPrefix + '/')) continue;
        const relative = stripPrefix ? n.slice(stripPrefix.length + 1) : n;
        if (!relative) continue;
        // Must be at least one folder deep (mod folder/file)
        if (!relative.includes('/')) continue;
        const outPath = path.join(modsDir, relative);
        fs.mkdirSync(path.dirname(outPath), { recursive: true });
        getContent(name, outPath);
      }
    }

    // Use cached file list and worker for lua extraction
    const { entries: allNames } = await getArchiveFileList(modName);
    const stripPrefix = findStripPrefix(allNames);
    console.log('[lua] stripPrefix:', JSON.stringify(stripPrefix));
    const filesToExtract = [];
    for (const name of allNames) {
      const n = name.replace(/\\/g, '/');
      if (PAK_EXTS.includes(path.extname(n).toLowerCase())) continue;
      if (stripPrefix && !n.startsWith(stripPrefix + '/')) continue;
      const relative = stripPrefix ? n.slice(stripPrefix.length + 1) : n;
      if (!relative || !relative.includes('/')) continue;
      const outPath = path.join(modsDir, relative);
      fs.mkdirSync(path.dirname(outPath), { recursive: true });
      filesToExtract.push({ archiveName: n, destPath: outPath });
    }
    await runExtractionWorker(archivePath, filesToExtract, (done, total, file) => {
      try { event.sender.send('install-progress', { done, total, file, modName }); } catch {}
    });
  }
  return true;
});

ipcMain.handle('delete-installed-pak', async (_, baseName, gameDir) => {
  // baseName is the mod folder name inside Paks
  const modDir = path.join(gameDir, 'F1Manager24', 'Content', 'Paks', baseName);
  if (fs.existsSync(modDir)) {
    let lastErr;
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        fs.rmSync(modDir, { recursive: true, force: true });
        if (!fs.existsSync(modDir)) return true;
      } catch (e) { lastErr = e; }
      await new Promise(r => setTimeout(r, 150));
    }
    throw new Error(lastErr ? lastErr.message : `Could not delete ${baseName} — folder may be in use`);
  } else {
    // Legacy: flat files directly in Paks
    ['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap'].forEach(ext => {
      const f = path.join(gameDir, 'F1Manager24', 'Content', 'Paks', baseName + ext);
      try { if (fs.existsSync(f)) fs.unlinkSync(f); } catch {}
    });
  }
  return true;
});

ipcMain.handle('delete-installed-lua', async (_, folderName, gameDir) => {
  const modsDir = path.join(gameDir, 'F1Manager24', 'Binaries', 'Win64', 'ue4ss', 'Mods');
  const target = path.join(modsDir, folderName);
  if (!fs.existsSync(target)) return true; // already gone — not an error
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      fs.rmSync(target, { recursive: true, force: true });
      // Confirm it's actually gone
      if (!fs.existsSync(target)) return true;
    } catch (e) { lastErr = e; }
    // Brief pause before retry — helps with Windows file locks
    await new Promise(r => setTimeout(r, 150));
  }
  throw new Error(lastErr ? lastErr.message : `Could not delete ${folderName} — the folder may be in use`);
});

ipcMain.handle('delete-repo-mod', (_, folderName) => {
  console.log('[delete-repo] folderName:', folderName);
  const modDir = path.join(REPO_DIR, folderName);
  console.log('[delete-repo] modDir:', modDir, 'exists:', fs.existsSync(modDir));
  try {
    if (fs.existsSync(modDir) && modDir !== REPO_DIR) {
      fs.rmSync(modDir, { recursive: true, force: true });
      console.log('[delete-repo] deleted:', modDir);
    }
  } catch (e) { console.log('[delete-repo] error:', e.message); }
  return true;
});

ipcMain.handle('validate-game-dir', (_, dir) => {
  return fs.existsSync(path.join(dir, 'F1Manager24.exe'));
});



// ── Home page data ────────────────────────────────────────────────────────────

ipcMain.handle('get-featured-mod', async () => {
  // ── Add/change featured mod URLs here (up to 5) ──────────────────────────
  const FEATURED_URLS = [
    'https://www.overtake.gg/downloads/2026-season-update.83636/',
    'https://www.overtake.gg/downloads/2026-ui-changes.82743/',
    'https://www.overtake.gg/downloads/2026-season-mod-facepack.82754/',
    'https://www.overtake.gg/downloads/2026-season-update-myteam-livery-pack-add-on.83637/',
    'https://www.overtake.gg/downloads/f1-2026-season-helmets.82901/',
  ];
  // ─────────────────────────────────────────────────────────────────────────

  const session = mainWindow.webContents.session;

  async function fetchWithSession(url) {
    const res = await session.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      }
    });
    return res.text();
  }

  function parseMod(html, modUrl) {
    const slugMatch = modUrl.match(/\/downloads\/([^./]+)\./);
    const title = slugMatch
      ? slugMatch[1].replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
      : 'Featured Mod';

    const descMatch = html.match(/resourceTagLine[^>]*>([^<]+)</);
    const desc = descMatch ? descMatch[1].trim() : '';

    let image = '';
    // og:image
    const ogMatch = html.match(/property="og:image"[^>]*content="([^"]+)"/);
    if (ogMatch) image = ogMatch[1];
    // Fallback: resource icon
    if (!image) {
      const iconMatch = html.match(/src="(https:\/\/overtake-data\.community\.forum\/resource_icons\/[^"]+)"/);
      if (iconMatch) image = iconMatch[1];
    }

    const dlMatch = html.match(/playRewardVideo\('([^']+)'\)/);
    const downloadUrl = dlMatch ? 'https://www.overtake.gg' + dlMatch[1] : modUrl + 'download';

    const countMatch = html.match(/<dt>Downloads<\/dt>\s*<dd>([\d,]+)<\/dd>/);
    const downloads = countMatch ? countMatch[1] : '';

    const ratingMatch = html.match(/ratingValue":\s*([\d.]+)/);
    const rating = ratingMatch ? parseFloat(ratingMatch[1]).toFixed(1) : '';

    return { title, desc, image, downloadUrl, url: modUrl, downloads, rating };
  }

  // Fetch all in parallel
  const results = await Promise.allSettled(
    FEATURED_URLS.map(url => fetchWithSession(url).then(html => parseMod(html, url)))
  );

  return results
    .filter(r => r.status === 'fulfilled')
    .map(r => r.value);
});

ipcMain.handle('get-my-mods', async () => {
  // Scrape the author's downloads page — same structure as Browse Overtake
  const session = mainWindow.webContents.session;

  async function fetchWithSession(url) {
    const res = await session.fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'text/html',
      }
    });
    return res.text();
  }

  const html = await fetchWithSession('https://www.overtake.gg/downloads/authors/thefir3nexus.1772538/');
  const mods = [];
  const parts = html.split(/<div class="structItem structItem--resource/);
  for (let i = 1; i < parts.length && mods.length < 3; i++) {
    const chunk = parts[i];
    if (chunk.includes('samUnitWrapper') || chunk.includes('samItem')) continue;
    const titleMatch = chunk.match(/href="(\/downloads\/[^"]+)"[^>]*data-tp-primary="on">([^<]+)<\/a>/);
    if (!titleMatch) continue;
    const url = 'https://www.overtake.gg' + titleMatch[1];
    const name = titleMatch[2].trim();
    const iconMatch = chunk.match(/class="avatar avatar--s"[^>]*>\s*<img[^>]*src="([^"]+)"/);
    const icon = iconMatch ? iconMatch[1] : '';
    const dlMatch = chunk.match(/structItem-metaItem--downloads[\s\S]{0,200}?<dd>([\d,]+)<\/dd>/);
    const downloads = dlMatch ? dlMatch[1] : '';
    const dateMatch = chunk.match(/structItem-metaItem--lastUpdate[\s\S]{0,300}?datetime="([^"]+)"/);
    const updated = dateMatch ? dateMatch[1].split('T')[0] : '';
    // Download URL
    const downloadUrl = url.replace(/\/$/, '') + '/download';
    mods.push({ name, url, icon, downloads, updated, downloadUrl });
  }
  return mods;
});

ipcMain.handle('open-repo-dir', () => shell.openPath(REPO_DIR));

ipcMain.handle('open-path', (_, filePath) => shell.openPath(filePath));

ipcMain.handle('delete-path', (_, filePath) => {
  try {
    if (!fs.existsSync(filePath)) return true;
    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) fs.rmSync(filePath, { recursive: true, force: true });
    else fs.unlinkSync(filePath);
  } catch (e) { console.log('[delete-path] error:', e.message); }
  return true;
});

ipcMain.handle('open-external', (_, url) => shell.openExternal(url));

ipcMain.handle('fetch-image', async (_, url) => {
  try {
    const session = mainWindow.webContents.session;
    const res = await session.fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' }
    });
    const buf = Buffer.from(await res.arrayBuffer());
    const ct = res.headers.get('content-type') || 'image/jpeg';
    return `data:${ct};base64,${buf.toString('base64')}`;
  } catch { return ''; }
});

ipcMain.handle('get-folder-contents', (_, folderPath) => {
  try {
    if (!fs.existsSync(folderPath)) return [];
    const entries = fs.readdirSync(folderPath, { withFileTypes: true });
    return entries.map(e => ({
      name: e.name,
      isDir: e.isDirectory(),
      path: path.join(folderPath, e.name),
      ext: e.isDirectory() ? '' : path.extname(e.name).toLowerCase(),
    })).sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
  } catch { return []; }
});

// ── Overtake login ────────────────────────────────────────────────────────────

ipcMain.handle('check-login', async () => {
  try {
    const session = mainWindow.webContents.session;
    const all = await session.cookies.get({ url: 'https://www.overtake.gg' });
    if (all.some(c => c.name === 'xf_user')) return true;
    const a = await session.cookies.get({ domain: 'overtake.gg' });
    const b = await session.cookies.get({ domain: '.overtake.gg' });
    return a.some(c => c.name === 'xf_user') || b.some(c => c.name === 'xf_user');
  } catch { return false; }
});

ipcMain.handle('login-overtake', () => {
  return new Promise((resolve) => {
    let resolved = false;
    const done = (val) => { if (!resolved) { resolved = true; resolve(val); } };

    // Allow certificate errors for Overtake (Electron 41 is stricter)
    const certHandler = (event, webContents, url, error, cert, callback) => {
      if (url.includes('overtake.gg')) { event.preventDefault(); callback(true); }
    };
    app.on('certificate-error', certHandler);

    const loginWin = new BrowserWindow({
      width: 1000,
      height: 700,
      parent: mainWindow,
      title: 'Log in to Overtake.gg',
      webPreferences: {
        nodeIntegration: false,
        contextIsolation: true,
        session: mainWindow.webContents.session,
      }
    });

    loginWin.setMenuBarVisibility(false);
    loginWin.loadURL('https://www.overtake.gg/login/');

    const isLoggedIn = async () => {
      try {
        const all = await mainWindow.webContents.session.cookies.get({ url: 'https://www.overtake.gg' });
        if (all.some(c => c.name === 'xf_user')) return true;
        const a = await mainWindow.webContents.session.cookies.get({ domain: 'overtake.gg' });
        const b = await mainWindow.webContents.session.cookies.get({ domain: '.overtake.gg' });
        return a.some(c => c.name === 'xf_user') || b.some(c => c.name === 'xf_user');
      } catch { return false; }
    };

    const cleanup = () => {
      app.removeListener('certificate-error', certHandler);
      clearInterval(checkInterval);
    };

    // Watch for navigation away from /login/
    loginWin.webContents.on('did-navigate', async (_, url) => {
      if (!url.includes('/login/') && !loginWin.isDestroyed()) {
        setTimeout(async () => {
          if (await isLoggedIn()) {
            cleanup();
            if (!loginWin.isDestroyed()) loginWin.close();
            await persistSessionCookies(mainWindow.webContents.session);
            done(true);
          }
        }, 800);
      }
    });

    // Poll as fallback
    const checkInterval = setInterval(async () => {
      if (loginWin.isDestroyed()) { cleanup(); return; }
      if (await isLoggedIn()) {
        cleanup();
        if (!loginWin.isDestroyed()) loginWin.close();
        await persistSessionCookies(mainWindow.webContents.session);
        done(true);
      }
    }, 1500);

    loginWin.on('closed', () => {
      cleanup();
      isLoggedIn().then(done);
    });
  });
});

ipcMain.handle('logout-overtake', async () => {
  const session = mainWindow.webContents.session;

  // Clear cookies for all overtake domain variants
  const domains = ['overtake.gg', '.overtake.gg', 'www.overtake.gg', 'overtake-data.community.forum'];
  for (const domain of domains) {
    const cookies = await session.cookies.get({ domain });
    await Promise.all(cookies.map(c =>
      session.cookies.remove(`https://${domain.replace(/^\./, '')}`, c.name).catch(() => {})
    ));
  }

  // Also clear by URL to catch anything missed
  const byUrl = await session.cookies.get({ url: 'https://www.overtake.gg' });
  await Promise.all(byUrl.map(c =>
    session.cookies.remove('https://www.overtake.gg', c.name).catch(() => {})
  ));

  // Clear HTTP cache
  await session.clearCache().catch(() => {});

  // Clear storage data for overtake.gg
  await session.clearStorageData({
    origin: 'https://www.overtake.gg',
    storages: ['cookies', 'localstorage', 'sessionstorage', 'indexdb', 'cachestorage']
  }).catch(() => {});

  // Remove encrypted cookie file
  clearPersistedCookies();

  return true;
});

// Overtake — XenForo site, fetch HTML directly and parse structItem elements
ipcMain.handle('check-mod-updates', async () => {
  ensureRepoDir();
  const session = mainWindow.webContents.session;
  const updates = [];

  let entries;
  try { entries = fs.readdirSync(REPO_DIR, { withFileTypes: true }); } catch { return []; }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const metaPath = path.join(REPO_DIR, entry.name, 'meta.json');
    if (!fs.existsSync(metaPath)) continue;

    let meta;
    try { meta = JSON.parse(fs.readFileSync(metaPath, 'utf8')); } catch { continue; }
    if (!meta.overtakeUrl || !meta.downloadedAt) continue;

    try {
      const res = await session.fetch(meta.overtakeUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'text/html',
        }
      });
      if (!res.ok) continue;
      const html = await res.text();

      // Parse last-update datetime and version from resource tab
      const updateMatch  = html.match(/<dt>[Ll]ast\s+[Uu]pdate<\/dt>[\s\S]{0,400}?datetime="([^"]+)"/);
      const versionMatch = html.match(/<dt>Version<\/dt>\s*<dd>\s*([^\s<][^<]*?)\s*<\/dd>/);
      const titleMatch   = html.match(/property="og:title"[^>]*content="([^"]+)"/);

      const newUpdatedAt = updateMatch  ? updateMatch[1]           : null;
      const newVersion   = versionMatch ? versionMatch[1].trim()   : null;
      const displayName  = titleMatch
        ? titleMatch[1].replace(/\s*\|\s*Overtake\.GG\s*$/i, '').trim()
        : entry.name;

      // Is there an update?
      let hasUpdate = false;
      if (newUpdatedAt && meta.overtakeUpdatedAt) {
        hasUpdate = new Date(newUpdatedAt) > new Date(meta.overtakeUpdatedAt);
      } else if (newUpdatedAt && meta.downloadedAt) {
        hasUpdate = new Date(newUpdatedAt) > new Date(meta.downloadedAt);
      } else if (newVersion && meta.overtakeVersion) {
        hasUpdate = newVersion !== meta.overtakeVersion;
      }
      if (!hasUpdate) continue;

      // Parse fresh download URL from the page
      const dlMatch    = html.match(/playRewardVideo\('([^']+)'\)/);
      const downloadUrl = dlMatch
        ? 'https://www.overtake.gg' + dlMatch[1]
        : meta.overtakeUrl.replace(/\/$/, '') + '/download';

      updates.push({
        folderName:     entry.name,
        displayName,
        currentVersion: meta.overtakeVersion || null,
        newVersion:     newVersion || null,
        downloadedAt:   meta.downloadedAt,
        newUpdatedAt,
        overtakeUrl:    meta.overtakeUrl,
        downloadUrl,
        icon:           meta.icon || '',
        type:           meta.type || 'pak',
      });
    } catch (e) {
      console.log('[check-updates]', entry.name, ':', e.message);
    }
  }

  return updates;
});

ipcMain.handle('scrape-overtake', async (_, pageNum = 1) => {
  const https = require('https');

  function fetchPage(url) {
    return new Promise((resolve, reject) => {
      const req = https.get(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.5',
        }
      }, res => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location) {
          return fetchPage(res.headers.location).then(resolve).catch(reject);
        }
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => resolve({ status: res.statusCode, body: data }));
      });
      req.on('error', reject);
      req.setTimeout(20000, () => { req.destroy(); reject(new Error('Request timed out')); });
    });
  }

  function parseModsFromHTML(html) {
    const items = [];

    // Split on each structItem--resource opening tag
    // Each mod card starts with: <div class="structItem structItem--resource
    const parts = html.split(/<div class="structItem structItem--resource/);

    for (let i = 1; i < parts.length; i++) {
      const chunk = parts[i];

      // Skip ad/SAM wrappers
      if (chunk.includes('samUnitWrapper') || chunk.includes('samItem')) continue;

      // Get author from data-author attribute
      const authorMatch = chunk.match(/data-author="([^"]*)"/);
      const author = authorMatch ? authorMatch[1] : '';

      // Get mod URL and name — look for data-tp-primary link
      const titleMatch = chunk.match(/href="(\/downloads\/[^"]+)"[^>]*data-tp-primary="on">([^<]+)<\/a>/);
      if (!titleMatch) continue;
      const url = 'https://www.overtake.gg' + titleMatch[1];
      const name = titleMatch[2].trim();
      if (!name || name.length < 2) continue;

      // Download count
      const dlMatch = chunk.match(/structItem-metaItem--downloads[\s\S]{0,200}?<dd>([\d,]+)<\/dd>/);
      const downloads = dlMatch ? dlMatch[1] : '';

      // Updated date
      const dateMatch = chunk.match(/structItem-metaItem--lastUpdate[\s\S]{0,300}?datetime="([^"]+)"/);
      const updated = dateMatch ? dateMatch[1].split('T')[0] : '';

      // Tagline
      const tagMatch = chunk.match(/structItem-resourceTagLine">([^<]+)<\/div>/);
      const desc = tagMatch ? tagMatch[1].trim() : '';

      // Mod icon — resource_icons thumbnail
      const iconMatch = chunk.match(/class="avatar avatar--s"[^>]*>\s*<img[^>]*src="([^"]+)"/);
      const icon = iconMatch ? iconMatch[1] : '';

      items.push({ name, author, downloads, updated, url, desc, icon });
    }

    return items;
  }

  const BASE = 'https://www.overtake.gg/downloads/categories/f1-manager-2024.272/';
  const url = pageNum === 1 ? BASE : `${BASE}?page=${pageNum}`;

  const { status, body } = await fetchPage(url);
  if (status !== 200) throw new Error(`HTTP ${status} fetching page ${pageNum}`);

  const mods = parseModsFromHTML(body);
  if (mods.length === 0) throw new Error('No mods found — could not parse the page. Cloudflare may be blocking the request.');

  // Detect total pages from page nav
  let totalPages = pageNum;
  const lastPageMatches = [...body.matchAll(/href="[^"]*[?&]page=(\d+)[^"]*"[^>]*>\s*(\d+)\s*<\/a>/g)];
  if (lastPageMatches.length) {
    const nums = lastPageMatches.map(m => parseInt(m[1])).filter(Boolean);
    if (nums.length) totalPages = Math.max(...nums);
  }
  // Also try the "last page" link
  const lastMatch = body.match(/pageNav-jump--last[^>]*href="[^"]*[?&]page=(\d+)/);
  if (lastMatch) totalPages = Math.max(totalPages, parseInt(lastMatch[1]));

  // Construct download URLs
  mods.forEach(mod => {
    if (mod.url) mod.downloadUrl = mod.url.replace(/\/$/, '') + '/download';
  });

  return { mods, page: pageNum, totalPages };
})

ipcMain.handle('search-overtake', async (_, query) => {
  if (!modCache) throw new Error('Cache not built yet — click "Cache all mods" first');
  const q = query.toLowerCase();
  const results = modCache.mods.filter(m =>
    m.name.toLowerCase().includes(q) ||
    (m.author || '').toLowerCase().includes(q) ||
    (m.desc || '').toLowerCase().includes(q)
  );
  console.log('[search] query:', query, '→', results.length, 'results from cache of', modCache.mods.length);
  return results;
});

ipcMain.handle('get-cache-status', () => {
  if (!modCache) return { cached: false };
  return { cached: true, count: modCache.mods.length, cachedAt: modCache.cachedAt };
});

ipcMain.handle('build-mod-cache', async (event) => {
  // If already in progress return the same promise
  if (modCacheInProgress) return modCacheInProgress;

  modCacheInProgress = (async () => {
    const https = require('https');

    function fetchPage(url) {
      return new Promise((resolve, reject) => {
        const req = https.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
            'Accept-Language': 'en-US,en;q=0.5',
          }
        }, res => {
          if ([301,302,303,307,308].includes(res.statusCode) && res.headers.location)
            return fetchPage(res.headers.location).then(resolve).catch(reject);
          let data = '';
          res.on('data', c => data += c);
          res.on('end', () => resolve({ status: res.statusCode, body: data }));
        });
        req.on('error', reject);
        req.setTimeout(20000, () => { req.destroy(); reject(new Error('Timeout')); });
      });
    }

    function parseModsFromHTML(html) {
      const items = [];
      const parts = html.split(/<div class="structItem structItem--resource/);
      for (let i = 1; i < parts.length; i++) {
        const chunk = parts[i];
        if (chunk.includes('samUnitWrapper') || chunk.includes('samItem')) continue;
        const titleMatch = chunk.match(/href="(\/downloads\/[^"]+)"[^>]*data-tp-primary="on">([^<]+)<\/a>/);
        if (!titleMatch) continue;
        const url = 'https://www.overtake.gg' + titleMatch[1];
        const name = titleMatch[2].trim();
        if (!name || name.length < 2) continue;
        const authorMatch = chunk.match(/data-author="([^"]*)"/);
        const author = authorMatch ? authorMatch[1] : '';
        const dlMatch = chunk.match(/structItem-metaItem--downloads[\s\S]{0,200}?<dd>([\d,]+)<\/dd>/);
        const downloads = dlMatch ? dlMatch[1] : '';
        const dateMatch = chunk.match(/structItem-metaItem--lastUpdate[\s\S]{0,300}?datetime="([^"]+)"/);
        const updated = dateMatch ? dateMatch[1].split('T')[0] : '';
        const tagMatch = chunk.match(/structItem-resourceTagLine">([^<]+)<\/div>/);
        const desc = tagMatch ? tagMatch[1].trim() : '';
        const iconMatch = chunk.match(/class="avatar avatar--s"[^>]*>\s*<img[^>]*src="([^"]+)"/);
        const icon = iconMatch ? iconMatch[1] : '';
        items.push({ name, author, downloads, updated, url, desc, icon, downloadUrl: url.replace(/\/$/, '') + '/download' });
      }
      return items;
    }

    const BASE = 'https://www.overtake.gg/downloads/categories/f1-manager-2024.272/';

    // Get first page to find total pages
    const { status: s1, body: b1 } = await fetchPage(BASE);
    if (s1 !== 200) throw new Error(`HTTP ${s1}`);

    let totalPages = 1;
    const lastPageMatches = [...b1.matchAll(/href="[^"]*[?&]page=(\d+)[^"]*"[^>]*>\s*(\d+)\s*<\/a>/g)];
    if (lastPageMatches.length) {
      const nums = lastPageMatches.map(m => parseInt(m[1])).filter(Boolean);
      if (nums.length) totalPages = Math.max(...nums);
    }
    const lastMatch = b1.match(/pageNav-jump--last[^>]*href="[^"]*[?&]page=(\d+)/);
    if (lastMatch) totalPages = Math.max(totalPages, parseInt(lastMatch[1]));

    console.log('[cache] total pages:', totalPages);
    const allMods = parseModsFromHTML(b1);
    event.sender.send('cache-progress', { current: 1, total: totalPages, count: allMods.length });

    // Fetch remaining pages
    for (let p = 2; p <= totalPages; p++) {
      const { status, body } = await fetchPage(`${BASE}?page=${p}`);
      if (status === 200) {
        const mods = parseModsFromHTML(body);
        allMods.push(...mods);
      }
      event.sender.send('cache-progress', { current: p, total: totalPages, count: allMods.length });
      // Small delay to be polite to the server
      await new Promise(r => setTimeout(r, 300));
    }

    modCache = { mods: allMods, cachedAt: Date.now() };
    modCacheInProgress = null;
    console.log('[cache] built:', allMods.length, 'mods');
    return { count: allMods.length, totalPages };
  })();

  return modCacheInProgress;
});

ipcMain.handle('launch-game', (_, gameDir) => {
  const exePath = path.join(gameDir, 'F1Manager24.exe');
  if (!fs.existsSync(exePath)) throw new Error('F1Manager24.exe not found in game directory');
  const { spawn } = require('child_process');
  spawn(exePath, [], { detached: true, stdio: 'ignore', cwd: gameDir }).unref();
  return true;
});

ipcMain.handle('import-mod-file', async (_, filePath) => {
  ensureRepoDir();
  const ext = path.extname(filePath).toLowerCase();
  if (!['.zip', '.rar'].includes(ext)) throw new Error('Only .zip and .rar files are supported');
  const baseName = path.basename(filePath, ext);
  const modDir = modFolderFor(baseName);
  if (!fs.existsSync(modDir)) fs.mkdirSync(modDir, { recursive: true });
  const destPath = path.join(modDir, path.basename(filePath));
  fs.copyFileSync(filePath, destPath);
  const type = await classifyArchive(destPath);
  const metaPath = path.join(modDir, 'meta.json');
  fs.writeFileSync(metaPath, JSON.stringify({ type }));
  return { name: baseName, type };
});
