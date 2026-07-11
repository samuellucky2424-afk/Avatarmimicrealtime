import { useEffect, useState } from 'react';
import { X, Download, RefreshCw, ArrowUpCircle } from 'lucide-react';
import {
  isDesktopUpdaterAvailable,
  subscribeToDesktopUpdateState,
  getDesktopUpdateState,
  installUpdate,
  type DesktopUpdateState,
  DEFAULT_DESKTOP_UPDATE_STATE,
} from '@/lib/desktop-updater';

export function UpdateBanner() {
  const [state, setState] = useState<DesktopUpdateState>(DEFAULT_DESKTOP_UPDATE_STATE);
  const [dismissed, setDismissed] = useState(false);
  const [isInstalling, setIsInstalling] = useState(false);

  useEffect(() => {
    if (!isDesktopUpdaterAvailable()) return;

    void getDesktopUpdateState().then(setState);

    const unsubscribe = subscribeToDesktopUpdateState((next) => {
      setState(next);
      // Re-show banner if a new version becomes available after being dismissed
      if (next.updateAvailable) setDismissed(false);
    });

    return unsubscribe;
  }, []);

  const shouldShow =
    isDesktopUpdaterAvailable() &&
    !dismissed &&
    (state.updateAvailable || state.readyToInstall);

  if (!shouldShow) return null;

  const handleInstall = async () => {
    setIsInstalling(true);
    await installUpdate();
    setIsInstalling(false);
  };

  const isDownloading = state.downloadInProgress;
  const isReady = state.readyToInstall;
  const version = state.latestVersion ?? '';
  const percent = Math.round(state.downloadProgress.percent);

  return (
    <div className="pointer-events-auto absolute left-1/2 top-4 z-30 w-full max-w-sm -translate-x-1/2 px-4">
      <div className="flex items-start gap-3 rounded-xl border border-blue-500/20 bg-[#0d1117]/90 px-4 py-3 shadow-2xl shadow-black/50 backdrop-blur-md">
        {/* Icon */}
        <div className="mt-0.5 flex-shrink-0">
          {isReady ? (
            <ArrowUpCircle className="h-5 w-5 text-green-400" />
          ) : (
            <Download className="h-5 w-5 text-blue-400" />
          )}
        </div>

        {/* Text + action */}
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-white">
            {isReady ? `v${version} ready to install` : `Update v${version} available`}
          </p>
          <p className="mt-0.5 text-xs text-[#a1a1aa]">
            {isReady
              ? 'Click Install to restart and apply the update.'
              : isDownloading
                ? `Downloading… ${percent}%`
                : 'A new version of Avatar Mimic Real Time is available.'}
          </p>

          {/* Download progress bar */}
          {isDownloading && (
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/10">
              <div
                className="h-full rounded-full bg-blue-500 transition-all duration-300"
                style={{ width: `${percent}%` }}
              />
            </div>
          )}

          {/* Install button */}
          {isReady && (
            <button
              onClick={() => void handleInstall()}
              disabled={isInstalling}
              className="mt-2 flex items-center gap-1.5 rounded-md bg-blue-600 px-3 py-1 text-xs font-semibold text-white transition-colors hover:bg-blue-500 disabled:opacity-60"
            >
              <RefreshCw className={`h-3 w-3 ${isInstalling ? 'animate-spin' : ''}`} />
              {isInstalling ? 'Launching…' : 'Install & Restart'}
            </button>
          )}
        </div>

        {/* Dismiss */}
        <button
          onClick={() => setDismissed(true)}
          className="flex-shrink-0 rounded p-0.5 text-[#71717a] transition-colors hover:text-white"
          title="Dismiss"
        >
          <X className="h-4 w-4" />
        </button>
      </div>
    </div>
  );
}
