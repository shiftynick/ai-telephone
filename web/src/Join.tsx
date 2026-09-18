import { useEffect, useRef, useState } from 'react';
import { api, uploadWithProgress } from './api.ts';

type Phase = 'checking' | 'invalid' | 'pick' | 'preview' | 'uploading' | 'done';

export default function Join({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('checking');
  const [sessionId, setSessionId] = useState('');
  const [maxBytes, setMaxBytes] = useState(20 * 1048576);
  const [error, setError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<string | null>(null);
  const [progress, setProgress] = useState(0);
  const cameraRef = useRef<HTMLInputElement | null>(null);
  const libraryRef = useRef<HTMLInputElement | null>(null);
  const abortRef = useRef<(() => void) | null>(null);

  useEffect(() => {
    let alive = true;
    api.join(token).then(
      (r) => {
        if (!alive) return;
        setSessionId(r.sessionId);
        setMaxBytes(r.maxBytes);
        setPhase('pick');
      },
      (e) => {
        if (!alive) return;
        setError(String((e as Error).message));
        setPhase('invalid');
      },
    );
    return () => {
      alive = false;
    };
  }, [token]);

  useEffect(() => {
    if (!file) {
      setPreview(null);
      return;
    }
    const url = URL.createObjectURL(file);
    setPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

  const choose = (f: File | undefined) => {
    setError(null);
    if (!f) return;
    if (f.size > maxBytes) {
      setError(`That photo is ${(f.size / 1048576).toFixed(1)} MB, larger than the ${Math.round(maxBytes / 1048576)} MB limit. Choose a smaller one.`);
      return;
    }
    setFile(f);
    setPhase('preview');
  };

  const upload = async () => {
    if (!file) return;
    setError(null);
    setProgress(0);
    setPhase('uploading');
    const { promise, abort } = uploadWithProgress(sessionId, token, file, setProgress);
    abortRef.current = abort;
    try {
      await promise;
      setPhase('done');
    } catch (e) {
      setError(String((e as Error).message));
      setPhase('preview');
    } finally {
      abortRef.current = null;
    }
  };

  const reset = () => {
    setFile(null);
    setProgress(0);
    setError(null);
    setPhase('pick');
  };

  return (
    <div className="mx-auto flex min-h-full max-w-md flex-col gap-4 p-4">
      <h1 className="text-xl font-semibold text-neutral-100">AI Telephone — send a photo</h1>

      {phase === 'checking' && <p className="text-neutral-400">Checking this link…</p>}

      {phase === 'invalid' && (
        <div className="rounded-lg border border-red-900 bg-red-950/60 p-4 text-red-100">
          <p className="font-medium">This link does not work.</p>
          <p className="mt-1 text-sm">{error}</p>
        </div>
      )}

      {(phase === 'pick' || phase === 'preview' || phase === 'uploading') && (
        <>
          {error && <div className="rounded-lg border border-red-900 bg-red-950/60 p-3 text-sm text-red-100">{error}</div>}

          {phase === 'pick' && (
            <div className="flex flex-col gap-3">
              <button type="button" className="rounded-xl bg-sky-600 px-4 py-6 text-lg font-semibold text-white active:bg-sky-700" onClick={() => cameraRef.current?.click()}>
                📷 Take photo
              </button>
              <button
                type="button"
                className="rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-6 text-lg font-semibold text-neutral-100 active:bg-neutral-700"
                onClick={() => libraryRef.current?.click()}
              >
                🖼 Choose from library
              </button>
            </div>
          )}

          <input
            ref={cameraRef}
            type="file"
            accept="image/*"
            capture="environment"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              choose(f);
            }}
          />
          <input
            ref={libraryRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              choose(f);
            }}
          />

          {preview && (
            <div className="space-y-3">
              <img src={preview} alt="your photo" className="w-full rounded-xl border border-neutral-800 object-contain" />
              {phase === 'uploading' ? (
                <div className="space-y-2">
                  <div className="h-3 w-full overflow-hidden rounded-full bg-neutral-800">
                    <div className="h-full bg-sky-500 transition-[width] duration-150" style={{ width: `${Math.round(progress * 100)}%` }} />
                  </div>
                  <p className="text-center text-sm text-neutral-400">Uploading… {Math.round(progress * 100)}%</p>
                </div>
              ) : (
                <div className="flex gap-3">
                  <button type="button" className="flex-1 rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-4 text-base text-neutral-100" onClick={reset}>
                    Retake
                  </button>
                  <button type="button" className="flex-[2] rounded-xl bg-sky-600 px-4 py-4 text-base font-semibold text-white" onClick={() => void upload()}>
                    Upload
                  </button>
                </div>
              )}
            </div>
          )}
        </>
      )}

      {phase === 'done' && (
        <div className="space-y-4">
          <div className="rounded-xl border border-emerald-800 bg-emerald-950/60 p-5 text-center">
            <div className="text-2xl">✓</div>
            <p className="mt-1 text-lg font-semibold text-emerald-100">Sent! The host will review it.</p>
          </div>
          <button type="button" className="w-full rounded-xl border border-neutral-700 bg-neutral-800 px-4 py-4 text-base text-neutral-100" onClick={reset}>
            Send another
          </button>
        </div>
      )}

      <div className="mt-auto space-y-2 rounded-lg border border-neutral-800 bg-neutral-900/60 p-3 text-xs leading-relaxed text-neutral-400">
        <p>
          If the host accepts your photo, it is sent to external AI providers (OpenRouter and fal.ai) to be described and re-generated. It is not kept
          private to this laptop.
        </p>
        <p>Please photograph objects or a tabletop scene — or get permission from anyone who is visible.</p>
        <p>This link goes over the local Wi-Fi without encryption. Only send photos you are happy to share with the room.</p>
      </div>
    </div>
  );
}
