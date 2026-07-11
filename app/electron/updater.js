import { app, shell } from 'electron';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { once } from 'events';

const GITHUB_RELEASES_URL = 'https://github.com/samuellucky2424-afk/Avatarmimicrealtime/releases';

function normalizePackageType(value) {
  return value === 'portable' ? 'portable' : 'installer';
}

function buildAssetName(version, packageType) {
  return buildAssetNameCandidates(version, packageType)[0];
}

function buildAssetNameCandidates(version, packageType) {
  const safeVersion = typeof version === 'string' ? version.trim() : String(version ?? '').trim();
  return packageType === 'portable'
    ? [
      `Avatar Mimic Real Time.${safeVersion}.exe`,
      `Avatar Mimic Real Time ${safeVersion}.exe`,
      `Avatar Mimic Real Time-${safeVersion}.exe`,
    ]
    : [
      `Avatar Mimic Real Time.Setup.${safeVersion}.exe`,
      `Avatar Mimic Real Time Setup ${safeVersion}.exe`,
      `Avatar Mimic Real Time-Setup-${safeVersion}.exe`,
    ];
}

function findReleaseAsset(assets, version, packageType) {
  const candidates = new Set(buildAssetNameCandidates(version, packageType));
  const exactMatch = assets.find((asset) => candidates.has(asset.name));
  if (exactMatch) return exactMatch;

  const exeAssets = assets.filter((asset) => asset.name.toLowerCase().endsWith('.exe'));
  if (packageType === 'portable') {
    return exeAssets.find((asset) => !/setup|installer/i.test(asset.name)) || null;
  }

  return exeAssets.find((asset) => /setup|installer/i.test(asset.name)) || null;
}

const DEFAULT_MANIFEST_URL = process.env.SUREVIDEOTOOL_UPDATE_MANIFEST_URL
  || process.env.VITE_UPDATE_MANIFEST_URL
  || 'https://virtualpresenceai.vercel.app/api/version';

function safeStringify(value) {
  try {
    return JSON.stringify(value);
  } catch {
    try {
      return String(value);
    } catch {
      return '[unserializable]';
    }
  }
}

function toErrorString(error) {
  if (!error) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.stack || error.message || String(error);
  if (typeof error === 'object') return safeStringify(error);
  return String(error);
}

