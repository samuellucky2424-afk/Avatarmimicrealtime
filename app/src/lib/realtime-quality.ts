export type QualityMode = 'fast' | 'balanced' | 'hd';

// The exported canvas and both native camera drivers use this fixed format.
// Camera capture and the AI provider can supply a smaller source image.
export const VIDEO_OUTPUT_WIDTH = 1820;
export const VIDEO_OUTPUT_HEIGHT = 720;
export const VIDEO_OUTPUT_FPS = 24;

type QualityProfile = {
  label: string;
  width: number;
  height: number;
  targetFps: number;
  maxFps: number;
  enhance: boolean;
};

export const QUALITY_MODE_PROFILES: Record<QualityMode, QualityProfile> = {
  fast: {
    label: 'Fast',
    width: 640,
    height: 352,
    targetFps: VIDEO_OUTPUT_FPS,
    maxFps: VIDEO_OUTPUT_FPS,
    enhance: false,
  },
  balanced: {
    label: 'Balanced',
    width: 960,
    height: 528,
    targetFps: VIDEO_OUTPUT_FPS,
    maxFps: VIDEO_OUTPUT_FPS,
    enhance: false,
  },
  hd: {
    label: 'HD',
    width: VIDEO_OUTPUT_WIDTH,
    height: VIDEO_OUTPUT_HEIGHT,
    targetFps: VIDEO_OUTPUT_FPS,
    maxFps: VIDEO_OUTPUT_FPS,
    enhance: false,
  },
};

const QUALITY_MODE_ORDER: QualityMode[] = ['fast', 'balanced', 'hd'];

export function getQualityModeRank(mode: QualityMode): number {
  return QUALITY_MODE_ORDER.indexOf(mode);
}

export function getAdaptiveQualityMode(downlinkMbps?: number | null): QualityMode {
  if (!downlinkMbps || !Number.isFinite(downlinkMbps)) {
    return 'hd';
  }

  if (downlinkMbps < 2.5) {
    return 'fast';
  }

  if (downlinkMbps < 6) {
    return 'balanced';
  }

  return 'hd';
}

export function clampQualityMode(requestedMode: QualityMode, capMode: QualityMode): QualityMode {
  return getQualityModeRank(requestedMode) <= getQualityModeRank(capMode) ? requestedMode : capMode;
}

export function downgradeQualityMode(mode: QualityMode): QualityMode {
  const modeIndex = getQualityModeRank(mode);
  return QUALITY_MODE_ORDER[Math.max(0, modeIndex - 1)];
}

export function upgradeQualityMode(mode: QualityMode, ceilingMode: QualityMode = 'hd'): QualityMode {
  const nextRank = Math.min(
    getQualityModeRank(mode) + 1,
    getQualityModeRank(ceilingMode),
  );
  return QUALITY_MODE_ORDER[nextRank];
}

export function buildVideoTrackConstraints(mode: QualityMode): MediaTrackConstraints {
  const profile = QUALITY_MODE_PROFILES[mode];

  return {
    width: {
      ideal: profile.width,
    },
    height: {
      ideal: profile.height,
    },
    aspectRatio: {
      ideal: profile.width / profile.height,
    },
    frameRate: {
      ideal: profile.targetFps,
      max: profile.maxFps,
      min: Math.max(15, profile.targetFps - 6),
    },
  };
}

export function buildVideoInputConstraints(
  mode: QualityMode,
  deviceId?: string,
): MediaStreamConstraints {
  const videoConstraints = buildVideoTrackConstraints(mode);

  videoConstraints.facingMode = {
    ideal: 'user',
  };

  if (deviceId) {
    videoConstraints.deviceId = {
      exact: deviceId,
    };
  }

  return {
    video: videoConstraints,
    audio: true,
  };
}
