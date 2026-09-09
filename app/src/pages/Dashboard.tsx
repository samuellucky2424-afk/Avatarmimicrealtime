import { useState, useRef, useEffect, useCallback } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  Upload,
  Play,
  Square,
  Clock,
  Monitor,
  Settings,
  Plus,
  Coins,
  LoaderCircle,
} from 'lucide-react';
import { toast } from 'sonner';
import { useAuth } from '@/context/AuthContext';
import { useApp } from '@/context/AppContext';
import { apiFetchWithAuth } from '@/lib/api-client';
import { supabase } from '@/lib/supabase';
import { DB_TABLES } from '@/lib/dbNames';
import { CREDITS_PER_SECOND } from '@/lib/billing';
import { UpdateBanner } from '@/components/UpdateBanner';
import {
  VIDEO_OUTPUT_WIDTH,
  VIDEO_OUTPUT_HEIGHT,
  VIDEO_OUTPUT_FPS,
  buildVideoInputConstraints,
  buildVideoTrackConstraints,
  clampQualityMode,
  downgradeQualityMode,
  type QualityMode,
} from '@/lib/realtime-quality';
import { disconnectRealtimeClient, remainingSessionSeconds, shouldRestartRealtime } from '@/lib/realtime-session';
import { createMorphlyFetch } from '@/lib/morphly-fetch';


type ConnectionState = 'connecting' | 'connected' | 'generating' | 'disconnected' | 'reconnecting';

type UserNotification = {
  id: string;
  message: string;
  severity: 'info' | 'warning' | 'critical';
};

type RealtimeStats = {
  timestamp: number;
  video: {
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    framesDroppedDelta: number;
    freezeCountDelta: number;
    bitrate: number;
  } | null;
  outboundVideo: {
    qualityLimitationReason: string;
    framesPerSecond: number;
    frameWidth: number;
    frameHeight: number;
    bitrate: number;
  } | null;
  connection: {
    currentRoundTripTime: number | null;
    availableOutgoingBitrate: number | null;
  };
};

type RealtimeBalance = {
  available_credits: number;
  reserved_credits: number;
  charged_credits: number;
  billable_seconds: number;
};

type RealtimeClientEventMap = {
  connectionChange: ConnectionState;
  connectionStateChange: ConnectionState;
  stats: RealtimeStats;
  error: { message: string; code?: string };
  generationTick: { seconds: number };
  diagnostic: unknown;
  balance: RealtimeBalance;
  lowCredit: { level: number | string };
  creditsExhausted: void;
};

interface RealtimeClient {
  // disconnect() returns a promise in the current Morphly SDK; awaiting it lets us
  // handle SESSION_STOP_PENDING. Older builds returned void, so callers use void/await safely.
  disconnect: () => void | Promise<void>;
  set: (config: {
    prompt?: string | null;
    enhance?: boolean;
    image?: string | Blob | File | null;
  }) => Promise<void>;
  setPrompt: (text: string, options?: { enhance?: boolean }) => Promise<void>;
  getState?: () => ConnectionState;
  getConnectionState?: () => ConnectionState;
  on: <K extends keyof RealtimeClientEventMap>(
    event: K,
    listener: (data: RealtimeClientEventMap[K]) => void,
  ) => void;
  off: <K extends keyof RealtimeClientEventMap>(
    event: K,
    listener: (data: RealtimeClientEventMap[K]) => void,
  ) => void;
}

type ReferenceImage = {
  file: File;
  name: string;
  signature: string;
};

type TransformState = {
  prompt: string;
  enhance: boolean;
  image: File | null;
  imageSignature: string | null;
};

type StreamMetrics = {
  fps: number;
  frameWidth: number;
  frameHeight: number;
  rttMs: number | null;
  limitation: string;
  bitrateKbps: number;
};

type VideoElementWithFrameCallbacks = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: VideoFrameRequestCallback) => number;
  cancelVideoFrameCallback?: (handle: number) => void;
  latencyHint?: string;
};

const BASE_PROMPT = `Substitute the visible garment on the person with the garment shown in the reference image.
Use the reference image only for the clothing item, fabric, color, texture, and fit.
Keep the person's face, hair, skin tone, pose, body shape, hands, and background exactly as seen in the live camera feed.
Preserve natural lighting, camera softness, realistic fabric texture, and accurate garment fit.
Render skin with faithful tone and natural facial texture — visible pores, subtle detail, and realistic shading; do not smooth, blur, plastify, or over-beautify the face.
Match the garment's edges, seams, and folds precisely to the body so it reads as a real, well-fitted item, not a flat overlay.
The output must remain photorealistic and indistinguishable from a normal live camera recording.
Never produce a cartoon, anime, illustration, painting, CGI, 3D render, beauty filter, or stylized look.`;
const DEFAULT_ENHANCE = false;
const POLLING_INTERVAL = 5000; // poll session-status every 5 s for live credit display
const TRANSFORM_SYNC_DEBOUNCE_MS = 180;
const RESTART_WATCHDOG_INTERVAL_MS = 3000;
const FREEZE_RESTART_THRESHOLD_MS = 30000;
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 10000;
// The provider model ID is an implementation detail and is never shown in the UI.
// 'lucy-2.5' remains accepted by Morphly; new integrations use 'morphly-realtime'.
const REALTIME_MODEL_ID = 'morphly-realtime';
const SUREVIDEOTOOL_CAM_FRAME_WIDTH = VIDEO_OUTPUT_WIDTH;
const SUREVIDEOTOOL_CAM_FRAME_HEIGHT = VIDEO_OUTPUT_HEIGHT;
const SUREVIDEOTOOL_CAM_FRAME_INTERVAL_MS = 1000 / VIDEO_OUTPUT_FPS;

function canPublishVirtualCameraFrames() {
  return typeof window !== 'undefined' && Boolean(window.electron?.sendVirtualCameraFrame);
}

function createEmptyStreamMetrics(): StreamMetrics {
  return {
    fps: 0,
    frameWidth: 0,
    frameHeight: 0,
    rttMs: null,
    limitation: 'none',
    bitrateKbps: 0,
  };
}

function buildTransformSignature(transform: TransformState): string {
  return [
    transform.prompt,
    transform.enhance ? 'enhance' : 'base',
    transform.imageSignature ?? 'no-image',
  ].join('|');
}

function buildRealtimeSessionState(transform: TransformState) {
  return {
    prompt: transform.prompt,
    enhance: transform.enhance,
    image: transform.image ?? null,
  };
}

async function applyRealtimeSessionState(realtimeClient: RealtimeClient, transform: TransformState) {
  await realtimeClient.set(buildRealtimeSessionState(transform));
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function drawVideoFrameContain(
  context: CanvasRenderingContext2D,
  video: HTMLVideoElement,
  targetWidth: number,
  targetHeight: number,
) {
  const sourceWidth = video.videoWidth;
  const sourceHeight = video.videoHeight;

  if (!sourceWidth || !sourceHeight || !targetWidth || !targetHeight) {
    return;
  }

  const scale = Math.min(targetWidth / sourceWidth, targetHeight / sourceHeight);
  const width = sourceWidth * scale;
  const height = sourceHeight * scale;
  context.imageSmoothingEnabled = true;
  context.imageSmoothingQuality = 'high';
  context.drawImage(
    video,
    (targetWidth - width) / 2,
    (targetHeight - height) / 2,
    width,
    height,
  );
}

function getStartSessionErrorToast(error: unknown): string | null {
  if (!(error instanceof Error)) {
    return 'Failed to start session';
  }

  switch (error.message) {
    case 'Webcam start failed':
    case 'AI connection was not established':
      return null;
    case 'Missing session token':
      return 'Failed to start session: missing AI token';
    default:
      return error.message || 'Failed to start session';
  }
}

function getRealtimeSdkErrorMessage(error: unknown): string | null {
  if (error instanceof Error && error.message) {
    return error.message;
  }

  if (typeof error === 'object' && error !== null) {
    const candidate = error as {
      message?: unknown;
      code?: unknown;
      cause?: { message?: unknown } | unknown;
    };

    if (typeof candidate.message === 'string' && candidate.message) {
      return candidate.message;
    }

    if (
      typeof candidate.cause === 'object'
      && candidate.cause !== null
      && 'message' in candidate.cause
      && typeof candidate.cause.message === 'string'
      && candidate.cause.message
    ) {
      return candidate.cause.message;
    }

    if (typeof candidate.code === 'string' && candidate.code) {
      return candidate.code;
    }
  }

  return null;
}

async function apiRequest<T>(endpoint: string, options?: RequestInit): Promise<T> {
  const response = await apiFetchWithAuth(endpoint, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...options?.headers,
    },
  });

  if (!response.ok) {
    const errorData = await response.json().catch(() => ({}));
    throw new Error(errorData.error || errorData.message || `API Error: ${response.statusText}`);
  }

  return response.json();
}

