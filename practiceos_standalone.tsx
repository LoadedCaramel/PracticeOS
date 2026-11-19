import React, {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

/**
 * PracticeOS — Standalone Simulated Android-like Environment & Event Director
 *
 * Designed as an isolated, reusable module (`PracticeOS` + exported types)
 * that renders any JSON-defined phone scenario without app-specific hardcoding.
 *
 * Exports:
 *  - Named exports: `PracticeOS`, `evaluateDirectorTriggers`, `createEmptySandboxLog`,
 *    plus all TypeScript interfaces (`PhoneApp`, `PhoneScreen`, `ScriptEvent`, etc.)
 *  - Default export: `App` (an interactive workbench wrapper with a live telemetry
 *    inspector so you can test and develop PracticeOS standalone).
 */

// ============================================================================
// 1. PUBLIC DATA CONTRACTS (Drop-in compatible with Zod schemas)
// ============================================================================

export type ScreenLayout =
  | 'list'
  | 'thread'
  | 'detail'
  | 'dialer'
  | 'call'
  | 'form'
  | 'keypad';

export interface Block {
  id: string;
  kind: 'info' | 'message' | 'field' | 'warning' | 'transaction' | 'toggle';
  sender?: string;
  senderMeta?: string;
  title?: string;
  body: string;
  timestamp?: string;
  isIncoming?: boolean;
  classification?: 'legit' | 'scam';
  explanationId?: string;
  linkLabel?: string;
  linkTargetAppId?: string;
  linkTargetScreenId?: string;
  openAppId?: string;
  openScreenId?: string;
}

export interface Action {
  id: string;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
  grantsStepId?: string;
  triggersUnsafeId?: string;
  wrongChannelId?: string;
  falseAlarmExplanationId?: string;
  phishingClueNote?: string;
  nextAppId?: string;
  nextScreenId?: string;
  feedbackMessage: string;
}

export interface PhoneScreen {
  id: string;
  title: string;
  subtitle?: string;
  layout: ScreenLayout;
  keypadHint?: string;
  keypadTrapUnsafeId?: string;
  keypadTrapMessage?: string;
  dialNumbers?: Array<{
    number: string;
    label: string;
    targetScreenId: string;
    wrongChannelId?: string;
  }>;
  blocks: Block[];
  actions: Action[];
}

export interface PhoneApp {
  id: string;
  name: string;
  iconKey: string;
  accentColor: string;
  homeScreenId: string;
  screens: Record<string, PhoneScreen>;
}

export type Trigger =
  | { type: 'atSecond'; seconds: number }
  | { type: 'afterAction'; actionId: string }
  | { type: 'ifIdleFor'; seconds: number }
  | { type: 'onAppOpened'; appId: string }
  | { type: 'onScreenShown'; screenId: string };

export interface CallReplyOption {
  id: string;
  label: string;
  tone: 'primary' | 'secondary' | 'danger';
  grantsStepId?: string;
  triggersUnsafeId?: string;
  wrongChannelId?: string;
  nextAppId?: string;
  nextScreenId?: string;
  endCall?: boolean;
  feedbackMessage: string;
}

export type EventPayload =
  | {
      type: 'notification';
      appId: string;
      screenId: string;
      appName: string;
      title: string;
      body: string;
    }
  | {
      type: 'incomingSms';
      appId: string;
      screenId: string;
      sender: string;
      body: string;
    }
  | {
      type: 'chatMessage';
      appId: string;
      screenId: string;
      sender: string;
      body: string;
    }
  | {
      type: 'incomingCall';
      callerName: string;
      callerNumber: string;
      pressureTag: string;
      dialogueLines: string[];
      replies: CallReplyOption[];
    }
  | {
      type: 'callDialogueLine';
      line: string;
    }
  | {
      type: 'changeBattery';
      batteryPercent: number;
    }
  | {
      type: 'changeBalance';
      newBalance: string;
    }
  | {
      type: 'showBanner';
      text: string;
    }
  | {
      type: 'endDrill';
      reason: string;
    };

export interface ScriptEvent {
  id: string;
  trigger: Trigger;
  event: EventPayload;
  label?: 'legit' | 'scam';
  explanationId?: string;
}

export interface PracticeOSPhoneConfig {
  scenarioId: string;
  startTime: string;
  startDate: string;
  initialBattery: number;
  apps: string[];
  appDefinitions: Record<string, PhoneApp>;
  inbox: ScriptEvent[];
  script: ScriptEvent[];
  totalExpectedSteps?: number;
}

export interface ActionLogEntry {
  timestampSec: number;
  appId: string;
  screenId: string;
  actionId: string;
  label: string;
}

export interface SandboxSessionLog {
  completedStepOrder: string[];
  triggeredUnsafeIds: string[];
  wrongChannelIds: string[];
  falseAlarmIds: string[];
  phishingClueNotes: string[];
  actionsLog: ActionLogEntry[];
  timedOut: boolean;
}

export function createEmptySandboxLog(): SandboxSessionLog {
  return {
    completedStepOrder: [],
    triggeredUnsafeIds: [],
    wrongChannelIds: [],
    falseAlarmIds: [],
    phishingClueNotes: [],
    actionsLog: [],
    timedOut: false,
  };
}

// ============================================================================
// 2. EVENT DIRECTOR (Pure Deterministic Scheduler)
// ============================================================================

export function hashSeed(input: string): number {
  let hash = 2166136261;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return hash >>> 0;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function next(): number {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface DirectorContext {
  elapsedSeconds: number;
  idleSeconds: number;
  currentAppId: string | null;
  currentScreenId: string | null;
  completedActionIds: ReadonlySet<string>;
  firedEventIds: ReadonlySet<string>;
  paceMultiplier: number; // 1.0 for normal, 1.6 for relaxed mode
  seedKey: string;
}

export function evaluateDirectorTriggers(
  script: readonly ScriptEvent[],
  ctx: DirectorContext
): ScriptEvent[] {
  const rng = mulberry32(hashSeed(ctx.seedKey));
  const jitterOffset = Math.floor(rng() * 2); // 0 or 1s seeded timing jitter
  const due: ScriptEvent[] = [];

  for (const item of script) {
    if (ctx.firedEventIds.has(item.id)) {
      continue;
    }
    const trig = item.trigger;
    if (trig.type === 'atSecond') {
      const target = Math.round(trig.seconds * ctx.paceMultiplier) + jitterOffset;
      if (ctx.elapsedSeconds >= target) {
        due.push(item);
      }
    } else if (trig.type === 'ifIdleFor') {
      const targetIdle =
        Math.round(trig.seconds * ctx.paceMultiplier) + jitterOffset;
      if (ctx.idleSeconds >= targetIdle) {
        due.push(item);
      }
    } else if (trig.type === 'afterAction') {
      if (ctx.completedActionIds.has(trig.actionId)) {
        due.push(item);
      }
    } else if (trig.type === 'onAppOpened') {
      if (ctx.currentAppId === trig.appId) {
        due.push(item);
      }
    } else if (trig.type === 'onScreenShown') {
      if (ctx.currentScreenId === trig.screenId) {
        due.push(item);
      }
    }
  }
  return due;
}

// ============================================================================
// 3. PRACTICEOS SIMULATED PHONE COMPONENT
// ============================================================================

interface PracticeNotification {
  id: string;
  appId: string;
  screenId: string;
  appName: string;
  title: string;
  body: string;
  classification?: 'legit' | 'scam';
  explanationId?: string;
}

interface ActiveCallState {
  callerName: string;
  callerNumber: string;
  pressureTag: string;
  dialogueLines: string[];
  replies: CallReplyOption[];
  status: 'ringing' | 'connected';
  revealedLinesCount: number;
  speakerOn: boolean;
  muted: boolean;
}

interface NavHistoryEntry {
  view: 'lock' | 'home' | 'recents' | 'app';
  appId?: string;
  screenId?: string;
}

export interface PracticeOSProps {
  phone: PracticeOSPhoneConfig;
  paceMode?: 'timed' | 'relaxed' | 'untimed';
  deadlineMs?: number | null;
  startedAtMs?: number;
  initialView?: 'lock' | 'home';
  onLogChange?: (log: SandboxSessionLog) => void;
  onCompleteSandbox: (log: SandboxSessionLog) => void;
  onRequestExitPractice: () => void;
}

export function PracticeOS({
  phone,
  paceMode = 'untimed',
  deadlineMs = null,
  startedAtMs: externalStartedAtMs,
  initialView = 'lock',
  onLogChange,
  onCompleteSandbox,
  onRequestExitPractice,
}: PracticeOSProps) {
  const startedAtMs = useMemo(
    () => externalStartedAtMs ?? Date.now(),
    [externalStartedAtMs]
  );
  const paceMultiplier = paceMode === 'relaxed' ? 1.6 : 1.0;

  // Core PracticeOS state
  const [batteryPercent, setBatteryPercent] = useState<number>(
    phone.initialBattery
  );
  const [soundEnabled, setSoundEnabled] = useState<boolean>(true);
  const [shadeOpen, setShadeOpen] = useState<boolean>(false);
  const [navStack, setNavStack] = useState<NavHistoryEntry[]>([
    { view: initialView },
  ]);
  const [recentApps, setRecentApps] = useState<string[]>([]);
  const [notifications, setNotifications] = useState<PracticeNotification[]>(
    () =>
      phone.inbox.map((evt) => {
        const p = evt.event;
        if (p.type === 'notification') {
          return {
            id: evt.id,
            appId: p.appId,
            screenId: p.screenId,
            appName: p.appName,
            title: p.title,
            body: p.body,
            classification: evt.label,
            explanationId: evt.explanationId,
          };
        }
        return {
          id: evt.id,
          appId: 'messages',
          screenId: '',
          appName: 'Messages',
          title: 'New Alert',
          body: 'Tap to read',
          classification: evt.label,
          explanationId: evt.explanationId,
        };
      })
  );

  // Dynamic event state
  const [dynamicMessagesByScreen, setDynamicMessagesByScreen] = useState<
    Record<string, Block[]>
  >({});
  const [typingBanner, setTypingBanner] = useState<string | null>(null);
  const [osBanner, setOsBanner] = useState<string | null>(null);
  const [activeCall, setActiveCall] = useState<ActiveCallState | null>(null);
  const [pinTrapBanner, setPinTrapBanner] = useState<string | null>(null);
  const [latestToast, setLatestToast] = useState<string | null>(null);
  const [dialedDigits, setDialedDigits] = useState<string>('');

  // Telemetry & Director refs
  const [sandboxLog, setSandboxLog] = useState<SandboxSessionLog>(() =>
    createEmptySandboxLog()
  );
  const sandboxLogRef = useRef<SandboxSessionLog>(sandboxLog);
  sandboxLogRef.current = sandboxLog;
  const completedActionIdsRef = useRef<Set<string>>(new Set());
  const firedEventIdsRef = useRef<Set<string>>(new Set());
  const lastInteractionMsRef = useRef<number>(Date.now());
  const timeoutFiredRef = useRef<boolean>(false);

  const [secondsLeft, setSecondsLeft] = useState<number>(() => {
    if (deadlineMs === null) {
      return 0;
    }
    return Math.max(0, Math.ceil((deadlineMs - Date.now()) / 1000));
  });

  useEffect(() => {
    onLogChange?.(sandboxLog);
  }, [sandboxLog, onLogChange]);

  const currentNav = navStack[navStack.length - 1] ?? { view: initialView };

  const bumpInteraction = useCallback(() => {
    lastInteractionMsRef.current = Date.now();
  }, []);

  const navigateTo = useCallback(
    (entry: NavHistoryEntry) => {
      bumpInteraction();
      setShadeOpen(false);
      setPinTrapBanner(null);
      setNavStack((prev) => [...prev, entry]);
      if (entry.view === 'app' && entry.appId) {
        const appId = entry.appId;
        setRecentApps((prev) => [
          appId,
          ...prev.filter((id) => id !== appId),
        ]);
      }
    },
    [bumpInteraction]
  );

  const handlePracticeOSBack = useCallback(() => {
    bumpInteraction();
    if (shadeOpen) {
      setShadeOpen(false);
      return;
    }
    if (activeCall) {
      setActiveCall(null);
      return;
    }
    if (currentNav.view === 'home' || currentNav.view === 'lock') {
      onRequestExitPractice();
      return;
    }
    setNavStack((prev) =>
      prev.length > 1 ? prev.slice(0, prev.length - 1) : [{ view: 'home' }]
    );
  }, [
    bumpInteraction,
    shadeOpen,
    activeCall,
    currentNav.view,
    onRequestExitPractice,
  ]);

  // Escape key maps to Android hardware Back inside PracticeOS
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        handlePracticeOSBack();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handlePracticeOSBack]);

  // Optional Web Speech API captions voiceover
  const speakCallerLine = useCallback(
    (text: string) => {
      if (!soundEnabled) {
        return;
      }
      try {
        if (
          typeof window !== 'undefined' &&
          'speechSynthesis' in window &&
          typeof window.SpeechSynthesisUtterance !== 'undefined'
        ) {
          window.speechSynthesis.cancel();
          const utter = new window.SpeechSynthesisUtterance(text);
          utter.rate = 1.0;
          window.speechSynthesis.speak(utter);
        }
      } catch {
        // Fall back to visual captions only
      }
    },
    [soundEnabled]
  );

  useEffect(() => {
    return () => {
      try {
        if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
          window.speechSynthesis.cancel();
        }
      } catch {
        // Ignore
      }
    };
  }, []);

  // Main scheduler loop: countdown timer + Event Director
  useEffect(() => {
    const interval = window.setInterval(() => {
      const now = Date.now();
      const elapsedSec = Math.floor((now - startedAtMs) / 1000);
      const idleSec = Math.floor((now - lastInteractionMsRef.current) / 1000);

      if (deadlineMs !== null) {
        const rem = Math.max(0, Math.ceil((deadlineMs - now) / 1000));
        setSecondsLeft(rem);
        if (rem === 0 && !timeoutFiredRef.current) {
          timeoutFiredRef.current = true;
          onCompleteSandbox({ ...sandboxLogRef.current, timedOut: true });
          return;
        }
      }

      const dueEvents = evaluateDirectorTriggers(phone.script, {
        elapsedSeconds: elapsedSec,
        idleSeconds: idleSec,
        currentAppId: currentNav.appId ?? null,
        currentScreenId: currentNav.screenId ?? null,
        completedActionIds: completedActionIdsRef.current,
        firedEventIds: firedEventIdsRef.current,
        paceMultiplier,
        seedKey: phone.scenarioId + ':' + String(startedAtMs),
      });

      for (const evt of dueEvents) {
        firedEventIdsRef.current.add(evt.id);
        const payload = evt.event;

        if (payload.type === 'notification') {
          setNotifications((prev) => [
            {
              id: evt.id,
              appId: payload.appId,
              screenId: payload.screenId,
              appName: payload.appName,
              title: payload.title,
              body: payload.body,
              classification: evt.label,
              explanationId: evt.explanationId,
            },
            ...prev,
          ]);
          setOsBanner(payload.appName + ': ' + payload.title);
        } else if (
          payload.type === 'chatMessage' ||
          payload.type === 'incomingSms'
        ) {
          setTypingBanner(payload.sender + ' is typing...');
          window.setTimeout(() => {
            setTypingBanner(null);
            setDynamicMessagesByScreen((prev) => {
              const existing = prev[payload.screenId] ?? [];
              return {
                ...prev,
                [payload.screenId]: [
                  ...existing,
                  {
                    id: evt.id,
                    kind: 'message',
                    sender: payload.sender,
                    body: payload.body,
                    timestamp: 'Just now',
                    isIncoming: true,
                    classification: evt.label,
                    explanationId: evt.explanationId,
                  },
                ],
              };
            });
            setNotifications((prev) => [
              {
                id: evt.id + '_notif',
                appId: payload.appId,
                screenId: payload.screenId,
                appName: payload.sender,
                title: 'New message',
                body: payload.body,
                classification: evt.label,
                explanationId: evt.explanationId,
              },
              ...prev,
            ]);
          }, 900);
        } else if (payload.type === 'incomingCall') {
          try {
            if (
              soundEnabled &&
              typeof navigator !== 'undefined' &&
              'vibrate' in navigator
            ) {
              navigator.vibrate([200, 100, 200]);
            }
          } catch {
            // Optional vibration
          }
          setActiveCall({
            callerName: payload.callerName,
            callerNumber: payload.callerNumber,
            pressureTag: payload.pressureTag,
            dialogueLines: payload.dialogueLines,
            replies: payload.replies,
            status: 'ringing',
            revealedLinesCount: 0,
            speakerOn: true,
            muted: false,
          });
        } else if (payload.type === 'callDialogueLine') {
          setActiveCall((prev) =>
            prev
              ? {
                  ...prev,
                  dialogueLines: [...prev.dialogueLines, payload.line],
                }
              : null
          );
        } else if (payload.type === 'changeBattery') {
          setBatteryPercent(payload.batteryPercent);
        } else if (payload.type === 'showBanner') {
          setOsBanner(payload.text);
        } else if (payload.type === 'endDrill') {
          onCompleteSandbox({ ...sandboxLogRef.current, timedOut: false });
        }
      }
    }, 500);

    return () => window.clearInterval(interval);
  }, [
    startedAtMs,
    deadlineMs,
    phone,
    currentNav.appId,
    currentNav.screenId,
    paceMultiplier,
    soundEnabled,
    onCompleteSandbox,
  ]);

  // Reveal caller lines sequentially once call is answered
  useEffect(() => {
    if (!activeCall || activeCall.status !== 'connected') {
      return;
    }
    if (activeCall.revealedLinesCount >= activeCall.dialogueLines.length) {
      return;
    }
    const nextIdx = activeCall.revealedLinesCount;
    const delay = nextIdx === 0 ? 300 : Math.round(2400 * paceMultiplier);
    const timer = window.setTimeout(() => {
      const line = activeCall.dialogueLines[nextIdx];
      if (line) {
        speakCallerLine(line);
      }
      setActiveCall((prev) =>
        prev
          ? {
              ...prev,
              revealedLinesCount: Math.min(
                prev.dialogueLines.length,
                prev.revealedLinesCount + 1
              ),
            }
          : null
      );
    }, delay);

    return () => window.clearTimeout(timer);
  }, [activeCall, paceMultiplier, speakCallerLine]);

  // Execute a user tap inside PracticeOS
  const executePracticeAction = useCallback(
    (action: {
      id: string;
      label: string;
      grantsStepId?: string;
      triggersUnsafeId?: string;
      wrongChannelId?: string;
      falseAlarmExplanationId?: string;
      phishingClueNote?: string;
      nextAppId?: string;
      nextScreenId?: string;
      feedbackMessage: string;
    }) => {
      bumpInteraction();
      completedActionIdsRef.current.add(action.id);
      const elapsedSec = Math.max(
        1,
        Math.floor((Date.now() - startedAtMs) / 1000)
      );
      const appId = currentNav.appId ?? 'practiceos';
      const screenId = currentNav.screenId ?? currentNav.view;

      setSandboxLog((prev) => ({
        ...prev,
        completedStepOrder:
          action.grantsStepId &&
          !prev.completedStepOrder.includes(action.grantsStepId)
            ? [...prev.completedStepOrder, action.grantsStepId]
            : prev.completedStepOrder,
        triggeredUnsafeIds:
          action.triggersUnsafeId &&
          !prev.triggeredUnsafeIds.includes(action.triggersUnsafeId)
            ? [...prev.triggeredUnsafeIds, action.triggersUnsafeId]
            : prev.triggeredUnsafeIds,
        wrongChannelIds:
          action.wrongChannelId &&
          !prev.wrongChannelIds.includes(action.wrongChannelId)
            ? [...prev.wrongChannelIds, action.wrongChannelId]
            : prev.wrongChannelIds,
        falseAlarmIds:
          action.falseAlarmExplanationId &&
          !prev.falseAlarmIds.includes(action.falseAlarmExplanationId)
            ? [...prev.falseAlarmIds, action.falseAlarmExplanationId]
            : prev.falseAlarmIds,
        phishingClueNotes:
          action.phishingClueNote &&
          !prev.phishingClueNotes.includes(action.phishingClueNote)
            ? [...prev.phishingClueNotes, action.phishingClueNote]
            : prev.phishingClueNotes,
        actionsLog: [
          ...prev.actionsLog,
          {
            timestampSec: elapsedSec,
            appId,
            screenId,
            actionId: action.id,
            label: action.label,
          },
        ],
      }));

      setLatestToast(action.feedbackMessage);

      if (action.nextAppId || action.nextScreenId) {
        const targetAppId = action.nextAppId ?? appId;
        const targetApp = phone.appDefinitions[targetAppId];
        const targetScreenId =
          action.nextScreenId ?? targetApp?.homeScreenId ?? '';
        navigateTo({
          view: 'app',
          appId: targetAppId,
          screenId: targetScreenId,
        });
      }
    },
    [
      bumpInteraction,
      startedAtMs,
      currentNav.appId,
      currentNav.screenId,
      currentNav.view,
      phone.appDefinitions,
      navigateTo,
    ]
  );

  // PIN / OTP Keypad trap: first tap triggers lesson immediately, zero digits stored
  const handleKeypadTrapTap = useCallback(
    (screen: PhoneScreen) => {
      bumpInteraction();
      const unsafeId = screen.keypadTrapUnsafeId;
      if (unsafeId) {
        setSandboxLog((prev) => ({
          ...prev,
          triggeredUnsafeIds: prev.triggeredUnsafeIds.includes(unsafeId)
            ? prev.triggeredUnsafeIds
            : [...prev.triggeredUnsafeIds, unsafeId],
          actionsLog: [
            ...prev.actionsLog,
            {
              timestampSec: Math.max(
                1,
                Math.floor((Date.now() - startedAtMs) / 1000)
              ),
              appId: currentNav.appId ?? 'payeasy',
              screenId: screen.id,
              actionId: 'keypad_first_tap',
              label: 'Tapped practice PIN/OTP keypad',
            },
          ],
        }));
      }
      setPinTrapBanner(
        screen.keypadTrapMessage ??
          'Practice trap triggered: Never enter a PIN or OTP to receive money. (Zero digits stored.)'
      );
    },
    [bumpInteraction, startedAtMs, currentNav.appId]
  );

  const minutes = Math.floor(secondsLeft / 60);
  const secs = secondsLeft % 60;
  const clockStr =
    String(minutes) + ':' + (secs < 10 ? '0' + String(secs) : String(secs));

  return (
    <div className="space-y-3">
      {/* Persistent Practice Guardrail Header */}
      <div className="rounded-xl border-2 border-blue-700 bg-blue-50 px-3 py-2 flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="rounded-full bg-blue-700 text-white px-2.5 py-0.5 text-xs font-bold tracking-wide">
            PRACTICE MODE · No real money
          </span>
          {deadlineMs !== null ? (
            <span
              aria-live="off"
              className="rounded-full border border-blue-700 bg-white text-zinc-900 px-2.5 py-0.5 text-xs font-bold"
            >
              {paceMode === 'relaxed' ? 'Relaxed ' : ''}Time: {clockStr}
            </span>
          ) : (
            <span className="rounded-full border border-zinc-300 bg-white text-zinc-900 px-2.5 py-0.5 text-xs font-bold">
              Untimed
            </span>
          )}
        </div>

        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={() => setSoundEnabled((s) => !s)}
            className="min-h-[36px] rounded-lg border border-zinc-400 bg-white px-2.5 py-1 text-xs font-bold text-zinc-900 cursor-pointer"
          >
            {soundEnabled ? '🔊 Sound On' : '🔇 Muted'}
          </button>
          <button
            type="button"
            onClick={onRequestExitPractice}
            className="min-h-[36px] rounded-lg border border-red-700 bg-red-50 px-2.5 py-1 text-xs font-bold text-red-900 cursor-pointer"
          >
            Exit practice
          </button>
        </div>
      </div>

      {/* PracticeOS Simulated Device Frame */}
      <div
        role="region"
        aria-label="PracticeOS Simulated Phone"
        className="w-full rounded-3xl border-4 border-zinc-800 bg-gray-900 overflow-hidden shadow-xl flex flex-col relative"
      >
        {/* 1. STATUS BAR */}
        <button
          type="button"
          onClick={() => setShadeOpen((o) => !o)}
          aria-label="Status bar — tap to open notification shade"
          className="w-full min-h-[38px] px-4 py-1.5 bg-zinc-950 text-zinc-100 flex items-center justify-between text-xs font-bold cursor-pointer border-b border-zinc-800"
        >
          <div className="flex items-center gap-2">
            <span>{phone.startTime}</span>
            {notifications.length > 0 ? (
              <span className="rounded-full bg-amber-500 text-zinc-950 px-1.5 py-0.5 text-[11px] font-extrabold">
                {notifications.length} alert{notifications.length > 1 ? 's' : ''} ↓
              </span>
            ) : (
              <span className="text-zinc-400">Shade ↓</span>
            )}
          </div>
          <div className="flex items-center gap-2">
            <span>5G ▂▄▆█</span>
            <span>Wi-Fi</span>
            <span
              className={
                batteryPercent <= 20 ? 'text-amber-400 font-extrabold' : ''
              }
            >
              🔋 {batteryPercent}%
            </span>
          </div>
        </button>

        {/* Live OS Banner */}
        {osBanner ? (
          <div className="px-4 py-2 bg-slate-800 text-slate-50 text-xs font-bold flex items-center justify-between gap-2 border-b border-slate-700">
            <span>🔔 {osBanner}</span>
            <button
              type="button"
              onClick={() => setShadeOpen(true)}
              className="underline text-amber-300 cursor-pointer shrink-0"
            >
              Open Shade
            </button>
          </div>
        ) : null}

        {/* Live Typing Indicator */}
        {typingBanner ? (
          <div className="px-4 py-1.5 bg-slate-900 text-blue-300 text-xs font-semibold border-b border-slate-800">
            💬 {typingBanner}
          </div>
        ) : null}

        {/* 2. NOTIFICATION SHADE */}
        {shadeOpen ? (
          <div className="p-4 bg-zinc-950/95 text-zinc-100 space-y-3 border-b-2 border-zinc-700">
            <div className="flex items-center justify-between">
              <p className="text-sm font-bold">
                Notification Shade ({notifications.length})
              </p>
              <button
                type="button"
                onClick={() => setShadeOpen(false)}
                className="min-h-[36px] rounded-lg border border-zinc-600 px-3 py-1 text-xs font-bold text-white cursor-pointer"
              >
                Swipe Up / Close ↑
              </button>
            </div>

            {notifications.length === 0 ? (
              <p className="text-xs text-zinc-400 py-3">
                No unread notifications.
              </p>
            ) : (
              <div className="space-y-2.5">
                {notifications.map((notif) => (
                  <div
                    key={notif.id}
                    className="rounded-xl border border-gray-700 bg-gray-800 p-3 space-y-2"
                  >
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-xs font-bold text-sky-300">
                        {notif.appName}
                      </span>
                      <button
                        type="button"
                        onClick={() =>
                          setNotifications((prev) =>
                            prev.filter((n) => n.id !== notif.id)
                          )
                        }
                        className="text-xs text-zinc-300 underline cursor-pointer"
                      >
                        Swipe away ✕
                      </button>
                    </div>
                    <p className="text-sm font-bold text-white">{notif.title}</p>
                    <p className="text-xs text-zinc-200 leading-relaxed">
                      {notif.body}
                    </p>
                    <button
                      type="button"
                      onClick={() => {
                        const targetApp = phone.appDefinitions[notif.appId];
                        navigateTo({
                          view: 'app',
                          appId: notif.appId,
                          screenId:
                            notif.screenId || targetApp?.homeScreenId || '',
                        });
                      }}
                      className="min-h-[38px] w-full rounded-lg bg-sky-600 px-3 py-1.5 text-xs font-bold text-white cursor-pointer"
                    >
                      Tap to open {notif.appName}
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        ) : null}

        {/* 3. INCOMING & IN-CALL SCREEN OVERLAY */}
        {activeCall ? (
          <div className="p-5 bg-slate-950 text-slate-50 space-y-4 min-h-[430px] flex flex-col justify-between">
            <div className="space-y-2 text-center pt-2">
              <span className="inline-block rounded-full bg-amber-500/20 border border-amber-400 px-3 py-1 text-xs font-bold text-amber-200">
                {activeCall.status === 'ringing'
                  ? '📞 Incoming Simulated Call · ' + activeCall.pressureTag
                  : '🎙 Simulated Call Connected · ' + activeCall.pressureTag}
              </span>
              <h2 className="text-2xl font-bold text-white pt-1">
                {activeCall.callerName}
              </h2>
              <p className="text-sm text-zinc-300">{activeCall.callerNumber}</p>
            </div>

            {activeCall.status === 'ringing' ? (
              <div className="space-y-3 py-6">
                <p className="text-center text-xs text-zinc-300">
                  {soundEnabled
                    ? 'Ringing (vibration & audio active)...'
                    : 'Ringing (muted)...'}
                </p>
                <div className="grid grid-cols-2 gap-3">
                  <button
                    type="button"
                    onClick={() => {
                      bumpInteraction();
                      setActiveCall(null);
                      setLatestToast('Declined incoming call.');
                    }}
                    className="min-h-[54px] rounded-2xl bg-red-600 px-4 py-3 text-base font-bold text-white cursor-pointer"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      bumpInteraction();
                      setActiveCall((prev) =>
                        prev ? { ...prev, status: 'connected' } : null
                      );
                    }}
                    className="min-h-[54px] rounded-2xl bg-emerald-600 px-4 py-3 text-base font-bold text-white cursor-pointer"
                  >
                    Answer
                  </button>
                </div>
              </div>
            ) : (
              <div className="space-y-4">
                <div className="rounded-2xl border border-slate-700 bg-slate-800 p-4 space-y-2">
                  <p className="text-xs font-bold uppercase tracking-wider text-sky-300">
                    Live Caller Captions
                  </p>
                  {activeCall.dialogueLines
                    .slice(0, activeCall.revealedLinesCount)
                    .map((line, i) => (
                      <p
                        key={'call-line-' + String(i)}
                        className="text-sm leading-relaxed text-white font-medium"
                      >
                        “{line}”
                      </p>
                    ))}
                  {activeCall.revealedLinesCount === 0 ? (
                    <p className="text-xs text-zinc-400">Connecting audio...</p>
                  ) : null}
                </div>

                <div className="grid grid-cols-3 gap-2">
                  <button
                    type="button"
                    onClick={() =>
                      setActiveCall((prev) =>
                        prev ? { ...prev, speakerOn: !prev.speakerOn } : null
                      )
                    }
                    className="min-h-[42px] rounded-xl border border-zinc-600 px-2 py-1.5 text-xs font-bold text-white cursor-pointer"
                  >
                    {activeCall.speakerOn ? '🔊 Speaker On' : '🔈 Speaker'}
                  </button>
                  <button
                    type="button"
                    onClick={() =>
                      setActiveCall((prev) =>
                        prev ? { ...prev, muted: !prev.muted } : null
                      )
                    }
                    className="min-h-[42px] rounded-xl border border-zinc-600 px-2 py-1.5 text-xs font-bold text-white cursor-pointer"
                  >
                    {activeCall.muted ? '🔇 Muted' : '🎤 Mute'}
                  </button>
                  <button
                    type="button"
                    onClick={() => {
                      bumpInteraction();
                      setActiveCall(null);
                    }}
                    className="min-h-[42px] rounded-xl bg-red-600 px-2 py-1.5 text-xs font-bold text-white cursor-pointer"
                  >
                    End Call
                  </button>
                </div>

                <div className="space-y-2">
                  <p className="text-xs font-bold text-zinc-300">
                    Choose how to reply:
                  </p>
                  {activeCall.replies.map((rep) => (
                    <button
                      key={rep.id}
                      type="button"
                      onClick={() => {
                        executePracticeAction({
                          id: rep.id,
                          label: rep.label,
                          grantsStepId: rep.grantsStepId,
                          triggersUnsafeId: rep.triggersUnsafeId,
                          wrongChannelId: rep.wrongChannelId,
                          nextAppId: rep.nextAppId,
                          nextScreenId: rep.nextScreenId,
                          feedbackMessage: rep.feedbackMessage,
                        });
                        if (rep.endCall) {
                          setActiveCall(null);
                        }
                      }}
                      className={`w-full min-h-[48px] rounded-xl px-3.5 py-2.5 text-left text-sm font-bold cursor-pointer ${
                        rep.tone === 'danger'
                          ? 'bg-red-900/70 border border-red-400 text-red-100'
                          : rep.tone === 'primary'
                          ? 'bg-sky-600 text-white'
                          : 'bg-zinc-800 border border-zinc-600 text-white'
                      }`}
                    >
                      {rep.label}
                    </button>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : null}

        {/* 4. MAIN PHONE VIEWPORT */}
        {!activeCall ? (
          <div className="flex-1 min-h-[440px] flex flex-col">
            {/* VIEW A: LOCK SCREEN */}
            {currentNav.view === 'lock' ? (
              <div className="flex-1 p-5 bg-gradient-to-b from-slate-900 to-slate-800 text-slate-50 flex flex-col justify-between space-y-5">
                <div className="text-center pt-3 space-y-1">
                  <p className="text-xs font-bold uppercase tracking-widest text-sky-300">
                    🔒 PracticeOS Lock Screen
                  </p>
                  <p className="text-4xl font-extrabold tracking-tight text-white">
                    {phone.startTime}
                  </p>
                  <p className="text-sm text-zinc-300">{phone.startDate}</p>
                </div>

                <div className="space-y-2.5">
                  <p className="text-xs font-bold text-zinc-300">
                    Lock screen notifications (tap to open app):
                  </p>
                  {notifications.map((notif) => (
                    <button
                      key={notif.id}
                      type="button"
                      onClick={() => {
                        const targetApp = phone.appDefinitions[notif.appId];
                        navigateTo({
                          view: 'app',
                          appId: notif.appId,
                          screenId:
                            notif.screenId || targetApp?.homeScreenId || '',
                        });
                      }}
                      className="w-full rounded-2xl border border-slate-600 bg-slate-800/90 p-3.5 text-left space-y-1 hover:border-sky-400 cursor-pointer"
                    >
                      <div className="flex items-center justify-between text-xs">
                        <span className="font-bold text-sky-300">
                          {notif.appName}
                        </span>
                        <span className="text-zinc-400">Tap to open →</span>
                      </div>
                      <p className="text-sm font-bold text-white">
                        {notif.title}
                      </p>
                      <p className="text-xs text-zinc-200 leading-relaxed">
                        {notif.body}
                      </p>
                    </button>
                  ))}
                </div>

                <button
                  type="button"
                  onClick={() => navigateTo({ view: 'home' })}
                  className="w-full min-h-[52px] rounded-2xl bg-white text-zinc-950 font-bold text-base shadow-md cursor-pointer"
                >
                  Unlock to PracticeOS Home ↑
                </button>
              </div>
            ) : null}

            {/* VIEW B: HOME SCREEN */}
            {currentNav.view === 'home' ? (
              <div className="flex-1 p-5 bg-gradient-to-b from-slate-800 to-slate-900 text-slate-50 flex flex-col justify-between space-y-6">
                <div className="space-y-4">
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold text-zinc-300">
                      PracticeOS Home · Tap an app
                    </span>
                    <button
                      type="button"
                      onClick={() => setShadeOpen(true)}
                      className="text-xs font-bold text-sky-300 underline cursor-pointer"
                    >
                      Notifications ({notifications.length})
                    </button>
                  </div>

                  <div className="grid grid-cols-3 gap-3 pt-2">
                    {phone.apps.map((appId) => {
                      const app = phone.appDefinitions[appId];
                      if (!app) {
                        return null;
                      }
                      return (
                        <button
                          key={app.id}
                          type="button"
                          onClick={() =>
                            navigateTo({
                              view: 'app',
                              appId: app.id,
                              screenId: app.homeScreenId,
                            })
                          }
                          className="min-h-[84px] rounded-2xl bg-white/10 hover:bg-white/15 p-3 flex flex-col items-center justify-center gap-1.5 cursor-pointer"
                        >
                          <span
                            style={{ backgroundColor: app.accentColor }}
                            className="w-11 h-11 rounded-2xl flex items-center justify-center text-xl font-bold text-white shadow"
                          >
                            {app.iconKey}
                          </span>
                          <span className="text-xs font-bold text-white text-center leading-tight">
                            {app.name}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                </div>

                {/* Bottom Dock */}
                <div className="rounded-2xl bg-white/10 p-2.5 grid grid-cols-4 gap-2">
                  {phone.apps.slice(0, 4).map((dockId) => {
                    const app = phone.appDefinitions[dockId];
                    if (!app) {
                      return null;
                    }
                    return (
                      <button
                        key={'dock-' + app.id}
                        type="button"
                        onClick={() =>
                          navigateTo({
                            view: 'app',
                            appId: app.id,
                            screenId: app.homeScreenId,
                          })
                        }
                        className="min-h-[54px] rounded-xl flex flex-col items-center justify-center gap-1 cursor-pointer hover:bg-white/10"
                      >
                        <span
                          style={{ backgroundColor: app.accentColor }}
                          className="w-9 h-9 rounded-xl flex items-center justify-center text-base font-bold text-white"
                        >
                          {app.iconKey}
                        </span>
                        <span className="text-[11px] font-bold text-zinc-200">
                          {app.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>
            ) : null}

            {/* VIEW C: RECENTS SWITCHER */}
            {currentNav.view === 'recents' ? (
              <div className="flex-1 p-5 bg-gray-900 text-slate-50 space-y-4">
                <h2 className="text-lg font-bold">Recent Apps</h2>
                {recentApps.length === 0 ? (
                  <p className="text-sm text-zinc-400">
                    No apps opened yet. Tap Home below to launch an app.
                  </p>
                ) : (
                  <div className="space-y-2.5">
                    {recentApps.map((appId) => {
                      const app = phone.appDefinitions[appId];
                      if (!app) {
                        return null;
                      }
                      return (
                        <button
                          key={'recent-' + app.id}
                          type="button"
                          onClick={() =>
                            navigateTo({
                              view: 'app',
                              appId: app.id,
                              screenId: app.homeScreenId,
                            })
                          }
                          className="w-full min-h-[54px] rounded-xl bg-zinc-800 border border-zinc-700 px-4 py-3 flex items-center justify-between cursor-pointer"
                        >
                          <span className="font-bold text-base">
                            {app.iconKey} {app.name}
                          </span>
                          <span className="text-xs text-sky-300 font-bold">
                            Switch →
                          </span>
                        </button>
                      );
                    })}
                  </div>
                )}
              </div>
            ) : null}

            {/* VIEW D: GENERIC JSON-DRIVEN FAKE APP RENDERER */}
            {currentNav.view === 'app' && currentNav.appId
              ? (() => {
                  const app = phone.appDefinitions[currentNav.appId];
                  const screenId =
                    currentNav.screenId ?? app?.homeScreenId ?? '';
                  const screen = app?.screens[screenId];
                  if (!app || !screen) {
                    return null;
                  }

                  const extraBlocks = dynamicMessagesByScreen[screen.id] ?? [];
                  const allBlocks = [...screen.blocks, ...extraBlocks];

                  return (
                    <div className="flex-1 flex flex-col bg-[#F8F7F4] text-zinc-900">
                      <div
                        style={{
                          backgroundColor: app.accentColor,
                          color: '#FFFFFF',
                        }}
                        className="px-4 py-3 flex items-center justify-between gap-2"
                      >
                        <div>
                          <p className="text-xs font-bold opacity-90">
                            {app.iconKey} {app.name}
                          </p>
                          <h2 className="text-lg font-bold leading-snug">
                            {screen.title}
                          </h2>
                          {screen.subtitle ? (
                            <p className="text-xs opacity-90">
                              {screen.subtitle}
                            </p>
                          ) : null}
                        </div>
                      </div>

                      <div className="p-4 space-y-3 flex-1">
                        {pinTrapBanner ? (
                          <div
                            role="alert"
                            className="rounded-xl border-2 border-red-700 bg-red-50 text-red-900 p-3.5 text-sm font-bold leading-relaxed"
                          >
                            {pinTrapBanner}
                          </div>
                        ) : null}

                        {/* Blocks */}
                        {allBlocks.map((block) => {
                          if (block.kind === 'warning') {
                            return (
                              <div
                                key={block.id}
                                className="rounded-xl border border-amber-600 bg-amber-50 p-3.5 space-y-1"
                              >
                                {block.title ? (
                                  <p className="text-xs font-bold uppercase text-amber-900">
                                    {block.title}
                                  </p>
                                ) : null}
                                <p className="text-sm font-bold text-zinc-900 leading-relaxed">
                                  {block.body}
                                </p>
                              </div>
                            );
                          }

                          if (block.kind === 'message') {
                            const isClickableThread = Boolean(
                              block.openScreenId || block.openAppId
                            );
                            return (
                              <div
                                key={block.id}
                                onClick={() => {
                                  if (block.openAppId || block.openScreenId) {
                                    navigateTo({
                                      view: 'app',
                                      appId: block.openAppId ?? app.id,
                                      screenId:
                                        block.openScreenId ?? app.homeScreenId,
                                    });
                                  }
                                }}
                                role={isClickableThread ? 'button' : undefined}
                                tabIndex={isClickableThread ? 0 : undefined}
                                className={`rounded-xl border border-stone-300 bg-white p-3.5 space-y-1 ${
                                  isClickableThread
                                    ? 'cursor-pointer hover:border-blue-600'
                                    : ''
                                }`}
                              >
                                <div className="flex items-center justify-between gap-2">
                                  <span className="text-xs font-bold text-zinc-900">
                                    {block.sender ?? block.title}
                                    {block.senderMeta
                                      ? ' · ' + block.senderMeta
                                      : ''}
                                  </span>
                                  {block.timestamp ? (
                                    <span className="text-xs text-zinc-500">
                                      {block.timestamp}
                                    </span>
                                  ) : null}
                                </div>
                                {block.title && block.sender ? (
                                  <p className="text-sm font-bold text-zinc-900">
                                    {block.title}
                                  </p>
                                ) : null}
                                <p className="text-sm text-zinc-700 leading-relaxed">
                                  {block.body}
                                </p>
                                {block.linkLabel && block.linkTargetAppId ? (
                                  <button
                                    type="button"
                                    onClick={(e) => {
                                      e.stopPropagation();
                                      navigateTo({
                                        view: 'app',
                                        appId: block.linkTargetAppId!,
                                        screenId:
                                          block.linkTargetScreenId ?? '',
                                      });
                                    }}
                                    className="text-xs font-bold text-blue-700 underline pt-1 cursor-pointer"
                                  >
                                    {block.linkLabel} →
                                  </button>
                                ) : null}
                              </div>
                            );
                          }

                          return (
                            <div
                              key={block.id}
                              className="rounded-xl border border-stone-300 bg-white p-3.5 space-y-0.5"
                            >
                              {block.title ? (
                                <p className="text-xs font-bold uppercase text-zinc-500">
                                  {block.title}
                                </p>
                              ) : null}
                              <p className="text-sm font-bold text-zinc-900 leading-relaxed">
                                {block.body}
                              </p>
                            </div>
                          );
                        })}

                        {/* LAYOUT: IN-APP TAP KEYPAD TRAP */}
                        {screen.layout === 'keypad' ? (
                          <div className="rounded-2xl border-2 border-stone-400 bg-white p-4 space-y-3">
                            <p className="text-center text-xs font-bold text-amber-900">
                              {screen.keypadHint ??
                                'Practice keypad. Never type your real PIN.'}
                            </p>
                            <div className="flex justify-center gap-3 py-1">
                              {[0, 1, 2, 3].map((dot) => (
                                <span
                                  key={'dot-' + String(dot)}
                                  className="w-4 h-4 rounded-full border-2 border-zinc-500 inline-block"
                                />
                              ))}
                            </div>
                            <div className="grid grid-cols-3 gap-2">
                              {[
                                '1',
                                '2',
                                '3',
                                '4',
                                '5',
                                '6',
                                '7',
                                '8',
                                '9',
                                '0',
                              ].map((digit) => (
                                <button
                                  key={'key-' + digit}
                                  type="button"
                                  onClick={() => handleKeypadTrapTap(screen)}
                                  className={`min-h-[48px] rounded-xl bg-stone-200 text-zinc-900 font-bold text-lg cursor-pointer ${
                                    digit === '0' ? 'col-span-3' : ''
                                  }`}
                                >
                                  {digit}
                                </button>
                              ))}
                            </div>
                          </div>
                        ) : null}

                        {/* LAYOUT: SIMULATED DIALER */}
                        {screen.layout === 'dialer' ? (
                          <div className="space-y-3">
                            {screen.dialNumbers &&
                            screen.dialNumbers.length > 0 ? (
                              <div className="space-y-2">
                                <p className="text-xs font-bold uppercase text-zinc-500">
                                  Directory & Speed Dial
                                </p>
                                {screen.dialNumbers.map((item) => (
                                  <button
                                    key={item.number}
                                    type="button"
                                    onClick={() => {
                                      executePracticeAction({
                                        id: 'dial_' + item.number,
                                        label: 'Dialed ' + item.number,
                                        wrongChannelId: item.wrongChannelId,
                                        nextScreenId: item.targetScreenId,
                                        feedbackMessage:
                                          'Calling ' + item.label + '...',
                                      });
                                    }}
                                    className="w-full min-h-[50px] rounded-xl border border-stone-400 bg-white p-3 flex items-center justify-between text-left cursor-pointer"
                                  >
                                    <div>
                                      <p className="text-sm font-bold">
                                        {item.label}
                                      </p>
                                      <p className="text-xs text-zinc-600">
                                        {item.number}
                                      </p>
                                    </div>
                                    <span className="rounded-lg bg-emerald-700 text-white px-3 py-1.5 text-xs font-bold">
                                      📞 Call
                                    </span>
                                  </button>
                                ))}
                              </div>
                            ) : null}

                            <div className="rounded-xl border border-stone-300 bg-white p-3 space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-sm font-bold">
                                  {dialedDigits || 'Enter number (e.g. 1930)'}
                                </span>
                                {dialedDigits ? (
                                  <button
                                    type="button"
                                    onClick={() =>
                                      setDialedDigits((d) => d.slice(0, -1))
                                    }
                                    className="text-xs font-bold underline cursor-pointer"
                                  >
                                    ⌫ Clear
                                  </button>
                                ) : null}
                              </div>
                              <div className="grid grid-cols-3 gap-1.5">
                                {[
                                  '1',
                                  '2',
                                  '3',
                                  '4',
                                  '5',
                                  '6',
                                  '7',
                                  '8',
                                  '9',
                                  '*',
                                  '0',
                                  '#',
                                ].map((k) => (
                                  <button
                                    key={'dial-k-' + k}
                                    type="button"
                                    onClick={() =>
                                      setDialedDigits((d) =>
                                        d.length < 12 ? d + k : d
                                      )
                                    }
                                    className="min-h-[42px] rounded-lg bg-stone-200 font-bold text-base cursor-pointer"
                                  >
                                    {k}
                                  </button>
                                ))}
                              </div>
                            </div>
                          </div>
                        ) : null}

                        {/* Screen Action Buttons */}
                        {screen.actions.length > 0 ? (
                          <div className="space-y-2 pt-1">
                            {screen.actions.map((act) => {
                              const done =
                                act.grantsStepId !== undefined &&
                                sandboxLog.completedStepOrder.includes(
                                  act.grantsStepId
                                );
                              const btnClasses =
                                act.tone === 'primary'
                                  ? 'bg-blue-700 border-blue-700 text-white'
                                  : act.tone === 'danger'
                                  ? 'bg-red-50 border-red-700 text-red-900'
                                  : 'bg-white border-blue-700 text-blue-700';
                              return (
                                <button
                                  key={act.id}
                                  type="button"
                                  onClick={() => executePracticeAction(act)}
                                  className={`w-full min-h-[50px] px-4 py-3 rounded-xl border-2 font-bold text-base transition-opacity active:opacity-85 cursor-pointer flex items-center justify-center text-center ${btnClasses}`}
                                >
                                  {done ? act.label + ' (Done ✓)' : act.label}
                                </button>
                              );
                            })}
                          </div>
                        ) : null}
                      </div>
                    </div>
                  );
                })()
              : null}
          </div>
        ) : null}

        {/* 5. PRACTICEOS NAVIGATION BAR (Back · Home · Recents) */}
        <div className="grid grid-cols-3 bg-zinc-950 text-zinc-200 border-t border-zinc-800">
          <button
            type="button"
            onClick={handlePracticeOSBack}
            aria-label="PracticeOS Back"
            className="min-h-[48px] py-2 text-xs font-bold hover:bg-white/10 cursor-pointer"
          >
            ◀ Back
          </button>
          <button
            type="button"
            onClick={() => navigateTo({ view: 'home' })}
            aria-label="PracticeOS Home"
            className="min-h-[48px] py-2 text-xs font-bold hover:bg-white/10 cursor-pointer"
          >
            ● Home
          </button>
          <button
            type="button"
            onClick={() => navigateTo({ view: 'recents' })}
            aria-label="PracticeOS Recents"
            className="min-h-[48px] py-2 text-xs font-bold hover:bg-white/10 cursor-pointer"
          >
            ■ Recents
          </button>
        </div>
      </div>

      {/* Latest Action Toast & Finish Bar */}
      {latestToast ? (
        <div
          role="status"
          aria-live="polite"
          className="rounded-xl border border-l-4 border-blue-700 bg-white p-3 text-sm text-zinc-900"
        >
          <span className="font-bold">Action recorded: </span>
          {latestToast}
        </div>
      ) : null}

      <div className="flex items-center justify-between gap-3 pt-1">
        <span className="text-xs font-bold text-zinc-600">
          Safe steps completed: {sandboxLog.completedStepOrder.length}
          {phone.totalExpectedSteps
            ? ' of ' + String(phone.totalExpectedSteps)
            : ''}
        </span>
        <button
          type="button"
          onClick={() =>
            onCompleteSandbox({ ...sandboxLog, timedOut: false })
          }
          className="min-h-[46px] px-4 py-2 rounded-xl border-2 border-blue-700 bg-white text-blue-700 font-bold text-sm cursor-pointer"
        >
          Finish & Emit Session Log
        </button>
      </div>
    </div>
  );
}

// ============================================================================
// 4. SAMPLE SCENARIO & STANDALONE WORKBENCH (Default Export `App`)
// ============================================================================

const SAMPLE_PHONE_CONFIG: PracticeOSPhoneConfig = {
  scenarioId: 'practiceos-upi-demo',
  startTime: '6:42 PM',
  startDate: 'Thu, 19 Nov',
  initialBattery: 68,
  totalExpectedSteps: 3,
  apps: [
    'payeasy',
    'messages',
    'chatnest',
    'phone',
    'sunrise',
    'browser',
    'settings',
  ],
  appDefinitions: {
    payeasy: {
      id: 'payeasy',
      name: 'PayEasy',
      iconKey: '₹',
      accentColor: '#0F52BA',
      homeScreenId: 'payeasy_home',
      screens: {
        payeasy_home: {
          id: 'payeasy_home',
          title: 'PayEasy UPI',
          subtitle: 'Simulated Payment App',
          layout: 'detail',
          blocks: [
            {
              id: 'pe_bal',
              kind: 'field',
              title: 'Available Bank Balance',
              body: '₹18,450 (Sunrise Bank ••4821)',
            },
            {
              id: 'pe_warn',
              kind: 'warning',
              title: '1 Pending Collect Request',
              body: 'Rohan Verma (rohan.refund99@payeasy-sim) is requesting ₹4,500 FROM you.',
            },
          ],
          actions: [
            {
              id: 'act_open_collect_req',
              label: 'Open Pending Request (₹4,500)',
              tone: 'primary',
              nextScreenId: 'payeasy_request',
              feedbackMessage: 'Opened pending collect request details.',
            },
            {
              id: 'act_check_pe_history',
              label: 'Check Balance & Transaction History',
              tone: 'secondary',
              grantsStepId: 'check_balance',
              nextScreenId: 'payeasy_history',
              feedbackMessage: 'Checked PayEasy balance and history.',
            },
          ],
        },
        payeasy_request: {
          id: 'payeasy_request',
          title: 'Collect Request Details',
          subtitle: 'Money will LEAVE your account if approved',
          layout: 'detail',
          blocks: [
            {
              id: 'req_from',
              kind: 'field',
              title: 'Pay To (Requester)',
              body: 'Rohan Verma (rohan.refund99@payeasy-sim)',
            },
            {
              id: 'req_amt',
              kind: 'warning',
              title: 'Amount to be DEBITED from your bank',
              body: '₹4,500',
            },
            {
              id: 'req_note',
              kind: 'info',
              title: 'Note written by requester',
              body: 'Marketplace Refund — Enter UPI PIN to receive ₹4,500',
            },
          ],
          actions: [
            {
              id: 'act_decline_collect',
              label: 'Decline Request',
              tone: 'primary',
              grantsStepId: 'decline_request',
              feedbackMessage:
                'Collect request declined! ₹4,500 stayed safely in your account.',
            },
            {
              id: 'act_report_collect',
              label: 'Report & Block Sender',
              tone: 'secondary',
              grantsStepId: 'report_request',
              feedbackMessage: 'Reported and blocked sender in PayEasy.',
            },
            {
              id: 'act_go_pin_trap',
              label: 'Approve & Enter UPI PIN to Receive',
              tone: 'danger',
              nextScreenId: 'payeasy_pin_keypad',
              feedbackMessage:
                'Opened simulated UPI PIN screen — notice it authorizes a debit!',
            },
          ],
        },
        payeasy_pin_keypad: {
          id: 'payeasy_pin_keypad',
          title: 'Enter 4-Digit UPI PIN',
          subtitle: 'Paying ₹4,500 to Rohan Verma',
          layout: 'keypad',
          keypadHint: 'Practice keypad. Never type your real PIN.',
          keypadTrapUnsafeId: 'enter_upi_pin_trap',
          keypadTrapMessage:
            'PIN TRAP TRIGGERED: A UPI PIN is NEVER needed to receive money! Tapping a PIN key on a collect request sends ₹4,500 OUT of your account. (Zero digits stored.)',
          blocks: [
            {
              id: 'pin_warn_block',
              kind: 'warning',
              title: 'Debit Authorization Warning',
              body: 'You are authorizing a payment of ₹4,500 FROM your account.',
            },
          ],
          actions: [
            {
              id: 'act_cancel_pin',
              label: 'Cancel & Go Back Safely',
              tone: 'primary',
              nextScreenId: 'payeasy_request',
              feedbackMessage: 'Cancelled PIN entry safely.',
            },
          ],
        },
        payeasy_history: {
          id: 'payeasy_history',
          title: 'Balance & History',
          subtitle: 'Sunrise Bank ••4821',
          layout: 'list',
          blocks: [
            {
              id: 'hist_bal',
              kind: 'field',
              title: 'Current Balance',
              body: '₹18,450 — No money has been deducted',
            },
            {
              id: 'hist_tx1',
              kind: 'transaction',
              title: 'Metro Groceries',
              body: 'Paid ₹240 · Completed yesterday',
              timestamp: 'Yesterday',
            },
          ],
          actions: [
            {
              id: 'act_back_pe_home',
              label: 'Back to PayEasy Home',
              tone: 'primary',
              nextScreenId: 'payeasy_home',
              feedbackMessage: 'Returned to PayEasy home.',
            },
          ],
        },
      },
    },
    messages: {
      id: 'messages',
      name: 'Messages',
      iconKey: '💬',
      accentColor: '#1E7E34',
      homeScreenId: 'sms_inbox',
      screens: {
        sms_inbox: {
          id: 'sms_inbox',
          title: 'Messages (SMS)',
          subtitle: 'Mixed real & suspicious texts',
          layout: 'list',
          blocks: [
            {
              id: 'sms_scam',
              kind: 'message',
              sender: 'VK-PAYEZY',
              senderMeta: '+91 9XXXX XXX12',
              title: 'Collect request ₹4,500',
              body: 'Rohan Verma requested ₹4,500. Tap link or PayEasy to approve & receive refund.',
              timestamp: '6:41 PM',
              classification: 'scam',
              openScreenId: 'sms_detail_scam',
            },
            {
              id: 'sms_legit',
              kind: 'message',
              sender: 'JD-DELIVR',
              senderMeta: 'Verified Sender',
              title: 'Package Out for Delivery',
              body: 'Your BookBazaar order #4821 is out for delivery today.',
              timestamp: '5:50 PM',
              classification: 'legit',
            },
          ],
          actions: [],
        },
        sms_detail_scam: {
          id: 'sms_detail_scam',
          title: 'VK-PAYEZY',
          subtitle: 'Suspicious SMS Thread',
          layout: 'thread',
          blocks: [
            {
              id: 'msg_s1',
              kind: 'message',
              sender: 'VK-PAYEZY',
              body: 'URGENT: Rohan Verma sent ₹4,500 refund. Tap http://payezy-refund-claim-sim.in or enter UPI PIN in PayEasy within 2 mins!',
              timestamp: '6:41 PM',
              isIncoming: true,
              classification: 'scam',
              linkLabel: 'Open PayEasy App',
              linkTargetAppId: 'payeasy',
              linkTargetScreenId: 'payeasy_request',
            },
          ],
          actions: [
            {
              id: 'act_flag_scam_sms',
              label: 'Flag SMS & Fake Link as Phishing',
              tone: 'primary',
              phishingClueNote:
                'Flagged spoofed sender VK-PAYEZY and fake HTTP link.',
              feedbackMessage: 'Phishing indicators flagged!',
            },
            {
              id: 'act_sms_back',
              label: 'Back to Inbox',
              tone: 'secondary',
              nextScreenId: 'sms_inbox',
              feedbackMessage: 'Returned to SMS inbox.',
            },
          ],
        },
      },
    },
    chatnest: {
      id: 'chatnest',
      name: 'ChatNest',
      iconKey: '💭',
      accentColor: '#0B7285',
      homeScreenId: 'chat_list',
      screens: {
        chat_list: {
          id: 'chat_list',
          title: 'ChatNest',
          subtitle: 'Chats',
          layout: 'list',
          blocks: [
            {
              id: 'cn_buyer',
              kind: 'message',
              sender: 'Rohan Verma',
              senderMeta: 'Unknown Contact',
              body: 'I sent ₹4,500 request on PayEasy, tap Approve and type PIN!',
              timestamp: '6:42 PM',
              classification: 'scam',
              openScreenId: 'chat_scammer',
            },
            {
              id: 'cn_friend',
              kind: 'message',
              sender: 'Ananya (Friend)',
              senderMeta: 'Saved Contact',
              body: 'Hey! Are we still meeting at 7:15 PM near Metro Gate 2?',
              timestamp: '6:15 PM',
              classification: 'legit',
            },
          ],
          actions: [],
        },
        chat_scammer: {
          id: 'chat_scammer',
          title: 'Rohan Verma',
          subtitle: 'Not in your contacts',
          layout: 'thread',
          blocks: [
            {
              id: 'cs_1',
              kind: 'message',
              sender: 'Rohan Verma',
              body: 'Open pending request in PayEasy and enter your UPI PIN to receive ₹4,500.',
              timestamp: '6:42 PM',
              isIncoming: true,
              classification: 'scam',
            },
          ],
          actions: [
            {
              id: 'act_chat_go_pe',
              label: 'Open PayEasy to Decline Request',
              tone: 'primary',
              nextAppId: 'payeasy',
              nextScreenId: 'payeasy_request',
              feedbackMessage: 'Switched to PayEasy app.',
            },
          ],
        },
      },
    },
    phone: {
      id: 'phone',
      name: 'Phone',
      iconKey: '📞',
      accentColor: '#135E24',
      homeScreenId: 'phone_dialer',
      screens: {
        phone_dialer: {
          id: 'phone_dialer',
          title: 'Simulated Phone & Helplines',
          subtitle: 'Practice dialer (never places real calls)',
          layout: 'dialer',
          dialNumbers: [
            {
              number: '1930',
              label: 'National Cybercrime Helpline (1930)',
              targetScreenId: 'helpline_1930',
            },
          ],
          blocks: [],
          actions: [],
        },
        helpline_1930: {
          id: 'helpline_1930',
          title: 'Simulated 1930 Cyber Helpline',
          subtitle: 'Connected · Practice Call',
          layout: 'detail',
          blocks: [
            {
              id: 'h1930_msg',
              kind: 'info',
              title: '1930 Operator Guidance',
              body: 'Decline the collect request inside PayEasy and report the fake UPI ID.',
            },
          ],
          actions: [
            {
              id: 'act_1930_back',
              label: 'End Simulated Call',
              tone: 'primary',
              nextScreenId: 'phone_dialer',
              feedbackMessage: 'Ended simulated helpline call.',
            },
          ],
        },
      },
    },
    sunrise: {
      id: 'sunrise',
      name: 'Sunrise Bank',
      iconKey: '🏦',
      accentColor: '#1E3A8A',
      homeScreenId: 'sb_home',
      screens: {
        sb_home: {
          id: 'sb_home',
          title: 'Sunrise Bank Mobile',
          subtitle: 'Savings Account ••4821',
          layout: 'detail',
          blocks: [
            {
              id: 'sb_bal',
              kind: 'field',
              title: 'Ledger Balance',
              body: '₹18,450 (No unauthorized debits)',
            },
          ],
          actions: [],
        },
      },
    },
    browser: {
      id: 'browser',
      name: 'Browser',
      iconKey: '🌐',
      accentColor: '#3F3F46',
      homeScreenId: 'br_home',
      screens: {
        br_home: {
          id: 'br_home',
          title: 'Practice Browser',
          subtitle: 'https://upi-safety-guide-sim.org',
          layout: 'detail',
          blocks: [
            {
              id: 'br_guide',
              kind: 'info',
              title: 'UPI Safety Rule',
              body: 'Receiving money on UPI never requires entering your UPI PIN.',
            },
          ],
          actions: [],
        },
      },
    },
    settings: {
      id: 'settings',
      name: 'Settings',
      iconKey: '⚙',
      accentColor: '#52525B',
      homeScreenId: 'set_home',
      screens: {
        set_home: {
          id: 'set_home',
          title: 'PracticeOS Settings',
          subtitle: 'Device & App Security',
          layout: 'detail',
          blocks: [
            {
              id: 'set_1',
              kind: 'field',
              title: 'PayEasy App Lock',
              body: 'Enabled',
            },
          ],
          actions: [],
        },
      },
    },
  },
  inbox: [
    {
      id: 'init_notif_scam',
      trigger: { type: 'atSecond', seconds: 0 },
      label: 'scam',
      event: {
        type: 'notification',
        appId: 'payeasy',
        screenId: 'payeasy_request',
        appName: 'PayEasy',
        title: 'Collect request: ₹4,500',
        body: 'Rohan Verma requested ₹4,500. Tap to review.',
      },
    },
    {
      id: 'init_notif_legit',
      trigger: { type: 'atSecond', seconds: 0 },
      label: 'legit',
      event: {
        type: 'notification',
        appId: 'messages',
        screenId: 'sms_inbox',
        appName: 'Messages · JD-DELIVR',
        title: 'Parcel #4821 out for delivery',
        body: 'Your BookBazaar package arrives today. No payment due.',
      },
    },
  ],
  script: [
    {
      id: 'evt_chat_pressure_1',
      trigger: { type: 'atSecond', seconds: 4 },
      label: 'scam',
      event: {
        type: 'chatMessage',
        appId: 'chatnest',
        screenId: 'chat_scammer',
        sender: 'Rohan Verma',
        body: 'Bhai jaldi! Open PayEasy and enter your UPI PIN so ₹4,500 credits to your bank.',
      },
    },
    {
      id: 'evt_scammer_call',
      trigger: { type: 'ifIdleFor', seconds: 16 },
      label: 'scam',
      event: {
        type: 'incomingCall',
        callerName: 'Rohan Verma (Buyer)',
        callerNumber: '+91 9XXXX XXX12',
        pressureTag: 'Urgency & Fake Help Pressure',
        dialogueLines: [
          'Hello! I already sent ₹4,500 to your PayEasy account.',
          'Just tap Approve and enter your 4-digit UPI PIN so the money enters your bank. Do it fast!',
        ],
        replies: [
          {
            id: 'rep_refuse_hangup',
            label: 'Say "Receiving money never needs a PIN" & Hang up',
            tone: 'primary',
            endCall: true,
            feedbackMessage:
              'Great response! You rejected the caller’s PIN lie and hung up.',
          },
          {
            id: 'rep_fall_for_call',
            label: 'Agree to enter UPI PIN to receive money',
            tone: 'danger',
            triggersUnsafeId: 'agreed_on_scam_call',
            nextAppId: 'payeasy',
            nextScreenId: 'payeasy_pin_keypad',
            endCall: true,
            feedbackMessage:
              'Risky reaction: caller pressured you toward the UPI PIN trap.',
          },
        ],
      },
    },
  ],
};

export default function App() {
  const [sessionKey, setSessionKey] = useState(0);
  const [paceMode, setPaceMode] = useState<'untimed' | 'timed' | 'relaxed'>(
    'untimed'
  );
  const [liveLog, setLiveLog] = useState<SandboxSessionLog>(() =>
    createEmptySandboxLog()
  );
  const [completedSnapshot, setCompletedSnapshot] =
    useState<SandboxSessionLog | null>(null);

  const startedAtMs = useMemo(() => Date.now(), [sessionKey, paceMode]);
  const deadlineMs = useMemo(() => {
    if (paceMode === 'timed') {
      return startedAtMs + 90 * 1000;
    }
    if (paceMode === 'relaxed') {
      return startedAtMs + 135 * 1000;
    }
    return null;
  }, [startedAtMs, paceMode]);

  return (
    <div className="min-h-screen bg-[#F8F7F4] text-zinc-900 p-4 font-sans">
      <div className="max-w-xl mx-auto space-y-4">
        {/* Workbench Controls */}
        <header className="rounded-2xl border border-stone-300 bg-white p-4 space-y-3 shadow-sm">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <div>
              <span className="inline-block rounded-md border border-blue-700 bg-blue-50 px-2 py-0.5 text-xs font-bold text-blue-700">
                Standalone OS Module
              </span>
              <h1 className="text-xl font-bold pt-1">
                PracticeOS — Dev & Sandbox Workbench
              </h1>
            </div>
            <button
              type="button"
              onClick={() => {
                setCompletedSnapshot(null);
                setLiveLog(createEmptySandboxLog());
                setSessionKey((k) => k + 1);
              }}
              className="min-h-[40px] rounded-xl bg-blue-700 text-white px-3.5 py-2 text-xs font-bold cursor-pointer"
            >
              ↻ Reboot PracticeOS
            </button>
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <span className="text-xs font-bold text-zinc-600">Pace Mode:</span>
            {(['untimed', 'timed', 'relaxed'] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                onClick={() => {
                  setPaceMode(mode);
                  setCompletedSnapshot(null);
                  setSessionKey((k) => k + 1);
                }}
                className={`min-h-[34px] rounded-lg border px-3 py-1 text-xs font-bold capitalize cursor-pointer ${
                  paceMode === mode
                    ? 'border-blue-700 bg-blue-50 text-blue-800'
                    : 'border-stone-300 bg-stone-50 text-zinc-700'
                }`}
              >
                {mode}
              </button>
            ))}
          </div>
        </header>

        {/* Extracted PracticeOS Instance */}
        <PracticeOS
          key={String(sessionKey) + '-' + paceMode}
          phone={SAMPLE_PHONE_CONFIG}
          paceMode={paceMode}
          deadlineMs={deadlineMs}
          startedAtMs={startedAtMs}
          onLogChange={setLiveLog}
          onCompleteSandbox={(finalLog) => setCompletedSnapshot(finalLog)}
          onRequestExitPractice={() => {
            setCompletedSnapshot(null);
            setSessionKey((k) => k + 1);
          }}
        />

        {/* Live Telemetry Inspector (Shows the exact SandboxSessionLog output for grading) */}
        <section className="rounded-2xl border border-stone-300 bg-white p-4 space-y-2 text-xs">
          <div className="flex items-center justify-between">
            <h2 className="font-bold text-sm text-zinc-900">
              PracticeOS Output Telemetry (`SandboxSessionLog`)
            </h2>
            {completedSnapshot ? (
              <span className="rounded-full bg-emerald-100 text-emerald-900 px-2.5 py-0.5 font-bold">
                Session Emitted ✓
              </span>
            ) : (
              <span className="text-zinc-500 font-semibold">Live Stream</span>
            )}
          </div>
          <pre className="rounded-xl bg-zinc-900 text-zinc-100 p-3 overflow-x-auto leading-relaxed">
            {JSON.stringify(completedSnapshot ?? liveLog, null, 2)}
          </pre>
        </section>
      </div>
    </div>
  );
}