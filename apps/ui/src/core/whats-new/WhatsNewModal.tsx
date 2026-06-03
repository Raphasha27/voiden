import { useState, useEffect, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { X, Sparkles } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import whatsNewData from './whats-new.json';

// ── Types ─────────────────────────────────────────────────────────────────────

type WhatsNewItem = {
  emoji: string;
  title: string;
  description: string;
};

type WhatsNewSection = {
  title: string;
  items: WhatsNewItem[];
};

type Release = {
  version: string;
  date: string;
  sections: WhatsNewSection[];
};

type WelcomeData = {
  headline: string;
  subheadline: string;
  items: WhatsNewItem[];
};

// ── Version helpers ───────────────────────────────────────────────────────────

function getBaseVersion(version: string): string {
  return version.replace(/-.*$/, '');
}

function compareVersions(a: string, b: string): number {
  const aParts = a.split('.').map(n => parseInt(n, 10) || 0);
  const bParts = b.split('.').map(n => parseInt(n, 10) || 0);
  const len = Math.max(aParts.length, bParts.length);
  for (let i = 0; i < len; i++) {
    const diff = (aParts[i] || 0) - (bParts[i] || 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function saveUiSettings(patch: { last_seen_version?: string; show_whats_new_after_update?: boolean }) {
  (window as any).electron?.userSettings?.set({ ui: patch });
}

// ── Hook ─────────────────────────────────────────────────────────────────────

function useWhatsNew() {
  const [open, setOpen] = useState(false);
  const [isFreshInstall, setIsFreshInstall] = useState(false);
  const [releases, setReleases] = useState<Release[]>([]);
  const [baseVersion, setBaseVersion] = useState('');

  useEffect(() => {
    (async () => {
      const [fullVersion, settings] = await Promise.all([
        (window as any).electron?.getVersion?.() as Promise<string> | undefined,
        (window as any).electron?.userSettings?.get(),
      ]);

      if (!fullVersion) return;

      const base = getBaseVersion(fullVersion);
      setBaseVersion(base);

      const lastSeen: string | undefined = settings?.ui?.last_seen_version;
      const showAfterUpdate: boolean = settings?.ui?.show_whats_new_after_update ?? false;

      if (showAfterUpdate) {
        saveUiSettings({ show_whats_new_after_update: false });
        const toShow = (whatsNewData.releases as Release[]).slice(0, 1);
        if (toShow.length > 0) {
          setReleases(toShow);
          setOpen(true);
        }
        return;
      }

      if (!lastSeen) {
        setIsFreshInstall(true);
        setOpen(true);
        return;
      }

      if (lastSeen !== base) {
        const newer = (whatsNewData.releases as Release[]).filter(
          r => compareVersions(r.version, lastSeen) > 0
        );
        if (newer.length > 0) {
          setReleases(newer);
          setOpen(true);
        } else {
          saveUiSettings({ last_seen_version: base });
        }
      }
    })();
  }, []);

  const dismiss = useCallback(() => {
    setOpen(false);
    if (baseVersion) {
      saveUiSettings({ last_seen_version: baseVersion, show_whats_new_after_update: false });
    }
  }, [baseVersion]);

  return {
    open,
    isFreshInstall,
    releases,
    dismiss,
    welcome: whatsNewData.welcome as WelcomeData,
  };
}

// ── Section accent colours ────────────────────────────────────────────────────

const SECTION_ACCENT: Record<string, { dot: string; badge: string; text: string }> = {
  'New Features':  { dot: 'rgb(var(--common-accent))',   badge: 'rgba(var(--common-accent), 0.12)', text: 'rgb(var(--common-accent))' },
  'Improvements':  { dot: '#22c55e',                    badge: 'rgba(34,197,94,0.12)',              text: '#22c55e' },
  'Bug Fixes':     { dot: '#f97316',                    badge: 'rgba(249,115,22,0.12)',             text: '#f97316' },
};

function getSectionAccent(title: string) {
  return SECTION_ACCENT[title] ?? SECTION_ACCENT['New Features'];
}

// ── Main component ────────────────────────────────────────────────────────────

export const WhatsNewModal = () => {
  const { open, isFreshInstall, releases, dismiss, welcome } = useWhatsNew();

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') dismiss(); };
    document.addEventListener('keydown', onKey, true);
    return () => document.removeEventListener('keydown', onKey, true);
  }, [open, dismiss]);

  const latestRelease = releases[0];

  return createPortal(
    <AnimatePresence>
      {open && (
        <motion.div
          key="backdrop"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.18 }}
          className="fixed inset-0 z-[10001] flex items-end sm:items-center justify-center p-4"
          style={{ backgroundColor: 'rgba(0,0,0,0.55)', backdropFilter: 'blur(3px)' }}
          onClick={dismiss}
        >
          <motion.div
            key="modal"
            initial={{ opacity: 0, y: 32, scale: 0.95 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 20, scale: 0.96 }}
            transition={{ type: 'spring', stiffness: 380, damping: 26, mass: 0.9 }}
            className="relative w-full flex flex-col overflow-hidden rounded-2xl border border-border shadow-2xl"
            style={{
              maxWidth: 500,
              maxHeight: '88vh',
              backgroundColor: 'var(--bg)',
            }}
            onClick={e => e.stopPropagation()}
          >
            {/* Subtle accent glow behind header */}
            <div
              className="pointer-events-none absolute inset-x-0 top-0 h-32 opacity-30"
              style={{
                background: 'radial-gradient(ellipse 70% 80% at 50% -20%, rgba(var(--common-accent), 0.35), transparent)',
              }}
            />

            {/* ── Header ────────────────────────────────────────────────── */}
            <div className="relative z-10 flex items-start justify-between gap-3 px-6 pt-6 pb-5 flex-shrink-0">
              <div className="flex items-center gap-3.5">
                {/* Icon badge */}
                <div
                  className="w-10 h-10 rounded-xl flex items-center justify-center flex-shrink-0"
                  style={{
                    background: 'rgba(var(--common-accent), 0.14)',
                    border: '1px solid rgba(var(--common-accent), 0.28)',
                    boxShadow: '0 0 16px rgba(var(--common-accent), 0.12)',
                  }}
                >
                  <Sparkles className="w-4.5 h-4.5" style={{ color: 'rgb(var(--common-accent))' }} />
                </div>

                <div>
                  <h2
                    className="text-[15px] font-bold leading-tight tracking-tight"
                    style={{ color: 'var(--text)' }}
                  >
                    {isFreshInstall ? welcome.headline : "What's New"}
                  </h2>

                  {isFreshInstall ? (
                    <p className="text-xs text-comment mt-0.5">{welcome.subheadline}</p>
                  ) : latestRelease ? (
                    <div className="flex items-center gap-1.5 mt-1">
                      <span
                        className="inline-flex items-center text-[10px] font-mono font-bold px-1.5 py-0.5 rounded-md"
                        style={{
                          color: 'rgb(var(--common-accent))',
                          background: 'rgba(var(--common-accent), 0.14)',
                          border: '1px solid rgba(var(--common-accent), 0.22)',
                        }}
                      >
                        v{latestRelease.version}
                      </span>
                      <span className="text-[11px] text-comment">{latestRelease.date}</span>
                    </div>
                  ) : null}
                </div>
              </div>

              {/* Close */}
              <button
                onClick={dismiss}
                className="text-comment hover:text-text transition-colors p-1.5 rounded-lg hover:bg-active flex-shrink-0 mt-0.5"
              >
                <X size={14} />
              </button>
            </div>

            {/* Divider */}
            <div className="relative z-10 h-px mx-6 flex-shrink-0" style={{ background: 'var(--border)' }} />

            {/* ── Body ──────────────────────────────────────────────────── */}
            <div className="relative z-10 overflow-y-auto flex-1 px-5 py-5">
              {isFreshInstall ? (
                <FreshInstallGrid items={welcome.items} />
              ) : (
                <UpdateChangelog releases={releases} />
              )}
            </div>

            {/* ── Footer ────────────────────────────────────────────────── */}
            <div
              className="relative z-10 px-5 pb-5 pt-4 flex-shrink-0"
              style={{ borderTop: '1px solid var(--border)' }}
            >
              <motion.button
                whileTap={{ scale: 0.97 }}
                onClick={dismiss}
                className="w-full font-semibold py-2.5 rounded-xl text-sm transition-opacity"
                style={{
                  background: `linear-gradient(135deg, rgb(var(--common-accent)) 0%, rgba(var(--common-accent), 0.8) 100%)`,
                  color: 'var(--bg)',
                  boxShadow: '0 2px 12px rgba(var(--common-accent), 0.3)',
                }}
                onMouseOver={e => { (e.currentTarget as HTMLElement).style.opacity = '0.88'; }}
                onMouseOut={e => { (e.currentTarget as HTMLElement).style.opacity = '1'; }}
              >
                Got it
              </motion.button>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>,
    document.body
  );
};

// ── Fresh install: 2×2 feature card grid ─────────────────────────────────────

const FreshInstallGrid = ({ items }: { items: WhatsNewItem[] }) => (
  <div className="grid grid-cols-2 gap-2.5">
    {items.map((item, i) => (
      <motion.div
        key={i}
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ delay: i * 0.08, type: 'spring', stiffness: 500, damping: 30 }}
        className="group rounded-xl p-4 cursor-default transition-colors"
        style={{
          border: '1px solid var(--border)',
          backgroundColor: 'var(--ui-panel-bg)',
        }}
        whileHover={{
          boxShadow: '0 0 0 1px rgba(var(--common-accent), 0.3), 0 4px 20px rgba(var(--common-accent), 0.1)',
        }}
        transition={{ duration: 0.15 } as any}
      >
        <div className="text-2xl mb-2.5 select-none">{item.emoji}</div>
        <p className="text-[13px] font-semibold text-text leading-snug">{item.title}</p>
        <p className="text-[11px] text-comment mt-1 leading-relaxed">{item.description}</p>
      </motion.div>
    ))}
  </div>
);

