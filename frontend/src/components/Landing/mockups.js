import React from 'react';
import {
  Home, Building2, FileText, MessageSquare, BarChart3, LineChart,
  Settings, Link2, Sparkles, Star, Check, TrendingUp, Eye, Phone,
  MapPin, Globe, Facebook, Instagram, Linkedin, Twitter, Wand2,
  Image as ImageIcon, Zap, ChevronRight, CircleDot, Layers, Send,
  BookOpen, Megaphone, Gauge, Search
} from 'lucide-react';
import {
  AreaChart, Area, ResponsiveContainer, BarChart, Bar,
  PieChart, Pie, Cell
} from 'recharts';

// ---------------------------------------------------------------------------
// Shared browser chrome — wraps a mockup in a fake macOS-style window
// ---------------------------------------------------------------------------
export const BrowserFrame = ({ children, className = '', label = 'app.post-to.app' }) => (
  <div className={`relative rounded-2xl bg-white ring-1 ring-slate-200/70 shadow-2xl shadow-slate-900/10 overflow-hidden ${className}`}>
    <div className="flex items-center gap-2 px-4 py-3 border-b border-slate-100 bg-slate-50/70">
      <span className="w-2.5 h-2.5 rounded-full bg-red-400/70" />
      <span className="w-2.5 h-2.5 rounded-full bg-yellow-400/70" />
      <span className="w-2.5 h-2.5 rounded-full bg-green-400/70" />
      <div className="flex-1 flex justify-center">
        <div className="px-3 py-1 rounded-full bg-white text-[11px] text-slate-500 ring-1 ring-slate-200 font-medium">
          {label}
        </div>
      </div>
    </div>
    {children}
  </div>
);

// ---------------------------------------------------------------------------
// Dashboard mockup — hero visual
// ---------------------------------------------------------------------------
const NAV_ITEMS = [
  { icon: Home, label: 'Dashboard', active: true },
  { icon: Link2, label: 'Connections' },
  { icon: Building2, label: 'Business Profiles' },
  { icon: FileText, label: 'Posts' },
  { icon: MessageSquare, label: 'Reviews' },
  { icon: BarChart3, label: 'Insights' },
  { icon: LineChart, label: 'Analytics' },
  { icon: Settings, label: 'Services' }
];

const KPI = [
  { label: 'Search views', value: '48,210', delta: '+18%', color: 'text-emerald-600' },
  { label: 'Calls', value: '312', delta: '+9%', color: 'text-emerald-600' },
  { label: 'Website visits', value: '6,842', delta: '+24%', color: 'text-emerald-600' },
  { label: 'Direction requests', value: '1,204', delta: '+11%', color: 'text-emerald-600' }
];

const SPARK = Array.from({ length: 14 }, (_, i) => ({
  v: 40 + Math.round(Math.sin(i / 1.6) * 18 + i * 3.2 + Math.random() * 5)
}));

