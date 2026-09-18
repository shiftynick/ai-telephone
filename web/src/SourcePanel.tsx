import { useEffect, useRef, useState } from 'react';
import QRCode from 'qrcode';
import { api, mediaUrl, type LanView, type SessionView } from './api.ts';
import { Banner, CopyText, Pill, Section, fmtTime } from './util.tsx';

function Qr({ value }: { value: string }) {
  const [src, setSrc] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    // Rendered locally by the bundled qrcode package: no network, no external image service.
    QRCode.toDataURL(value, { margin: 1, width: 220, color: { dark: '#000000', light: '#ffffff' } }).then(
      (d) => alive && setSrc(d),
      () => alive && setSrc(null),
    );
    return () => {
      alive = false;
    };
  }, [value]);
  return src ? (
    <img src={src} width={220} height={220} alt="QR code for the phone upload link" className="rounded bg-white p-1" />
  ) : (
    <div className="flex h-[220px] w-[220px] items-center justify-center rounded bg-neutral-800 text-xs text-neutral-400">QR unavailable</div>
  );
}

export function SourcePanel({
  session,
  lan,
  onChanged,
  onError,
}: {
  session: SessionView | null;
  lan: LanView | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [selected, setSelected] = useState<string>('');
  const [manual, setManual] = useState('');
  const [busy, setBusy] = useState(false);
  const [text, setText] = useState('');
  const fileRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    if (lan?.active) setSelected(lan.active.address);
    else if (!selected && lan?.candidates.length) setSelected(lan.candidates[0].address);
  }, [lan]); // eslint-disable-line react-hooks/exhaustive-deps

  const guard = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    try {
      await fn();
      onChanged();
    } catch (e) {
      onError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const joinUrl =
    lan?.active && session ? `http://${lan.active.address}:${lan.active.port}/join/${session.uploadToken}` : null;

  return (
    <Section title="Source">
      {/* --- LAN sharing ------------------------------------------------ */}
      <div className="space-y-2">
        <div className="lbl">Phone upload over local Wi-Fi</div>
        <div className="grid gap-2 sm:grid-cols-2">
          <div>
            <label className="lbl">Network address</label>
            <select className="inp mt-1" value={selected} onChange={(e) => setSelected(e.target.value)}>
              <option value="">(choose an address)</option>
              {(lan?.candidates ?? []).map((c) => (
                <option key={c.address} value={c.address}>
                  {c.name} — {c.address}
                </option>
              ))}
              {manual.trim() && <option value={manual.trim()}>manual — {manual.trim()}</option>}
            </select>
          </div>
          <div>
            <label className="lbl">Manual IPv4 override</label>
            <input
              className="inp mt-1 font-mono"
              placeholder="192.168.1.23"
              value={manual}
              onChange={(e) => {
                setManual(e.target.value);
                if (/^\d{1,3}(\.\d{1,3}){3}$/.test(e.target.value.trim())) setSelected(e.target.value.trim());
              }}
            />
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" className="btn btn-primary" disabled={busy || !selected} onClick={() => guard(() => api.setLan(selected))}>
            Start LAN sharing
          </button>
          <button type="button" className="btn" disabled={busy || !lan?.active} onClick={() => guard(() => api.setLan(null))}>
            Stop LAN sharing
          </button>
          <button type="button" className="btn btn-xs" disabled={busy} onClick={() => guard(() => api.rotate('upload'))}>
            Rotate upload link
          </button>
          {lan?.active ? <Pill tone="ok">listening on {lan.active.address}:{lan.active.port}</Pill> : <Pill>not shared</Pill>}
        </div>
        {lan?.warning && <Banner kind="warn">{lan.warning}</Banner>}
        {lan?.firewallHint && <p className="font-mono text-[11px] text-neutral-400">{lan.firewallHint}</p>}
        {joinUrl && (
          <div className="flex flex-wrap items-start gap-4">
            <Qr value={joinUrl} />
            <div className="min-w-64 flex-1 space-y-2">
              <p className="text-xs text-neutral-400">Point the phone camera at this code, or type the URL:</p>
              <CopyText value={joinUrl} />
              <p className="text-[11px] text-neutral-500">
                Rotating the upload link immediately invalidates the old QR code. Uploads never start a run or contact any provider.
              </p>
            </div>
          </div>
        )}
      </div>

      <hr className="border-neutral-800" />

      {/* --- desktop upload / starting text ------------------------------ */}
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="lbl">Desktop upload (fallback)</label>
          <input
            ref={fileRef}
            type="file"
            accept="image/*"
            disabled={busy}
            className="mt-1 block w-full text-xs text-neutral-300 file:mr-2 file:rounded file:border file:border-neutral-700 file:bg-neutral-800 file:px-2 file:py-1 file:text-neutral-100"
            onChange={(e) => {
              const f = e.target.files?.[0];
              e.target.value = '';
              if (f) void guard(() => api.desktopUpload(f));
            }}
          />
        </div>
        <div>
          <label className="lbl">Starting text (instead of an image)</label>
          <div className="mt-1 flex gap-1">
            <input className="inp" placeholder="A scene description to start from…" value={text} onChange={(e) => setText(e.target.value)} />
            <button
              type="button"
              className="btn"
              disabled={busy || !text.trim()}
              onClick={() =>
                guard(async () => {
                  await api.sourceText(text.trim());
                  setText('');
                })
              }
            >
              Use
            </button>
          </div>
        </div>
      </div>

      {/* --- accepted source -------------------------------------------- */}
      <div className="rounded-md border border-neutral-800 bg-neutral-900/60 p-2">
        <div className="lbl mb-1">Current source (used by the next run)</div>
        {session?.source ? (
          <div className="flex items-start gap-3">
            {session.source.kind === 'image' ? (
              <img src={mediaUrl(session.source.id)} alt="accepted source" className="h-24 w-24 rounded object-cover" />
            ) : (
              <div className="max-h-24 flex-1 overflow-y-auto rounded bg-neutral-950 p-2 text-xs text-neutral-200">{session.source.text}</div>
            )}
            <div className="text-xs text-neutral-400">
              <Pill tone="ok">accepted</Pill>
              <div className="mt-1">
                {session.source.kind}
                {session.source.width ? ` · ${session.source.width}×${session.source.height}` : ''}
              </div>
              <div className="font-mono text-[11px] text-neutral-500">{session.source.id}</div>
            </div>
          </div>
        ) : (
          <p className="text-sm text-neutral-500">Nothing accepted yet. Accept an upload below, or enter starting text.</p>
        )}
      </div>

      {/* --- incoming uploads ------------------------------------------- */}
      <div>
        <div className="lbl mb-1">Incoming uploads</div>
        <div className="max-h-72 space-y-2 overflow-y-auto pr-1">
          {(session?.uploads ?? []).length === 0 && <p className="text-sm text-neutral-500">No uploads yet.</p>}
          {(session?.uploads ?? []).map((u) => (
            <div key={u.id} className="flex items-start gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-2">
              {u.artifact.kind === 'image' ? (
                <img src={mediaUrl(u.artifact.id)} alt="upload" className="h-20 w-20 shrink-0 rounded object-cover" />
              ) : (
                <div className="h-20 w-32 shrink-0 overflow-y-auto rounded bg-neutral-950 p-1 text-[10px] leading-snug text-neutral-300">{u.artifact.text}</div>
              )}
              <div className="min-w-0 flex-1 text-xs text-neutral-400">
                <div className="flex flex-wrap items-center gap-1">
                  <Pill tone={u.status === 'accepted' ? 'ok' : u.status === 'rejected' ? 'error' : 'neutral'}>{u.status}</Pill>
                  <Pill>{u.origin}</Pill>
                  <span className="text-neutral-500">{fmtTime(u.createdAt)}</span>
                </div>
                <div className="mt-1 break-words">
                  {u.artifact.width ? `${u.artifact.width}×${u.artifact.height} · ` : ''}
                  {u.transformations.length ? u.transformations.join(', ') : 'no transformations'}
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-1">
                <button
                  type="button"
                  className="btn btn-xs btn-primary"
                  disabled={busy || u.status === 'accepted'}
                  onClick={() => guard(() => api.decideUpload(u.id, 'accept'))}
                >
                  Accept as source
                </button>
                <button type="button" className="btn btn-xs" disabled={busy || u.status === 'rejected'} onClick={() => guard(() => api.decideUpload(u.id, 'reject'))}>
                  Reject
                </button>
              </div>
            </div>
          ))}
        </div>
        <p className="mt-2 text-[11px] text-neutral-500">
          Accepting only marks the image as the next run’s source. Nothing is sent to OpenRouter or fal until you create and start a run.
        </p>
      </div>
    </Section>
  );
}

