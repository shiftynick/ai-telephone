import type {
  ArtifactView,
  ModelsView,
  Preset,
  PresetBody,
  PresentState,
  RunStatus,
  RunView,
  StepIssue,
  StepType,
} from '../../shared/types.ts';

// ---- view models that only exist on the wire (documented in docs/API.md) ----

export type StatusView =
  | { host: false }
  | { host: true; mock: boolean; port: number; defaultBudgetUsd: number | null; keys: { openrouter: boolean; fal: boolean } };

export type UploadView = {
  id: string;
  origin: 'phone' | 'phone-text' | 'desktop' | 'text';
  status: 'pending' | 'accepted' | 'rejected';
  createdAt: number;
  transformations: string[];
  artifact: ArtifactView;
};

export type SessionView = {
  id: string;
  uploadToken: string;
  projectorToken: string;
  expiresAt: number;
  source: ArtifactView | null;
  uploads: UploadView[];
  selectedRunId: string | null;
  replay: boolean;
  autoReveal: boolean;
  revealed: number[];
  currentStage: number;
  compare: boolean;
};

export type SourceCandidate = {
  artifact: ArtifactView;
  label: string;
  createdAt: number;
  isCurrent: boolean;
};

export type LanView = {
  candidates: { name: string; address: string }[];
  active: { address: string; port: number } | null;
  firewallHint: string | null;
  warning: string;
};

export type RunListItem = { id: string; name: string; status: RunStatus; createdAt: number; imported: boolean; stepCount: number };

export type RevealAction =
  | { action: 'show'; stage: number }
  | { action: 'next' }
  | { action: 'prev' }
  | { action: 'final' }
  | { action: 'reset' }
  | { action: 'compare'; on: boolean }
  | { action: 'auto'; on: boolean };

export type RunAction = 'start' | 'next' | 'pause' | 'resume' | 'stop' | 'retry';

/** Which run controls are valid in each status (shared by the host console and the projector overlay). */
export const ALLOWED_ACTIONS: Record<RunView['status'], RunAction[]> = {
  ready: ['start', 'next', 'stop'],
  running: ['pause', 'stop'],
  paused: ['resume', 'next', 'stop'],
  failed: ['retry', 'stop'],
  completed: [],
  stopped: [],
};

// ---- error type -----------------------------------------------------------

export class ApiError extends Error {
  status: number;
  body: unknown;
  issues?: StepIssue[] | string[];
  constructor(message: string, status: number, body: unknown) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.body = body;
    const iss = (body as { issues?: StepIssue[] | string[] } | null)?.issues;
    if (iss) this.issues = iss;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  let res: Response;
  try {
    res = await fetch(path, { credentials: 'same-origin', ...init });
  } catch (e) {
    throw new ApiError(`Could not reach the local server (${String((e as Error)?.message ?? e)}).`, 0, null);
  }
  const text = await res.text();
  let body: unknown = null;
  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
  }
  if (!res.ok) {
    const msg =
      (body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
        ? (body as { error: string }).error
        : typeof body === 'string' && body
          ? body
          : `Request failed (HTTP ${res.status}).`);
    throw new ApiError(msg, res.status, body);
  }
  return body as T;
}

const json = <T,>(path: string, method: string, data?: unknown) =>
  request<T>(path, {
    method,
    // Fastify rejects an empty body that declares a JSON content type, so only send the header with a body.
    headers: data === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: data === undefined ? undefined : JSON.stringify(data),
  });

