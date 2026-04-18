// ── State ─────────────────────────────────────────────────────────────────────
const State = {
  gameDir: '',
  repoMods: [],
  installedPak: [],
  installedLua: [],
};

// Escape for safe use inside onclick='...' single-quoted attributes.
function safeAttr(s) { return String(s).replace(/\\/g, '\\\\').replace(/'/g, "\\'"); }

// ── Toast ─────────────────────────────────────────────────────────────────────
function toast(msg, type = '', dur = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.className = 'toast show' + (type ? ' ' + type : '');
  clearTimeout(el._t);
  el._t = setTimeout(() => el.classList.remove('show'), dur);
}

// ── Navigation ────────────────────────────────────────────────────────────────
document.querySelectorAll('.nav-btn').forEach(btn => {
  btn.addEventListener('click', () => {
    const page = btn.dataset.page;
    document.querySelectorAll('.nav-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById('page-' + page).classList.add('active');
    if (page === 'home') Home.load();
    if (page === 'browse') Browse.checkCacheStatus();
  });
});

// ── App ───────────────────────────────────────────────────────────────────────
const App = {
  async init() {
    const settings = await window.api.loadSettings();
    if (settings.gameDir) {
      State.gameDir = settings.gameDir;
      document.getElementById('game-dir-input').value = settings.gameDir;
      this.updateDirUI(settings.gameDir);
    }
    // Load repo dir
    const repoDir = await window.api.getRepoDir();
    document.getElementById('repo-dir-input').value = repoDir;
    const repoLabel = document.getElementById('derived-repo');
    if (repoLabel) repoLabel.textContent = repoDir;
    await this.checkLoginStatus();
    await this.refresh();
    Home.load();
    // Show first-run prompt if no game dir set
    if (!settings.gameDir) Setup.show();
  },

  async checkLoginStatus() {
    const loggedIn = await window.api.checkLogin();
    this.updateLoginUI(loggedIn);
  },

  updateStatusBar() {
    const pakCount = State.installedPak ? State.installedPak.length : 0;
    const luaCount = State.installedLua ? State.installedLua.length : 0;
    const gameDir = document.getElementById('status-game-dir');
    const pakEl = document.getElementById('status-pak-count');
    const luaEl = document.getElementById('status-lua-count');
    if (gameDir) gameDir.textContent = State.gameDir ? `📁 ${State.gameDir.split('\\').pop()}` : 'No game directory';
    if (pakEl) pakEl.textContent = `${pakCount} PAK installed`;
    if (luaEl) luaEl.textContent = `${luaCount} Lua installed`;
    // Update panel counts
    const repoPak = State.repoMods ? State.repoMods.filter(m => m.type === 'pak') : [];
    const repoLua = State.repoMods ? State.repoMods.filter(m => m.type === 'lua') : [];
    const rpc = document.getElementById('repo-pak-count');
    const rlc = document.getElementById('repo-lua-count');
    const ipc = document.getElementById('installed-pak-count');
    const ilc = document.getElementById('installed-lua-count');
    if (rpc) rpc.textContent = repoPak.length ? `(${repoPak.length})` : '';
    if (rlc) rlc.textContent = repoLua.length ? `(${repoLua.length})` : '';
    if (ipc) ipc.textContent = pakCount ? `(${pakCount})` : '';
    if (ilc) ilc.textContent = luaCount ? `(${luaCount})` : '';
  },

  updateLoginUI(loggedIn) {
    const badge = document.getElementById('login-status');
    const loginBtn = document.getElementById('login-btn');
    const logoutBtn = document.getElementById('logout-btn');
    const hint = document.getElementById('login-hint');
    const statusLogin = document.getElementById('status-login');
    if (loggedIn) {
      badge.textContent = '✓ Logged in to Overtake.gg';
      badge.className = 'login-status-badge ok';
      loginBtn.style.display = 'none';
      logoutBtn.style.display = '';
      hint.textContent = 'You can now download mods directly from the Browse page.';
      hint.style.color = 'var(--green)';
      if (statusLogin) statusLogin.textContent = '✓ Overtake logged in';
    } else {
      badge.textContent = 'Not logged in';
      badge.className = 'login-status-badge';
      loginBtn.style.display = '';
      logoutBtn.style.display = 'none';
      hint.textContent = 'A browser window will open — sign in, then close the window to continue.';
      hint.style.color = 'var(--hint)';
      if (statusLogin) statusLogin.textContent = 'Not logged in to Overtake';
    }
  },

  async loginOvertake() {
    const btn = document.getElementById('login-btn');
    btn.disabled = true;
    btn.textContent = 'Opening...';
    const loggedIn = await window.api.loginOvertake();
    btn.disabled = false;
    btn.textContent = 'Log in to Overtake.gg';
    this.updateLoginUI(loggedIn);
    if (loggedIn) toast('Logged in to Overtake.gg!', 'ok');
    else toast('Login cancelled or failed.', '');
  },

  async logoutOvertake() {
    await window.api.logoutOvertake();
    this.updateLoginUI(false);
    toast('Logged out of Overtake.gg.', '');
  },

  updateDirUI(dir) {
    const pak = dir + '\\F1Manager24\\Content\\Paks';
    const lua = dir + '\\F1Manager24\\Binaries\\Win64\\ue4ss\\Mods';
    document.getElementById('pak-path-sub').textContent = pak;
    document.getElementById('lua-path-sub').textContent = lua;
    document.getElementById('pak-dir-hint').textContent = pak;
    document.getElementById('lua-dir-hint').textContent = lua;
    document.getElementById('derived-pak').textContent = pak;
    document.getElementById('derived-lua').textContent = lua;
    const badge = document.getElementById('dir-status');
    const name = dir.split('\\').pop() || dir;
    badge.textContent = '✓ ' + name;
    badge.className = 'dir-status-badge ok';
    this.updateStatusBar();
  },

  async browseDir() {
    const dir = await window.api.browseDir();
    if (!dir) return;
    const valid = await window.api.validateGameDir(dir);
    if (!valid) {
      toast('F1Manager24.exe not found in that folder. Please select the correct game directory.', 'err');
      return;
    }
    document.getElementById('game-dir-input').value = dir;
  },

  async saveDir() {
    const dir = document.getElementById('game-dir-input').value.trim();
    if (!dir) { toast('Enter a game directory.', 'err'); return; }
    const valid = await window.api.validateGameDir(dir);
    if (!valid) {
      toast('F1Manager24.exe not found in that folder. Please select the correct game directory.', 'err');
      return;
    }
    State.gameDir = dir;
    await window.api.saveSetting('gameDir', dir);
    this.updateDirUI(dir);
    const fb = document.getElementById('dir-feedback');
    fb.textContent = '✓ Saved';
    fb.className = 'feedback ok';
    setTimeout(() => { fb.textContent = ''; }, 2500);
    await this.refresh();
    toast('Game directory saved.', 'ok');
  },

  async browseRepoDir() {
    const dir = await window.api.browseRepoDir();
    if (dir) document.getElementById('repo-dir-input').value = dir;
  },

  async saveRepoDir() {
    const dir = document.getElementById('repo-dir-input').value.trim();
    if (!dir) { toast('Enter a repository directory.', 'err'); return; }
    const ok = await window.api.setRepoDir(dir);
    if (!ok) { toast('Directory not found — please create it first.', 'err'); return; }
    const repoLabel = document.getElementById('derived-repo');
    if (repoLabel) repoLabel.textContent = dir;
    const fb = document.getElementById('repo-dir-feedback');
    fb.textContent = '✓ Saved';
    fb.className = 'feedback ok';
    setTimeout(() => { fb.textContent = ''; }, 2500);
    await this.refresh();
    toast('Repository location saved.', 'ok');
  },

  async downloadZip(url, icon = '') {
    try {
      const mod = await window.api.downloadZip(url, icon);
      await this.refresh();
      toast(`Downloaded ${mod.name} (${mod.type.toUpperCase()})`, 'ok');
      return mod;
    } catch (e) {
      toast('Download failed: ' + e.message, 'err');
      throw e;
    }
  },

  async refresh() {
    State.repoMods = await window.api.getRepoMods();
    if (State.gameDir) {
      State.installedPak = await window.api.getInstalledPak(State.gameDir);
      State.installedLua = await window.api.getInstalledLua(State.gameDir);
    }
    Render.pakPage();
    Render.luaPage();
    this.updateStatusBar();
  },

  // Refresh only state + repo lists, without touching open installed trees
  async refreshRepoOnly() {
    State.repoMods = await window.api.getRepoMods();
    if (State.gameDir) {
      State.installedPak = await window.api.getInstalledPak(State.gameDir);
      State.installedLua = await window.api.getInstalledLua(State.gameDir);
    }
    const pakMods = State.repoMods.filter(m => m.type === 'pak');
    const luaMods = State.repoMods.filter(m => m.type === 'lua');
    Render._renderRepo('repo-pak-list', pakMods, 'pak');
    Render._renderRepo('repo-lua-list', luaMods, 'lua');
    Render._renderInstalledPak();
    Render._renderInstalledLua();
  },

  // Like refreshRepoOnly but does NOT re-render installed panels (keeps open trees intact)
  async _refreshRepoAndInstalledState() {
    State.repoMods = await window.api.getRepoMods();
    if (State.gameDir) {
      State.installedPak = await window.api.getInstalledPak(State.gameDir);
      State.installedLua = await window.api.getInstalledLua(State.gameDir);
    }
    const pakMods = State.repoMods.filter(m => m.type === 'pak');
    const luaMods = State.repoMods.filter(m => m.type === 'lua');
    Render._renderRepo('repo-pak-list', pakMods, 'pak');
    Render._renderRepo('repo-lua-list', luaMods, 'lua');
  },

  async installMod(modName, type) {
    if (!State.gameDir) { toast('Set game directory first.', 'err'); return; }
    if (type === 'lua') {
      const ue4ssOk = await UE4SSModal.check(modName, type);
      if (ue4ssOk) await this._doLuaInstall(modName);
    } else {
      const installed = await InstallModal.open(modName, type);
      if (installed) this._flashInstallBtn(modName);
    }
  },

  async _doLuaInstall(modName) {
    let success = false;
    try {
      await window.api.installMod(modName, State.gameDir, 'lua');
      success = true;
      toast(`Installed ${modName}`, 'ok');
      this._flashInstallBtn(modName);
    } catch (e) {
      toast('Install failed: ' + e.message, 'err');
    } finally {
      // Refresh installed list regardless — ensures UI always matches disk
      await this.refresh();
    }
  },

  _flashInstallBtn(modName) {
    const id = 'install-btn-' + modName.replace(/[^a-z0-9]/gi, '_');
    const btn = document.getElementById(id);
    if (!btn) return;
    btn.textContent = '✓ Installed';
    btn.disabled = true;
    btn.style.opacity = '0.6';
    setTimeout(() => {
      btn.textContent = 'Install';
      btn.disabled = false;
      btn.style.opacity = '';
    }, 3000);
  },

  async deleteInstalledPak(name) {
    if (!State.gameDir) return;
    const ok = await ConfirmModal.ask(`Remove installed PAK mod?`, name);
    if (!ok) return;
    try {
      await window.api.deleteInstalledPak(name, State.gameDir);
      toast(`Removed ${name}`, '');
    } catch (e) {
      toast('Delete failed: ' + e.message, 'err');
    } finally {
      await this.refresh();
    }
  },

  async deleteInstalledLua(name) {
    if (!State.gameDir) return;
    try {
      await window.api.deleteInstalledLua(name, State.gameDir);
      toast(`Removed ${name}`, '');
    } catch (e) {
      toast('Delete failed: ' + e.message, 'err');
    } finally {
      // Always refresh — list must reflect actual disk state even after errors
      await this.refresh();
    }
  },

  async checkForUpdates() {
    try {
      const updates = await window.api.checkModUpdates();
      if (updates.length > 0) UpdatesModal.show(updates);
    } catch (e) {
      console.log('[update check]', e.message);
    }
  },

  async launchGame() {
    if (!State.gameDir) { toast('Set game directory first.', 'err'); return; }
    const btn = document.getElementById('launch-game-btn');
    if (btn) { btn.disabled = true; btn.textContent = '▶ Launching...'; }
    try {
      await window.api.launchGame(State.gameDir);
      toast('Launching F1 Manager 2024…', 'ok');
    } catch (e) {
      toast('Launch failed: ' + e.message, 'err');
    } finally {
      setTimeout(() => {
        if (btn) { btn.disabled = false; btn.textContent = '▶ Launch Game'; }
      }, 2000);
    }
  },

  async deleteRepoMod(zip) {
    const ok = await ConfirmModal.ask('Remove mod from repository?', zip);
    if (!ok) return;
    try {
      await window.api.deleteRepoMod(zip);
      await this.refresh();
      toast('Removed from repository.', '');
    } catch (e) {
      toast('Delete failed: ' + e.message, 'err');
    }
  },
};

// ── Render ────────────────────────────────────────────────────────────────────
const Render = {
  pakPage() {
    const pakMods = State.repoMods.filter(m => m.type === 'pak');
    this._renderRepo('repo-pak-list', pakMods, 'pak');
    this._renderInstalledPak();
  },

  luaPage() {
    const luaMods = State.repoMods.filter(m => m.type === 'lua');
    this._renderRepo('repo-lua-list', luaMods, 'lua');
    this._renderInstalledLua();
  },

  _renderRepo(elId, mods, type) {
    const el = document.getElementById(elId);
    if (!mods.length) {
      el.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-icon" style="font-size:18px">◎</div><div>No ' + type.toUpperCase() + ' mods in repository</div></div>';
      return;
    }
    // Store names in a per-list lookup so onclicks never embed the name string
    const key = '_repo_' + elId;
    Render[key] = mods.map(m => m.name);

    el.innerHTML = mods.map((m, i) => {
      const isInstalled = type === 'pak'
        ? State.installedPak.includes(m.name)
        : State.installedLua.includes(m.name);
      const isRar = m.zip && m.zip.toLowerCase().endsWith('.rar');
      const extTag = isRar ? '<span class="tag" style="background:rgba(212,130,10,0.15);color:#e8a240;font-size:10px">RAR</span>' : '';
      const iconHtml = m.icon
        ? `<img src="${m.icon}" style="width:32px;height:32px;border-radius:4px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'" />`
        : '';
      return `<div class="mod-card">
        ${iconHtml}
        <div style="flex:1;min-width:0">
          <div class="mod-card-name" title="${m.zip}">${m.name}</div>
        </div>
        ${extTag}
        <span class="tag tag-${type}">${type.toUpperCase()}</span>
        ${isInstalled ? '<span class="tag tag-installed">installed</span>' : ''}
        <div class="mod-actions">
          <button class="btn-ghost" id="install-btn-${m.name.replace(/[^a-z0-9]/gi,'_')}" onclick="App.installMod(Render['${key}'][${i}],'${type}')">Install</button>
          <button class="btn-danger" title="Remove from repository" onclick="App.deleteRepoMod(Render['${key}'][${i}])">✕</button>
        </div>
      </div>`;
    }).join('');
  },

  _renderInstalledPak() {
    const el = document.getElementById('installed-pak-list');
    if (!State.gameDir) { el.innerHTML = '<div class="empty-state" style="padding:20px"><div>Set game directory in Settings</div></div>'; return; }
    if (!State.installedPak.length) { el.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-icon" style="font-size:18px">◎</div><div>No PAK mods installed</div></div>'; return; }

    // Store names + paths by index — no mod name ever appears in an onclick string
    Render._pakNames   = [];
    Render._pakFolders = [];

    el.innerHTML = State.installedPak.map((name, i) => {
      Render._pakNames.push(name);
      Render._pakFolders.push(`${State.gameDir}\\F1Manager24\\Content\\Paks\\${name}`);
      return `<div class="mod-card-wrap" id="installed-pak-${CSS.escape(name)}">
        <div class="mod-card">
          <div style="flex:1;min-width:0">
            <div class="mod-card-name">${name}</div>
          </div>
          <span class="tag tag-pak">PAK</span>
          <button class="btn-ghost" onclick="Render.toggleInstalledFolder(Render._pakFolders[${i}],'installed-pak-${i}-files')" title="Browse files">📁</button>
          <button class="btn-danger" onclick="App.deleteInstalledPak(Render._pakNames[${i}])">Delete</button>
        </div>
        <div class="folder-tree" id="installed-pak-${i}-files" style="display:none"></div>
      </div>`;
    }).join('');
  },

  _renderInstalledLua() {
    const el = document.getElementById('installed-lua-list');
    if (!State.gameDir) { el.innerHTML = '<div class="empty-state" style="padding:20px"><div>Set game directory in Settings</div></div>'; return; }
    if (!State.installedLua.length) { el.innerHTML = '<div class="empty-state" style="padding:20px"><div class="empty-icon" style="font-size:18px">◎</div><div>No Lua mods installed</div></div>'; return; }

    // Store names by index — no mod name ever in an onclick string
    Render._luaNames = [];

    el.innerHTML = State.installedLua.map((name, i) => {
      Render._luaNames.push(name);
      return `<div class="mod-card">
        <div style="flex:1;min-width:0">
          <div class="mod-card-name">📁 ${name}</div>
        </div>
        <span class="tag tag-lua">LUA</span>
        <button class="btn-danger" onclick="App.deleteInstalledLua(Render._luaNames[${i}])">Delete</button>
      </div>`;
    }).join('');
  },

  async toggleInstalledFolder(folderPath, treeId) {
    const tree = document.getElementById(treeId);
    if (!tree) return;
    if (tree.style.display !== 'none') { tree.style.display = 'none'; return; }
    tree.style.display = 'block';
    tree.innerHTML = '<div style="padding:6px 12px;color:var(--muted);font-size:11px">Loading...</div>';
    tree.innerHTML = await this._buildTree(folderPath, 0);
  },

  async _buildTree(folderPath, depth) {
    const allFiles = await this._collectAllFiles(folderPath);
    if (!allFiles.length) return `<div class="tree-empty">Empty folder</div>`;

    const pakGroups = {};
    const others = [];
    for (const e of allFiles) {
      if (['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap'].includes(e.ext)) {
        const base = e.name.slice(0, e.name.lastIndexOf('.'));
        if (!pakGroups[base]) pakGroups[base] = { base, paths: [] };
        pakGroups[base].paths.push(e.path);
      } else {
        others.push(e);
      }
    }

    const indent = 12;
    let html = '';

    for (const [base, group] of Object.entries(pakGroups)) {
      const safePaths = JSON.stringify(group.paths).replace(/'/g, "\'");
      html += `<div class="tree-row" style="padding-left:${indent}px">
        <span class="tree-name">📦 ${base}</span>
        <button class="btn-danger tree-del" onclick="Render._deletePakGroup(${safePaths.replace(/"/g,"'")})" title="Delete">✕</button>
      </div>`;
    }

    for (const e of others) {
      const safePath = e.path.replace(/\\/g, '\\\\').replace(/'/g, "\\'");
      const icon = this._fileIcon(e.ext);
      html += `<div class="tree-row" style="padding-left:${indent}px">
        <span class="tree-name tree-file" onclick="window.api.openPath('${safePath}')" title="${e.path}">${icon} ${e.name}</span>
        <button class="btn-danger tree-del" onclick="Render._deleteEntry('${safePath}',false)" title="Delete">✕</button>
      </div>`;
    }

    return html;
  },

  async _collectAllFiles(folderPath) {
    const entries = await window.api.getFolderContents(folderPath);
    const files = [];
    for (const e of entries) {
      if (e.isDir) {
        const sub = await this._collectAllFiles(e.path);
        files.push(...sub);
      } else {
        files.push(e);
      }
    }
    return files;
  },

  async _deletePakGroup(paths) {
    if (!Array.isArray(paths)) paths = [paths];
    const label = paths.length ? paths[0].split('\\').pop().split('/').pop() : 'these files';
    // Capture row/tree NOW — event.target becomes stale after any await
    const row  = event.target.closest('.tree-row');
    const tree = row?.closest('.folder-tree');
    const ok = await ConfirmModal.ask('Delete file?', label);
    if (!ok) return;
    for (const p of paths) await window.api.deletePath(p);
    if (row) row.remove();
    // If no more rows remain in this tree, remove the parent installed entry
    if (tree && tree.querySelectorAll('.tree-row').length === 0) {
      await this._removeEmptyInstalledEntry(tree);
      // Folder gone — do a full refresh to remove it from the installed list
      await App.refresh();
    } else {
      // Files still remain — just update counts without collapsing the open tree
      if (State.gameDir) {
        State.installedPak = await window.api.getInstalledPak(State.gameDir);
        State.installedLua = await window.api.getInstalledLua(State.gameDir);
      }
      App.updateStatusBar();
    }
    toast('Deleted.', '');
  },

  async _deleteEntry(entryPath, isDir) {
    const label = entryPath.split('\\').pop().split('/').pop();
    // Capture row/tree NOW — event.target becomes stale after any await
    const row  = event.target.closest('.tree-row');
    const tree = row?.closest('.folder-tree');
    const ok = await ConfirmModal.ask('Delete file?', label);
    if (!ok) return;
    await window.api.deletePath(entryPath);
    if (row) row.remove();
    // If no more rows remain in this tree, remove the parent installed entry
    if (tree && tree.querySelectorAll('.tree-row').length === 0) {
      await this._removeEmptyInstalledEntry(tree);
      await App.refresh();
    } else {
      if (State.gameDir) {
        State.installedPak = await window.api.getInstalledPak(State.gameDir);
        State.installedLua = await window.api.getInstalledLua(State.gameDir);
      }
      App.updateStatusBar();
    }
    toast('Deleted.', '');
  },

  async _removeEmptyInstalledEntry(tree) {
    const modCardWrap = tree.closest('.mod-card-wrap');
    if (!modCardWrap) return;
    // Derive index from the tree's ID (installed-pak-{i}-files)
    const idxMatch = tree.id && tree.id.match(/installed-pak-(\d+)-files/);
    if (idxMatch) {
      const folderPath = Render._pakFolders[parseInt(idxMatch[1])];
      if (folderPath) {
        try { await window.api.deletePath(folderPath); } catch (_) {}
      }
    }
    modCardWrap.remove();
  },



  _fileIcon(ext) {
    if (['.pak','.ucas','.utoc','.ubulk','.uexp','.umap'].includes(ext)) return '📦';
    if (ext === '.lua') return '📜';
    if (['.json','.ini','.cfg','.txt','.toml'].includes(ext)) return '📄';
    if (['.png','.jpg','.jpeg','.webp','.dds'].includes(ext)) return '🖼️';
    return '📎';
  },
};

// ── Browse / Overtake ─────────────────────────────────────────────────────────
const Browse = {
  mods: [],
  activeFilter: 'all',
  saved: new Set(),
  currentPage: 1,
  totalPages: 1,

  async loadCurrentPage() {
    const btn = document.getElementById('scrape-btn');
    btn.disabled = true;
    btn.textContent = 'Loading...';
    document.getElementById('browse-list').innerHTML =
      `<div class="loading-row"><div class="spinner"></div>Fetching page ${this.currentPage}...</div>`;
    try {
      const result = await window.api.scrapeOvertake(this.currentPage);
      this.mods = result.mods.map((m, i) => ({ ...m, id: i, type: this._guessType(m.name, m.url, m.desc) }));
      this.totalPages = result.totalPages;
      this._updatePagination();
      this.render();
      document.getElementById('browse-page-sub').textContent =
        `Page ${this.currentPage} of ${this.totalPages} — ~20 mods per page`;
      toast(`Loaded page ${this.currentPage} of ${this.totalPages}`, 'ok');
      // Kick off background cache build — force rebuild on manual refresh
      this._buildCacheBackground(this.currentPage === 1);
    } catch (e) {
      document.getElementById('browse-list').innerHTML =
        `<div class="empty-state">
          <div class="empty-icon">✕</div>
          <div style="margin-bottom:8px">${e.message}</div>
          <button class="btn-outline" onclick="window.api.openExternal('https://www.overtake.gg/downloads/categories/f1-manager-2024.272/')">Open in browser ↗</button>
        </div>`;
      toast('Failed: ' + e.message, 'err');
    } finally {
      btn.disabled = false;
      btn.textContent = 'Refresh';
    }
  },

  _buildCacheBackground(force = false) {
    const status = document.getElementById('cache-status');
    // Don't rebuild if already cached this session unless forced (refresh)
    if (!force && status.textContent && status.textContent.includes('✓')) return;
    status.textContent = 'Caching all mods...';
    window.api.onCacheProgress(({ current, total }) => {
      status.textContent = `Caching ${current}/${total} pages…`;
    });
    window.api.buildModCache().then(result => {
      status.textContent = `✓ ${result.count} mods cached — search ready`;
    }).catch(() => {
      status.textContent = '';
    });
  },

  _updatePagination() {
    const pag = document.getElementById('browse-pagination');
    const input = document.getElementById('page-input');
    const label = document.getElementById('page-total-label');
    const prevBtn = document.getElementById('btn-prev-page');
    const nextBtn = document.getElementById('btn-next-page');
    pag.style.display = 'flex';
    input.value = this.currentPage;
    input.max = this.totalPages;
    label.textContent = `of ${this.totalPages}`;
    prevBtn.disabled = this.currentPage <= 1;
    nextBtn.disabled = this.currentPage >= this.totalPages;
  },

  prevPage() {
    if (this.currentPage > 1) {
      this.currentPage--;
      this.loadCurrentPage();
    }
  },

  nextPage() {
    if (this.currentPage < this.totalPages) {
      this.currentPage++;
      this.loadCurrentPage();
    }
  },

  jumpToPage(val) {
    const p = Math.max(1, Math.min(this.totalPages, parseInt(val) || 1));
    this.currentPage = p;
    this.loadCurrentPage();
  },

  _guessType(name, url, desc) {
    const t = (name + ' ' + (url || '') + ' ' + (desc || '')).toLowerCase();
    if (t.includes('lua') || t.includes('ue4ss') || t.includes('script')) return 'lua';
    if (t.includes('pak') || t.includes('livery') || t.includes('skin') ||
        t.includes('sponsor') || t.includes('helmet') || t.includes('sound') ||
        t.includes('database') || t.includes('asset') || t.includes('texture') ||
        t.includes('team') || t.includes('driver') || t.includes('car ')) return 'pak';
    return 'unknown';
  },

  setFilter(f, el) {
    this.activeFilter = f;
    document.querySelectorAll('.chip').forEach(c => c.classList.remove('active'));
    el.classList.add('active');
    if (this._searchMode) { this._searchPage = 1; this._renderSearchPage(); }
    else this.render();
  },

  // Search state
  _searchResults: [],   // all results when in search mode
  _searchMode: false,
  _searchPage: 1,
  _searchTotalPages: 1,
  PAGE_SIZE: 20,

  onSearchInput() {
    const q = document.getElementById('browse-search').value;
    document.getElementById('browse-search-clear').style.display = q ? '' : 'none';
    // If user clears the input, auto-reset to browse mode
    if (!q && this._searchMode) this.clearSearch();
  },

  async checkCacheStatus() {
    const status = document.getElementById('cache-status');
    const btn = document.getElementById('cache-btn');
    if (!status || !btn) return;
    const s = await window.api.getCacheStatus();
    if (s.cached) {
      const age = Math.round((Date.now() - s.cachedAt) / 60000);
      status.textContent = `✓ ${s.count} mods cached (${age < 1 ? 'just now' : age + 'm ago'})`;
      btn.textContent = 'Refresh cache';
    }
  },

  async searchByName() {
    const query = document.getElementById('browse-search').value.trim();
    if (!query) return;
    const list = document.getElementById('browse-list');
    list.innerHTML = '<div class="loading-row"><div class="spinner"></div>Searching...</div>';
    document.getElementById('browse-pagination').style.display = 'none';
    document.getElementById('browse-search-clear').style.display = '';
    try {
      const results = await window.api.searchOvertake(query);
      if (!results.length) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><div>No mods found for "<strong>${query}</strong>"</div></div>`;
        return;
      }
      this._searchMode = true;
      this._searchResults = results.map((m, i) => ({ ...m, id: i, type: this._guessType(m.name, m.url, m.desc) }));
      this._searchPage = 1;
      this._searchTotalPages = Math.ceil(this._searchResults.length / this.PAGE_SIZE);
      document.getElementById('browse-page-sub').textContent = `${results.length} result(s) for "${query}"`;
      this._renderSearchPage();
    } catch (e) {
      if (e.message.includes('Cache not built')) {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><div>Click <strong>Cache all mods</strong> first to enable search</div></div>`;
      } else {
        list.innerHTML = `<div class="empty-state"><div class="empty-icon">✕</div><div>Search failed: ${e.message}</div></div>`;
      }
    }
  },

  _renderSearchPage() {
    const filtered = this.activeFilter === 'all'
      ? this._searchResults
      : this._searchResults.filter(m => m.type === this.activeFilter);
    this._searchTotalPages = Math.max(1, Math.ceil(filtered.length / this.PAGE_SIZE));
    if (this._searchPage > this._searchTotalPages) this._searchPage = 1;
    const start = (this._searchPage - 1) * this.PAGE_SIZE;
    const page = filtered.slice(start, start + this.PAGE_SIZE);
    this.mods = page;
    // Update pagination to reflect search results
    const pag = document.getElementById('browse-pagination');
    if (this._searchTotalPages > 1) {
      pag.style.display = 'flex';
      const input = document.getElementById('page-input');
      const label = document.getElementById('page-total-label');
      input.value = this._searchPage;
      input.max = this._searchTotalPages;
      label.textContent = `of ${this._searchTotalPages}`;
      document.getElementById('btn-prev-page').disabled = this._searchPage <= 1;
      document.getElementById('btn-next-page').disabled = this._searchPage >= this._searchTotalPages;
    } else {
      pag.style.display = 'none';
    }
    this.render();
  },

  clearSearch() {
    document.getElementById('browse-search').value = '';
    document.getElementById('browse-search-clear').style.display = 'none';
    this._searchMode = false;
    this._searchResults = [];
    this._searchPage = 1;
    // If we had a page loaded before, reload it — otherwise show default empty state
    if (this.totalPages > 1 || this.mods.length) {
      this.loadCurrentPage();
    } else {
      this.mods = [];
      document.getElementById('browse-list').innerHTML =
        '<div class="empty-state"><div class="empty-icon">◎</div><div>Click <strong>Load mods</strong> to browse or search by name above</div></div>';
      document.getElementById('browse-page-sub').textContent = 'F1 Manager 2024 mod directory';
      document.getElementById('browse-pagination').style.display = 'none';
    }
  },

  prevPage() {
    if (this._searchMode) {
      if (this._searchPage > 1) { this._searchPage--; this._renderSearchPage(); }
    } else {
      if (this.currentPage > 1) { this.currentPage--; this.loadCurrentPage(); }
    }
  },

  nextPage() {
    if (this._searchMode) {
      if (this._searchPage < this._searchTotalPages) { this._searchPage++; this._renderSearchPage(); }
    } else {
      if (this.currentPage < this.totalPages) { this.currentPage++; this.loadCurrentPage(); }
    }
  },

  jumpToPage(val) {
    if (this._searchMode) {
      const p = Math.max(1, Math.min(this._searchTotalPages, parseInt(val) || 1));
      this._searchPage = p;
      this._renderSearchPage();
    } else {
      const p = Math.max(1, Math.min(this.totalPages, parseInt(val) || 1));
      this.currentPage = p;
      this.loadCurrentPage();
    }
  },

  render() {
    let mods = this.mods;
    if (this.activeFilter !== 'all' && !this._searchMode) {
      mods = mods.filter(m => m.type === this.activeFilter);
    }

    if (!mods.length) {
      document.getElementById('browse-list').innerHTML =
        '<div class="empty-state"><div class="empty-icon">◎</div><div>No mods match your filter</div></div>';
      return;
    }

    document.getElementById('browse-list').innerHTML = mods.map(m => {
      const isSaved = this.saved.has(m.id);
      const typeLabel = m.type === 'pak' ? 'PAK' : m.type === 'lua' ? 'LUA' : '?';
      const typeClass = m.type === 'pak' ? 'tag-pak' : m.type === 'lua' ? 'tag-lua' : 'tag-unknown';
      const iconHtml = m.icon
        ? `<img src="${m.icon}" style="width:40px;height:40px;border-radius:6px;object-fit:cover;flex-shrink:0;" onerror="this.style.display='none'" />`
        : `<div style="width:40px;height:40px;border-radius:6px;background:var(--bg3);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px;color:var(--hint);">◎</div>`;
      return `<div class="browse-card">
        ${iconHtml}
        <div class="browse-info">
          <div class="browse-name">${m.name}</div>
          <div class="browse-meta">
            ${m.author ? `<span>by ${m.author}</span>` : ''}
            ${m.downloads ? `<span>${m.downloads} downloads</span>` : ''}
            ${m.updated ? `<span>Updated ${m.updated}</span>` : ''}
          </div>
          ${m.desc ? `<div class="browse-desc">${m.desc}</div>` : ''}
        </div>
        <div class="browse-actions">
          <span class="tag ${typeClass}">${typeLabel}</span>
          ${m.url ? `<button class="link-btn" onclick="window.api.openExternal('${m.url}')">View ↗</button>` : ''}
          ${isSaved
            ? `<span class="tag tag-installed">✓ Saved</span>`
            : `<button class="btn-ghost" id="dl-btn-${m.id}" onclick="Browse.downloadMod(${m.id})">↓ Download</button>`
          }
        </div>
      </div>`;
    }).join('');
  },

  async downloadMod(id) {
    const mod = this.mods.find(m => m.id === id);
    if (!mod) return;
    if (!mod.downloadUrl) {
      toast('No download URL for this mod.', 'err');
      return;
    }

    const btn = document.getElementById(`dl-btn-${id}`);
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Opening...';
    }

    try {
      toast(`Opening "${mod.name}" — a window will open, the download starts automatically`, '', 6000);
      const result = await window.api.downloadZip(mod.downloadUrl, mod.icon || '', mod.name || '', mod.url || '');
      this.saved.add(id);
      this.render();
      await App.refresh();
      toast(`✓ Downloaded "${result.name}" (${result.type.toUpperCase()})`, 'ok', 3000);
      // Reset the saved state after 3s so the button reappears
      setTimeout(() => { this.saved.delete(id); this.render(); }, 3000);
    } catch (e) {
      if (btn) {
        btn.disabled = false;
        btn.textContent = '↓ Download';
      }
      if (e.message && e.message.includes('Not logged in')) {
        toast('Please log in to Overtake.gg in Settings first.', 'err', 4000);
      } else {
        toast('Download failed: ' + e.message, 'err', 4000);
      }
    }
  },
};
const _browseFilterFn = () => Browse.render();
document.addEventListener('DOMContentLoaded', () => {
  const si = document.getElementById('browse-search');
  if (si) si.oninput = _browseFilterFn;
});

// ── Install Modal ─────────────────────────────────────────────────────────────
// ── UE4SS Install Prompt ──────────────────────────────────────────────────────
const UE4SSModal = {
  _modName: null,
  _targetType: null,

  async check(modName, targetType) {
    this._modName = modName;
    this._targetType = targetType;
    const ue4ssInstalled = await window.api.checkUe4ss(State.gameDir);
    if (!ue4ssInstalled) {
      document.getElementById('ue4ss-modal').style.display = 'flex';
      return false; // caller should wait
    }
    return true; // UE4SS present, proceed with normal install
  },

  hide() {
    document.getElementById('ue4ss-modal').style.display = 'none';
    // Reset progress UI for next use
    const btns = document.getElementById('ue4ss-modal-btns');
    const wrap = document.getElementById('ue4ss-progress-wrap');
    const bar  = document.getElementById('ue4ss-progress-bar');
    if (btns) btns.style.display = '';
    if (wrap) wrap.style.display = 'none';
    if (bar)  bar.style.width = '0%';
  },

  async skip() {
    this.hide();
    await App._doLuaInstall(this._modName);
  },

  async installBoth() {
    // Show progress bar, hide buttons
    const btns = document.getElementById('ue4ss-modal-btns');
    const wrap = document.getElementById('ue4ss-progress-wrap');
    if (btns) btns.style.display = 'none';
    if (wrap) wrap.style.display = '';

    const bar    = document.getElementById('ue4ss-progress-bar');
    const status = document.getElementById('ue4ss-progress-status');
    const file   = document.getElementById('ue4ss-progress-file');

    window.api.onUe4ssProgress(({ status: s, done, total, file: f }) => {
      if (status) status.textContent = s || 'Installing…';
      if (bar && total > 0) bar.style.width = Math.round(done / total * 100) + '%';
      if (file) file.textContent = f || '';
    });

    try {
      await window.api.installUe4ss(State.gameDir, this._modName);
      toast('UE4SS installed ✓', 'ok');
    } catch (e) {
      toast('UE4SS install failed: ' + e.message, 'err');
    } finally {
      window.api.offUe4ssProgress();
      this.hide();
    }
    await App._doLuaInstall(this._modName);
    await App.refresh();
  },
};

const InstallModal = {
  modName: null,
  targetType: null,
  selectedVariant: null,
  files: [],
  _resolve: null,

  async open(modName, targetType = 'pak') {
    this.modName = modName;
    this.targetType = targetType;
    this.selectedVariant = null;
    document.getElementById('modal-mod-name').textContent = `Install — ${modName}`;
    document.getElementById('modal-file-list').innerHTML =
      '<div style="padding:12px 16px;color:var(--muted);font-size:11px">Loading archive contents...</div>';
    document.getElementById('install-modal').style.display = 'flex';

    try {
      // Check for variants and exe warning (PAK only)
      if (targetType === 'pak') {
        const info = await window.api.detectPakVariants(modName);
        if (info) {
          const { variants, nested, hasExe } = info;
          if (hasExe) this._showExeWarning(variants, nested);
          else if (variants) this._renderVariantPicker(variants, nested);
          else {
            this.files = await window.api.listArchiveContents(modName, this.targetType, null);
            this._renderList();
          }
          return new Promise(resolve => { this._resolve = resolve; });
        }
      }
      this.files = await window.api.listArchiveContents(modName, this.targetType, null);
      this._renderList();
    } catch (e) {
      document.getElementById('modal-file-list').innerHTML =
        `<div style="padding:12px 16px;color:var(--red);font-size:11px">Failed to read archive: ${e.message}</div>`;
    }

    return new Promise(resolve => { this._resolve = resolve; });
  },

  _renderVariantPicker(variants, nested, title = 'This mod has multiple versions — choose which one to install:') {
    let buttonsHtml = '';
    if (nested) {
      // variants is an object: { 'ADVANCED': ['ADVANCED/EPIC VERSION', 'ADVANCED/STEAM VERSION'], ... }
      for (const [top, subs] of Object.entries(variants)) {
        buttonsHtml += `<div style="font-size:11px;color:var(--hint);margin:10px 0 4px">${top}</div>`;
        for (const sub of subs) {
          const label = sub.split('/').pop(); // e.g. "EPIC VERSION" or "STEAM VERSION"
          buttonsHtml += `<button class="btn-outline" style="text-align:left;padding:8px 14px;font-size:13px"
            onclick="InstallModal.selectVariant('${sub.replace(/'/g,"\\'")}')">
            📦 ${label}
          </button>`;
        }
      }
    } else {
      // variants is a flat array
      for (const v of variants) {
        buttonsHtml += `<button class="btn-outline" style="text-align:left;padding:10px 14px;font-size:13px"
          onclick="InstallModal.selectVariant('${v.replace(/'/g,"\\'")}')">
          📦 ${v}
        </button>`;
      }
    }

    document.getElementById('modal-file-list').innerHTML = `
      <div style="padding:16px">
        <div style="font-size:12px;color:var(--muted);margin-bottom:12px">${title}</div>
        <div style="display:flex;flex-direction:column;gap:6px">${buttonsHtml}</div>
      </div>`;
    document.getElementById('modal-actions').style.display = 'none';
  },

  _showExeWarning(variants, nested) {
    const hasVariants = variants && (Array.isArray(variants) ? variants.length >= 2 : Object.keys(variants).length >= 1);
    const variantHtml = hasVariants ? `
      <div style="margin-top:12px;font-size:12px;color:var(--muted)">This mod also has multiple versions — you'll choose one after confirming:</div>
      <div style="display:flex;flex-direction:column;gap:6px;margin-top:8px">
        ${Array.isArray(variants)
          ? variants.map(v => `<button class="btn-outline" style="text-align:left;padding:8px 12px;font-size:12px" onclick="InstallModal.selectVariant('${v.replace(/'/g,"\\'")}')">📦 ${v}</button>`).join('')
          : Object.entries(variants).map(([top, subs]) =>
              `<div style="font-size:11px;color:var(--hint);margin:8px 0 4px">${top}</div>` +
              subs.map(sub => `<button class="btn-outline" style="text-align:left;padding:8px 12px;font-size:12px" onclick="InstallModal.selectVariant('${sub.replace(/'/g,"\\'")}')">📦 ${sub.split('/').pop()}</button>`).join('')
            ).join('')
        }
      </div>` : '';

    document.getElementById('modal-file-list').innerHTML = `
      <div style="padding:16px">
        <div style="background:rgba(220,50,50,0.1);border:1px solid var(--red);border-radius:8px;padding:12px 14px;margin-bottom:12px">
          <div style="font-size:13px;font-weight:600;color:var(--red);margin-bottom:4px">⚠ This mod contains an .exe file</div>
          <div style="font-size:12px;color:var(--muted)">Installing will replace the game executable in your Win64 folder. Only proceed if you trust this mod and know what it does.</div>
        </div>
        ${variantHtml || ''}
        ${!variants || variants.length < 2 ? `
          <div style="display:flex;gap:8px;margin-top:12px;justify-content:flex-end">
            <button class="btn-outline" onclick="InstallModal.close()">Cancel</button>
            <button class="btn-primary" onclick="InstallModal._proceedAfterExeWarning()">I understand — continue</button>
          </div>` : ''}
      </div>`;
    document.getElementById('modal-actions').style.display = 'none';
  },

  async _proceedAfterExeWarning() {
    document.getElementById('modal-actions').style.display = '';
    document.getElementById('modal-file-list').innerHTML =
      '<div style="padding:12px 16px;color:var(--muted);font-size:11px">Loading files...</div>';
    this.files = await window.api.listArchiveContents(this.modName, this.targetType, null);
    this._renderList();
  },

  async selectVariant(variantFolder) {
    this.selectedVariant = variantFolder;
    document.getElementById('modal-mod-name').textContent = `Install — ${this.modName} (${variantFolder})`;
    const actionsEl = document.getElementById('modal-actions');
    if (actionsEl) actionsEl.style.display = '';
    document.getElementById('modal-file-list').innerHTML =
      '<div style="padding:12px 16px;color:var(--muted);font-size:11px">Loading files...</div>';
    try {
      this.files = await window.api.listArchiveContents(this.modName, this.targetType, variantFolder);
      this._renderList();
    } catch (e) {
      document.getElementById('modal-file-list').innerHTML =
        `<div style="padding:12px 16px;color:var(--red);font-size:11px">Failed: ${e.message}</div>`;
    }
  },

  close(success = false) {
    document.getElementById('install-modal').style.display = 'none';
    this.modName = null;
    this.files = [];
    if (this._resolve) { this._resolve(success); this._resolve = null; }
  },

  _fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    if (['pak','ucas','utoc','ubulk','uexp','umap'].includes(ext)) return '📦';
    if (ext === 'lua') return '📜';
    if (['json','ini','cfg','txt','toml'].includes(ext)) return '📄';
    if (['png','jpg','jpeg','webp','dds'].includes(ext)) return '🖼️';
    return '📎';
  },

  _renderList() {
    // Always make sure the action buttons are visible when showing the file list
    const actionsEl = document.getElementById('modal-actions');
    if (actionsEl) actionsEl.style.display = '';
    const el = document.getElementById('modal-file-list');
    if (!this.files.length) {
      el.innerHTML = '<div style="padding:12px 16px;color:var(--muted);font-size:11px">No files found in archive.</div>';
      return;
    }

    // Group .pak/.ucas/.utoc/.ubulk/.uexp/.umap by base name
    const pakGroups = {}; // baseName -> [indices]
    const others = [];   // { index, name }
    this.files.forEach((f, i) => {
      const ext = '.' + f.split('.').pop().toLowerCase();
      const base = f.slice(0, f.lastIndexOf('.'));
      if (['.pak', '.ucas', '.utoc', '.ubulk', '.uexp', '.umap'].includes(ext)) {
        if (!pakGroups[base]) pakGroups[base] = { base, indices: [], names: [] };
        pakGroups[base].indices.push(i);
        pakGroups[base].names.push(f);
      } else {
        others.push({ index: i, name: f });
      }
    });

    let html = '';

    // Render grouped PAK entries — one checkbox controls all files in the group
    for (const [base, group] of Object.entries(pakGroups)) {
      const indicesAttr = group.indices.join(',');
      const displayName = base.includes('/') ? base.split('/').pop() : base;
      html += `<label class="modal-file-row">
        <input type="checkbox" class="modal-file-cb modal-pak-group" data-indices="${indicesAttr}" checked />
        <span class="modal-file-icon">📦</span>
        <span class="modal-file-name" title="${group.names.join(', ')}">${displayName}</span>
      </label>`;
    }

    // Render other files individually
    for (const { index, name } of others) {
      const displayName = name.includes('/') ? name.split('/').pop() : name;
      html += `<label class="modal-file-row">
        <input type="checkbox" class="modal-file-cb" data-index="${index}" checked />
        <span class="modal-file-icon">${this._fileIcon(name)}</span>
        <span class="modal-file-name" title="${name}">${displayName}</span>
      </label>`;
    }

    el.innerHTML = html;

    // If there's only one item (one pak group, no loose files), simplify the action buttons:
    // hide "Install all files", rename "Install selected" → "Install",
    // and hide the "Select all" checkbox (nothing to toggle between).
    const totalItems = Object.keys(pakGroups).length + others.length;
    const installAllBtn = document.getElementById('modal-btn-install-all');
    const installSelBtn = document.getElementById('modal-btn-install-sel');
    const checkAllWrap = document.getElementById('modal-check-all-wrap');
    if (installAllBtn && installSelBtn) {
      if (totalItems <= 1) {
        installAllBtn.style.display = 'none';
        installSelBtn.textContent = 'Install';
        if (checkAllWrap) checkAllWrap.style.display = 'none';
      } else {
        installAllBtn.style.display = '';
        installSelBtn.textContent = 'Install selected';
        if (checkAllWrap) checkAllWrap.style.display = '';
      }
    }
  },

  toggleAll(checked) {
    document.querySelectorAll('.modal-file-cb').forEach(cb => cb.checked = checked);
  },

  _getSelected() {
    const selected = [];
    document.querySelectorAll('.modal-file-cb:checked').forEach(cb => {
      if (cb.dataset.indices) {
        // PAK group — expand indices to individual filenames
        cb.dataset.indices.split(',').forEach(i => selected.push(this.files[parseInt(i)]));
      } else {
        selected.push(this.files[parseInt(cb.dataset.index)]);
      }
    });
    return selected;
  },

  _showProgress(label) {
    const el = document.getElementById('modal-install-progress');
    const bar = document.getElementById('modal-progress-bar');
    const lbl = document.getElementById('modal-progress-label');
    const file = document.getElementById('modal-progress-file');
    if (!el) return;
    el.style.display = 'block';
    if (bar) { bar.style.width = '0%'; bar.style.transition = 'none'; }
    if (lbl) lbl.textContent = label;
    if (file) file.textContent = '';
    // Disable action buttons while installing
    document.getElementById('modal-actions').style.display = 'none';
    window.api.onInstallProgress(({ done, total, file: f }) => {
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      if (bar) { bar.style.transition = 'width 0.15s'; bar.style.width = pct + '%'; }
      if (lbl) lbl.textContent = `Installing… ${done}/${total} files (${pct}%)`;
      if (file) file.textContent = f || '';
    });
  },

  _hideProgress() {
    const el = document.getElementById('modal-install-progress');
    if (el) el.style.display = 'none';
    window.api.offInstallProgress();
  },

  async installAll() {
    const name = this.modName;
    const variant = this.selectedVariant;
    this._showProgress('Preparing…');
    try {
      if (variant) {
        await window.api.installModSelected(name, State.gameDir, this.files, this.targetType);
      } else {
        await window.api.installMod(name, State.gameDir, this.targetType);
      }
      this._hideProgress();
      this.close(true);
      await App.refreshRepoOnly();
      toast(`Installed ${name}${variant ? ` (${variant})` : ''}`, 'ok');
    } catch (e) {
      this._hideProgress();
      document.getElementById('modal-actions').style.display = '';
      toast('Install failed: ' + e.message, 'err');
    }
  },

  async installSelected() {
    const selected = this._getSelected();
    if (!selected.length) { toast('No files selected.', 'err'); return; }
    const name = this.modName;
    this._showProgress('Preparing…');
    try {
      await window.api.installModSelected(name, State.gameDir, selected, this.targetType);
      this._hideProgress();
      this.close(true);
      await App.refreshRepoOnly();
      toast(`Installed ${selected.length} file(s) from ${name}`, 'ok');
    } catch (e) {
      this._hideProgress();
      document.getElementById('modal-actions').style.display = '';
      toast('Install failed: ' + e.message, 'err');
    }
  },
};

// ── Home ──────────────────────────────────────────────────────────────────────
const Home = {
  _mods: [],
  _index: 0,
  _timer: null,

  async load() {
    // Render team immediately — no network needed
    this.renderTeam();
    // Load featured with a timeout so it never hangs forever
    const timeout = new Promise((_, reject) =>
      setTimeout(() => reject(new Error('Timeout')), 15000)
    );
    Promise.race([this.loadFeatured(), timeout]).catch(() => {
      const el = document.getElementById('home-featured');
      if (el) el.innerHTML = `<div class="empty-state"><div class="empty-icon">◎</div><div>Could not load featured mods — check your connection</div></div>`;
    });
  },

  async loadFeatured() {
    const el = document.getElementById('home-featured');
    try {
      const mods = await window.api.getFeaturedMod();
      if (!mods || !mods.length) throw new Error('No mods returned');
      this._mods = mods;
      this._index = 0;
      this._buildDots();
      this._showSlide(0);
      this._startAutoplay();
    } catch (e) {
      if (el) el.innerHTML = `<div class="empty-state"><div class="empty-icon">✕</div><div>Failed to load featured mods</div></div>`;
    }
  },

  _buildDots() {
    const dots = document.getElementById('carousel-dots');
    if (!dots) return;
    dots.innerHTML = this._mods.map((_, i) =>
      `<button class="carousel-dot${i === 0 ? ' active' : ''}" onclick="Home.goToSlide(${i})"></button>`
    ).join('');
  },

  _updateDots() {
    document.querySelectorAll('.carousel-dot').forEach((d, i) => {
      d.classList.toggle('active', i === this._index);
    });
  },

  _showSlide(i, direction = 'right') {
    const el = document.getElementById('home-featured');
    const mod = this._mods[i];
    if (!mod) return;

    const imgHtml = mod.image
      ? `<img src="${mod.image}" class="home-featured-img" onerror="this.style.display='none'" />`
      : `<div class="home-featured-img home-featured-placeholder">◎</div>`;

    const newSlide = document.createElement('div');
    newSlide.className = `home-featured-inner slide-in-${direction}`;
    newSlide.innerHTML = `
      ${imgHtml}
      <div class="home-featured-info">
        <div class="home-featured-title">${mod.title}</div>
        ${mod.desc ? `<div class="home-featured-desc">${mod.desc}</div>` : ''}
        ${mod.downloads ? `<div class="home-featured-meta">${mod.downloads} downloads${mod.rating ? ` · ★ ${mod.rating}` : ''}</div>` : ''}
        <div class="home-featured-actions">
          <button class="btn-primary" id="home-dl-btn" onclick="Home.downloadFeatured('${mod.downloadUrl}','${mod.title.replace(/'/g,"\\'")}')">↓ Download</button>
          <button class="btn-outline" onclick="window.api.openExternal('${mod.url}')">View mod ↗</button>
        </div>
      </div>`;

    const old = el.querySelector('.home-featured-inner');
    if (old) {
      old.classList.add(`slide-out-${direction}`);
      setTimeout(() => old.remove(), 280);
    } else {
      // Clear any loading/error content (no existing slide)
      el.innerHTML = '';
    }
    el.appendChild(newSlide);
    this._updateDots();
  },

  _startAutoplay() {
    this._stopAutoplay();
    this._timer = setInterval(() => this.nextSlide(true), 5000);
  },

  _stopAutoplay() {
    if (this._timer) { clearInterval(this._timer); this._timer = null; }
  },

  goToSlide(i) {
    if (!this._mods.length || i === this._index) return;
    const dir = i > this._index ? 'right' : 'left';
    this._index = i;
    this._showSlide(this._index, dir);
    this._startAutoplay();
  },

  nextSlide(auto = false) {
    if (!this._mods.length) return;
    this._index = (this._index + 1) % this._mods.length;
    this._showSlide(this._index, 'right');
    if (!auto) this._startAutoplay();
  },

  prevSlide() {
    if (!this._mods.length) return;
    this._index = (this._index - 1 + this._mods.length) % this._mods.length;
    this._showSlide(this._index, 'left');
    this._startAutoplay();
  },

  async downloadFeatured(downloadUrl, modName, pageUrl = '') {
    const btn = document.getElementById('home-dl-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Opening...'; }
    try {
      toast(`Opening "${modName}" — downloading...`, '', 5000);
      const result = await window.api.downloadZip(downloadUrl, '', modName, pageUrl);
      await App.refresh();
      toast(`✓ Downloaded "${result.name}"`, 'ok', 3000);
    } catch (e) {
      toast('Download failed: ' + e.message, 'err', 4000);
    } finally {
      if (btn) { btn.disabled = false; btn.textContent = '↓ Download'; }
    }
  },

  renderTeam() {
    // ── ModVengers Team members — add more objects here as needed ─────────
    // Just need name, id (from their Overtake URL) and their profile url
    const TEAM = [
      { name: 'Little0nion',      id: '1159856', url: 'https://www.overtake.gg/members/little0nion.1159856/' },
      { name: 'BONNEX',           id: '1607350', url: 'https://www.overtake.gg/members/bonnex.1607350/' },
      { name: 'Grzeluuu',         id: '1244140', url: 'https://www.overtake.gg/members/grzeluuu.1244140/' },
      { name: 'n4x_0',            id: '475614',  url: 'https://www.overtake.gg/members/n4x_0.475614/' },
      { name: 'Thatgingerdude15', id: '3294857', url: 'https://www.overtake.gg/members/thatgingerdude15.3294857/' },
      { name: 'wiechuz',          id: '2197769', url: 'https://www.overtake.gg/members/wiechuz.2197769/' },
      { name: 'TheFir3Nexus',     id: '1772538', url: 'https://www.overtake.gg/members/thefir3nexus.1772538/' },
      { name: 'kevintaddo_',      id: '719375',  url: 'https://www.overtake.gg/members/kevintaddo_.719375/' },
      { name: 'cmdesigns192',     id: '4577966', url: 'https://www.overtake.gg/members/cmdesigns192.4577966/' },
    ];
    // ─────────────────────────────────────────────────────────────────────

    const el = document.getElementById('home-team');
    if (!el) return;

    el.innerHTML = TEAM.map(m => {
      // Overtake avatar folder = Math.floor(id / 1000)
      const folder = Math.floor(parseInt(m.id) / 1000);
      const avatar = `https://overtake-data.community.forum/avatars/s/${folder}/${m.id}.jpg`;
      return `
        <div class="team-card" onclick="window.api.openExternal('${m.url}')" title="View ${m.name}'s profile">
          <img src="${avatar}" class="team-avatar" alt="${m.name}"
               onerror="this.style.display='none';this.nextElementSibling.style.display='flex'" />
          <div class="team-avatar-placeholder" style="display:none">${m.name[0]}</div>
          <div class="team-name">${m.name}</div>
          <span class="team-link">↗</span>
        </div>`;
    }).join('');
  },
};

