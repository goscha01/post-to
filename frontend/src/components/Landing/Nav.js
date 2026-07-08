import React, { useEffect, useState } from 'react';
import { Sparkles, Menu, X } from 'lucide-react';

const LINKS = [
  { href: '#workflow', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#pricing', label: 'Pricing' },
  { href: '#faq', label: 'FAQ' }
];

const Nav = ({ onCtaClick }) => {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 8);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <header
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'bg-white/80 backdrop-blur-xl border-b border-slate-200/60'
          : 'bg-transparent'
      }`}
    >
      <div className="max-w-7xl mx-auto px-6 lg:px-8 h-16 flex items-center justify-between">
        <a href="#top" className="flex items-center gap-2">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg shadow-primary-500/30">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-bold text-slate-900 tracking-tight">Post-To</span>
        </a>

        <nav className="hidden md:flex items-center gap-8">
          {LINKS.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm font-medium text-slate-600 hover:text-slate-900 transition"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden md:flex items-center gap-3">
          <a
            href="/login"
            className="text-sm font-medium text-slate-600 hover:text-slate-900 transition"
          >
            Sign in
          </a>
          <button
            onClick={onCtaClick}
            className="text-sm font-semibold text-white bg-slate-900 hover:bg-slate-800 rounded-lg px-4 py-2 transition shadow-sm"
          >
            Start free
          </button>
        </div>

        <button
          onClick={() => setOpen((v) => !v)}
          className="md:hidden p-2 -mr-2 text-slate-700"
          aria-label="Menu"
        >
          {open ? <X className="w-5 h-5" /> : <Menu className="w-5 h-5" />}
        </button>
      </div>

      {open && (
        <div className="md:hidden border-t border-slate-200 bg-white/95 backdrop-blur-xl">
          <div className="px-6 py-4 space-y-3">
            {LINKS.map((l) => (
              <a
                key={l.href}
                href={l.href}
                onClick={() => setOpen(false)}
                className="block text-sm font-medium text-slate-700"
              >
                {l.label}
              </a>
            ))}
            <div className="pt-3 border-t border-slate-100 flex gap-3">
              <a href="/login" className="flex-1 text-center text-sm font-semibold text-slate-700 border border-slate-200 rounded-lg py-2">
                Sign in
              </a>
              <button
                onClick={() => { setOpen(false); onCtaClick && onCtaClick(); }}
                className="flex-1 text-sm font-semibold text-white bg-slate-900 rounded-lg py-2"
              >
                Start free
              </button>
            </div>
          </div>
        </div>
      )}
    </header>
  );
};

export default Nav;
