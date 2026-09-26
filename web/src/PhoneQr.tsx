import { useEffect, useState } from 'react';
import QRCode from 'qrcode';
import { api, type LanView, type PublicView, type SessionView } from './api.ts';

/**
 * The phone-upload QR code, big in the middle of the projector so the room can scan it. Uses the public link
 * (Tailscale Funnel: no Wi-Fi needed) when it is on, otherwise the LAN link; offers to start the public link
 * when neither is on. Host-only: it needs the session's upload token.
 */
export function PhoneQr({ session, onClose }: { session: SessionView; onClose: () => void }) {
  const [pub, setPub] = useState<PublicView | null>(null);
  const [lan, setLan] = useState<LanView | null>(null);
  const [src, setSrc] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => Promise.all([api.publicLink().then(setPub, () => {}), api.lan().then(setLan, () => {})]);
  useEffect(() => { void refresh(); }, []);

  const url = pub?.active ? `${pub.active.url}/join/${session.uploadToken}`
    : lan?.active ? `http://${lan.active.address}:${lan.active.port}/join/${session.uploadToken}` : null;

  useEffect(() => {
    if (!url) return setSrc(null);
    let alive = true;
    // rendered locally by the bundled qrcode package: no network, no external image service
    QRCode.toDataURL(url, { margin: 1, width: 900, errorCorrectionLevel: 'M', color: { dark: '#000000', light: '#ffffff' } }).then(
      (d) => alive && setSrc(d),
      () => alive && setSrc(null),
    );
    return () => { alive = false; };
  }, [url]);

  const startPublic = async () => {
    setBusy(true);
    setError(null);
    try {
      setPub(await api.setPublic(true));
    } catch (e) {
      setError(String((e as Error).message));
    } finally {
      setBusy(false);
    }
  };

  const received = session.uploads.filter((u) => u.origin.startsWith('phone')).length; // photos (and texts) sent from phones
  return (
    <div className="absolute inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm" onClick={onClose}>
      <div className="flex max-h-[92vh] items-center gap-[4vw] rounded-3xl bg-neutral-950/95 p-[3vh_3vw] shadow-2xl ring-1 ring-white/10" onClick={(e) => e.stopPropagation()}>
        <div className="flex flex-col items-center">
          {src ? (
            <img src={src} alt="QR code for the phone upload link" className="rounded-2xl bg-white p-[1.2vh]" style={{ height: '62vh', width: '62vh' }} />
          ) : (
            <div className="flex items-center justify-center rounded-2xl bg-neutral-900 text-center text-neutral-400" style={{ height: '62vh', width: '62vh', fontSize: 'clamp(14px, 1.4vw, 26px)' }}>
              {url ? 'Drawing the code…' : 'The phone link is off.'}
            </div>
          )}
        </div>
        <div className="max-w-[34vw] text-left">
          <div className="tracking-[0.25em] text-sky-300 uppercase" style={{ fontSize: 'clamp(10px, 1vw, 18px)' }}>your turn</div>
          <div className="mt-[1vh] font-semibold text-neutral-50" style={{ fontSize: 'clamp(28px, 4vw, 76px)', lineHeight: 1.05 }}>Add your photo</div>
          <div className="mt-[2vh] text-neutral-300" style={{ fontSize: 'clamp(14px, 1.5vw, 28px)' }}>
            {pub?.active ? 'Point your phone camera at the code. No app, no Wi-Fi needed.'
              : lan?.active ? 'Join the venue Wi-Fi, then point your phone camera at the code.'
              : 'Start the public link so phones can join from anywhere.'}
          </div>
          {url && <div className="mt-[2vh] font-mono break-all text-neutral-500" style={{ fontSize: 'clamp(10px, 0.9vw, 16px)' }}>{url}</div>}
          {!url && (
            <button type="button" disabled={busy} onClick={() => void startPublic()} className="mt-[3vh] rounded-xl bg-sky-500 px-[1.6vw] py-[1vh] font-semibold text-white hover:bg-sky-400 disabled:opacity-50" style={{ fontSize: 'clamp(13px, 1.2vw, 22px)' }}>
              {busy ? 'Starting…' : 'Start public link'}
            </button>
          )}
          {error && <div className="mt-[1.5vh] text-red-300" style={{ fontSize: 'clamp(11px, 1vw, 18px)' }}>{error}</div>}
          <div className="mt-[4vh] flex items-baseline gap-[0.8vw] text-neutral-300" style={{ fontSize: 'clamp(14px, 1.6vw, 30px)' }}>
            <span className="font-semibold text-amber-300 tabular-nums" style={{ fontSize: 'clamp(24px, 3vw, 56px)' }}>{received}</span>
            {received === 1 ? 'photo in so far' : 'photos in so far'}
          </div>
          <div className="mt-[3vh] text-neutral-600" style={{ fontSize: 'clamp(10px, 0.85vw, 15px)' }}>Q or click outside to close</div>
        </div>
      </div>
    </div>
  );
}