// ── First-run Setup ───────────────────────────────────────────────────────────
const Setup = {
  show() {
    document.getElementById('setup-modal').style.display = 'flex';
    document.getElementById('setup-feedback').textContent = '';
  },

  hide() {
    document.getElementById('setup-modal').style.display = 'none';
  },

  async browse() {
    const dir = await window.api.browseDir();
    if (!dir) return;
    const valid = await window.api.validateGameDir(dir);
    if (!valid) {
      const fb = document.getElementById('setup-feedback');
      fb.textContent = 'F1Manager24.exe not found in that folder.';
      fb.className = 'feedback err';
      return;
    }
    document.getElementById('setup-dir-input').value = dir;
    document.getElementById('setup-feedback').textContent = '';
  },

  async save() {
    const dir = document.getElementById('setup-dir-input').value.trim();
    const fb = document.getElementById('setup-feedback');
    if (!dir) {
      fb.textContent = 'Please select your game directory first.';
      fb.className = 'feedback err';
      return;
    }
    const valid = await window.api.validateGameDir(dir);
    if (!valid) {
      fb.textContent = 'F1Manager24.exe not found in that folder. Please select the correct game directory.';
      fb.className = 'feedback err';
      return;
    }
    State.gameDir = dir;
    await window.api.saveSetting('gameDir', dir);
    document.getElementById('game-dir-input').value = dir;
    App.updateDirUI(dir);
    await App.refresh();
    this.hide();
    toast('Game directory saved. You\'re ready to go!', 'ok');
  },

  skip() {
    this.hide();
    // Navigate to settings so they can set it easily
    document.querySelector('.nav-btn[data-page="settings"]').click();
  },
};