// ── Update changelog ──────────────────────────────────────────────────────────

const UpdateChangelog = ({ releases }: { releases: Release[] }) => (
  <div className="space-y-5">
    {releases.map((release, ri) => (
      <div key={release.version} className="space-y-4">
        {releases.length > 1 && ri > 0 && (
          <div className="flex items-center gap-3 pt-1">
            <span
              className="text-[10px] font-mono font-bold px-1.5 py-0.5 rounded"
              style={{
                color: 'rgb(var(--common-accent))',
                background: 'rgba(var(--common-accent), 0.12)',
              }}
            >
              v{release.version}
            </span>
            <div className="h-px flex-1" style={{ background: 'var(--border)' }} />
            <span className="text-[11px] text-comment">{release.date}</span>
          </div>
        )}
        {release.sections.map((section, si) => {
          const accent = getSectionAccent(section.title);
          return (
            <div key={section.title} className="space-y-0.5">
              {/* Section header */}
              <div className="flex items-center gap-2 px-1 mb-2">
                <span
                  className="inline-block w-1.5 h-1.5 rounded-full flex-shrink-0"
                  style={{ backgroundColor: accent.dot }}
                />
                <span
                  className="text-[10px] font-bold uppercase tracking-[0.1em]"
                  style={{ color: accent.text }}
                >
                  {section.title}
                </span>
              </div>
              {/* Items */}
              {section.items.map((item, i) => (
                <motion.div
                  key={i}
                  initial={{ opacity: 0, x: -8 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: (si * 3 + i) * 0.055, type: 'spring', stiffness: 500, damping: 30 }}
                  className="flex gap-3 px-3 py-2.5 rounded-lg cursor-default transition-colors hover:bg-active"
                >
                  <span className="text-[15px] leading-none mt-[1px] flex-shrink-0 select-none">
                    {item.emoji}
                  </span>
                  <div className="min-w-0">
                    <p className="text-[13px] font-semibold text-text leading-snug">{item.title}</p>
                    <p className="text-[11px] text-comment mt-0.5 leading-relaxed">{item.description}</p>
                  </div>
                </motion.div>
              ))}
            </div>
          );
        })}
        {ri < releases.length - 1 && (
          <div className="h-px" style={{ background: 'var(--border)' }} />
        )}
      </div>
    ))}
  </div>
);
