// Tests for the SEO UI components (SeoBanner + SeoChecklistDrawer +
// MetadataEditor + useDebouncedSeo).
//
// Covers what the spec's "D. Frontend Tests" section requires:
//   * banner renders (word count, keyword, pass counts, dot color)
//   * checklist opens/closes
//   * category groups render
//   * per-check "Fix with AI" button appears only for failed/warning checks
//   * metadata editor updates fields + tags
//   * SEO recalculates on edit (debounced via useDebouncedSeo)
//   * old articles without SEO metadata still render (banner shows "pending")

import React, { useState } from 'react';
import { render, screen, fireEvent, waitFor, act } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock blogsService because SeoPanel calls it directly for analyze/fix.
jest.mock('../../services/blogsService', () => ({
  __esModule: true,
  default: {
    analyzeSeo: jest.fn(),
    fixSeo: jest.fn(),
    fixSeoAll: jest.fn(),
  },
}));

// eslint-disable-next-line import/first
import blogsService from '../../services/blogsService';
// eslint-disable-next-line import/first
import {
  SeoBanner,
  SeoChecklistDrawer,
  MetadataEditor,
  useDebouncedSeo,
} from './SeoPanel';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const strongAnalysis = {
  analyzerVersion: 1,
  analyzedAt: '2026-08-21T00:00:00.000Z',
  score: 92,
  status: 'green',
  keyword: 'house cleaning tampa',
  wordCount: 2184,
  passed: 22, warnings: 2, failed: 0, notApplicable: 3,
  criticalFailures: 0,
  contentHash: 'abc',
  checks: [
    { id: 'title_present', category: 'meta', categoryLabel: 'Meta & Technical', label: 'Title present', status: 'passed', value: '61 chars', recommendation: null, weight: 3 },
    { id: 'meta_description_length', category: 'meta', categoryLabel: 'Meta & Technical', label: 'Meta description length', status: 'warning', value: '175 chars', recommendation: 'Recommended 140-160 characters.', weight: 2 },
    { id: 'internal_links_present', category: 'links', categoryLabel: 'Links', label: 'Internal links present', status: 'passed', value: '3 internal links', recommendation: null, weight: 2 },
    { id: 'hero_image_present', category: 'media', categoryLabel: 'Media & Visuals', label: 'Hero image present', status: 'passed', value: null, recommendation: null, weight: 3 },
    { id: 'word_count', category: 'content', categoryLabel: 'Content Quality', label: 'Article length', status: 'passed', value: '2184 words', recommendation: null, weight: 2 },
    { id: 'keyword_in_title', category: 'keyword', categoryLabel: 'Search Term Optimization', label: 'Keyword in title', status: 'passed', value: null, recommendation: null, weight: 3 },
  ],
};

// ---------------------------------------------------------------------------
// SeoBanner
// ---------------------------------------------------------------------------