// ── Boot ──────────────────────────────────────────────────────────────────────
App.init();
setTimeout(() => App.checkForUpdates(), 4000);

// ── Download progress sidebar bar ────────────────────────────────────────────
(function () {
  const dlWrap  = document.getElementById('sidebar-dl-wrap');
  const dlBar   = document.getElementById('sidebar-dl-bar');
  const dlLabel = document.getElementById('sidebar-dl-label');
  let hideTimer = null;

  function showProgress(label, pct) {
    if (!dlWrap) return;
    clearTimeout(hideTimer);
    dlWrap.style.display = '';
    if (dlLabel) dlLabel.textContent = label || 'Downloading…';
    if (dlBar) dlBar.style.width = (pct || 0) + '%';
  }
  function hideProgress() {
    hideTimer = setTimeout(() => { if (dlWrap) dlWrap.style.display = 'none'; }, 600);
  }

  window.api.onDownloadProgress(({ label, downloaded, total, complete }) => {
    if (complete) { hideProgress(); return; }
    const pct = total > 0 ? Math.round(downloaded / total * 100) : 0;
    showProgress(label || 'Downloading…', pct);
  });
})();

// ── Drag & Drop mod import ────────────────────────────────────────────────────
(function() {
  const overlay = document.getElementById('drop-overlay');
  let dragCounter = 0; // track nested dragenter/dragleave pairs

  document.addEventListener('dragenter', (e) => {
    // Only react to file drags
    if (!e.dataTransfer || !Array.from(e.dataTransfer.types).includes('Files')) return;
    dragCounter++;
    overlay.classList.add('active');
  });

  document.addEventListener('dragleave', (e) => {
    dragCounter--;
    if (dragCounter <= 0) { dragCounter = 0; overlay.classList.remove('active'); }
  });

  document.addEventListener('dragover', (e) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'copy';
  });

  document.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragCounter = 0;
    overlay.classList.remove('active');

    const files = Array.from(e.dataTransfer.files || []);
    const archives = files.filter(f => /\.(zip|rar)$/i.test(f.name));

    if (!archives.length) {
      toast('Drop a .zip or .rar mod file to import', 'err');
      return;
    }

    let imported = 0;
    for (const file of archives) {
      let filePath;
      try { filePath = window.api.getPathForFile(file); } catch (_) { filePath = file.path; }
      if (!filePath) { toast('Cannot read file path — try dragging again', 'err'); continue; }
      try {
        await window.api.importModFile(filePath);
        imported++;
      } catch (err) {
        toast('Import failed: ' + err.message, 'err', 4000);
      }
    }

    if (imported > 0) {
      await App.refresh();
      toast(`Imported ${imported} mod${imported > 1 ? 's' : ''} ✓`, 'ok');
      // Navigate to PAK page so user can see and install the new mod
      const pakBtn = document.querySelector('.nav-btn[data-page="pak"]');
      if (pakBtn) pakBtn.click();
    }
  });
})();