function Dashboard() {
  const { user } = useAuth();
  const { credits, setCredits, setSessionStatus } = useApp();
  const navigate = useNavigate();

  const [isStreaming, setIsStreaming] = useState(false);
  const [referenceImage, setReferenceImage] = useState<ReferenceImage | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [cameraDevices, setCameraDevices] = useState<MediaDeviceInfo[]>([]);
  const [selectedCameraId, setSelectedCameraId] = useState('');
  const [prompt] = useState(BASE_PROMPT);
  const [preferredMode, setPreferredMode] = useState<QualityMode>('hd');
  const [runtimeModeCap, setRuntimeModeCap] = useState<QualityMode>('hd');
  const [connectionState, setConnectionState] = useState<ConnectionState>('disconnected');
  const [uiStatus, setUiStatus] = useState('Disconnected');
  const [isSyncingTransform, setIsSyncingTransform] = useState(false);
  const [hasRemoteFrame, setHasRemoteFrame] = useState(false);
  const [streamMetrics, setStreamMetrics] = useState<StreamMetrics>(() => createEmptyStreamMetrics());
  const [userNotification, setUserNotification] = useState<UserNotification | null>(null);

  useEffect(() => {
    let mounted = true;

    const loadNotification = async () => {
      const { data, error } = await supabase
        .from(DB_TABLES.notifications)
        .select('id,message,severity')
        .eq('is_active', true)
        .order('created_at', { ascending: false })
        .limit(1)
        .maybeSingle();

      if (!mounted) return;
      if (error) {
        console.warn('[dashboard] notification load failed:', error.message);
        return;
      }
      setUserNotification((data as UserNotification | null) ?? null);
    };

    void loadNotification();
    const interval = window.setInterval(() => void loadNotification(), 30_000);
    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, []);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const webcamVideoRef = useRef<HTMLVideoElement>(null);
  const outputVideoRef = useRef<HTMLVideoElement>(null);
  const webcamSourceStreamRef = useRef<MediaStream | null>(null);
  const webcamStreamRef = useRef<MediaStream | null>(null);
  const realtimeClientRef = useRef<RealtimeClient | null>(null);
  const pollIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const transformSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pendingTransformRef = useRef<TransformState | null>(null);
  const lastAppliedTransformRef = useRef<TransformState | null>(null);
  const transformInFlightRef = useRef(false);
  const clientSubscriptionsCleanupRef = useRef<(() => void) | null>(null);
  // This flags that our own metered session is active; Morphly credentials stay
  // inside the SDK and are never stored in the application.
  const activeSessionRef = useRef(false);
  const sessionIdRef = useRef('');
  const sessionDeadlineRef = useRef(0);
  const sessionEpochRef = useRef(0);
  const frameCallbackHandleRef = useRef<number | null>(null);
  const lastRemoteFrameAtRef = useRef(0);
  const frameWatchdogIntervalRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const restartInFlightRef = useRef(false);
  const safeStopInFlightRef = useRef(false);
  const restartRetryDelayRef = useRef(INITIAL_RETRY_DELAY_MS);
  const handleStopRef = useRef<((options?: { silent?: boolean }) => Promise<void>) | null>(null);
  const safelyStopSessionRef = useRef<(() => Promise<void>) | null>(null);
  const userInitiatedCameraChangeRef = useRef(false);
  const previousCameraIdRef = useRef('');
  const surevideotoolCamWindowRef = useRef<Window | null>(null);
  const surevideotoolCamVideoRef = useRef<HTMLVideoElement | null>(null);
  const surevideotoolCamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const surevideotoolCamStatusRef = useRef<HTMLDivElement | null>(null);
  const surevideotoolCamPlaceholderRef = useRef<HTMLDivElement | null>(null);
  const surevideotoolCamWindowEnabledRef = useRef(false);
  const latestRemoteStreamRef = useRef<MediaStream | null>(null);
  const surevideotoolCamRenderHandleRef = useRef<number | null>(null);
  const mainVirtualCamCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mainVirtualCamRenderHandleRef = useRef<number | null>(null);
  const virtualCameraPublisherStartedRef = useRef(false);
  const virtualCameraStartInFlightRef = useRef<Promise<void> | null>(null);

  const promptRef = useRef(prompt);
  const referenceImageRef = useRef(referenceImage);
  const isStreamingRef = useRef(isStreaming);
  const hasRemoteFrameRef = useRef(hasRemoteFrame);
  const connectionStateRef = useRef<ConnectionState>(connectionState);
  const activeModeRef = useRef<QualityMode>('hd');

  const activeMode = clampQualityMode(preferredMode, runtimeModeCap);
  useEffect(() => {
    promptRef.current = prompt;
  }, [prompt]);

  useEffect(() => {
    referenceImageRef.current = referenceImage;
  }, [referenceImage]);

  useEffect(() => {
    isStreamingRef.current = isStreaming;
  }, [isStreaming]);

  useEffect(() => {
    hasRemoteFrameRef.current = hasRemoteFrame;
  }, [hasRemoteFrame]);

  useEffect(() => {
    connectionStateRef.current = connectionState;
  }, [connectionState]);

  useEffect(() => {
    activeModeRef.current = activeMode;
  }, [activeMode]);


  const resetSurevideotoolCamRefs = useCallback(() => {
    if (surevideotoolCamWindowRef.current && surevideotoolCamRenderHandleRef.current !== null) {
      surevideotoolCamWindowRef.current.cancelAnimationFrame(surevideotoolCamRenderHandleRef.current);
    }

    surevideotoolCamRenderHandleRef.current = null;
    surevideotoolCamWindowRef.current = null;
    surevideotoolCamVideoRef.current = null;
    surevideotoolCamCanvasRef.current = null;
    surevideotoolCamStatusRef.current = null;
    surevideotoolCamPlaceholderRef.current = null;
    surevideotoolCamWindowEnabledRef.current = false;
  }, []);

  const updateSurevideotoolCamPlaceholder = useCallback((message: string | null) => {
    const placeholder = surevideotoolCamPlaceholderRef.current;

    if (!placeholder) {
      return;
    }

    if (!message) {
      placeholder.style.opacity = '0';
      placeholder.style.pointerEvents = 'none';
      return;
    }

    placeholder.textContent = message;
    placeholder.style.opacity = '1';
    placeholder.style.pointerEvents = 'auto';
  }, []);

  const getSurevideotoolCamGuideMessage = useCallback((hasLiveVideo: boolean) => {
    if (hasLiveVideo) {
      return 'Avatar Mimic Real Time is live. In WhatsApp, Zoom, or OBS, select "Avatar Mimic Real Time" as your camera. This window is only a live mirror.';
    }

    if (isStreamingRef.current) {
      return 'Waiting for Avatar Mimic Real Time video. Keep the session running, then select "Avatar Mimic Real Time" as your camera in WhatsApp, Zoom, or OBS.';
    }

    return 'Click Start in Avatar Mimic Real Time first. When the session is live, select "Avatar Mimic Real Time" as your camera in WhatsApp, Zoom, or OBS.';
  }, []);

  const updateSurevideotoolCamStatus = useCallback((message: string | null) => {
    const status = surevideotoolCamStatusRef.current;

    if (!status) {
      return;
    }

    if (!message) {
      status.textContent = '';
      status.style.opacity = '0';
      return;
    }

    status.textContent = message;
    status.style.opacity = '1';
  }, []);

  const startVirtualCameraPublisher = useCallback(() => {
    if (!window.electron || virtualCameraPublisherStartedRef.current || virtualCameraStartInFlightRef.current) {
      return;
    }

    const startPromise = window.electron.invoke('virtual-camera:start')
      .then((result: { success?: boolean; error?: string } | undefined) => {
        if (!result?.success) {
          virtualCameraPublisherStartedRef.current = false;
          console.warn('Failed to start Avatar Mimic Real Time virtual camera:', result?.error ?? 'Unknown error');
          if (result?.error) {
            toast.error(result.error);
          }
          return;
        }

        if (!surevideotoolCamWindowEnabledRef.current) {
          return;
        }

        virtualCameraPublisherStartedRef.current = true;
      })
      .catch((err: unknown) => {
        virtualCameraPublisherStartedRef.current = false;
        console.warn('Failed to start Avatar Mimic Real Time virtual camera:', err);
        toast.error('Unable to start Avatar Mimic Real Time virtual camera.');
      })
      .finally(() => {
        virtualCameraStartInFlightRef.current = null;
      });

    virtualCameraStartInFlightRef.current = startPromise;
  }, []);

  const stopSurevideotoolCamRenderLoop = useCallback(() => {
    const popup = surevideotoolCamWindowRef.current;
    if (popup && surevideotoolCamRenderHandleRef.current !== null) {
      popup.cancelAnimationFrame(surevideotoolCamRenderHandleRef.current);
    }

    surevideotoolCamRenderHandleRef.current = null;
  }, []);

  const stopMainVirtualCamRenderLoop = useCallback(() => {
    if (mainVirtualCamRenderHandleRef.current !== null) {
      window.clearTimeout(mainVirtualCamRenderHandleRef.current);
    }

    mainVirtualCamRenderHandleRef.current = null;
  }, []);

  const pushSurevideotoolCamFrame = useCallback((canvas: HTMLCanvasElement, context: CanvasRenderingContext2D) => {
    if (!window.electron?.sendVirtualCameraFrame) {
      return;
    }

    const imageData = context.getImageData(0, 0, canvas.width, canvas.height);
    window.electron.sendVirtualCameraFrame({
      width: canvas.width,
      height: canvas.height,
      stride: canvas.width * 4,
      pixels: new Uint8ClampedArray(imageData.data),
    });
  }, []);

  const startSurevideotoolCamRenderLoop = useCallback(() => {
    const popup = surevideotoolCamWindowRef.current;
    const video = surevideotoolCamVideoRef.current;
    const canvas = surevideotoolCamCanvasRef.current;

    if (!popup || popup.closed || !video || !canvas) {
      return;
    }

    stopSurevideotoolCamRenderLoop();

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!context) {
      return;
    }

    const renderFrame = () => {
      const currentPopup = surevideotoolCamWindowRef.current;
      const currentVideo = surevideotoolCamVideoRef.current;
      const currentCanvas = surevideotoolCamCanvasRef.current;

      if (!currentPopup || currentPopup.closed || !currentVideo || !currentCanvas) {
        surevideotoolCamRenderHandleRef.current = null;
        return;
      }

      context.fillStyle = '#000000';
      context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        drawVideoFrameContain(context, currentVideo, currentCanvas.width, currentCanvas.height);


      }

      surevideotoolCamRenderHandleRef.current = currentPopup.requestAnimationFrame(renderFrame);
    };

    surevideotoolCamRenderHandleRef.current = popup.requestAnimationFrame(renderFrame);
  }, [stopSurevideotoolCamRenderLoop]);

  const startMainVirtualCamRenderLoop = useCallback(() => {
    if (!surevideotoolCamWindowEnabledRef.current) {
      return;
    }

    const video = outputVideoRef.current;
    if (!video) {
      return;
    }

    let canvas = mainVirtualCamCanvasRef.current;
    if (!canvas) {
      canvas = document.createElement('canvas');
      canvas.width = SUREVIDEOTOOL_CAM_FRAME_WIDTH;
      canvas.height = SUREVIDEOTOOL_CAM_FRAME_HEIGHT;
      mainVirtualCamCanvasRef.current = canvas;
    }

    stopMainVirtualCamRenderLoop();
    let nextFrameDue = performance.now();

    const context = canvas.getContext('2d', {
      alpha: false,
      desynchronized: true,
      willReadFrequently: true,
    });

    if (!context) {
      return;
    }

    const renderFrame = () => {
      const currentVideo = outputVideoRef.current;
      const currentCanvas = mainVirtualCamCanvasRef.current;

      if (!surevideotoolCamWindowEnabledRef.current || !currentVideo || !currentCanvas) {
        mainVirtualCamRenderHandleRef.current = null;
        return;
      }

      context.fillStyle = '#000000';
      context.fillRect(0, 0, currentCanvas.width, currentCanvas.height);

      if (currentVideo.readyState >= 2 && currentVideo.videoWidth > 0 && currentVideo.videoHeight > 0) {
        drawVideoFrameContain(context, currentVideo, currentCanvas.width, currentCanvas.height);

        pushSurevideotoolCamFrame(currentCanvas, context);
      }

      const now = performance.now();
      nextFrameDue = Math.max(nextFrameDue, now - SUREVIDEOTOOL_CAM_FRAME_INTERVAL_MS) + SUREVIDEOTOOL_CAM_FRAME_INTERVAL_MS;
      mainVirtualCamRenderHandleRef.current = window.setTimeout(renderFrame, Math.max(0, Math.ceil(nextFrameDue - now)));
    };

    renderFrame();
  }, [pushSurevideotoolCamFrame, stopMainVirtualCamRenderLoop]);

  const renderSurevideotoolCamWindowShell = useCallback((popup: Window) => {
    const doc = popup.document;

    doc.open();
    doc.write(`
      <!DOCTYPE html>
      <html lang="en">
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0" />
          <title>Avatar Mimic Real Time Cam</title>
          <style>
            html, body {
              width: 100%;
              height: 100%;
              margin: 0;
              background: #000;
              overflow: hidden;
              font-family: Arial, sans-serif;
            }

            body {
              display: flex;
              align-items: center;
              justify-content: center;
            }

            #surevideotool-cam-root {
              position: relative;
              width: 100vw;
              height: 100vh;
              background: #000;
            }

            #surevideotool-cam-output {
              width: 100%;
              height: 100%;
              object-fit: contain;
              background: #000;
            }

            #surevideotool-cam-video {
              position: absolute;
              width: 1px;
              height: 1px;
              opacity: 0;
              pointer-events: none;
            }

            #surevideotool-cam-placeholder {
              position: absolute;
              inset: 0;
              display: flex;
              align-items: center;
              justify-content: center;
              padding: 24px;
              text-align: center;
              color: #f4f4f5;
              background:
                radial-gradient(circle at top, rgba(59, 130, 246, 0.16), transparent 52%),
                linear-gradient(180deg, rgba(10, 10, 10, 0.82), rgba(0, 0, 0, 0.92));
              font-size: 14px;
              line-height: 1.7;
              letter-spacing: 0.01em;
              transition: opacity 180ms ease;
            }

            #surevideotool-cam-status {
              position: absolute;
              left: 50%;
              bottom: 24px;
              transform: translateX(-50%);
              padding: 10px 14px;
              border: 1px solid rgba(255, 255, 255, 0.12);
              border-radius: 999px;
              background: rgba(10, 10, 10, 0.7);
              color: #f4f4f5;
              font-size: 12px;
              letter-spacing: 0.04em;
              backdrop-filter: blur(10px);
              transition: opacity 180ms ease;
            }
          </style>
        </head>
        <body>
          <div id="surevideotool-cam-root">
            <canvas id="surevideotool-cam-output" width="${SUREVIDEOTOOL_CAM_FRAME_WIDTH}" height="${SUREVIDEOTOOL_CAM_FRAME_HEIGHT}"></canvas>
            <video id="surevideotool-cam-video" autoplay playsinline muted></video>
            <div id="surevideotool-cam-placeholder">
              Click Start in Avatar Mimic Real Time first. When the session is live, select &quot;Avatar Mimic Real Time&quot; as your camera in WhatsApp, Zoom, or OBS.
            </div>
            <div id="surevideotool-cam-status">Connecting Avatar Mimic Real Time cam...</div>
          </div>
        </body>
      </html>
    `);
    doc.close();
    doc.title = 'Avatar Mimic Real Time Cam';

    surevideotoolCamCanvasRef.current = doc.getElementById('surevideotool-cam-output') as HTMLCanvasElement | null;
    surevideotoolCamVideoRef.current = doc.getElementById('surevideotool-cam-video') as HTMLVideoElement | null;
    surevideotoolCamStatusRef.current = doc.getElementById('surevideotool-cam-status') as HTMLDivElement | null;
    surevideotoolCamPlaceholderRef.current = doc.getElementById('surevideotool-cam-placeholder') as HTMLDivElement | null;

    if (latestRemoteStreamRef.current && surevideotoolCamVideoRef.current) {
      surevideotoolCamVideoRef.current.srcObject = latestRemoteStreamRef.current;
      void surevideotoolCamVideoRef.current.play().catch(() => {});
      startSurevideotoolCamRenderLoop();
      updateSurevideotoolCamStatus(null);
      updateSurevideotoolCamPlaceholder(null);
    } else {
      updateSurevideotoolCamPlaceholder(getSurevideotoolCamGuideMessage(false));
    }

    popup.onbeforeunload = () => {
      stopSurevideotoolCamRenderLoop();
      resetSurevideotoolCamRefs();
    };
  }, [getSurevideotoolCamGuideMessage, resetSurevideotoolCamRefs, startSurevideotoolCamRenderLoop, stopSurevideotoolCamRenderLoop, updateSurevideotoolCamPlaceholder, updateSurevideotoolCamStatus]);

  const ensureSurevideotoolCamWindow = useCallback((statusMessage: string) => {
    if (typeof window === 'undefined') {
      return null;
    }

    const popup = surevideotoolCamWindowRef.current;
    if (!popup) {
      return null;
    }

    if (popup.closed) {
      resetSurevideotoolCamRefs();
      return null;
    }

    if (!popup.document.getElementById('surevideotool-cam-output') || !popup.document.getElementById('surevideotool-cam-video')) {
      renderSurevideotoolCamWindowShell(popup);
    }

    popup.document.title = 'Avatar Mimic Real Time Cam';
    updateSurevideotoolCamStatus(statusMessage);

    if (!latestRemoteStreamRef.current) {
      updateSurevideotoolCamPlaceholder(getSurevideotoolCamGuideMessage(false));
    }

    return popup;
  }, [getSurevideotoolCamGuideMessage, renderSurevideotoolCamWindowShell, resetSurevideotoolCamRefs, updateSurevideotoolCamPlaceholder, updateSurevideotoolCamStatus]);

  const syncSurevideotoolCamStream = useCallback((stream: MediaStream, statusMessage?: string | null) => {
    latestRemoteStreamRef.current = stream;

    if (!surevideotoolCamWindowEnabledRef.current) {
      return;
    }

    startVirtualCameraPublisher();
    startMainVirtualCamRenderLoop();

    const popup = ensureSurevideotoolCamWindow(statusMessage ?? 'Preparing Avatar Mimic Real Time cam...');
    if (!popup || popup.closed) {
      return;
    }

    const popupVideo = surevideotoolCamVideoRef.current;
    if (!popupVideo) {
      return;
    }

    if (popupVideo.srcObject !== stream) {
      popupVideo.srcObject = stream;
    }

    popupVideo.playbackRate = 1;
    popupVideo.onloadedmetadata = () => {
      void popupVideo.play().catch(() => {});
      startSurevideotoolCamRenderLoop();
      updateSurevideotoolCamStatus(null);
      updateSurevideotoolCamPlaceholder(null);
    };

    if (popupVideo.readyState >= 2) {
      void popupVideo.play().catch(() => {});
      startSurevideotoolCamRenderLoop();
      updateSurevideotoolCamStatus(null);
      updateSurevideotoolCamPlaceholder(null);
    }
  }, [ensureSurevideotoolCamWindow, startMainVirtualCamRenderLoop, startSurevideotoolCamRenderLoop, startVirtualCameraPublisher, updateSurevideotoolCamPlaceholder, updateSurevideotoolCamStatus]);

  const closeSurevideotoolCamWindow = useCallback((options?: { clearStream?: boolean }) => {
    if (options?.clearStream) {
      latestRemoteStreamRef.current = null;
    }

    stopSurevideotoolCamRenderLoop();
    stopMainVirtualCamRenderLoop();

    if (surevideotoolCamVideoRef.current) {
      surevideotoolCamVideoRef.current.srcObject = null;
    }

    const popup = surevideotoolCamWindowRef.current;
    if (popup && !popup.closed) {
      popup.close();
    }

    resetSurevideotoolCamRefs();
  }, [resetSurevideotoolCamRefs, stopMainVirtualCamRenderLoop, stopSurevideotoolCamRenderLoop]);

  const clearFrameWatchdog = useCallback(() => {
    if (frameWatchdogIntervalRef.current) {
      clearInterval(frameWatchdogIntervalRef.current);
      frameWatchdogIntervalRef.current = null;
    }
  }, []);

  const cleanupClientSubscriptions = useCallback(() => {
    clientSubscriptionsCleanupRef.current?.();
    clientSubscriptionsCleanupRef.current = null;
  }, []);

  const cancelRemoteFrameMonitor = useCallback(() => {
    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;

    if (video?.cancelVideoFrameCallback && frameCallbackHandleRef.current !== null) {
      video.cancelVideoFrameCallback(frameCallbackHandleRef.current);
    }

    frameCallbackHandleRef.current = null;
  }, []);

  const markRemoteFrameFresh = useCallback(() => {
    lastRemoteFrameAtRef.current = performance.now();

    if (!hasRemoteFrameRef.current) {
      hasRemoteFrameRef.current = true;
      setHasRemoteFrame(true);
    }
  }, []);

  const startRemoteFrameMonitor = useCallback(() => {
    cancelRemoteFrameMonitor();

    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
    if (!video?.requestVideoFrameCallback) {
      return;
    }

    const onFrame: VideoFrameRequestCallback = () => {
      markRemoteFrameFresh();
      frameCallbackHandleRef.current = video.requestVideoFrameCallback?.(onFrame) ?? null;
    };

    frameCallbackHandleRef.current = video.requestVideoFrameCallback(onFrame);
  }, [cancelRemoteFrameMonitor, markRemoteFrameFresh]);

  const bindOutputStream = useCallback((stream: MediaStream, statusMessage: string) => {
    const video = outputVideoRef.current as VideoElementWithFrameCallbacks | null;
    if (!video) {
      return;
    }

    if (video.srcObject !== stream) {
      video.srcObject = stream;
    }

    video.playbackRate = 1;
    video.latencyHint = 'interactive';

    const playOutput = () => {
      void video.play().catch(() => {});
      markRemoteFrameFresh();
      startRemoteFrameMonitor();
    };

    video.onloadedmetadata = playOutput;

    if (video.readyState >= 2) {
      playOutput();
    }

    if (canPublishVirtualCameraFrames()) {
      syncSurevideotoolCamStream(stream, statusMessage);
    }
  }, [markRemoteFrameFresh, startRemoteFrameMonitor, syncSurevideotoolCamStream]);

  const stopWebcam = useCallback(() => {
    if (webcamStreamRef.current) {
      webcamStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamStreamRef.current = null;
    }

    if (webcamSourceStreamRef.current) {
      webcamSourceStreamRef.current.getTracks().forEach((track) => track.stop());
      webcamSourceStreamRef.current = null;
    }

    if (webcamVideoRef.current) {
      webcamVideoRef.current.srcObject = null;
    }
  }, []);

  const stopVirtualCameraPublisher = useCallback(() => {
    surevideotoolCamWindowEnabledRef.current = false;
    virtualCameraPublisherStartedRef.current = false;
    virtualCameraStartInFlightRef.current = null;

    if (window.electron) {
      void window.electron.invoke('virtual-camera:stop').catch((err: unknown) => {
        console.warn('Failed to stop virtual camera publisher:', err);
      });
    }
  }, []);

  const disconnectFromRealtimeAI = useCallback((options?: { skipStateUpdate?: boolean }) => {
    // Keep the watchdog running during recovery; only Stop/unmount clears it.
    cleanupClientSubscriptions();

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
      transformSyncTimerRef.current = null;
    }

    transformInFlightRef.current = false;
    pendingTransformRef.current = null;
    setIsSyncingTransform(false);

    if (realtimeClientRef.current) {
      realtimeClientRef.current = null;
    }

    cancelRemoteFrameMonitor();
    lastRemoteFrameAtRef.current = 0;
    hasRemoteFrameRef.current = false;
    setHasRemoteFrame(false);

    if (outputVideoRef.current) {
      outputVideoRef.current.srcObject = null;
    }

    if (!options?.skipStateUpdate) closeSurevideotoolCamWindow();

    lastAppliedTransformRef.current = null;
    setStreamMetrics(createEmptyStreamMetrics());
    if (!options?.skipStateUpdate) {
      setConnectionState('disconnected');
    }
  }, [cancelRemoteFrameMonitor, cleanupClientSubscriptions, closeSurevideotoolCamWindow]);

  const getDesiredTransformState = useCallback((): TransformState => ({
    prompt: promptRef.current,
    enhance: DEFAULT_ENHANCE,
    image: referenceImageRef.current?.file ?? null,
    imageSignature: referenceImageRef.current?.signature ?? null,
  }), []);

  const applyTrackProfileWithFallback = useCallback(async (
    track: MediaStreamTrack,
    requestedMode: QualityMode,
  ): Promise<QualityMode> => {
    let attemptedMode = requestedMode;

    while (true) {
      try {
        track.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
        await track.applyConstraints(buildVideoTrackConstraints(attemptedMode));
        return attemptedMode;
      } catch (error) {
        if (attemptedMode === 'fast') {
          throw error;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, []);

  const startWebcam = useCallback(async (
    requestedMode: QualityMode,
    options?: { forceNewStream?: boolean; silent?: boolean },
  ): Promise<MediaStream | null> => {
    if (!options?.forceNewStream && webcamSourceStreamRef.current) {
      const existingTrack = webcamSourceStreamRef.current.getVideoTracks()[0];

      if (existingTrack && existingTrack.readyState === 'live') {
        try {
          const appliedMode = await applyTrackProfileWithFallback(existingTrack, requestedMode);

          webcamStreamRef.current = webcamSourceStreamRef.current;

          if (appliedMode !== requestedMode) {
            setRuntimeModeCap((currentMode) => clampQualityMode(currentMode, appliedMode));
          }

          if (webcamVideoRef.current) {
            webcamVideoRef.current.srcObject = webcamSourceStreamRef.current;
          }

          return webcamSourceStreamRef.current;
        } catch (error) {
          console.warn('Failed to update camera constraints in place:', error);
        }
      }
    }

    let attemptedMode = requestedMode;

    while (true) {
      try {
        const nextStream = await navigator.mediaDevices.getUserMedia(
          buildVideoInputConstraints(attemptedMode, selectedCameraId || undefined),
        );
        const nextTrack = nextStream.getVideoTracks()[0];

        if (nextTrack) {
          nextTrack.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
        }

        const previousSourceStream = webcamSourceStreamRef.current;
        webcamSourceStreamRef.current = nextStream;
        webcamStreamRef.current = nextStream;

        if (webcamVideoRef.current) {
          webcamVideoRef.current.srcObject = nextStream;
        }

        if (previousSourceStream && previousSourceStream !== nextStream) {
          previousSourceStream.getTracks().forEach((track) => track.stop());
        }

        if (attemptedMode !== requestedMode) {
          setRuntimeModeCap((currentMode) => clampQualityMode(currentMode, attemptedMode));
        }

        return nextStream;
      } catch (error) {
        const isNotReadable =
          error instanceof DOMException && error.name === 'NotReadableError';

        // Camera is locked by another app — quality downgrade won't help.
        // Try once more without an exact deviceId so the browser can pick
        // any available camera instead of insisting on the busy one.
        if (isNotReadable && selectedCameraId) {
          try {
            const fallbackStream = await navigator.mediaDevices.getUserMedia(
              buildVideoInputConstraints(attemptedMode, undefined),
            );
            const fallbackTrack = fallbackStream.getVideoTracks()[0];

            if (fallbackTrack) {
              fallbackTrack.contentHint = attemptedMode === 'fast' ? 'motion' : 'detail';
            }

            const previousSourceStream = webcamSourceStreamRef.current;
            webcamSourceStreamRef.current = fallbackStream;
            webcamStreamRef.current = fallbackStream;

            if (webcamVideoRef.current) {
              webcamVideoRef.current.srcObject = fallbackStream;
            }

            if (previousSourceStream && previousSourceStream !== fallbackStream) {
              previousSourceStream.getTracks().forEach((track) => track.stop());
            }

            return fallbackStream;
          } catch {
            // fallback also failed — fall through to the give-up path below
          }
        }

        if (attemptedMode === 'fast') {
          console.error('Webcam error:', error);

          if (!options?.silent) {
            toast.error(
              isNotReadable
                ? 'Camera or microphone is already in use by another application. Close it and try again.'
                : 'Failed to access camera or microphone. Please check device permissions.',
            );
          }

          return null;
        }

        attemptedMode = downgradeQualityMode(attemptedMode);
      }
    }
  }, [applyTrackProfileWithFallback, selectedCameraId]);

  const flushTransformSync = useCallback(async (nextTransform: TransformState) => {
    const realtimeClient = realtimeClientRef.current;
    if (!realtimeClient) {
      return;
    }

    const nextSignature = buildTransformSignature(nextTransform);
    const lastSignature = lastAppliedTransformRef.current
      ? buildTransformSignature(lastAppliedTransformRef.current)
      : null;

    if (nextSignature === lastSignature) {
      return;
    }

    if (transformInFlightRef.current) {
      pendingTransformRef.current = nextTransform;
      return;
    }

    transformInFlightRef.current = true;
    setIsSyncingTransform(true);

    try {
      await applyRealtimeSessionState(realtimeClient, nextTransform);

      lastAppliedTransformRef.current = nextTransform;
    } catch (error) {
      console.error('Failed to sync live transformation:', error);
      toast.error('Live style update stalled. Recovering stream...');
    } finally {
      transformInFlightRef.current = false;
      setIsSyncingTransform(false);

      if (pendingTransformRef.current) {
        const queuedTransform = pendingTransformRef.current;
        pendingTransformRef.current = null;

        if (
          !lastAppliedTransformRef.current ||
          buildTransformSignature(queuedTransform) !== buildTransformSignature(lastAppliedTransformRef.current)
        ) {
          void flushTransformSync(queuedTransform);
        }
      }
    }
  }, []);

  const queueTransformSync = useCallback((nextTransform: TransformState, immediate = false) => {
    pendingTransformRef.current = nextTransform;

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    transformSyncTimerRef.current = setTimeout(() => {
      transformSyncTimerRef.current = null;
      const queuedTransform = pendingTransformRef.current;
      pendingTransformRef.current = null;

      if (queuedTransform) {
        void flushTransformSync(queuedTransform);
      }
    }, immediate ? 0 : TRANSFORM_SYNC_DEBOUNCE_MS);
  }, [flushTransformSync]);

  const handleRealtimeStats = useCallback((stats: RealtimeStats) => {
    const inboundFps = Math.round(stats.video?.framesPerSecond ?? 0);
    const outboundFps = Math.round(stats.outboundVideo?.framesPerSecond ?? 0);
    const bitrate = stats.video?.bitrate ?? stats.outboundVideo?.bitrate ?? 0;

    setStreamMetrics({
      fps: inboundFps || outboundFps,
      frameWidth: stats.video?.frameWidth ?? stats.outboundVideo?.frameWidth ?? 0,
      frameHeight: stats.video?.frameHeight ?? stats.outboundVideo?.frameHeight ?? 0,
      rttMs: stats.connection.currentRoundTripTime !== null
        ? Math.round(stats.connection.currentRoundTripTime * 1000)
        : null,
      limitation: stats.outboundVideo?.qualityLimitationReason ?? 'none',
      bitrateKbps: Math.round(bitrate / 1000),
    });

    // Outgoing camera frames do not prove that AI output is still arriving.
    if ((stats.video?.framesPerSecond ?? 0) > 0) {
      markRemoteFrameFresh();
    }

  }, [markRemoteFrameFresh]);

  const connectToRealtimeAI = useCallback(async (
    stream: MediaStream,
    initialTransform: TransformState,
    maxSessionSeconds: number,
    options?: { isRecovery?: boolean },
  ): Promise<RealtimeClient | null> => {
    const epoch = sessionEpochRef.current;
    const meteredSessionId = sessionIdRef.current;
    const isCurrent = () => activeSessionRef.current && sessionEpochRef.current === epoch;
    try {
      if (surevideotoolCamWindowEnabledRef.current && surevideotoolCamWindowRef.current && !surevideotoolCamWindowRef.current.closed) {
        updateSurevideotoolCamStatus(options?.isRecovery ? 'Reconnecting Avatar Mimic Real Time cam...' : 'Connecting Avatar Mimic Real Time cam...');
        updateSurevideotoolCamPlaceholder(getSurevideotoolCamGuideMessage(false));
      }

      const morphlySdkUrl: string = 'https://morphly.fun/sdk/morphly.js';
      const { createMorphlyClient } = await import(/* @vite-ignore */ morphlySdkUrl);
      if (!isCurrent()) return null;
      const client = createMorphlyClient({
        // apiFetchWithAuth keeps the permanent MORPHLY_API_KEY on the server
        // while the SDK receives only its short-lived session credential.
        tokenEndpoint: '/morphly-token',
        fetch: createMorphlyFetch(apiFetchWithAuth, meteredSessionId),
      });

      const realtimeClient = await client.realtime.connect(stream, {
        model: REALTIME_MODEL_ID,
        resolution: '720p',
        maxSessionSeconds,
        onRemoteStream: (editedStream: MediaStream) => {
          if (!isCurrent()) return;
          bindOutputStream(
            editedStream,
            options?.isRecovery ? 'Reconnecting Avatar Mimic Real Time cam...' : 'Connecting Avatar Mimic Real Time cam...',
          );
        },
        prompt: initialTransform.prompt,
        enhancePrompt: initialTransform.enhance,
        image: initialTransform.image ?? undefined,
      });

      if (!isCurrent()) {
        await disconnectRealtimeClient(realtimeClient);
        return null;
      }
      cleanupClientSubscriptions();
      // connect() already applies the image/prompt. Reapplying it resets generation.

      const onConnectionChange = (nextState: ConnectionState) => {
        if (!isCurrent() || realtimeClientRef.current !== realtimeClient) return;
        const previousState = connectionStateRef.current;

        // Some SDK builds emit both events for the same transition; ignore duplicate state notifications.
        if (previousState === nextState) {
          return;
        }

        connectionStateRef.current = nextState;
        setConnectionState(nextState);
        console.log('Realtime state:', nextState);

        if (nextState === 'reconnecting' || nextState === 'disconnected') {
          setUiStatus('Reconnecting...');
          // The watchdog recovers the connection without ending the metered session.
        }
        if (nextState === 'connected' || nextState === 'generating') {
          setUiStatus('Live');
          restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
        }
      };

      const onStats = (stats: RealtimeStats) => {
        if (!isCurrent()) return;
        handleRealtimeStats(stats);
      };

      const onError = (error: { message: string; code?: string }) => {
        console.error('[Realtime AI] stream error:', error);

        // Morphly stop/settlement errors that need user-facing handling.
        const code = error?.code || '';
        if (code === 'REALTIME_SETUP_REQUIRED') {
          toast.error('Realtime service is being updated by Morphly. Please try again shortly.');
        }
      };

      // Morphly billing/credit lifecycle events. available_credits may stay
      // unchanged while streaming (charges spend reserved_credits). Do not
      // deduct wallet credits in the browser; just surface status.
      const onBalance = (balance: RealtimeBalance) => {
        if (balance && typeof balance.available_credits === 'number') {
          console.log('[Morphly] balance', {
            available: balance.available_credits,
            reserved: balance.reserved_credits,
            charged: balance.charged_credits,
            billable_seconds: balance.billable_seconds,
          });
        }
      };

      const onLowCredit = ({ level }: { level: number | string }) => {
        console.warn('[Morphly] low credit:', level);
        toast.warning('Streaming credits are running low. The stream may stop soon.');
      };

      const onCreditsExhausted = () => {
        if (!isCurrent()) return;
        toast.error('Streaming stopped - Morphly credits exhausted.');
        void safelyStopSessionRef.current?.();
      };

      realtimeClient.on('connectionChange', onConnectionChange);
      realtimeClient.on('stats', onStats);
      realtimeClient.on('error', onError);
      realtimeClient.on('balance', onBalance);
      realtimeClient.on('lowCredit', onLowCredit);
      realtimeClient.on('creditsExhausted', onCreditsExhausted);

      clientSubscriptionsCleanupRef.current = () => {
        realtimeClient.off('connectionChange', onConnectionChange);
        realtimeClient.off('stats', onStats);
        realtimeClient.off('error', onError);
        realtimeClient.off('balance', onBalance);
        realtimeClient.off('lowCredit', onLowCredit);
        realtimeClient.off('creditsExhausted', onCreditsExhausted);
      };

      realtimeClientRef.current = realtimeClient as RealtimeClient;
      lastAppliedTransformRef.current = initialTransform;
      const initialState = realtimeClient.getState?.() ?? realtimeClient.getConnectionState?.() ?? 'connected';
      connectionStateRef.current = initialState;
      setConnectionState(initialState);
      setUiStatus('Live');
      setStreamMetrics(createEmptyStreamMetrics());
      hasRemoteFrameRef.current = false;
      setHasRemoteFrame(false);
      lastRemoteFrameAtRef.current = performance.now();

      if (!options?.isRecovery) {
        toast.success('Connected to AI!');
      }

      return realtimeClient as RealtimeClient;
    } catch (error) {
      console.error('[Realtime AI] SDK error:', error);

      const errorMessage = getRealtimeSdkErrorMessage(error) || '';
      const errorStatus = (error as { status?: number })?.status;

      // 402 = Morphly has no usable realtime credit. This is not recoverable by
      // reconnecting — retrying only stacks more reserved-credit holds. Surface a
      // clear message and stop immediately instead of entering the restart loop.
      const insufficientCredits = errorStatus === 402 || /credit|insufficient|payment/i.test(errorMessage);
      if (insufficientCredits) {
        toast.error('Streaming unavailable: no usable Morphly credits. Check your Morphly balance and try again.');
        void safelyStopSessionRef.current?.();
        return null;
      }

      if (!options?.isRecovery) {
        toast.error(
          errorMessage
            ? `Failed to connect to AI: ${errorMessage}`
            : 'Failed to connect to AI',
        );
      }

      return null;
    }
  }, [
    bindOutputStream,
    cleanupClientSubscriptions,
    getSurevideotoolCamGuideMessage,
    handleRealtimeStats,
    updateSurevideotoolCamPlaceholder,
    updateSurevideotoolCamStatus,
  ]);

  const restartRealtimeSession = useCallback(async (
    reason: string,
    options?: { immediate?: boolean },
  ) => {
    if (!isStreamingRef.current || restartInFlightRef.current || !activeSessionRef.current) return;
    const epoch = sessionEpochRef.current;
    const isCurrent = () => activeSessionRef.current && sessionEpochRef.current === epoch;
    restartInFlightRef.current = true;
    setUiStatus('Reconnecting...');
    try {
      if (!options?.immediate) await sleep(restartRetryDelayRef.current);
      if (!isCurrent()) return;
      if (remainingSessionSeconds(sessionDeadlineRef.current, performance.now()) <= 0) {
        await safelyStopSessionRef.current?.();
        return;
      }
      // Settlement must complete before requesting another provider session.
      cleanupClientSubscriptions();
      await disconnectRealtimeClient(realtimeClientRef.current);
      if (!isCurrent()) return;
      disconnectFromRealtimeAI({ skipStateUpdate: true });
      const currentStream = await startWebcam(activeModeRef.current, { silent: true });
      if (!isCurrent()) {
        currentStream?.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!currentStream) throw new Error('Camera unavailable during recovery');
      const seconds = remainingSessionSeconds(sessionDeadlineRef.current, performance.now());
      if (seconds <= 0) {
        await safelyStopSessionRef.current?.();
        return;
      }
      const client = await connectToRealtimeAI(currentStream, getDesiredTransformState(), seconds, { isRecovery: true });
      if (!isCurrent()) return;
      if (!client) throw new Error('Restart failed: ' + reason);
      restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
      setUiStatus('Live');
    } catch (error) {
      if (!isCurrent()) return;
      console.error('[Realtime AI] restart failed:', error);
      restartRetryDelayRef.current = Math.min(restartRetryDelayRef.current * 2, MAX_RETRY_DELAY_MS);
      connectionStateRef.current = 'disconnected';
      setConnectionState('disconnected');
    } finally {
      if (sessionEpochRef.current === epoch) restartInFlightRef.current = false;
    }
  }, [cleanupClientSubscriptions, connectToRealtimeAI, disconnectFromRealtimeAI, getDesiredTransformState, startWebcam]);

  const handleStop = useCallback(async (options?: { silent?: boolean }) => {
    if (safeStopInFlightRef.current) return;
    safeStopInFlightRef.current = true;
    const sessionId = sessionIdRef.current;
    const wasActive = activeSessionRef.current;
    const client = realtimeClientRef.current;
    // Cancel pending starts/retries synchronously, before any network work.
    sessionEpochRef.current += 1;
    activeSessionRef.current = false;
    isStreamingRef.current = false;
    restartInFlightRef.current = false;
    sessionIdRef.current = '';
    sessionDeadlineRef.current = 0;
    cleanupClientSubscriptions();
    if (pollIntervalRef.current) clearInterval(pollIntervalRef.current);
    pollIntervalRef.current = null;
    clearFrameWatchdog();
    stopVirtualCameraPublisher();
    disconnectFromRealtimeAI();
    stopWebcam();
    setIsStreaming(false);
    setIsLoading(true);
    setSessionStatus('IDLE');
    setUiStatus('Disconnected');
    restartRetryDelayRef.current = INITIAL_RETRY_DELAY_MS;
    try {
      await disconnectRealtimeClient(client).catch((error) => console.warn('Provider stop failed:', error));
      if (wasActive && sessionId) {
        const response = await apiRequest<{ remainingCredits?: number | null }>('/end-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id, sessionId }),
        });
        if (typeof response.remainingCredits === 'number' && Number.isFinite(response.remainingCredits)) {
          setCredits(response.remainingCredits);
        }
      }
      if (!options?.silent) toast.info('Session stopped');
    } catch (error) {
      console.error('Stop session error:', error);
    } finally {
      safeStopInFlightRef.current = false;
      setIsLoading(false);
    }
  }, [cleanupClientSubscriptions, clearFrameWatchdog, disconnectFromRealtimeAI, setCredits, setSessionStatus, stopVirtualCameraPublisher, stopWebcam, user?.id]);

  useEffect(() => {
    handleStopRef.current = handleStop;
    safelyStopSessionRef.current = () => handleStop({ silent: true });
  }, [handleStop]);

  const pollSessionStatus = useCallback(async () => {
    const sessionId = sessionIdRef.current;
    const epoch = sessionEpochRef.current;
    if (!user?.id || !sessionId || !activeSessionRef.current) return;
    try {
      const response = await apiRequest<{
        credits: number;
        remainingCredits?: number;
        shouldStop: boolean;
        forceEnd?: boolean;
      }>('/session-status?userId=' + user.id + '&sessionId=' + sessionId);
      if (!activeSessionRef.current || sessionEpochRef.current !== epoch) return;
      const live = response.remainingCredits ?? response.credits;
      if (typeof live === 'number' && Number.isFinite(live)) setCredits(live);
      if (response.shouldStop || response.forceEnd) {
        await handleStop({ silent: true });
        toast.error('Session ended - No streaming minutes remaining');
      }
    } catch (error) {
      console.error('Poll error:', error);
    }
  }, [handleStop, setCredits, user?.id]);

  const enumerateCameras = useCallback(async () => {
    try {
      const devices = await navigator.mediaDevices.enumerateDevices();
      const videoDevices = devices.filter((device) => device.kind === 'videoinput');
      setCameraDevices(videoDevices);

      if (videoDevices.length > 0 && (!selectedCameraId || !videoDevices.some((device) => device.deviceId === selectedCameraId))) {
        const builtinCamera = videoDevices.find((device) =>
          device.label.toLowerCase().includes('integrated') ||
          device.label.toLowerCase().includes('built-in') ||
          device.label.toLowerCase().includes('facetime') ||
          device.label.toLowerCase().includes('internal'),
        );

        setSelectedCameraId(builtinCamera?.deviceId || videoDevices[0].deviceId);
      }
    } catch (error) {
      console.error('Failed to enumerate cameras:', error);
    }
  }, [selectedCameraId]);

  useEffect(() => () => {
    sessionEpochRef.current += 1;
    activeSessionRef.current = false;
    isStreamingRef.current = false;
    if (pollIntervalRef.current) {
      clearInterval(pollIntervalRef.current);
    }

    if (transformSyncTimerRef.current) {
      clearTimeout(transformSyncTimerRef.current);
    }

    clearFrameWatchdog();
    cleanupClientSubscriptions();
    cancelRemoteFrameMonitor();
    closeSurevideotoolCamWindow({ clearStream: true });
    // Fire-and-forget on unmount; settlement may remain pending and is reconciled server-side.
    void disconnectRealtimeClient(realtimeClientRef.current).catch((error) => console.warn('Unmount stop failed:', error));
    webcamStreamRef.current?.getTracks().forEach((track) => track.stop());
    webcamSourceStreamRef.current?.getTracks().forEach((track) => track.stop());
  }, [cancelRemoteFrameMonitor, cleanupClientSubscriptions, clearFrameWatchdog, closeSurevideotoolCamWindow]);

  useEffect(() => {
    enumerateCameras();
    navigator.mediaDevices.addEventListener('devicechange', enumerateCameras);
    return () => navigator.mediaDevices.removeEventListener('devicechange', enumerateCameras);
  }, [enumerateCameras]);

  useEffect(() => {
    if (!isStreaming) {
      hasRemoteFrameRef.current = false;
      clearFrameWatchdog();
      setHasRemoteFrame(false);
      return undefined;
    }

    return undefined;
  }, [clearFrameWatchdog, isStreaming]);

  useEffect(() => {
    if (!isStreaming) {
      clearFrameWatchdog();
      return;
    }

    clearFrameWatchdog();
    frameWatchdogIntervalRef.current = setInterval(() => {
      if (!activeSessionRef.current || restartInFlightRef.current) return;
      if (shouldRestartRealtime(connectionStateRef.current, lastRemoteFrameAtRef.current, performance.now(), FREEZE_RESTART_THRESHOLD_MS)) {
        void restartRealtimeSession('output-watchdog');
      }
    }, RESTART_WATCHDOG_INTERVAL_MS);

    return clearFrameWatchdog;
  }, [clearFrameWatchdog, isStreaming, restartRealtimeSession]);

  useEffect(() => {
    if (!isStreaming) {
      return;
    }

    void startWebcam(activeMode, { silent: true }).catch((error) => {
      console.error('Failed to apply camera profile:', error);
    });
  }, [activeMode, isStreaming, startWebcam]);

  useEffect(() => {
    if (!isStreaming || !realtimeClientRef.current) {
      return;
    }

    queueTransformSync({
      prompt,
      enhance: DEFAULT_ENHANCE,
      image: referenceImage?.file ?? null,
      imageSignature: referenceImage?.signature ?? null,
    });
  }, [
    isStreaming,
    prompt,
    queueTransformSync,
    referenceImage?.file,
    referenceImage?.signature,
  ]);

  useEffect(() => {
    if (!selectedCameraId) {
      return;
    }

    if (!previousCameraIdRef.current) {
      previousCameraIdRef.current = selectedCameraId;
      return;
    }

    if (previousCameraIdRef.current === selectedCameraId) {
      return;
    }

    previousCameraIdRef.current = selectedCameraId;

    if (!isStreaming) {
      userInitiatedCameraChangeRef.current = false;
      return;
    }

    if (!userInitiatedCameraChangeRef.current) {
      return;
    }

    if (!['connected', 'generating'].includes(connectionStateRef.current)) {
      return;
    }

    void (async () => {
      const stream = await startWebcam(activeMode, {
        forceNewStream: true,
        silent: true,
      });

      if (stream) {
        await restartRealtimeSession('camera-switched', { immediate: true });
      }

      userInitiatedCameraChangeRef.current = false;
    })();
  }, [activeMode, isStreaming, restartRealtimeSession, selectedCameraId, startWebcam]);

  const handleStart = async () => {
    if (!user?.id) {
      toast.error('Please sign in before starting a live stream.');
      return;
    }

    if (!referenceImageRef.current?.file) {
      toast.error('Upload a garment reference image before starting.');
      return;
    }

    if (isLoading || activeSessionRef.current || safeStopInFlightRef.current) return;
    const epoch = ++sessionEpochRef.current;
    setIsLoading(true);
    setConnectionState('connecting');
    setUiStatus('Preparing camera...');
    setRuntimeModeCap('hd');

    try {
      surevideotoolCamWindowEnabledRef.current = canPublishVirtualCameraFrames();

      const stream = await startWebcam(activeMode, { forceNewStream: true });
      if (sessionEpochRef.current !== epoch) {
        stream?.getTracks().forEach((track) => track.stop());
        return;
      }
      if (!stream) {
        throw new Error('Webcam start failed');
      }

      setUiStatus('Connecting...');
      const startResponse = await apiRequest<{
        allowed: boolean;
        error?: string;
        credits?: number;
        maxSeconds?: number;
        sessionId?: string;
      }>('/start-session', {
        method: 'POST',
        body: JSON.stringify({ userId: user?.id }),
      });

      if (sessionEpochRef.current !== epoch) {
        if (startResponse.sessionId) {
          await apiRequest('/end-session', { method: 'POST', body: JSON.stringify({ userId: user.id, sessionId: startResponse.sessionId }) });
        }
        return;
      }
      if (!startResponse.allowed) {
        toast.error(startResponse.error?.replace(/credits?/gi, 'streaming minutes') || 'Insufficient streaming minutes');
        stopVirtualCameraPublisher();
        stopWebcam();
        closeSurevideotoolCamWindow({ clearStream: true });
        setIsLoading(false);
        return;
      }

      if (startResponse.credits !== undefined) {
        setCredits(startResponse.credits);
      }

      if (!startResponse.sessionId) {
        throw new Error('Missing metered session ID');
      }

      activeSessionRef.current = true;
      sessionIdRef.current = startResponse.sessionId || '';
      const seconds = Math.max(1, Math.floor(startResponse.maxSeconds || 300));
      sessionDeadlineRef.current = performance.now() + seconds * 1000;

      const realtimeClient = await connectToRealtimeAI(
        stream,
        getDesiredTransformState(),
        remainingSessionSeconds(sessionDeadlineRef.current, performance.now()),
      );

      if (sessionEpochRef.current !== epoch) return;
      if (!realtimeClient) {
        throw new Error('AI connection was not established');
      }

      if (pollIntervalRef.current) {
        clearInterval(pollIntervalRef.current);
      }

      pollIntervalRef.current = setInterval(pollSessionStatus, POLLING_INTERVAL);
      isStreamingRef.current = true;
      setIsStreaming(true);
      setSessionStatus('LIVE');
      setUiStatus('Live');

      toast.success('Avatar Mimic Real Time is live.');
    } catch (error) {
      if (sessionEpochRef.current !== epoch) return;
      console.error('Start session error:', error);
      const toastMessage = getStartSessionErrorToast(error);
      if (toastMessage) {
        toast.error(toastMessage);
      }

      if (activeSessionRef.current) {
        await apiRequest('/end-session', {
          method: 'POST',
          body: JSON.stringify({ userId: user?.id, sessionId: sessionIdRef.current }),
        }).catch((rollbackError) => {
          console.error('Failed to roll back session start:', rollbackError);
        });
      }

      activeSessionRef.current = false;
      sessionEpochRef.current += 1;
      sessionIdRef.current = '';
      stopVirtualCameraPublisher();
      stopWebcam();
      disconnectFromRealtimeAI();
      closeSurevideotoolCamWindow({ clearStream: true });
      setIsStreaming(false);
      setSessionStatus('IDLE');
      setUiStatus('Disconnected');
    } finally {
      setIsLoading(false);
    }
  };

  const handleFileChange = (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = '';

    if (!file) {
      return;
    }

    setReferenceImage({
      file,
      name: file.name,
      signature: `${file.name}:${file.size}:${file.lastModified}`,
    });

    if (isStreaming) {
      toast.info('Updating reference image...');
    } else {
      toast.success('Reference image selected. Click Start to begin streaming.');
    }
  };

  const handleModeChange = (mode: string) => {
    if (!mode) {
      return;
    }

    setRuntimeModeCap('hd');
    setPreferredMode(mode as QualityMode);
  };

  const handleCameraChange = (cameraId: string) => {
    if (!cameraId || cameraId === selectedCameraId) {
      return;
    }

    userInitiatedCameraChangeRef.current = true;
    setSelectedCameraId(cameraId);
  };

  const getRemainingSeconds = () => Math.floor(credits / CREDITS_PER_SECOND);
  const statusDetail = `${(streamMetrics.limitation === 'none' ? 'No throttling' : `${streamMetrics.limitation} limited`)} · ${uiStatus}`;

  const formatTime = (seconds: number) => {
    const mins = Math.floor(seconds / 60);
    const secs = seconds % 60;

    if (mins > 0) {
      return `~${mins}m ${secs}s`;
    }

    return `~${secs}s`;
  };

  return (
    <div className="flex h-screen w-screen flex-col overflow-hidden bg-black font-sans text-white">
      <main className="relative flex flex-1 items-center justify-center overflow-hidden bg-[#000000] shadow-inner">
        <UpdateBanner />
        {userNotification && (
          <div className={`absolute inset-x-4 top-14 z-30 mx-auto max-w-3xl rounded-lg border px-4 py-3 shadow-2xl backdrop-blur-md ${
            userNotification.severity === 'critical'
              ? 'border-red-400/50 bg-red-950/90 text-red-50'
              : userNotification.severity === 'info'
                ? 'border-blue-400/50 bg-blue-950/90 text-blue-50'
                : 'border-amber-400/50 bg-amber-950/90 text-amber-50'
          }`}>
            <div className="flex items-start gap-3">
              <div className="mt-1 h-2 w-2 shrink-0 rounded-full bg-current" />
              <div>
                <p className="text-[10px] font-bold uppercase tracking-[0.18em]">{userNotification.severity === 'info' ? 'Information' : userNotification.severity === 'critical' ? 'Critical notice' : 'Warning'}</p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-5">{userNotification.message}</p>
              </div>
            </div>
          </div>
        )}
        <video
          id="output"
          ref={outputVideoRef}
          autoPlay
          playsInline
          muted
          onLoadedData={markRemoteFrameFresh}
          onPlaying={markRemoteFrameFresh}
          className="h-full w-full object-contain transition-[opacity,filter] duration-200"
          style={{
            display: isStreaming ? 'block' : 'none',
            opacity: hasRemoteFrame ? 1 : 0.85,
            willChange: 'transform, opacity',
            transform: 'translateZ(0)',
            backfaceVisibility: 'hidden',
            imageRendering: 'auto',
          }}
        />

        {!isStreaming && (
          <div className="flex flex-col items-center justify-center gap-5 text-[#3F3F46]">
            <Monitor className="h-[60px] w-[60px] stroke-[1]" />
            <span className="text-xs font-semibold tracking-[0.2em] text-[#4A4A4A]">CAMERA FEED OFFLINE</span>
          </div>
        )}

        <input
          type="file"
          title="Upload image"
          ref={fileInputRef}
          onChange={handleFileChange}
          accept="image/*"
          className="hidden"
          id="image-upload"
        />

        {isStreaming && (isLoading || isSyncingTransform || connectionState === 'reconnecting' || !hasRemoteFrame) && (
          <div className="pointer-events-none absolute inset-x-0 bottom-8 z-20 flex justify-center px-6">
            <div className="inline-flex items-center gap-2 rounded-full border border-white/10 bg-black/55 px-4 py-2 text-xs text-white/90 shadow-xl shadow-black/30 backdrop-blur-md">
              <LoaderCircle className="h-4 w-4 animate-spin" />
              <span>
                {isSyncingTransform
                  ? 'Applying prompt/image changes without reconnecting...'
                  : connectionState === 'reconnecting'
                    ? 'Reconnecting stream...'
                    : 'Preparing realtime output...'}
              </span>
            </div>
          </div>
        )}

        {isStreaming && (
          <div className="pointer-events-none absolute left-4 top-4 z-20 inline-flex items-center gap-1.5 rounded-full border border-white/10 bg-black/55 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-[0.18em] text-white/80 backdrop-blur-md">
            <span className="relative flex h-1.5 w-1.5">
              <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-rose-500/70" />
              <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-rose-500" />
            </span>
            Live
          </div>
        )}
      </main>

      <footer className="relative z-10 flex flex-col gap-1.5 border-t border-white/5 bg-[#0A0A0A] px-2.5 py-1.5 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex flex-wrap items-center gap-1.5">
          <button
            onClick={handleStart}
            disabled={isStreaming || isLoading}
            className={`flex h-7 items-center gap-1.5 rounded border px-2.5 transition-all ${
              isStreaming
                ? 'border-[#133C29] bg-[#122A1F] text-[#22C55E] opacity-50'
                : 'border-[#133C29] bg-[#122A1F] text-[#22C55E] hover:bg-[#153828]'
            }`}
          >
            <Play className="h-3 w-3 fill-current" />
            <span className="text-[11px] font-semibold tracking-wide">
              {isLoading ? 'Starting' : 'Start'}
            </span>
          </button>

          <button
            onClick={() => void handleStop()}
            disabled={!isStreaming}
            className="flex h-7 items-center gap-1.5 rounded border border-[#2A2A2A] bg-[#1E1E1E] px-2.5 text-[#737373] transition-all hover:text-[#A3A3A3] disabled:opacity-50"
          >
            <Square className="h-3 w-3 fill-current opacity-70" />
            <span className="text-[11px] font-medium">Stop</span>
          </button>

          <button
            onClick={() => fileInputRef.current?.click()}
            className="flex h-7 items-center gap-1.5 rounded border border-[#2A2A2A] bg-[#1E1E1E] px-2.5 text-[#737373] transition-all hover:text-[#A3A3A3]"
          >
            <Upload className="h-3 w-3 opacity-80" />
            <span className="text-[11px] font-medium">{referenceImage ? 'Change' : 'Upload'}</span>
          </button>

          <select
            value={preferredMode}
            onChange={(event) => handleModeChange(event.target.value)}
            title="Select performance mode"
            aria-label="Select performance mode"
            className="h-7 rounded border border-[#2A2A2A] bg-[#1A1A1A] px-1.5 text-[11px] font-medium text-[#D4D4D8] transition-colors focus:border-[#3A3A3A] focus:outline-none"
          >
            <option value="fast">Fast</option>
            <option value="balanced">Balanced</option>
            <option value="hd">HD</option>
          </select>

          {cameraDevices.length >= 1 && (
            <select
              value={selectedCameraId}
              onChange={(event) => handleCameraChange(event.target.value)}
              title="Select input camera"
              aria-label="Select input camera"
              className="h-7 max-w-[180px] rounded border border-[#2A2A2A] bg-[#1E1E1E] px-1.5 text-[11px] text-[#A3A3A3] transition-colors focus:border-[#3A3A3A] focus:outline-none"
            >
              {cameraDevices.map((device, index) => (
                <option key={device.deviceId} value={device.deviceId}>
                  {device.label || `Camera ${index + 1}`}
                </option>
              ))}
            </select>
          )}

        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <div className="flex h-9 items-center gap-2 rounded-md border border-[#222222] bg-[#111111] px-2">
            <div className="flex flex-col leading-tight">
              <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-[#A1A1AA]">Time left</span>
              <div className="flex items-center gap-1">
                <Coins className="h-3 w-3 text-blue-400" />
                <span className="text-[11px] font-bold text-[#22C55E] tabular-nums">{formatTime(getRemainingSeconds())}</span>
              </div>
            </div>
            <button
              onClick={() => navigate('/subscription')}
              className="flex h-6 items-center gap-1 rounded-sm bg-white px-2 text-[10px] font-bold text-black shadow-sm transition-colors hover:bg-[#E5E5E5]"
            >
              <Plus className="h-3 w-3 stroke-[3]" />
              Buy
            </button>
            <button
              title="Settings"
              aria-label="Settings"
              onClick={() => navigate('/settings')}
              className="flex h-6 w-6 items-center justify-center rounded-sm border border-[#2A2A2A] bg-[#1A1A1A] text-[#A1A1AA] transition-colors hover:border-[#3A3A3A] hover:text-white"
            >
              <Settings className="h-3.5 w-3.5" />
            </button>
          </div>

          <div className="flex h-9 min-w-[120px] items-center gap-2 rounded-md border border-[#0F284B] bg-[#0E1524] px-2">
            <Clock className="h-3.5 w-3.5 stroke-[2.5] text-[#3B82F6]" />
            <div className="flex flex-col leading-tight">
              <span className="text-[8px] font-bold uppercase tracking-[0.18em] text-[#60A5FA]">Remaining</span>
              <span className="text-[11px] font-bold text-[#E5E5E5] tabular-nums">{formatTime(getRemainingSeconds())}</span>
              <span className="text-[9px] text-[#6B7280]">{statusDetail}</span>
            </div>
          </div>
        </div>
      </footer>
    </div>
  );
}

export default Dashboard;