export function ProjectorPanel({
  session,
  lan,
  onChanged,
  onError,
}: {
  session: SessionView | null;
  lan: LanView | null;
  onChanged: () => void;
  onError: (msg: string) => void;
}) {
  const [busy, setBusy] = useState(false);
  if (!session) return null;
  const localUrl = `${location.origin}/present/${session.projectorToken}`;
  const lanUrl = lan?.active ? `http://${lan.active.address}:${lan.active.port}/present/${session.projectorToken}` : null;
  return (
    <Section title="Projector">
      <div className="flex flex-wrap items-center gap-2">
        <a className="btn btn-primary" href={localUrl} target="_blank" rel="noreferrer">
          Open projector window
        </a>
        <button
          type="button"
          className="btn btn-xs"
          disabled={busy}
          onClick={async () => {
            setBusy(true);
            try {
              await api.rotate('projector');
              onChanged();
            } catch (e) {
              onError(String((e as Error).message));
            } finally {
              setBusy(false);
            }
          }}
        >
          Rotate projector link
        </button>
      </div>
      <CopyText value={localUrl} />
      {lanUrl && (
        <>
          <div className="lbl">LAN address (for a second machine)</div>
          <CopyText value={lanUrl} />
        </>
      )}
      <p className="text-[11px] text-neutral-500">The projector view is read-only and can never fetch an unrevealed stage.</p>
    </Section>
  );
}
