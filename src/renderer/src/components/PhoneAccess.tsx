import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Copy, KeyRound } from 'lucide-react';
import qrcode from 'qrcode-generator';
import type { PhoneInfo } from '@shared/types';
import { errorMessage, mb } from '@/lib/api';
import { t } from '@/lib/i18n';
import { isWindows } from '@/lib/platform';
import { useStore } from '@/lib/store';
import { Button, Spinner, Toggle } from './ui';

/** The pairing link as a QR code (dark modules on the screen colour, so phones read it easily). */
function QrCode({ text, size = 188 }: { text: string; size?: number }) {
  const path = useMemo(() => {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + 4} ${r + 4}h1v1h-1z`;
    return { d, n: n + 8 };
  }, [text]);
  return (
    <svg viewBox={`0 0 ${path.n} ${path.n}`} width={size} height={size} role="img" aria-label={t('QR code for the phone')} className="shrink-0 rounded-xl bg-screen" shapeRendering="crispEdges">
      <path d={path.d} fill="#160d12" />
    </svg>
  );
}

function Step({ n, children }: { n: number; children: ReactNode }) {
  return (
    <li className="flex gap-3">
      <span className="grid h-6 w-6 shrink-0 place-items-center rounded-full bg-curtain font-mono text-[11px] text-bulb">{n}</span>
      <span className="pt-0.5">{children}</span>
    </li>
  );
}

/**
 * Settings → Phone: a phone on the same network opens the app in its browser (QR code) and can
 * watch there or start things on the computer.
 */
export function PhoneAccess() {
  const toast = useStore((s) => s.toast);
  const running = useStore((s) => s.downloads.filter((d) => !d.finished).length);
  const refreshStatus = useStore((s) => s.refreshStatus);
  const [info, setInfo] = useState<PhoneInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [which, setWhich] = useState(0);

  useEffect(() => {
    mb.phone().then(setInfo, () => undefined);
  }, []);

  const change = async (patch: { enabled?: boolean; newKey?: boolean }) => {
    if (patch.enabled !== undefined && running && !window.confirm(t('Turning phone access on or off restarts the engine and stops the downloads in progress. Continue?'))) return;
    setBusy(true);
    try {
      setInfo(await mb.setPhone(patch));
      if (patch.enabled !== undefined) {
        useStore.setState({ providers: [], categories: [], categoriesLoaded: false });
        setTimeout(() => void refreshStatus(), 1500);
      }
      if (patch.newKey) toast('success', t('New pairing code'), t('Phones paired before must scan the new code.'));
    } catch (e) {
      toast('error', t('Could not change phone access'), errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <Spinner />;
  const link = info.urls[which] ?? info.urls[0];
  return (
    <div>
      <div className="divide-y divide-seam/60">
        <Toggle
          label={t('Phone access')}
          hint={t('Phones on the same Wi-Fi open the app in their browser. Turning it on or off restarts the engine.')}
          checked={info.enabled}
          onChange={(v) => void change({ enabled: v })}
        />
      </div>
      {busy && <Spinner />}
      {info.enabled && info.error && <p className="mt-3 rounded-lg border border-err/30 bg-err/10 px-3 py-2 text-[13px]">{info.error}</p>}
      {info.enabled && !info.error && !link && (
        <p className="mt-3 text-[13px] text-usher">{t("This computer isn't on a home network (Wi-Fi or cable) a phone could reach.")}</p>
      )}
      {info.enabled && !info.error && link && (
        <div className="mt-4 flex flex-wrap items-start gap-6">
          <QrCode text={link.url} />
          <div className="min-w-[260px] flex-1 text-[13px] leading-relaxed text-usher">
            <ol className="space-y-2.5">
              <Step n={1}>{t("Open the phone's camera and point it at the code, then tap the link it shows.")}</Step>
              <Step n={2}>{t('On an iPhone, tap Share → Add to Home Screen: the app gets its own icon.')}</Step>
              <Step n={3}>
                {isWindows
                  ? t('If Windows asks whether Kope\'s Kinoteatri may use the network, allow it on private networks.')
                  : t('If the computer asks whether Kope\'s Kinoteatri may accept connections, allow it.')}
              </Step>
            </ol>
            <div className="mt-4 flex flex-wrap items-center gap-2">
              {info.urls.length > 1 ? (
                <select
                  value={which}
                  onChange={(e) => setWhich(Number(e.target.value))}
                  className="h-8 rounded-lg border border-seam bg-velvet px-2 font-mono text-[12px] text-screen outline-none [color-scheme:dark]"
                >
                  {info.urls.map((u, i) => (
                    <option key={u.url} value={i}>
                      {new URL(u.url).host} · {u.label}
                    </option>
                  ))}
                </select>
              ) : (
                <span className="font-mono text-[12px] text-screen" data-selectable>
                  {new URL(link.url).host}
                </span>
              )}
              <Button
                size="sm"
                variant="quiet"
                icon={<Copy size={13} />}
                onClick={() =>
                  void navigator.clipboard.writeText(link.url).then(
                    () => toast('success', t('Link copied'), t('Open it on the phone (it pairs the phone).')),
                    () => undefined,
                  )
                }
              >
                {t('Copy link')}
              </Button>
              <Button size="sm" variant="quiet" icon={<KeyRound size={13} />} disabled={busy} onClick={() => void change({ newKey: true })}>
                {t('New pairing code')}
              </Button>
            </div>
            <p className="mt-3 text-[12px] text-dim">
              {t('Watching on the phone uses the engine here: the computer must stay on, with the app open.')}
              {info.watching ? ` ${t('A phone is watching now.')}` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
