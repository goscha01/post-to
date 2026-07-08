import React from 'react';
import { ArrowRight, Sparkles, PlayCircle } from 'lucide-react';
import { DashboardMock } from './mockups';

const Hero = ({ onCtaClick }) => {
  return (
    <section id="top" className="relative pt-32 pb-16 md:pt-40 md:pb-24 overflow-hidden">
      {/* Ambient background */}
      <div className="absolute inset-0 -z-10">
        <div className="absolute top-0 left-1/2 -translate-x-1/2 w-[80rem] h-[40rem] bg-gradient-to-br from-primary-100/60 via-fuchsia-100/40 to-transparent rounded-full blur-3xl" />
        <div className="absolute top-20 -right-20 w-96 h-96 bg-primary-200/30 rounded-full blur-3xl" />
        <div
          className="absolute inset-0 opacity-[0.08]"
          style={{
            backgroundImage:
              'linear-gradient(#0f172a 1px, transparent 1px), linear-gradient(90deg, #0f172a 1px, transparent 1px)',
            backgroundSize: '48px 48px',
            maskImage: 'radial-gradient(ellipse 60% 60% at 50% 30%, #000 40%, transparent 80%)',
            WebkitMaskImage: 'radial-gradient(ellipse 60% 60% at 50% 30%, #000 40%, transparent 80%)'
          }}
        />
      </div>

      <div className="max-w-7xl mx-auto px-6 lg:px-8">
        <div className="max-w-4xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 rounded-full bg-white/80 backdrop-blur ring-1 ring-slate-200 px-3 py-1.5 text-xs font-semibold text-slate-700 shadow-sm">
            <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            AI Marketing Manager for local businesses
          </div>

          <h1 className="mt-6 text-4xl md:text-6xl lg:text-7xl font-bold tracking-tight text-slate-900">
            Connect once.
            <br />
            <span className="bg-gradient-to-r from-primary-600 via-primary-500 to-fuchsia-600 bg-clip-text text-transparent">
              Post-To markets your business forever.
            </span>
          </h1>

          <p className="mt-6 text-lg md:text-xl text-slate-600 leading-relaxed max-w-2xl mx-auto">
            AI learns your business, writes content in your voice, publishes across every channel,
            and tells you what to do next. No prompts. No calendars. Just growth.
          </p>

          <div className="mt-8 flex flex-col sm:flex-row items-center justify-center gap-3">
            <button
              onClick={onCtaClick}
              className="group inline-flex items-center gap-2 rounded-xl bg-slate-900 hover:bg-slate-800 text-white font-semibold px-6 py-3.5 text-sm shadow-lg shadow-slate-900/20 transition"
            >
              Start free — connect your business
              <ArrowRight className="w-4 h-4 group-hover:translate-x-0.5 transition" />
            </button>
            <a
              href="#workflow"
              className="inline-flex items-center gap-2 rounded-xl bg-white/70 backdrop-blur ring-1 ring-slate-200 text-slate-700 font-semibold px-6 py-3.5 text-sm hover:bg-white transition"
            >
              <PlayCircle className="w-4 h-4" />
              See how it works
            </a>
          </div>

          <div className="mt-6 flex flex-wrap items-center justify-center gap-x-6 gap-y-2 text-xs text-slate-500">
            <span className="flex items-center gap-1.5">
              <Sparkles className="w-3.5 h-3.5 text-primary-600" /> Free 14-day trial
            </span>
            <span>·</span>
            <span>No credit card required</span>
            <span>·</span>
            <span>Setup in 2 minutes</span>
          </div>
        </div>

        {/* Dashboard visual */}
        <div className="mt-16 md:mt-20 relative">
          <div className="absolute -inset-x-8 -inset-y-8 bg-gradient-to-br from-primary-100/60 via-fuchsia-100/30 to-transparent blur-3xl -z-10 rounded-[3rem]" />
          <DashboardMock className="mx-auto max-w-6xl transform-gpu" />
        </div>
      </div>
    </section>
  );
};

export default Hero;
