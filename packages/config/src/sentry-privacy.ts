import type { ErrorEvent, EventHint, NodeOptions, StackFrame } from '@sentry/nestjs';

function safeFrame(frame: StackFrame): StackFrame {
  // Preserve code locations for diagnosis; omit locals and source lines.
  const filename = frame.filename?.split(/[?#]/, 1)[0]?.replace(/(\/\/)[^/@]+@/, '$1');
  return {
    filename,
    function: frame.function,
    lineno: frame.lineno,
    colno: frame.colno,
    in_app: frame.in_app,
  };
}

export function scrubSentryEvent(event: ErrorEvent, hint: EventHint): ErrorEvent {
  // Attachments travel outside the event body and need their own removal.
  hint.attachments = [];
  const tags: Record<string, string> = {};
  if (event.tags?.process === 'api' || event.tags?.process === 'worker') {
    tags.process = event.tags.process;
  }
  const requestId = event.tags?.requestId;
  if (typeof requestId === 'string' && /^[A-Za-z0-9._:-]{1,64}$/.test(requestId)) {
    tags.requestId = requestId;
  }
  const original = hint.originalException;
  if (original instanceof Error && 'code' in original &&
      typeof original.code === 'string' && /^[A-Z][A-Z0-9_]{0,95}$/.test(original.code)) {
    tags.errorCode = original.code;
  }
  // An allowlist also covers historical/new SDK fields without guessing secret names.
  return {
    type: undefined,
    event_id: event.event_id,
    timestamp: event.timestamp,
    level: event.level,
    platform: event.platform,
    release: event.release,
    environment: event.environment,
    tags,
    exception: {
      values: (event.exception?.values ?? []).map(exception => ({
        type: ['Error', 'TypeError', 'RangeError', 'SyntaxError', 'AppError'].includes(exception.type ?? '')
          ? exception.type : 'Error',
        value: 'Internal application error',
        stacktrace: exception.stacktrace ? {
          frames: exception.stacktrace.frames?.map(safeFrame),
        } : undefined,
      })),
    },
  };
}

// Shared by both early instrumentation entrypoints; this module has no runtime SDK imports.
export const sentryPrivacyOptions = {
  sendDefaultPii: false,
  maxBreadcrumbs: 0,
  beforeBreadcrumb: () => null,
  beforeSend: scrubSentryEvent,
  enableLogs: false,
  beforeSendLog: () => null,
  tracesSampleRate: 0,
  beforeSendTransaction: () => null,
} satisfies Partial<NodeOptions>;