export const DashboardMock = ({ className = '' }) => (
  <BrowserFrame className={className}>
    <div className="grid grid-cols-[210px_1fr] min-h-[520px] bg-white">
      {/* Sidebar */}
      <aside className="border-r border-slate-100 bg-slate-50/50 p-4 flex flex-col">
        <div className="flex items-center gap-2 px-2 pb-4 mb-3 border-b border-slate-100">
          <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
            <Sparkles className="w-4 h-4 text-white" />
          </div>
          <span className="font-semibold text-slate-800 text-sm">Post-To</span>
        </div>
        <nav className="space-y-1 text-sm">
          {NAV_ITEMS.map(({ icon: Icon, label, active }) => (
            <div
              key={label}
              className={`flex items-center gap-2.5 px-3 py-2 rounded-lg font-medium ${
                active
                  ? 'bg-primary-600 text-white shadow-sm shadow-primary-500/30'
                  : 'text-slate-600'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
            </div>
          ))}
        </nav>
        <div className="mt-auto pt-4 border-t border-slate-100">
          <div className="flex items-center gap-2 px-2">
            <div className="w-8 h-8 rounded-full bg-gradient-to-br from-amber-400 to-rose-500" />
            <div className="text-xs">
              <div className="font-semibold text-slate-700">Sarah's Cleaning</div>
              <div className="text-slate-400">Owner</div>
            </div>
          </div>
        </div>
      </aside>

      {/* Main */}
      <main className="p-6 space-y-5">
        <div className="flex items-center justify-between">
          <div>
            <h4 className="text-lg font-semibold text-slate-900">Good morning, Sarah</h4>
            <p className="text-xs text-slate-500">Here's how your marketing performed this week</p>
          </div>
          <button className="text-xs font-semibold text-white bg-primary-600 rounded-lg px-3 py-2 flex items-center gap-1.5">
            <Wand2 className="w-3.5 h-3.5" /> New AI post
          </button>
        </div>

        {/* KPIs */}
        <div className="grid grid-cols-4 gap-3">
          {KPI.map((k) => (
            <div key={k.label} className="rounded-xl bg-white ring-1 ring-slate-100 p-3">
              <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{k.label}</div>
              <div className="text-lg font-bold text-slate-900 mt-1">{k.value}</div>
              <div className={`text-[11px] font-semibold mt-0.5 ${k.color}`}>{k.delta} vs last week</div>
            </div>
          ))}
        </div>

        {/* Chart + AI card */}
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2 rounded-xl bg-white ring-1 ring-slate-100 p-4">
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-slate-700">Search views · last 14 days</div>
              <div className="text-[10px] font-semibold text-emerald-600 flex items-center gap-1">
                <TrendingUp className="w-3 h-3" /> Trending up
              </div>
            </div>
            <div className="h-24">
              <ResponsiveContainer>
                <AreaChart data={SPARK}>
                  <defs>
                    <linearGradient id="dashArea" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#3b82f6" stopOpacity={0.35} />
                      <stop offset="100%" stopColor="#3b82f6" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <Area type="monotone" dataKey="v" stroke="#2563eb" strokeWidth={2} fill="url(#dashArea)" />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>
          <div className="rounded-xl p-4 bg-gradient-to-br from-primary-600 to-primary-800 text-white">
            <div className="flex items-center gap-2 mb-2 text-xs font-semibold opacity-90">
              <Sparkles className="w-3.5 h-3.5" /> AI recommendation
            </div>
            <div className="text-[13px] leading-snug font-medium">
              Post a Google update about your recent 5-star review — you're getting 3× more clicks on review-based posts.
            </div>
            <button className="mt-3 w-full text-[11px] font-semibold bg-white/15 hover:bg-white/25 rounded-lg py-1.5">
              Generate now
            </button>
          </div>
        </div>

        {/* Upcoming */}
        <div className="rounded-xl bg-white ring-1 ring-slate-100 p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="text-xs font-semibold text-slate-700">Scheduled this week</div>
            <div className="text-[10px] text-slate-400">Auto-published by AI</div>
          </div>
          <div className="space-y-2">
            {[
              { p: 'Google Business', d: 'Tue · 9:00', t: 'Deep-clean promo — 15% off', tone: 'bg-blue-50 text-blue-700' },
              { p: 'Instagram', d: 'Wed · 12:00', t: 'Before / after: kitchen refresh', tone: 'bg-pink-50 text-pink-700' },
              { p: 'Blog', d: 'Fri · 8:00', t: '10 signs your carpet needs professional care', tone: 'bg-emerald-50 text-emerald-700' }
            ].map((r) => (
              <div key={r.t} className="flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50">
                <div className="flex items-center gap-3">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded ${r.tone}`}>{r.p}</span>
                  <span className="text-xs font-medium text-slate-700">{r.t}</span>
                </div>
                <span className="text-[10px] text-slate-400">{r.d}</span>
              </div>
            ))}
          </div>
        </div>
      </main>
    </div>
  </BrowserFrame>
);

