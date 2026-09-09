import { VIDEO_OUTPUT_FPS, VIDEO_OUTPUT_HEIGHT, VIDEO_OUTPUT_WIDTH } from '@/lib/realtime-quality';

/**
 * VirtualCameraService
 * 
 * Lightweight virtual camera implementation that captures the video output
 * to a canvas and exposes it as a MediaStream.
 * 
 * Note: For full system-wide virtual camera (Zoom/WhatsApp), a driver like OBS Virtual Camera
 * is typically required. This service prepares the stream for such integrations and
 * manages the frame processing efficiently.
 */

export class VirtualCameraService {
  private canvas: HTMLCanvasElement | null = null;
  private ctx: CanvasRenderingContext2D | null = null;
  private stream: MediaStream | null = null;
  private renderTimer: ReturnType<typeof setTimeout> | null = null;
  private videoElement: HTMLVideoElement | null = null;
  private isActive: boolean = false;
  private targetWidth: number = VIDEO_OUTPUT_WIDTH;
  private targetHeight: number = VIDEO_OUTPUT_HEIGHT;
  private targetFps: number = VIDEO_OUTPUT_FPS;
  private nextFrameDue: number = 0;

  constructor() {}

  public async start(videoElement: HTMLVideoElement): Promise<MediaStream | null> {
    if (this.isActive) return this.stream;

    this.videoElement = videoElement;
    this.canvas = document.createElement('canvas');
    this.canvas.width = this.targetWidth;
    this.canvas.height = this.targetHeight;
    this.ctx = this.canvas.getContext('2d', { 
      alpha: false, 
      desynchronized: true, // Optimize for frequent changes
      willReadFrequently: false // Optimize for write-only
    });

    if (!this.ctx) {
      console.error('Failed to get 2D context from canvas');
      return null;
    }

    try {
      // At zero fps the browser captures only when requestFrame is called.
      this.stream = this.canvas.captureStream(0);
      this.isActive = true;
      this.nextFrameDue = performance.now();
      this.renderLoop();
      return this.stream;
    } catch (error) {
      console.error('Failed to create virtual camera stream:', error);
      return null;
    }
  }

  private renderLoop = () => {
    if (!this.isActive || !this.videoElement || !this.ctx || !this.canvas) return;

    // Check if video is ready before drawing
    if (this.videoElement.readyState >= 2) {
      try {
        const sourceWidth = this.videoElement.videoWidth || this.targetWidth;
        const sourceHeight = this.videoElement.videoHeight || this.targetHeight;
        const scale = Math.min(this.targetWidth / sourceWidth, this.targetHeight / sourceHeight);
        const width = sourceWidth * scale;
        const height = sourceHeight * scale;
        this.ctx.fillStyle = '#000000';
        this.ctx.fillRect(0, 0, this.targetWidth, this.targetHeight);
        this.ctx.imageSmoothingEnabled = true;
        this.ctx.imageSmoothingQuality = 'high';
        this.ctx.drawImage(this.videoElement,
          (this.targetWidth - width) / 2, (this.targetHeight - height) / 2, width, height);
        const track = this.stream?.getVideoTracks()[0] as CanvasCaptureMediaStreamTrack | undefined;
        track?.requestFrame();
      } catch (error) {
        console.warn('Virtual Camera frame draw error:', error);
      }
    }

    const frameInterval = 1000 / this.targetFps;
    const now = performance.now();
    this.nextFrameDue = Math.max(this.nextFrameDue, now - frameInterval) + frameInterval;
    this.renderTimer = setTimeout(this.renderLoop, Math.max(0, Math.ceil(this.nextFrameDue - now)));
  };

  public stop() {
    this.isActive = false;
    if (this.renderTimer !== null) {
      clearTimeout(this.renderTimer);
      this.renderTimer = null;
    }
    if (this.stream) {
      this.stream.getTracks().forEach(track => track.stop());
      this.stream = null;
    }
    if (this.canvas) {
      this.canvas.remove();
      this.canvas = null;
    }
    this.ctx = null;
    this.videoElement = null;
  }

  public getStream(): MediaStream | null {
    return this.stream;
  }

  public getCanvas(): HTMLCanvasElement | null {
    return this.canvas;
  }

  public setResolution(width: number, height: number) {
    if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
      throw new RangeError('Virtual camera dimensions must be positive integers.');
    }
    if (this.canvas) {
      this.canvas.width = width;
      this.canvas.height = height;
    }
    this.targetWidth = width;
    this.targetHeight = height;
  }

  public setFramerate(fps: number) {
    if (!Number.isFinite(fps) || fps <= 0) {
      throw new RangeError('Virtual camera frame rate must be positive.');
    }
    this.targetFps = Math.min(fps, VIDEO_OUTPUT_FPS);
    this.nextFrameDue = performance.now();
  }
}