function normalizeText(value, fallback = null) {
  if (typeof value !== 'string') return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function normalizeNumber(value, fallback = null) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function parseVersionParts(version) {
  if (typeof version !== 'string') return null;
  const clean = version.split('-')[0]?.split('+')[0] ?? version;
  const parts = clean.split('.').map((part) => {
    const parsed = Number.parseInt(part, 10);
    return Number.isFinite(parsed) ? parsed : 0;
  });
  return parts.length > 0 ? parts : null;
}

function isVersionGreater(a, b) {
  const left = parseVersionParts(a);
  const right = parseVersionParts(b);
  if (!left || !right) return false;

  const length = Math.max(left.length, right.length);
  for (let index = 0; index < length; index += 1) {
    const av = left[index] ?? 0;
    const bv = right[index] ?? 0;
    if (av > bv) return true;
    if (av < bv) return false;
  }

  return false;
}

function formatHost(url) {
  try {
    return new URL(url).host;
  } catch {
    return null;
  }
}

function normalizeChecksum(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.replace(/^sha256[:=]\s*/i, '');
}

function ensureDirectory(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function buildDownloadCachePath(version, assetName) {
  const safeAssetName = path.basename(assetName || `Avatar Mimic Real Time Setup ${version}.exe`);
  return path.join(app.getPath('userData'), 'updates', version, safeAssetName);
}

function getAssetNameFromUrl(url) {
  try {
    const pathname = new URL(url).pathname;
    return path.basename(decodeURIComponent(pathname));
  } catch {
    return null;
  }
}

function looksLikeBinaryDownloadUrl(url) {
  if (typeof url !== 'string') return false;

  try {
    const pathname = decodeURIComponent(new URL(url).pathname).toLowerCase();
    return pathname.endsWith('.exe') || pathname.includes('/releases/download/');
  } catch {
    return /\.exe(?:$|[?#])/i.test(url) || /\/releases\/download\//i.test(url);
  }
}

function buildGitHubReleaseApiUrl(url, version) {
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/^\/([^/]+)\/([^/]+)\/releases(?:\/tag\/([^/]+))?/);
    if (!match) return null;

    const [, owner, repo, tagFromUrl] = match;
    const tag = tagFromUrl || `v${version}`;
    return `https://api.github.com/repos/${owner}/${repo}/releases/tags/${encodeURIComponent(tag)}`;
  } catch {
    return null;
  }
}

function createInitialState(currentVersion, manifestUrl, releasePageUrl) {
  return {
    status: 'idle',
    currentVersion,
    latestVersion: null,
    packageType: null,
    installMode: 'download-only',
    manifestUrl,
    releasePageUrl,
    sourceLabel: 'GitHub Releases',
    sourceHost: formatHost(manifestUrl) ?? formatHost(releasePageUrl) ?? 'github.com',
    downloadUrl: null,
    checksum: null,
    releaseNotes: null,
    assetName: null,
    downloadedFileName: null,
    downloadedPath: null,
    downloadDirectory: null,
    downloadProgress: {
      percent: 0,
      transferredBytes: 0,
      totalBytes: null,
      bytesPerSecond: null,
      etaSeconds: null
    },
    progress: 0,
    updateAvailable: false,
    readyToInstall: false,
    canAutoInstall: false,
    checksumVerified: null,
    checkInProgress: false,
    downloadInProgress: false,
    installInProgress: false,
    error: null,
    lastCheckedAt: null,
    lastDownloadedAt: null,
    lastInstalledAt: null
  };
}

export function createDesktopUpdater(options = {}) {
  const manifestUrl = normalizeText(options.manifestUrl, DEFAULT_MANIFEST_URL);
  const releasePageUrl = normalizeText(options.releasePageUrl, GITHUB_RELEASES_URL);
  const platform = normalizeText(options.platform, process.platform);
  const isPackaged = typeof options.isPackaged === 'boolean' ? options.isPackaged : app.isPackaged;
  const currentVersion = normalizeText(options.currentVersion, app.getVersion()) ?? app.getVersion();
  const sendState = typeof options.sendState === 'function' ? options.sendState : () => {};
  const logPath = normalizeText(options.logPath, null);

  const state = createInitialState(currentVersion, manifestUrl, releasePageUrl);
  let manifestCache = null;
  let downloadPromise = null;
  let startupTimer = null;
  let intervalTimer = null;
  let lastProgressEmitAt = 0;
  let lastProgressPercent = -1;
  let lastActionAt = 0;

  function log(...parts) {
    const line = `[${new Date().toISOString()}][updater] ${parts.map((part) => (typeof part === 'string' ? part : safeStringify(part))).join(' ')}`;
    console.log(line);
    if (!logPath) return;

    try {
      fs.appendFileSync(logPath, `${line}\n`, 'utf8');
    } catch {
      // Ignore log write failures so update flow stays resilient.
    }
  }

  function snapshot() {
    return {
      status: state.status,
      currentVersion: state.currentVersion,
      latestVersion: state.latestVersion,
      packageType: state.packageType,
      installMode: state.installMode,
      manifestUrl: state.manifestUrl,
      releasePageUrl: state.releasePageUrl,
      sourceLabel: state.sourceLabel,
      sourceHost: state.sourceHost,
      downloadUrl: state.downloadUrl,
      checksum: state.checksum,
      releaseNotes: state.releaseNotes,
      assetName: state.assetName,
      downloadedFileName: state.downloadedFileName,
      downloadedPath: state.downloadedPath,
      downloadDirectory: state.downloadDirectory,
      downloadProgress: state.downloadProgress,
      progress: state.progress,
      updateAvailable: state.updateAvailable,
      readyToInstall: state.readyToInstall,
      canAutoInstall: state.canAutoInstall,
      checksumVerified: state.checksumVerified,
      checkInProgress: state.checkInProgress,
      downloadInProgress: state.downloadInProgress,
      installInProgress: state.installInProgress,
      error: state.error,
      lastCheckedAt: state.lastCheckedAt,
      lastDownloadedAt: state.lastDownloadedAt,
      lastInstalledAt: state.lastInstalledAt
    };
  }

  function emitState(reason) {
    const data = snapshot();
    try {
      sendState(data, reason);
    } catch (error) {
      log('Failed to send updater state.', { reason, error: toErrorString(error) });
    }
    return data;
  }

  function patchState(patch, reason) {
    Object.assign(state, patch);
    return emitState(reason);
  }

  function markError(error, reason, extra = {}) {
    const message = toErrorString(error);
    log('Updater error.', { reason, error: message, ...extra });
    patchState({
      status: 'error',
      error: message,
      checkInProgress: false,
      downloadInProgress: false,
      installInProgress: false
    }, reason);
    return message;
  }

  function buildManifestRequestUrl() {
    const url = new URL(manifestUrl);
    url.searchParams.set('build', 'installer');
    url.searchParams.set('platform', platform);
    url.searchParams.set('currentVersion', state.currentVersion);
    return url.toString();
  }

  function normalizeManifest(manifest) {
    if (!manifest || typeof manifest !== 'object') {
      throw new Error('Invalid update manifest response.');
    }

    const latestVersion = normalizeText(manifest.latestVersion ?? manifest.version);
    const downloadUrl = normalizeText(manifest.downloadUrl ?? manifest.url);
    const packageType = normalizePackageType(manifest.packageType ?? manifest.buildType ?? manifest.kind);
    const releasePage = normalizeText(manifest.releasePageUrl ?? manifest.sourceUrl, releasePageUrl);
    const sourceLabel = normalizeText(manifest.sourceLabel, 'GitHub Releases');
    const assetName = normalizeText(manifest.assetName, buildAssetName(latestVersion || state.currentVersion, packageType));

    if (!latestVersion) {
      throw new Error('Update manifest did not include a latest version.');
    }

    if (!downloadUrl) {
      throw new Error('Update manifest did not include a download URL.');
    }

    return {
      latestVersion,
      downloadUrl,
      packageType,
      checksum: normalizeText(manifest.checksum ?? manifest.sha256, null),
      releaseNotes: normalizeText(manifest.releaseNotes, null),
      releasePageUrl: releasePage,
      sourceLabel,
      assetName,
      generatedAt: normalizeText(manifest.generatedAt, new Date().toISOString())
    };
  }

  async function fetchJson(url, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('Request timed out.')), timeoutMs);

    try {
      const response = await fetch(url, {
        method: 'GET',
        cache: 'no-store',
        headers: {
          'Cache-Control': 'no-cache',
          'Pragma': 'no-cache',
          'Accept': 'application/json'
        },
        signal: controller.signal
      });

      if (!response.ok) {
        throw new Error(`Manifest request failed with HTTP ${response.status}.`);
      }

      return await response.json();
    } finally {
      clearTimeout(timer);
    }
  }

  async function resolveDownloadSource(manifest, reason) {
    const sourceUrl = normalizeText(manifest.downloadUrl, null);
    if (!sourceUrl) {
      throw new Error('Update manifest did not include a download URL.');
    }

    if (looksLikeBinaryDownloadUrl(sourceUrl)) {
      return {
        downloadUrl: sourceUrl,
        assetName: manifest.assetName || getAssetNameFromUrl(sourceUrl) || buildAssetName(manifest.latestVersion, manifest.packageType)
      };
    }

    const releaseUrl = normalizeText(manifest.releasePageUrl, sourceUrl);
    const apiUrl = buildGitHubReleaseApiUrl(releaseUrl, manifest.latestVersion)
      || buildGitHubReleaseApiUrl(sourceUrl, manifest.latestVersion);

    if (!apiUrl) {
      throw new Error(`Update manifest pointed to a webpage instead of an installer: ${sourceUrl}`);
    }

    log('Resolving release page to downloadable asset.', { reason, sourceUrl, apiUrl });
    const release = await fetchJson(apiUrl, 30_000);
    const assets = (
      Array.isArray(release.assets)
        ? release.assets.map((asset) => ({
          name: typeof asset.name === 'string' ? asset.name : '',
          downloadUrl: typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '',
        }))
        : []
    ).filter((asset) => asset.name && asset.downloadUrl);
    const releaseAsset = findReleaseAsset(assets, manifest.latestVersion, manifest.packageType);

    if (!releaseAsset) {
      throw new Error(
        `No downloadable ${manifest.packageType || 'installer'} asset found for v${manifest.latestVersion}. ` +
        `Available assets: ${assets.map((asset) => asset.name).join(', ') || 'none'}`
      );
    }

    return {
      downloadUrl: releaseAsset.downloadUrl,
      assetName: releaseAsset.name
    };
  }

  async function loadManifest(reason) {
    const requestUrl = buildManifestRequestUrl();
    log('Fetching update manifest.', { reason, requestUrl });

    const manifest = normalizeManifest(await fetchJson(requestUrl, 30_000));
    manifestCache = manifest;

    const hasNewerVersion = isVersionGreater(manifest.latestVersion, state.currentVersion);
    const installMode = manifest.packageType === 'installer' && isPackaged && platform === 'win32'
      ? 'auto-install'
      : 'download-only';

    patchState({
      latestVersion: manifest.latestVersion,
      packageType: manifest.packageType,
      installMode,
      downloadUrl: manifest.downloadUrl,
      checksum: manifest.checksum,
      releaseNotes: manifest.releaseNotes,
      releasePageUrl: manifest.releasePageUrl,
      sourceLabel: manifest.sourceLabel,
      sourceHost: formatHost(manifest.downloadUrl) ?? state.sourceHost,
      assetName: manifest.assetName,
      updateAvailable: hasNewerVersion,
      canAutoInstall: installMode === 'auto-install',
      error: null,
      lastCheckedAt: new Date().toISOString(),
      status: hasNewerVersion ? 'update-available' : 'up-to-date',
      checkInProgress: false
    }, reason);

    return {
      manifest,
      hasNewerVersion,
      installMode
    };
  }

  async function ensureDownloaded(manifest, reason) {
    if (!manifest) {
      throw new Error('No update manifest available.');
    }

    if (!isVersionGreater(manifest.latestVersion, state.currentVersion)) {
      patchState({
        status: 'up-to-date',
        updateAvailable: false,
        readyToInstall: false,
        checkInProgress: false,
        downloadInProgress: false
      }, reason);
      return snapshot();
    }

    if (state.readyToInstall && state.latestVersion === manifest.latestVersion && state.downloadedPath) {
      log('Using cached downloaded update.', { reason, version: manifest.latestVersion });
      return snapshot();
    }

    if (downloadPromise) {
      log('Waiting for existing update download.', { reason, version: manifest.latestVersion });
      return downloadPromise;
    }

    const expectedChecksum = normalizeChecksum(manifest.checksum);
    const resolvedDownload = await resolveDownloadSource(manifest, reason);
    const sourceUrl = resolvedDownload.downloadUrl;
    const assetName = resolvedDownload.assetName || manifest.assetName || buildAssetName(manifest.latestVersion, manifest.packageType);
    const destination = buildDownloadCachePath(manifest.latestVersion, assetName);
    const destinationDir = path.dirname(destination);

    patchState({
      downloadUrl: sourceUrl,
      assetName,
      sourceHost: formatHost(sourceUrl) ?? state.sourceHost
    }, `${reason}:download-resolved`);

    ensureDirectory(destinationDir);

    if (fs.existsSync(destination) && fs.statSync(destination).size > 0) {
      log('Existing update file found; verifying before re-downloading.', { reason, destination });
      if (!expectedChecksum) {
        patchState({
          downloadedPath: destination,
          downloadedFileName: path.basename(destination),
          downloadDirectory: destinationDir,
          downloadInProgress: false,
          readyToInstall: true,
          status: 'downloaded',
          lastDownloadedAt: new Date().toISOString(),
          checksumVerified: null,
          progress: 100,
          downloadProgress: {
            percent: 100,
            transferredBytes: fs.statSync(destination).size,
            totalBytes: fs.statSync(destination).size,
            bytesPerSecond: null,
            etaSeconds: 0
          }
        }, reason);
        return snapshot();
      }
    }

    const downloadTask = (async () => {
      patchState({
        downloadInProgress: true,
        status: 'downloading',
        error: null,
        checksumVerified: null,
        downloadDirectory: destinationDir,
        downloadedFileName: null,
        downloadedPath: null
      }, `${reason}:download-start`);

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(new Error('Download timed out.')), 15 * 60 * 1000);
      let response;

      try {
        response = await fetch(sourceUrl, {
          method: 'GET',
          cache: 'no-store',
          headers: {
            'Cache-Control': 'no-cache',
            'Pragma': 'no-cache',
            'Accept': 'application/octet-stream'
          },
          signal: controller.signal
        });

        if (!response.ok || !response.body) {
          throw new Error(`Download request failed with HTTP ${response.status}.`);
        }

        const totalBytes = normalizeNumber(Number(response.headers.get('content-length')), null);
        const fileStream = fs.createWriteStream(destination, { flags: 'w' });
        const reader = response.body.getReader();
        const hexHash = crypto.createHash('sha256');
        const base64Hash = crypto.createHash('sha256');
        let transferredBytes = 0;
        let lastEmitPercent = -1;

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          const buffer = Buffer.from(value);
          hexHash.update(buffer);
          base64Hash.update(buffer);
          transferredBytes += buffer.byteLength;

          if (!fileStream.write(buffer)) {
            await once(fileStream, 'drain');
          }

          const percent = totalBytes ? Math.min(100, (transferredBytes / totalBytes) * 100) : 0;
          const now = Date.now();
          const shouldEmit = now - lastProgressEmitAt >= 750 || Math.floor(percent) !== Math.floor(lastEmitPercent);
          if (shouldEmit) {
            lastProgressEmitAt = now;
            lastEmitPercent = percent;
            patchState({
              downloadProgress: {
                percent: Number(percent.toFixed(2)),
                transferredBytes,
                totalBytes,
                bytesPerSecond: null,
                etaSeconds: null
              },
              progress: Number(percent.toFixed(2))
            }, `${reason}:download-progress`);
          }
        }

        fileStream.end();
        await once(fileStream, 'finish');

        const hexDigest = hexHash.digest('hex');
        const base64Digest = base64Hash.digest('base64');
        const checksumMatches = !expectedChecksum
          || expectedChecksum.toLowerCase() === hexDigest.toLowerCase()
          || expectedChecksum === base64Digest;

        if (!checksumMatches) {
          fs.rmSync(destination, { force: true });
          throw new Error(`Downloaded update checksum mismatch for ${manifest.latestVersion}.`);
        }

        patchState({
          downloadedPath: destination,
          downloadedFileName: path.basename(destination),
          downloadDirectory: destinationDir,
          downloadInProgress: false,
          readyToInstall: true,
          status: 'downloaded',
          lastDownloadedAt: new Date().toISOString(),
          checksumVerified: expectedChecksum ? true : null,
          downloadProgress: {
            percent: 100,
            transferredBytes,
            totalBytes,
            bytesPerSecond: null,
            etaSeconds: 0
          },
          progress: 100
        }, `${reason}:downloaded`);

        log('Update download finished.', {
          reason,
          version: manifest.latestVersion,
          destination,
          transferredBytes,
          checksumVerified: expectedChecksum ? true : null
        });

        return snapshot();
      } catch (error) {
        try {
          fs.rmSync(destination, { force: true });
        } catch {
          // Ignore cleanup failures.
        }

        throw error;
      } finally {
        clearTimeout(timer);
      }
    })();

    downloadPromise = downloadTask.then((result) => {
      downloadPromise = null;
      return result;
    }).catch((error) => {
      downloadPromise = null;
      markError(error, `${reason}:download-failed`, { version: manifest.latestVersion });
      throw error;
    });

    return downloadPromise;
  }

  async function checkForUpdates(source = 'manual') {
    if (state.checkInProgress) {
      log('Update check skipped because another check is already in progress.', { source });
      return {
        success: true,
        inProgress: true,
        ...snapshot()
      };
    }

    if (state.downloadInProgress || downloadPromise) {
      log('Update check skipped because a download is already in progress.', { source });
      return {
        success: true,
        inProgress: true,
        ...snapshot()
      };
    }

    if (state.installInProgress) {
      log('Update check skipped because an install is in progress.', { source });
      return {
        success: true,
        installing: true,
        ...snapshot()
      };
    }

    state.checkInProgress = true;
    state.error = null;
    emitState(`${source}:check-start`);

    try {
      const { manifest, hasNewerVersion } = await loadManifest(source);
      if (!hasNewerVersion) {
        const stateSnapshot = patchState({
          status: 'up-to-date',
          updateAvailable: false,
          checkInProgress: false,
          downloadInProgress: false,
          readyToInstall: false
        }, `${source}:up-to-date`);
        return {
          success: true,
          updateAvailable: false,
          ...stateSnapshot
        };
      }

      log('Update available; starting download.', {
        source,
        version: manifest.latestVersion,
        installMode: state.installMode
      });

      void ensureDownloaded(manifest, `${source}:auto-download`).catch(() => {});
      const stateSnapshot = patchState({
        status: 'downloading',
        updateAvailable: true,
        checkInProgress: false,
        downloadInProgress: true
      }, `${source}:download-started`);
      return {
        success: true,
        updateAvailable: true,
        downloadStarted: true,
        ...stateSnapshot
      };
    } catch (error) {
      state.checkInProgress = false;
      const message = markError(error, `${source}:check-failed`);
      return {
        success: false,
        error: message,
        ...snapshot()
      };
    }
  }

  async function downloadUpdate(source = 'manual') {
    if (downloadPromise) {
      log('Download requested while another download is active.', { source });
      return {
        success: true,
        inProgress: true,
        ...snapshot()
      };
    }

    if (state.readyToInstall && state.latestVersion && state.downloadedPath) {
      log('Download request satisfied by cached installer.', { source, version: state.latestVersion });
      return {
        success: true,
        readyToInstall: true,
        ...snapshot()
      };
    }

    if (!manifestCache || !state.latestVersion) {
      const checkResult = await checkForUpdates(`${source}:precheck`);
      if (checkResult.status === 'error') {
        return checkResult;
      }
    }

    if (!manifestCache) {
      throw new Error('Unable to load update manifest.');
    }

    try {
      const stateSnapshot = await ensureDownloaded(manifestCache, `${source}:download`);
      return {
        success: true,
        ...stateSnapshot
      };
    } catch (error) {
      const message = markError(error, `${source}:download-failed`);
      return {
        success: false,
        error: message,
        ...snapshot()
      };
    }
  }

  async function installUpdate(source = 'manual') {
    lastActionAt = Date.now();

    if (state.downloadInProgress && downloadPromise) {
      log('Waiting for in-progress download before installing.', { source });
      try {
        await downloadPromise;
      } catch (error) {
        const message = markError(error, `${source}:install-wait-download`);
        return {
          success: false,
          error: message,
          ...snapshot()
        };
      }
    }

    if (!state.readyToInstall || !state.downloadedPath) {
      return {
        success: false,
        error: 'No downloaded update is ready to install.',
        readyToInstall: false,
        ...snapshot()
      };
    }

    if (!state.canAutoInstall) {
      try {
        await shell.showItemInFolder(state.downloadedPath);
        log('Download-only mode: revealing installer instead of launching it.', {
          source,
          downloadedPath: state.downloadedPath
        });
        return {
          success: true,
          downloadOnly: true,
          revealed: true,
          downloadedPath: state.downloadedPath,
          downloadedFileName: state.downloadedFileName,
          ...snapshot()
        };
      } catch (error) {
        const message = markError(error, `${source}:reveal-failed`);
        return {
          success: false,
          error: message,
          ...snapshot()
        };
      }
    }

    try {
      patchState({
        installInProgress: true,
        status: 'installing',
        error: null
      }, `${source}:install-start`);

      // Use shell.openPath so Windows launches the installer through the shell
      // association — this triggers UAC elevation correctly (same as double-clicking).
      // spawn() with windowsHide:true suppresses the UAC prompt, causing the installer
      // to run without admin rights and fail to replace the existing installation.
      const openError = await shell.openPath(state.downloadedPath);

      if (openError) {
        // openPath returns a non-empty string on failure
        throw new Error(`Failed to open installer: ${openError}`);
      }

      patchState({
        lastInstalledAt: new Date().toISOString()
      }, `${source}:install-launched`);

      // Give the installer a moment to start before quitting so the file handle
      // is released and Windows can replace the executable.
      setTimeout(() => {
        try {
          app.quit();
        } catch (error) {
          log('Failed to quit application after launching installer.', {
            source,
            error: toErrorString(error)
          });
        }
      }, 1500);

      return {
        success: true,
        launched: true,
        downloadedPath: state.downloadedPath,
        downloadedFileName: state.downloadedFileName,
        ...snapshot()
      };
    } catch (error) {
      patchState({
        installInProgress: false,
        status: 'downloaded'
      }, `${source}:install-failed-reset`);
      const message = markError(error, `${source}:install-failed`);
      return {
        success: false,
        error: message,
        ...snapshot()
      };
    }
  }

  async function openReleasePage(source = 'manual', force = false) {
    const url = force ? releasePageUrl : (state.releasePageUrl || releasePageUrl);
    log('Opening release page.', { source, url, lastActionAt });
    try {
      await shell.openExternal(url);
      return { success: true, url };
    } catch (error) {
      const message = markError(error, `${source}:open-release-page-failed`, { url });
      return {
        success: false,
        error: message,
        ...snapshot()
      };
    }
  }

  function getStateSnapshot() {
    return snapshot();
  }

  function startBackgroundChecks() {
    if (startupTimer || intervalTimer) return;

    startupTimer = setTimeout(() => {
      const active = state.checkInProgress || state.downloadInProgress || state.installInProgress;
      if (active) {
        log('Startup update check skipped because updater is busy.', snapshot());
        return;
      }
      void checkForUpdates('startup');
    }, 15_000);

    intervalTimer = setInterval(() => {
      const active = state.checkInProgress || state.downloadInProgress || state.installInProgress;
      if (active) {
        log('Scheduled update check skipped because updater is busy.', snapshot());
        return;
      }
      void checkForUpdates('scheduled');
    }, 4 * 60 * 60 * 1000);
  }

  function dispose() {
    if (startupTimer) {
      clearTimeout(startupTimer);
      startupTimer = null;
    }
    if (intervalTimer) {
      clearInterval(intervalTimer);
      intervalTimer = null;
    }
  }

  process.on('uncaughtException', (error) => {
    log('uncaughtException', toErrorString(error));
  });

  process.on('unhandledRejection', (reason) => {
    log('unhandledRejection', toErrorString(reason));
  });

  emitState('init');

  return {
    checkForUpdates,
    downloadUpdate,
    installUpdate,
    openReleasePage,
    getStateSnapshot,
    startBackgroundChecks,
    dispose,
    manifestUrl,
    releasePageUrl,
    currentVersion: state.currentVersion
  };
}
