import React from 'react';
import { Clock, CalendarX, MessageSquare, TrendingDown, BarChart2, Compass } from 'lucide-react';

const PAINS = [
  {
    icon: Clock,
    title: 'No time for marketing',
    body: 'You run the business. Writing captions is the last thing on your list.'
  },
  {
    icon: CalendarX,
    title: 'Inconsistent posting',
    body: 'Two posts one week, silent for a month. Google notices. Customers do too.'
  },
  {
    icon: MessageSquare,
    title: 'Reviews sit unanswered',
    body: '5-star reviews are your best marketing asset — and they die in your inbox.'
  },
  {
    icon: TrendingDown,
    title: 'SEO you can’t decode',
    body: 'You know you need blogs, keywords, backlinks. You don’t know where to start.'
  },
  {
    icon: BarChart2,
    title: 'Analytics you can’t read',
    body: 'GA4 has 400 reports. You just want to know: is this working?'
  },
  {
    icon: Compass,
    title: 'No marketing strategy',
    body: 'You’re guessing. Every month feels like starting over.'
  }
];

const Pain = () => (
  <section className="relative py-24 bg-slate-50/50 border-y border-slate-100">
    <div className="max-w-7xl mx-auto px-6 lg:px-8">
      <div className="max-w-3xl">
        <div className="inline-flex items-center gap-2 text-xs font-semibold text-rose-600 bg-rose-50 rounded-full px-3 py-1 mb-4">
          The problem
        </div>
        <h2 className="text-3xl md:text-5xl font-bold tracking-tight text-slate-900">
          You didn’t start your business
          <br />
          to become a marketer.
        </h2>
        <p className="mt-4 text-lg text-slate-600">
          But local marketing is broken for small businesses. Here’s what it usually looks like:
        </p>
      </div>

      <div className="mt-12 grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {PAINS.map(({ icon: Icon, title, body }) => (
          <div
            key={title}
            className="group rounded-2xl bg-white ring-1 ring-slate-200/70 p-6 hover:ring-slate-300 hover:-translate-y-0.5 transition-all"
          >
            <div className="w-10 h-10 rounded-xl bg-rose-50 text-rose-600 flex items-center justify-center mb-4 group-hover:scale-105 transition-transform">
              <Icon className="w-5 h-5" />
            </div>
            <h3 className="text-base font-semibold text-slate-900">{title}</h3>
            <p className="mt-1.5 text-sm text-slate-600 leading-relaxed">{body}</p>
          </div>
        ))}
      </div>
    </div>
  </section>
);

export default Pain;