export const api = {
  // auth / status
  exchange: (code: string) => json<{ ok: true }>('/api/auth/exchange', 'POST', { code }),
  status: () => request<StatusView>('/api/status'),

  // models & presets
  models: () => request<ModelsView>('/api/models'),
  refreshModels: () => json<ModelsView>('/api/models/refresh', 'POST'),
  presets: () => request<{ presets: Preset[] }>('/api/presets'),
  createPreset: (preset: PresetBody) => json<Preset>('/api/presets', 'POST', preset),
  replacePreset: (id: string, preset: PresetBody) => json<Preset>(`/api/presets/${id}`, 'PUT', { confirmReplace: true, preset }),
  deletePreset: (id: string) => json<{ ok: true }>(`/api/presets/${id}`, 'DELETE'),
  validatePreset: (preset: PresetBody) => json<{ issues: StepIssue[] }>('/api/presets/validate', 'POST', preset),

  // session
  session: () => request<SessionView>('/api/session'),
  rotate: (which: 'upload' | 'projector' | 'both') => json<SessionView>('/api/session/rotate', 'POST', { which }),
  sourceText: (text: string) => json<SessionView>('/api/session/source-text', 'POST', { text }),
  decideUpload: (id: string, decision: 'accept' | 'reject') => json<SessionView>(`/api/session/uploads/${id}/${decision}`, 'POST'),
  sources: () => request<{ sources: SourceCandidate[] }>('/api/sources'),
  setSource: (artifactId: string) => json<SessionView>('/api/session/source', 'POST', { artifactId }),
  selectRun: (runId: string | null, replay: boolean) => json<SessionView>('/api/session/select-run', 'POST', { runId, replay }),
  reveal: (action: RevealAction) => json<SessionView>('/api/session/reveal', 'POST', action),
  desktopUpload: (file: File) => {
    const fd = new FormData();
    fd.append('file', file);
    return request<{ uploadId: string; width: number; height: number; transformations: string[]; session: SessionView }>(
      '/api/session/uploads',
      { method: 'POST', body: fd },
    );
  },

  // LAN
  lan: () => request<LanView>('/api/lan'),
  setLan: (address: string | null) => json<{ active: LanView['active'] }>('/api/lan', 'POST', { address }),

  // runs
  runs: () => request<{ runs: RunListItem[] }>('/api/runs'),
  run: (id: string) => request<RunView>(`/api/runs/${id}`),
  createRun: (body: { preset: PresetBody; sourceArtifactId?: string; budgetUsd?: number | null; select?: boolean; interactive?: boolean; autoBridge?: boolean }) =>
    json<RunView>('/api/runs', 'POST', body),
  appendStep: (id: string, type: StepType, twist?: string) => json<RunView>(`/api/runs/${id}/steps`, 'POST', { type, ...(twist ? { twist } : {}) }),
  runAction: (id: string, action: RunAction, acknowledgeBilling = false) =>
    json<RunView>(`/api/runs/${id}/actions`, 'POST', { action, acknowledgeBilling }),

  // phone / projector
  join: (token: string) => request<{ ok: true; sessionId: string; maxBytes: number }>(`/api/join/${encodeURIComponent(token)}`),
  presentState: (token: string) => request<PresentState>(`/api/present/${encodeURIComponent(token)}/state`),
  joinText: (sessionId: string, token: string, text: string) =>
    request<{ ok: true }>(`/api/sessions/${encodeURIComponent(sessionId)}/text`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-upload-token': token },
      body: JSON.stringify({ text }),
    }),
};

export const mediaUrl = (artifactId: string, projectorToken?: string) =>
  projectorToken ? `/media/${artifactId}?t=${encodeURIComponent(projectorToken)}` : `/media/${artifactId}`;

/** Phone upload with real progress; fetch() cannot report upload progress. */
export function uploadWithProgress(
  sessionId: string,
  token: string,
  file: File,
  onProgress: (fraction: number) => void,
): { promise: Promise<{ ok: true; width: number; height: number }>; abort: () => void } {
  const xhr = new XMLHttpRequest();
  const promise = new Promise<{ ok: true; width: number; height: number }>((resolve, reject) => {
    xhr.open('POST', `/api/sessions/${encodeURIComponent(sessionId)}/uploads`);
    xhr.setRequestHeader('x-upload-token', token);
    xhr.upload.onprogress = (e) => {
      if (e.lengthComputable) onProgress(e.loaded / e.total);
    };
    xhr.onerror = () => reject(new ApiError('The upload failed. Check that you are still on the same Wi-Fi network.', 0, null));
    xhr.onabort = () => reject(new ApiError('Upload cancelled.', 0, null));
    xhr.onload = () => {
      let body: unknown = null;
      try {
        body = JSON.parse(xhr.responseText);
      } catch {
        body = xhr.responseText;
      }
      if (xhr.status >= 200 && xhr.status < 300) {
        onProgress(1);
        resolve(body as { ok: true; width: number; height: number });
      } else {
        const msg =
          body && typeof body === 'object' && typeof (body as { error?: unknown }).error === 'string'
            ? (body as { error: string }).error
            : `Upload failed (HTTP ${xhr.status}).`;
        reject(new ApiError(msg, xhr.status, body));
      }
    };
    const fd = new FormData();
    fd.append('file', file);
    xhr.send(fd);
  });
  return { promise, abort: () => xhr.abort() };
}
