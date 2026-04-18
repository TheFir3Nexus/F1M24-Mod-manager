/**
 * extract-worker.js — runs in a worker_thread, so extraction never blocks the main process.
 *
 * Receives a task via parentPort.once('message', ...) and posts back:
 *   { type: 'progress', done, total, file }
 *   { type: 'done' }
 *   { type: 'error', message }
 */
'use strict';

const { parentPort } = require('worker_threads');
const path = require('path');
const fs   = require('fs');

parentPort.once('message', async (task) => {
  try {
    await run(task);
    parentPort.postMessage({ type: 'done' });
  } catch (e) {
    parentPort.postMessage({ type: 'error', message: e.message || String(e) });
  }
});

async function run({ archivePath, filesToExtract, destMap, ext }) {
  // filesToExtract: array of { archiveName, destPath }
  // destMap is not used directly — each item already has destPath resolved by main.js

  const total = filesToExtract.length;

  if (ext === '.rar') {
    await extractRar(archivePath, filesToExtract, total);
  } else {
    await extractZip(archivePath, filesToExtract, total);
  }
}

// ── ZIP ────────────────────────────────────────────────────────────────────────
async function extractZip(archivePath, filesToExtract, total) {
  // For large archives AdmZip loads the entire file into RAM and will OOM.
  // Threshold: 256 MB — above this we delegate to PowerShell's ZipFile API
  // which streams entries directly from disk.
  const fileSizeMB = fs.statSync(archivePath).size / (1024 * 1024);
  if (fileSizeMB > 30) { // 30 MB — keeps AdmZip RAM usage safe
    return extractZipPowerShell(archivePath, filesToExtract, total);
  }

  const AdmZip = require('adm-zip');
  const zip = new AdmZip(archivePath);

  // Build a lookup from normalised entryName → destPath
  const destByName = new Map(filesToExtract.map(f => [f.archiveName, f.destPath]));

  let done = 0;
  for (const entry of zip.getEntries()) {
    if (entry.isDirectory) continue;

    // Normalise separators — ZIP spec says '/' but some tools use '\'
    const normalized = entry.entryName.replace(/\\/g, '/');
    const destPath = destByName.get(normalized);
    if (!destPath) continue;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });

    // getData() + writeFileSync — avoids adm-zip extractEntryTo() parameter
    // signature differences between versions.
    const data = entry.getData();
    if (!data) continue;
    fs.writeFileSync(destPath, data);

    done++;
    parentPort.postMessage({ type: 'progress', done, total, file: path.basename(normalized) });
  }
}

// ── PowerShell ZIP extractor — streams from disk, no RAM limit ───────────────
async function extractZipPowerShell(archivePath, filesToExtract, total) {
  const { spawn }  = require('child_process');
  const os         = require('os');

  // Write the file map to a temp JSON so we avoid escaping issues in PS args
  const mapPath = path.join(os.tmpdir(), `f1m24_map_${Date.now()}.json`);
  fs.writeFileSync(mapPath, JSON.stringify(filesToExtract));

  const script = `
    Add-Type -Assembly System.IO.Compression.FileSystem
    $map = Get-Content '${mapPath.replace(/'/g, "''")}' | ConvertFrom-Json
    $lookup = @{}
    foreach ($item in $map) { $lookup[$item.archiveName] = $item.destPath }
    $zip = [System.IO.Compression.ZipFile]::OpenRead('${archivePath.replace(/'/g, "''")}')
    $done = 0
    foreach ($entry in $zip.Entries) {
      $name = $entry.FullName.Replace([char]92, [char]47)
      if ($lookup.ContainsKey($name)) {
        $dest = $lookup[$name]
        $dir  = [System.IO.Path]::GetDirectoryName($dest)
        if ($dir) { [System.IO.Directory]::CreateDirectory($dir) | Out-Null }
        [System.IO.Compression.ZipFileExtensions]::ExtractToFile($entry, $dest, $true)
        $done++
        Write-Output "$done|$([System.IO.Path]::GetFileName($dest))"
      }
    }
    $zip.Dispose()
    Remove-Item '${mapPath.replace(/'/g, "''")}' -ErrorAction SilentlyContinue
  `;

  return new Promise((resolve, reject) => {
    const ps = spawn('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-Command', script
    ]);

    let done = 0;
    ps.stdout.on('data', chunk => {
      const lines = chunk.toString().split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        const [doneStr, filename] = line.split('|');
        done = parseInt(doneStr) || done;
        parentPort.postMessage({ type: 'progress', done, total, file: filename || '' });
      }
    });
    ps.stderr.on('data', d => console.error('[PS extract]', d.toString()));
    ps.on('error', err => {
      try { fs.unlinkSync(mapPath); } catch {}
      reject(err);
    });
    ps.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`PowerShell extraction exited with code ${code}`));
    });
  });
}

// ── RAR ────────────────────────────────────────────────────────────────────────
async function extractRar(archivePath, filesToExtract, total) {
  const unrar = require('node-unrar-js');

  // Build lookup — normalize separators since RAR can use backslashes
  const normalize = s => s.replace(/\\/g, '/');
  const destByName = new Map(
    filesToExtract.map(f => [normalize(f.archiveName), f.destPath])
  );

  // Read file — unavoidable for node-unrar-js (WASM needs ArrayBuffer)
  // But now it's in a worker so the main thread stays responsive
  const buf = fs.readFileSync(archivePath);
  const extractor = await unrar.createExtractorFromData({ data: buf.buffer });
  const extracted = extractor.extract();

  let done = 0;
  for (const file of extracted.files) {
    if (file.fileHeader.flags.directory || !file.extraction) continue;
    const normalizedName = normalize(file.fileHeader.name);
    const destPath = destByName.get(normalizedName);
    if (!destPath) continue;

    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    fs.writeFileSync(destPath, Buffer.from(file.extraction));

    done++;
    parentPort.postMessage({ type: 'progress', done, total, file: path.basename(normalizedName) });
  }
}
