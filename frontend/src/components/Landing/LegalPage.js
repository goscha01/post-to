import React, { useEffect } from 'react';
import { Link } from 'react-router-dom';
import { Sparkles, ArrowLeft } from 'lucide-react';

// Shared shell used by Privacy Policy and Terms of Service pages.
// Keeps typography, nav, and footer consistent with the landing page.
const LegalPage = ({ title, updated, children }) => {
  useEffect(() => {
    window.scrollTo(0, 0);
  }, []);

  return (
    <div className="min-h-screen bg-white text-slate-900 antialiased">
      {/* Top bar */}
      <header className="border-b border-slate-200/70 bg-white/80 backdrop-blur-xl sticky top-0 z-40">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 h-16 flex items-center justify-between">
          <Link to="/" className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center shadow-lg shadow-primary-500/30">
              <Sparkles className="w-4 h-4 text-white" />
            </div>
            <span className="font-bold text-slate-900 tracking-tight">Post-To</span>
          </Link>
          <Link
            to="/"
            className="inline-flex items-center gap-1.5 text-sm font-medium text-slate-600 hover:text-slate-900"
          >
            <ArrowLeft className="w-4 h-4" />
            Back to home
          </Link>
        </div>
      </header>

      {/* Content */}
      <main className="max-w-4xl mx-auto px-6 lg:px-8 py-14 md:py-20">
        <div className="mb-10 pb-8 border-b border-slate-200">
          <div className="text-xs font-semibold text-primary-700 bg-primary-50 rounded-full px-3 py-1 inline-block mb-3">
            Legal
          </div>
          <h1 className="text-4xl md:text-5xl font-bold tracking-tight text-slate-900">
            {title}
          </h1>
          <p className="mt-3 text-sm text-slate-500">Last updated: {updated}</p>
        </div>

        <article className="legal-prose">{children}</article>

        {/* Contact card */}
        <div className="mt-16 rounded-2xl bg-slate-50 ring-1 ring-slate-200 p-6">
          <div className="text-sm font-semibold text-slate-900">Questions?</div>
          <p className="text-sm text-slate-600 mt-1">
            Email us at{' '}
            <a href="mailto:legal@post-to.app" className="text-primary-600 font-medium hover:underline">
              legal@post-to.app
            </a>
            . We reply to every message.
          </p>
        </div>
      </main>

      {/* Minimal footer */}
      <footer className="border-t border-slate-200 py-8">
        <div className="max-w-4xl mx-auto px-6 lg:px-8 flex flex-col md:flex-row items-center justify-between gap-3 text-sm text-slate-500">
          <div>© {new Date().getFullYear()} Post-To. All rights reserved.</div>
          <div className="flex gap-6">
            <Link to="/privacy" className="hover:text-slate-800">Privacy</Link>
            <Link to="/terms" className="hover:text-slate-800">Terms</Link>
            <Link to="/" className="hover:text-slate-800">Home</Link>
          </div>
        </div>
      </footer>
    </div>
  );
};

// Small typographic primitives used inside legal content.
export const H2 = ({ children }) => (
  <h2 className="text-2xl font-bold text-slate-900 mt-12 mb-3 tracking-tight">{children}</h2>
);
export const H3 = ({ children }) => (
  <h3 className="text-lg font-semibold text-slate-900 mt-8 mb-2">{children}</h3>
);
export const P = ({ children }) => (
  <p className="text-[15px] leading-relaxed text-slate-700 mb-4">{children}</p>
);
export const UL = ({ children }) => (
  <ul className="list-disc pl-6 space-y-2 text-[15px] leading-relaxed text-slate-700 mb-4 marker:text-slate-400">
    {children}
  </ul>
);

export default LegalPage;