// ---------------------------------------------------------------------------
// Connect Accounts mockup
// ---------------------------------------------------------------------------
const CONN_TILES = [
  { label: 'Google Business', sub: 'Connected', icon: Building2, connected: true, color: 'from-blue-500 to-blue-700' },
  { label: 'Google Analytics', sub: 'Connected', icon: LineChart, connected: true, color: 'from-amber-500 to-orange-600' },
  { label: 'Website', sub: 'sarahscleaning.com', icon: Globe, connected: true, color: 'from-slate-500 to-slate-700' },
  { label: 'Instagram', sub: 'Connect', icon: Instagram, connected: false, color: 'from-fuchsia-500 to-rose-500' },
  { label: 'Facebook', sub: 'Connect', icon: Facebook, connected: false, color: 'from-blue-500 to-indigo-600' },
  { label: 'LinkedIn', sub: 'Connect', icon: Linkedin, connected: false, color: 'from-sky-600 to-sky-800' },
  { label: 'X', sub: 'Connect', icon: Twitter, connected: false, color: 'from-slate-800 to-black' },
  { label: 'WordPress', sub: 'Connect', icon: BookOpen, connected: false, color: 'from-slate-600 to-slate-800' }
];

export const ConnectMock = ({ className = '' }) => (
  <BrowserFrame className={className} label="app.post-to.app / connections">
    <div className="p-6 bg-white">
      <div className="flex items-center justify-between mb-5">
        <div>
          <h4 className="text-base font-semibold text-slate-900">Connect your business</h4>
          <p className="text-xs text-slate-500">One connection powers every channel</p>
        </div>
        <div className="text-[11px] font-semibold text-emerald-700 bg-emerald-50 px-2 py-1 rounded-full">
          3 of 8 connected
        </div>
      </div>
      <div className="grid grid-cols-4 gap-3">
        {CONN_TILES.map(({ label, sub, icon: Icon, connected, color }) => (
          <div
            key={label}
            className={`relative rounded-xl p-4 ring-1 transition ${
              connected
                ? 'ring-emerald-200 bg-emerald-50/40'
                : 'ring-slate-200 bg-white'
            }`}
          >
            <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${color} flex items-center justify-center mb-3`}>
              <Icon className="w-4 h-4 text-white" strokeWidth={2} />
            </div>
            <div className="text-[13px] font-semibold text-slate-800">{label}</div>
            <div className={`text-[11px] mt-0.5 font-medium ${connected ? 'text-emerald-600' : 'text-slate-400'}`}>{sub}</div>
            {connected && (
              <span className="absolute top-3 right-3 w-5 h-5 rounded-full bg-emerald-500 flex items-center justify-center">
                <Check className="w-3 h-3 text-white" strokeWidth={3} />
              </span>
            )}
          </div>
        ))}
      </div>
    </div>
  </BrowserFrame>
);

// ---------------------------------------------------------------------------
// AI Brain mockup — knowledge graph card
// ---------------------------------------------------------------------------
const KNOWLEDGE = [
  { label: 'Business', value: "Sarah's Cleaning Co." },
  { label: 'Services', value: 'Deep clean · Move-in · Recurring · Post-construction' },
  { label: 'Service area', value: 'Tampa, Brandon, St. Petersburg' },
  { label: 'Voice & tone', value: 'Warm · Family-owned · Detail-oriented' },
  { label: 'Top keywords', value: 'eco-friendly · same-day · pet-safe' },
  { label: 'Reviews learned', value: '387 reviews · 4.9 avg' }
];

export const AiBrainMock = ({ className = '' }) => (
  <div className={`relative rounded-2xl p-6 bg-gradient-to-br from-slate-900 via-slate-900 to-primary-950 text-white ring-1 ring-white/10 shadow-2xl overflow-hidden ${className}`}>
    <div className="absolute -top-24 -right-24 w-80 h-80 rounded-full bg-primary-500/20 blur-3xl" />
    <div className="absolute -bottom-32 -left-16 w-72 h-72 rounded-full bg-fuchsia-500/10 blur-3xl" />
    <div className="relative">
      <div className="flex items-center gap-2 mb-1">
        <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-fuchsia-500 to-primary-500 flex items-center justify-center">
          <Sparkles className="w-4 h-4 text-white" />
        </div>
        <span className="text-sm font-semibold">Post-To Knowledge</span>
        <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-500/20 text-emerald-300">
          Learning · live
        </span>
      </div>
      <p className="text-xs text-slate-400 mb-4">
        AI reads your reviews, services, website, and analytics — so you never write a prompt.
      </p>
      <div className="grid grid-cols-2 gap-2">
        {KNOWLEDGE.map((k) => (
          <div key={k.label} className="rounded-lg bg-white/5 ring-1 ring-white/10 p-3">
            <div className="text-[10px] uppercase tracking-wide text-slate-400 font-semibold">{k.label}</div>
            <div className="text-[12px] font-medium mt-0.5 text-white/95 leading-snug">{k.value}</div>
          </div>
        ))}
      </div>
      <div className="mt-4 flex items-center gap-3 text-[11px] text-slate-400">
        <span className="flex items-center gap-1"><CircleDot className="w-3 h-3 text-emerald-400" /> GBP synced</span>
        <span className="flex items-center gap-1"><CircleDot className="w-3 h-3 text-emerald-400" /> GA4 synced</span>
        <span className="flex items-center gap-1"><CircleDot className="w-3 h-3 text-emerald-400" /> Site indexed</span>
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Content Composer mockup
// ---------------------------------------------------------------------------
export const ComposerMock = ({ className = '' }) => (
  <BrowserFrame className={className} label="app.post-to.app / posts / new">
    <div className="grid grid-cols-[1fr_260px] bg-white">
      <div className="p-5 border-r border-slate-100 space-y-4">
        <div className="flex items-center gap-2">
          <Wand2 className="w-4 h-4 text-primary-600" />
          <div className="text-sm font-semibold text-slate-800">AI draft — Google Business Post</div>
          <span className="ml-auto text-[10px] font-semibold px-2 py-0.5 rounded-full bg-primary-50 text-primary-700">
            Generated in 2.4s
          </span>
        </div>
        <div className="rounded-xl bg-slate-50 p-4 space-y-2 ring-1 ring-slate-100">
          <div className="text-sm font-semibold text-slate-900">Spring deep clean — book by Friday</div>
          <p className="text-xs text-slate-600 leading-relaxed">
            Kick off spring with a top-to-bottom deep clean from Sarah's Cleaning Co. Our eco-friendly,
            pet-safe crew handles kitchens, baths, baseboards, and inside cabinets. Same-day availability
            in Tampa &amp; Brandon this week — 15% off through Friday.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white ring-1 ring-slate-200 text-slate-600">#springclean</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white ring-1 ring-slate-200 text-slate-600">#tampa</span>
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded bg-white ring-1 ring-slate-200 text-slate-600">#ecofriendly</span>
          </div>
        </div>
        <div className="grid grid-cols-3 gap-2">
          {['Deep clean', 'Team on site', 'Before/after'].map((t, i) => (
            <div key={t} className={`aspect-video rounded-lg ring-1 ring-slate-200 flex items-center justify-center text-[10px] font-semibold text-slate-500 ${
              i === 0 ? 'bg-gradient-to-br from-emerald-100 to-emerald-50'
              : i === 1 ? 'bg-gradient-to-br from-amber-100 to-amber-50'
              : 'bg-gradient-to-br from-sky-100 to-sky-50'
            }`}>
              <ImageIcon className="w-3 h-3 mr-1" /> {t}
            </div>
          ))}
        </div>
      </div>
      <aside className="p-4 space-y-3 bg-slate-50/50">
        <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Also generate</div>
        {[
          { icon: BookOpen, label: 'SEO blog article', tone: 'from-emerald-500 to-emerald-700' },
          { icon: Instagram, label: 'Instagram caption', tone: 'from-pink-500 to-rose-500' },
          { icon: MessageSquare, label: 'Review reply', tone: 'from-blue-500 to-blue-700' },
          { icon: Megaphone, label: 'Promo campaign', tone: 'from-amber-500 to-orange-600' },
          { icon: Layers, label: 'Landing page', tone: 'from-fuchsia-500 to-purple-600' }
        ].map(({ icon: Icon, label, tone }) => (
          <div key={label} className="flex items-center gap-2 p-2 rounded-lg bg-white ring-1 ring-slate-100">
            <div className={`w-7 h-7 rounded-lg bg-gradient-to-br ${tone} flex items-center justify-center`}>
              <Icon className="w-3.5 h-3.5 text-white" />
            </div>
            <span className="text-xs font-medium text-slate-700 flex-1">{label}</span>
            <ChevronRight className="w-3.5 h-3.5 text-slate-400" />
          </div>
        ))}
      </aside>
    </div>
  </BrowserFrame>
);

// ---------------------------------------------------------------------------
// Review-to-Marketing mockup — signature capability
// ---------------------------------------------------------------------------
const REVIEW_OUTPUTS = [
  { icon: Building2, label: 'Google Business post', tone: 'from-blue-500 to-blue-700' },
  { icon: BookOpen, label: 'SEO blog article', tone: 'from-emerald-500 to-emerald-700' },
  { icon: Instagram, label: 'Social post', tone: 'from-fuchsia-500 to-rose-500' },
  { icon: Star, label: 'Website testimonial', tone: 'from-amber-500 to-orange-600' },
  { icon: Layers, label: 'Landing page block', tone: 'from-purple-500 to-fuchsia-600' }
];

export const ReviewFanMock = ({ className = '' }) => (
  <div className={`relative rounded-2xl bg-white ring-1 ring-slate-200 shadow-2xl shadow-slate-900/10 p-6 overflow-hidden ${className}`}>
    <div className="grid md:grid-cols-[minmax(0,1fr)_minmax(0,1.1fr)] gap-6 items-center">
      {/* Review card */}
      <div className="rounded-xl p-5 bg-gradient-to-br from-slate-50 to-white ring-1 ring-slate-100">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-9 h-9 rounded-full bg-gradient-to-br from-amber-400 to-rose-500" />
          <div>
            <div className="text-sm font-semibold text-slate-800">Melissa R.</div>
            <div className="flex text-amber-500 text-xs">{'★★★★★'}</div>
          </div>
          <span className="ml-auto text-[10px] text-slate-400 font-medium">Google · 2d ago</span>
        </div>
        <p className="text-[13px] text-slate-700 leading-relaxed">
          "Sarah's team is unbelievable. They deep-cleaned our kitchen and baths before we listed the
          house — spotless and pet-safe. Booked in 10 minutes, showed up same day."
        </p>
        <div className="mt-4 inline-flex items-center gap-1.5 text-[11px] font-semibold text-primary-700 bg-primary-50 rounded-full px-2 py-1">
          <Sparkles className="w-3 h-3" /> Turn into marketing
        </div>
      </div>

      {/* Outputs */}
      <div className="space-y-2">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-400 mb-1">One review → 5 assets</div>
        {REVIEW_OUTPUTS.map(({ icon: Icon, label, tone }) => (
          <div key={label} className="flex items-center gap-3 p-3 rounded-xl bg-white ring-1 ring-slate-100 hover:ring-primary-200 transition">
            <div className={`w-9 h-9 rounded-lg bg-gradient-to-br ${tone} flex items-center justify-center`}>
              <Icon className="w-4 h-4 text-white" />
            </div>
            <div className="flex-1">
              <div className="text-[13px] font-semibold text-slate-800">{label}</div>
              <div className="text-[11px] text-slate-500">Drafted from Melissa's review</div>
            </div>
            <Check className="w-4 h-4 text-emerald-500" strokeWidth={3} />
          </div>
        ))}
      </div>
    </div>
  </div>
);

// ---------------------------------------------------------------------------
// Publish everywhere mockup
// ---------------------------------------------------------------------------
const CHANNELS = [
  { icon: Building2, label: 'Google Business', tone: 'bg-blue-50 text-blue-700 ring-blue-200' },
  { icon: Instagram, label: 'Instagram', tone: 'bg-pink-50 text-pink-700 ring-pink-200' },
  { icon: Facebook, label: 'Facebook', tone: 'bg-blue-50 text-blue-700 ring-blue-200' },
  { icon: Linkedin, label: 'LinkedIn', tone: 'bg-sky-50 text-sky-700 ring-sky-200' },
  { icon: Twitter, label: 'X', tone: 'bg-slate-100 text-slate-800 ring-slate-300' },
  { icon: Globe, label: 'Website', tone: 'bg-emerald-50 text-emerald-700 ring-emerald-200' },
  { icon: BookOpen, label: 'WordPress', tone: 'bg-slate-100 text-slate-700 ring-slate-300' }
];

export const PublishMock = ({ className = '' }) => (
  <BrowserFrame className={className} label="app.post-to.app / publish">
    <div className="p-6 bg-white">
      <div className="flex items-center gap-3 mb-5">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center">
          <Send className="w-5 h-5 text-white" />
        </div>
        <div>
          <div className="text-sm font-semibold text-slate-900">Publish "Spring deep clean" everywhere</div>
          <div className="text-xs text-slate-500">AI adapts tone &amp; length per channel</div>
        </div>
        <button className="ml-auto text-xs font-semibold text-white bg-primary-600 rounded-lg px-3 py-2 flex items-center gap-1.5">
          <Zap className="w-3.5 h-3.5" /> Publish now
        </button>
      </div>
      <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
        {CHANNELS.map(({ icon: Icon, label, tone }) => (
          <div key={label} className={`flex items-center gap-2 p-3 rounded-xl ring-1 ${tone}`}>
            <Icon className="w-4 h-4" />
            <span className="text-xs font-semibold flex-1">{label}</span>
            <span className="w-4 h-4 rounded-md bg-white/70 ring-1 ring-inset ring-current/30 flex items-center justify-center">
              <Check className="w-3 h-3" strokeWidth={3} />
            </span>
          </div>
        ))}
      </div>
      <div className="mt-5 rounded-xl bg-slate-50 p-4 flex items-center gap-3">
        <Gauge className="w-4 h-4 text-slate-500" />
        <span className="text-xs text-slate-600">
          Scheduled for peak audience: <span className="font-semibold text-slate-900">Tue 9:00 AM</span> · reaches est. <span className="font-semibold text-slate-900">12,400 people</span>
        </span>
      </div>
    </div>
  </BrowserFrame>
);

// ---------------------------------------------------------------------------
// Analytics mockup
// ---------------------------------------------------------------------------
const SESSIONS = Array.from({ length: 12 }, (_, i) => ({
  x: i,
  v: 200 + Math.round(Math.sin(i / 1.4) * 60 + i * 24 + Math.random() * 20)
}));
const SOURCE_DATA = [
  { name: 'Organic search', v: 42, color: '#2563eb' },
  { name: 'Google Business', v: 28, color: '#10b981' },
  { name: 'Social', v: 18, color: '#ec4899' },
  { name: 'Direct', v: 12, color: '#f59e0b' }
];
const DEVICES = [
  { name: 'Mobile', v: 68 },
  { name: 'Desktop', v: 24 },
  { name: 'Tablet', v: 8 }
];

export const AnalyticsMock = ({ className = '' }) => (
  <BrowserFrame className={className} label="app.post-to.app / analytics">
    <div className="p-6 bg-white space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <div className="text-sm font-semibold text-slate-900">Performance · last 30 days</div>
          <div className="text-xs text-slate-500">All channels · all campaigns</div>
        </div>
        <div className="flex gap-1">
          {['7d', '30d', '90d'].map((r) => (
            <span key={r} className={`text-[11px] font-semibold px-2 py-1 rounded-lg ${
              r === '30d' ? 'bg-primary-600 text-white' : 'bg-slate-100 text-slate-600'
            }`}>{r}</span>
          ))}
        </div>
      </div>

      {/* Big chart */}
      <div className="rounded-xl bg-gradient-to-br from-primary-50 to-white ring-1 ring-primary-100 p-4">
        <div className="flex items-center justify-between mb-1">
          <div>
            <div className="text-[11px] font-semibold text-slate-500 uppercase tracking-wide">Sessions</div>
            <div className="text-2xl font-bold text-slate-900">14,208 <span className="text-xs font-semibold text-emerald-600 ml-1">+31%</span></div>
          </div>
          <div className="grid grid-cols-3 gap-4 text-right">
            {[
              { l: 'Calls', v: '312' },
              { l: 'Directions', v: '1,204' },
              { l: 'Conversions', v: '89' }
            ].map((m) => (
              <div key={m.l}>
                <div className="text-[10px] text-slate-500 font-medium">{m.l}</div>
                <div className="text-sm font-bold text-slate-800">{m.v}</div>
              </div>
            ))}
          </div>
        </div>
        <div className="h-28">
          <ResponsiveContainer>
            <AreaChart data={SESSIONS}>
              <defs>
                <linearGradient id="anArea" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#2563eb" stopOpacity={0.4} />
                  <stop offset="100%" stopColor="#2563eb" stopOpacity={0} />
                </linearGradient>
              </defs>
              <Area type="monotone" dataKey="v" stroke="#2563eb" strokeWidth={2.5} fill="url(#anArea)" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      {/* Bottom row: sources + devices */}
      <div className="grid grid-cols-2 gap-3">
        <div className="rounded-xl bg-white ring-1 ring-slate-100 p-4">
          <div className="text-xs font-semibold text-slate-700 mb-2">Traffic sources</div>
          <div className="space-y-2">
            {SOURCE_DATA.map((s) => (
              <div key={s.name}>
                <div className="flex justify-between text-[11px] font-medium mb-1">
                  <span className="text-slate-600">{s.name}</span>
                  <span className="text-slate-900 font-semibold">{s.v}%</span>
                </div>
                <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                  <div className="h-full rounded-full" style={{ width: `${s.v}%`, background: s.color }} />
                </div>
              </div>
            ))}
          </div>
        </div>
        <div className="rounded-xl bg-white ring-1 ring-slate-100 p-4">
          <div className="text-xs font-semibold text-slate-700 mb-2">Devices</div>
          <div className="h-24 flex items-center justify-center">
            <ResponsiveContainer>
              <PieChart>
                <Pie data={DEVICES} dataKey="v" innerRadius={22} outerRadius={40} paddingAngle={3}>
                  {['#2563eb', '#10b981', '#f59e0b'].map((c, i) => (
                    <Cell key={i} fill={c} />
                  ))}
                </Pie>
              </PieChart>
            </ResponsiveContainer>
          </div>
          <div className="flex justify-center gap-3 text-[10px] font-medium text-slate-500">
            {DEVICES.map((d, i) => (
              <span key={d.name} className="flex items-center gap-1">
                <span className="w-2 h-2 rounded-full" style={{ background: ['#2563eb', '#10b981', '#f59e0b'][i] }} />
                {d.name} {d.v}%
              </span>
            ))}
          </div>
        </div>
      </div>
    </div>
  </BrowserFrame>
);

// ---------------------------------------------------------------------------
// AI Recommendations mockup
// ---------------------------------------------------------------------------
const RECS = [
  {
    tag: 'Opportunity',
    tagTone: 'bg-emerald-50 text-emerald-700',
    icon: TrendingUp,
    title: '"Move-in cleaning" searches up 62% in Tampa',
    body: 'You rank #7. A blog article + Google post could push you into the top 3.',
    action: 'Generate content'
  },
  {
    tag: 'Attention',
    tagTone: 'bg-amber-50 text-amber-700',
    icon: MessageSquare,
    title: '3 new reviews waiting for a reply',
    body: 'Replying within 24h lifts your GBP ranking. AI can draft replies now.',
    action: 'Draft replies'
  },
  {
    tag: 'Insight',
    tagTone: 'bg-primary-50 text-primary-700',
    icon: Search,
    title: 'Instagram Reels drove 34% of new site visits last week',
    body: 'Double posting frequency on Instagram to compound the trend.',
    action: 'Schedule campaign'
  }
];

export const RecommendationsMock = ({ className = '' }) => (
  <div className={`space-y-3 ${className}`}>
    {RECS.map((r, i) => (
      <div key={i} className="rounded-2xl bg-white ring-1 ring-slate-200 shadow-lg shadow-slate-900/5 p-5 flex gap-4">
        <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-primary-500 to-primary-700 flex items-center justify-center flex-shrink-0">
          <r.icon className="w-5 h-5 text-white" />
        </div>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-1">
            <span className={`text-[10px] font-semibold uppercase tracking-wide px-2 py-0.5 rounded ${r.tagTone}`}>{r.tag}</span>
            <span className="text-[10px] text-slate-400 font-medium">Post-To AI · just now</span>
          </div>
          <div className="text-sm font-semibold text-slate-900">{r.title}</div>
          <div className="text-xs text-slate-500 mt-0.5 leading-relaxed">{r.body}</div>
        </div>
        <button className="self-center text-[11px] font-semibold text-white bg-primary-600 rounded-lg px-3 py-2 whitespace-nowrap">
          {r.action}
        </button>
      </div>
    ))}
  </div>
);

// ---------------------------------------------------------------------------
// Growth mockup — outcome
// ---------------------------------------------------------------------------
const GROWTH_DATA = Array.from({ length: 8 }, (_, i) => ({
  x: i,
  before: 20 + i * 3,
  after: 22 + i * 12 + Math.round(Math.random() * 6)
}));

export const GrowthMock = ({ className = '' }) => (
  <div className={`rounded-2xl bg-gradient-to-br from-primary-600 to-primary-800 text-white p-6 shadow-2xl ${className}`}>
    <div className="flex items-center justify-between mb-4">
      <div>
        <div className="text-xs font-semibold opacity-80 uppercase tracking-wide">Since connecting Post-To</div>
        <div className="text-3xl font-bold mt-1">+184% new customers</div>
      </div>
      <div className="text-right text-xs opacity-80">
        <div>Sarah's Cleaning Co.</div>
        <div className="font-semibold">Tampa · 6 months</div>
      </div>
    </div>
    <div className="h-36">
      <ResponsiveContainer>
        <BarChart data={GROWTH_DATA}>
          <Bar dataKey="before" fill="rgba(255,255,255,0.25)" radius={[4, 4, 0, 0]} />
          <Bar dataKey="after" fill="#ffffff" radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
    <div className="grid grid-cols-3 gap-3 mt-4">
      {[
        { l: 'Posts published', v: '312' },
        { l: 'Reviews replied', v: '100%' },
        { l: 'Time saved / week', v: '11 hrs' }
      ].map((s) => (
        <div key={s.l} className="rounded-lg bg-white/10 ring-1 ring-white/10 p-3">
          <div className="text-[10px] uppercase tracking-wide opacity-80 font-semibold">{s.l}</div>
          <div className="text-lg font-bold mt-0.5">{s.v}</div>
        </div>
      ))}
    </div>
  </div>
);