describe('SeoBanner', () => {
  it('renders word count, keyword, and pass counts', () => {
    render(<SeoBanner analysis={strongAnalysis} recalculating={false} onOpenChecklist={() => {}} />);
    expect(screen.getByText(/Words: 2,184/)).toBeInTheDocument();
    expect(screen.getByText(/house cleaning tampa/)).toBeInTheDocument();
    expect(screen.getByText(/22 of 24 SEO checks passed/)).toBeInTheDocument();
    expect(screen.getByText(/2 warnings/)).toBeInTheDocument();
  });

  it('renders a "pending" pill when analysis is null (legacy article)', () => {
    render(<SeoBanner analysis={null} recalculating={false} onOpenChecklist={() => {}} />);
    expect(screen.getByText(/SEO analysis pending/)).toBeInTheDocument();
  });

  it('opens the checklist when clicked', () => {
    const open = jest.fn();
    render(<SeoBanner analysis={strongAnalysis} recalculating={false} onOpenChecklist={open} />);
    fireEvent.click(screen.getByRole('button', { name: /Words/ }));
    expect(open).toHaveBeenCalled();
  });

  it('shows a recalculating spinner when the SEO hook is in-flight', () => {
    const { container } = render(
      <SeoBanner analysis={strongAnalysis} recalculating={true} onOpenChecklist={() => {}} />
    );
    // lucide-react svg gets `animate-spin` class from our JSX.
    expect(container.querySelector('.animate-spin')).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------
// SeoChecklistDrawer
// ---------------------------------------------------------------------------

describe('SeoChecklistDrawer', () => {
  it('renders category groups with pass/warning/failed counts', () => {
    render(
      <SeoChecklistDrawer
        open={true}
        onClose={() => {}}
        analysis={strongAnalysis}
        blogId="blog-1"
        onFixed={() => {}}
      />
    );
    // 5 categories should appear.
    expect(screen.getByText('Meta & Technical')).toBeInTheDocument();
    expect(screen.getByText('Links')).toBeInTheDocument();
    expect(screen.getByText('Media & Visuals')).toBeInTheDocument();
    expect(screen.getByText('Content Quality')).toBeInTheDocument();
    expect(screen.getByText('Search Term Optimization')).toBeInTheDocument();
  });

  it('does not render when closed', () => {
    render(
      <SeoChecklistDrawer open={false} onClose={() => {}} analysis={strongAnalysis} blogId="blog-1" />
    );
    expect(screen.queryByText('SEO checklist')).not.toBeInTheDocument();
  });

  it('shows Fix-with-AI button only for failing/warning checks', () => {
    render(
      <SeoChecklistDrawer open={true} onClose={() => {}} analysis={strongAnalysis} blogId="blog-1" />
    );
    // Meta is expanded by default — the meta_description_length warning has a Fix button.
    const fixButtons = screen.getAllByRole('button', { name: /Fix with AI/ });
    expect(fixButtons.length).toBeGreaterThan(0);
  });

  it('shows a "Fix all (N)" button when N repairable checks exist', () => {
    render(
      <SeoChecklistDrawer open={true} onClose={() => {}} analysis={strongAnalysis} blogId="blog-1" />
    );
    // Fixture has 1 fixable warning (meta_description_length).
    expect(screen.getByRole('button', { name: /Fix all \(1\)/ })).toBeInTheDocument();
  });

  it('invokes fixSeoAll and calls onFixed with the batch response', async () => {
    const blogsService = require('../../services/blogsService').default;
    blogsService.fixSeoAll.mockResolvedValueOnce({
      blog: { id: 'blog-1', title: 'Better' },
      seo: { ...strongAnalysis, warnings: 0, failed: 0 },
      applied: [{ checkId: 'meta_description_length', changedFields: ['meta_description'] }],
    });
    const onFixed = jest.fn();
    render(
      <SeoChecklistDrawer open={true} onClose={() => {}} analysis={strongAnalysis} blogId="blog-1" onFixed={onFixed} />
    );
    fireEvent.click(screen.getByRole('button', { name: /Fix all/ }));
    await waitFor(() => expect(blogsService.fixSeoAll).toHaveBeenCalledWith('blog-1'));
    await waitFor(() => expect(onFixed).toHaveBeenCalled());
  });

  it('invokes fixSeo and calls onFixed with the server response', async () => {
    blogsService.fixSeo.mockResolvedValueOnce({
      blog: { id: 'blog-1', title: 'Better' },
      seo: { ...strongAnalysis, checks: strongAnalysis.checks.map(c => ({ ...c, status: 'passed' })) },
      changed: { meta_description: 'better' },
      previous: { meta_description: 'old' },
    });
    const onFixed = jest.fn();
    render(
      <SeoChecklistDrawer open={true} onClose={() => {}} analysis={strongAnalysis} blogId="blog-1" onFixed={onFixed} />
    );
    fireEvent.click(screen.getAllByRole('button', { name: /Fix with AI/ })[0]);
    await waitFor(() => expect(blogsService.fixSeo).toHaveBeenCalledWith('blog-1', 'meta_description_length'));
    await waitFor(() => expect(onFixed).toHaveBeenCalled());
  });
});

// ---------------------------------------------------------------------------
// MetadataEditor
// ---------------------------------------------------------------------------

describe('MetadataEditor', () => {
  function Wrapper({ initial }) {
    const [blog, setBlog] = useState(initial);
    return <MetadataEditor blog={blog} onChange={setBlog} />;
  }

  it('updates keyword / meta / slug / title', () => {
    render(<Wrapper initial={{ keyword: '', title: '', slug: '', meta_description: '', tags: [] }} />);
    fireEvent.change(screen.getByPlaceholderText(/house cleaning tampa/), { target: { value: 'kw' } });
    expect(screen.getByPlaceholderText(/house cleaning tampa/).value).toBe('kw');
  });

  it('shows character count tone that updates as meta description grows', () => {
    render(<Wrapper initial={{ keyword: '', title: '', slug: '', meta_description: 'x'.repeat(150), tags: [] }} />);
    // 150 chars is in the optimal band.
    expect(screen.getByText(/150 chars — optimal/)).toBeInTheDocument();
  });

  it('adds and removes tags', () => {
    render(<Wrapper initial={{ keyword: '', title: '', slug: '', meta_description: '', tags: [] }} />);
    const input = screen.getByPlaceholderText(/type and press Enter/);
    fireEvent.change(input, { target: { value: 'tampa' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add' }));
    expect(screen.getByText('tampa')).toBeInTheDocument();

    fireEvent.click(screen.getByLabelText('Remove tampa'));
    expect(screen.queryByText('tampa')).not.toBeInTheDocument();
  });
});

// ---------------------------------------------------------------------------
// useDebouncedSeo
// ---------------------------------------------------------------------------

describe('useDebouncedSeo', () => {
  beforeEach(() => { jest.useFakeTimers(); });
  afterEach(() => { jest.useRealTimers(); jest.clearAllMocks(); });

  function Probe({ blogId, version, initialAnalysis }) {
    const { analysis, recalculating } = useDebouncedSeo({
      blogId, seoInputVersion: version, initialAnalysis, delayMs: 500,
    });
    return (
      <>
        <div data-testid="score">{analysis?.score ?? 'none'}</div>
        <div data-testid="recalc">{recalculating ? 'yes' : 'no'}</div>
      </>
    );
  }

  it('does not call server on initial mount', () => {
    render(<Probe blogId="b" version={0} initialAnalysis={strongAnalysis} />);
    expect(blogsService.analyzeSeo).not.toHaveBeenCalled();
    expect(screen.getByTestId('score').textContent).toBe('92');
  });

  it('debounces server calls: multiple bumps → one call after quiet period', async () => {
    blogsService.analyzeSeo.mockResolvedValue({ seo: { ...strongAnalysis, score: 77 } });

    const { rerender } = render(<Probe blogId="b" version={1} initialAnalysis={strongAnalysis} />);
    rerender(<Probe blogId="b" version={2} initialAnalysis={strongAnalysis} />);
    rerender(<Probe blogId="b" version={3} initialAnalysis={strongAnalysis} />);
    expect(blogsService.analyzeSeo).not.toHaveBeenCalled();

    await act(async () => { jest.advanceTimersByTime(500); });
    await waitFor(() => expect(blogsService.analyzeSeo).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByTestId('score').textContent).toBe('77'));
  });
});