// ── Confirm Dialog ────────────────────────────────────────────────────────────
const ConfirmModal = {
  _resolve: null,

  ask(message, detail = '') {
    document.getElementById('confirm-message').textContent = message;
    document.getElementById('confirm-detail').textContent = detail;
    document.getElementById('confirm-modal').style.display = 'flex';
    return new Promise(resolve => { this._resolve = resolve; });
  },

  confirm() {
    document.getElementById('confirm-modal').style.display = 'none';
    if (this._resolve) { this._resolve(true); this._resolve = null; }
  },

  cancel() {
    document.getElementById('confirm-modal').style.display = 'none';
    if (this._resolve) { this._resolve(false); this._resolve = null; }
  },
};

// ── Mod Update Checker ────────────────────────────────────────────────────────
const UpdatesModal = {
  _updates: [],

  show(updates) {
    this._updates = updates;
    this._render();
    document.getElementById('updates-modal').style.display = 'flex';
    toast(`\uD83D\uDD14 ${updates.length} mod update${updates.length > 1 ? 's' : ''} available`, 'ok', 6000);
  },

  hide() {
    document.getElementById('updates-modal').style.display = 'none';
  },

  _render() {
    const list = document.getElementById('updates-list');
    if (!list) return;
    if (!this._updates.length) {
      list.innerHTML = '<div style="padding:16px;color:var(--muted);text-align:center">All mods are up to date \u2713</div>';
      const btn = document.getElementById('update-all-btn');
      if (btn) btn.style.display = 'none';
      return;
    }
    list.innerHTML = this._updates.map((u, i) => {
      const iconHtml = u.icon
        ? `<img src="${u.icon}" style="width:36px;height:36px;border-radius:5px;object-fit:cover;flex-shrink:0" onerror="this.style.display='none'">`
        : `<div style="width:36px;height:36px;border-radius:5px;background:var(--bg3);flex-shrink:0;display:flex;align-items:center;justify-content:center;font-size:16px">\uD83D\uDCE6</div>`;
      const verLine = (u.currentVersion && u.newVersion)
        ? `<div style="font-size:10px;color:var(--hint);margin-top:2px">v${u.currentVersion} \u2192 v${u.newVersion}</div>`
        : u.newUpdatedAt
          ? `<div style="font-size:10px;color:var(--hint);margin-top:2px">Updated ${u.newUpdatedAt.slice(0,10)}</div>`
          : '';
      return `<div class="mod-card" style="margin:4px 0" id="update-row-${i}">
        ${iconHtml}
        <div style="flex:1;min-width:0">
          <div class="mod-card-name">${u.displayName}</div>
          ${verLine}
        </div>
        <span class="tag tag-${u.type || 'pak'}">${(u.type || 'pak').toUpperCase()}</span>
        <button class="btn-ghost" id="update-btn-${i}" onclick="UpdatesModal.updateOne(${i})">Update \u2193</button>
      </div>`;
    }).join('');
  },

  async updateOne(i) {
    const u = this._updates[i];
    if (!u) return;
    const btn = document.getElementById(`update-btn-${i}`);
    if (btn) { btn.disabled = true; btn.textContent = 'Updating\u2026'; }
    try {
      await window.api.downloadZip(u.downloadUrl, u.icon || '', u.displayName, u.overtakeUrl || '');
      await App.refresh();
      toast(`Updated ${u.displayName} \u2713`, 'ok');
      this._updates.splice(i, 1);
      this._render();
    } catch (e) {
      if (btn) { btn.disabled = false; btn.textContent = 'Update \u2193'; }
      toast('Update failed: ' + e.message, 'err');
    }
  },

  async updateAll() {
    const btn = document.getElementById('update-all-btn');
    if (btn) { btn.disabled = true; btn.textContent = 'Updating\u2026'; }
    for (let i = 0; i < this._updates.length; i++) {
      const u = this._updates[i];
      try {
        await window.api.downloadZip(u.downloadUrl, u.icon || '', u.displayName, u.overtakeUrl || '');
        toast(`Updated ${u.displayName} \u2713`, 'ok');
      } catch (e) {
        toast(`Failed ${u.displayName}: ${e.message}`, 'err');
      }
    }
    this._updates = [];
    this._render();
    await App.refresh();
    if (btn) { btn.disabled = false; btn.textContent = 'Update All'; }
  },
};
