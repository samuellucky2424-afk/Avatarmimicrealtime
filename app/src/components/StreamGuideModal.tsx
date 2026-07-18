import { useEffect, useState } from 'react';
import {
  X,
  Tv,
  FilePlus2,
  MousePointerSquareDashed,
  Scaling,
  PlayCircle,
  AppWindow,
  Video,
  CheckCircle2,
  Lightbulb,
  Zap,
  AlertTriangle,
  MonitorPlay,
} from 'lucide-react';

interface StreamGuideModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StreamGuideModal({ isOpen, onClose }: StreamGuideModalProps) {
  const [dontShowAgain, setDontShowAgain] = useState(false);

  useEffect(() => {
    const saved = localStorage.getItem('hide_obs_guide');
    if (saved === 'true') {
      setDontShowAgain(true);
    }
  }, [isOpen]);

  const handleDontShowChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const checked = e.target.checked;
    setDontShowAgain(checked);
    if (checked) {
      localStorage.setItem('hide_obs_guide', 'true');
    } else {
      localStorage.removeItem('hide_obs_guide');
    }
  };

  if (!isOpen) return null;

  const steps = [
    {
      num: 1,
      title: 'Start Avatar Mimic Real Time',
      desc: 'Begin your Avatar Mimic Real Time session, then click "Open Capture Window" only when you want to send the feed out.',
      icon: <CheckCircle2 className="w-4 h-4 text-green-500" />,
    },
    {
      num: 2,
      title: 'Open SplitCam or OBS',
      desc: 'Launch SplitCam or OBS Studio on your computer.',
      icon: <MonitorPlay className="w-4 h-4 text-blue-400" />,
    },
    {
      num: 3,
      title: 'Add Window Capture',
      desc: 'Create a Window Capture source instead of choosing Avatar Mimic Real Time as a webcam device.',
      icon: <FilePlus2 className="w-4 h-4 text-emerald-400" />,
    },
    {
      num: 4,
      title: 'Select Avatar Mimic Real Time Cam',
      desc: 'Choose the Avatar Mimic Real Time capture window from the list of open windows.',
      icon: <MousePointerSquareDashed className="w-4 h-4 text-purple-400" />,
    },
    {
      num: 5,
      title: 'Fit the Frame',
      desc: 'Resize or crop the capture so only the Avatar Mimic Real Time video fills the frame.',
      icon: <Scaling className="w-4 h-4 text-orange-400" />,
    },
    {
      num: 6,
      title: 'Start Virtual Camera',
      desc: 'If another app needs a webcam device, start SplitCam Camera or OBS Virtual Camera.',
      icon: <PlayCircle className="w-4 h-4 text-pink-400" />,
    },
    {
      num: 7,
      title: 'Open Meeting App',
      desc: 'Open Zoom, WhatsApp, Meet, or any app where you want to use the feed.',
      icon: <AppWindow className="w-4 h-4 text-indigo-400" />,
    },
    {
      num: 8,
      title: 'Pick SplitCam or OBS',
      desc: 'Select SplitCam Camera or OBS Virtual Camera as the final video source.',
      icon: <Video className="w-4 h-4 text-cyan-400" />,
    },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm animate-in fade-in duration-200">
      <div className="relative flex max-h-[90vh] w-full max-w-2xl flex-col rounded-2xl border border-[#27272A] bg-[#0F0F12] shadow-2xl animate-in zoom-in-95 duration-200">
        <div className="flex flex-shrink-0 items-center justify-between border-b border-[#27272A] p-6">
          <div>
            <h2 className="flex items-center gap-2 text-xl font-bold text-white">
              <Tv className="h-5 w-5 text-blue-500" />
              How to Stream Avatar Mimic Real Time
            </h2>
            <p className="mt-1 text-sm text-[#A1A1AA]">
              Send Avatar Mimic Real Time into SplitCam, OBS, Zoom, WhatsApp, and similar apps
            </p>
          </div>
          <button
            onClick={onClose}
            className="rounded-full bg-[#18181B] p-2 text-[#A1A1AA] transition-colors hover:bg-[#27272A] hover:text-white"
          >
            <X className="h-4 w-4" />
          </button>
        </div>

        <div className="custom-scrollbar flex-1 space-y-8 overflow-y-auto p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
            {steps.map((step) => (
              <div key={step.num} className="flex items-start gap-4 rounded-xl border border-[#27272A] bg-[#18181B] p-4">
                <div className="flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-full bg-[#27272A] text-xs font-bold text-white shadow-inner">
                  {step.num}
                </div>
                <div>
                  <h3 className="mb-1 flex items-center gap-1.5 text-sm font-semibold text-white">
                    {step.title}
                    <span className="opacity-80">{step.icon}</span>
                  </h3>
                  <p className="text-xs text-[#A1A1AA]">{step.desc}</p>
                </div>
              </div>
            ))}
          </div>

          <div className="flex items-start gap-3 rounded-xl border border-[#28315C] bg-[#1C2033] p-4">
            <Lightbulb className="mt-0.5 h-5 w-5 flex-shrink-0 text-blue-400" />
            <div>
              <h4 className="text-sm font-semibold text-blue-100">Pro Tip</h4>
              <p className="mt-1 text-xs leading-relaxed text-blue-200/80">
                If your app shows Avatar Mimic Real Time in its camera list, select it directly. If Avatar Mimic Real Time is not available,
                add the Avatar Mimic Real Time cam window in SplitCam or OBS as Window Capture, then publish through SplitCam Camera
                or OBS Virtual Camera for Zoom, WhatsApp, and similar apps.
              </p>
            </div>
          </div>

          <div className="space-y-3">
            <div className="flex items-start gap-3 rounded-xl border border-[#4D2E12] bg-[#2A1D11] p-4">
              <Zap className="mt-0.5 h-5 w-5 flex-shrink-0 text-amber-500" />
              <div>
                <h4 className="text-sm font-semibold text-amber-200">Billing Notice</h4>
                <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-amber-200/70">
                  <li>Streaming consumes minutes in real time</li>
                  <li>Charges are calculated per second during active sessions</li>
                  <li>Ensure you have enough minutes before starting</li>
                </ul>
              </div>
            </div>

            <div className="flex items-start gap-3 rounded-xl border border-[#522121] bg-[#2A1515] p-4">
              <AlertTriangle className="mt-0.5 h-5 w-5 flex-shrink-0 text-red-400" />
              <div>
                <h4 className="text-sm font-semibold text-red-200">Important Policy</h4>
                <ul className="mt-1.5 list-inside list-disc space-y-1 text-xs text-red-200/70">
                  <li>All payments are final and non-refundable</li>
                  <li>Purchased streaming time cannot be reversed once used</li>
                  <li>By using Avatar Mimic Real Time, you agree to this policy</li>
                </ul>
              </div>
            </div>
          </div>
        </div>

        <div className="flex flex-shrink-0 flex-col items-center justify-between gap-4 rounded-b-2xl border-t border-[#27272A] bg-[#18181B] p-4 sm:flex-row">
          <label className="group flex cursor-pointer items-center gap-2">
            <input
              type="checkbox"
              checked={dontShowAgain}
              onChange={handleDontShowChange}
              className="h-4 w-4 cursor-pointer rounded border-[#3F3F46] bg-[#27272A] text-blue-500 transition-all focus:ring-blue-500 focus:ring-offset-0"
            />
            <span className="text-sm text-[#A1A1AA] transition-colors group-hover:text-white">Don&apos;t show again</span>
          </label>
          <div className="flex w-full items-center gap-3 sm:w-auto">
            <button
              onClick={onClose}
              className="w-full rounded-xl bg-blue-600 px-6 py-2.5 text-sm font-semibold text-white transition-all hover:bg-blue-500 hover:shadow-blue-500/20 sm:w-auto"
            >
              I Understand
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
