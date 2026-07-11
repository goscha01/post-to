import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Sparkles, Trash2, Edit3, Globe, Search, X, AlertCircle, Check, FileText, RefreshCw } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import blogsService from '../services/blogsService';
import connectionsService from '../services/connectionsService';
import gscService from '../services/gscService';

const STATUS_STYLES = {
  draft: 'bg-gray-100 text-gray-700',
  published: 'bg-green-100 text-green-800',
  failed: 'bg-red-100 text-red-800',
};

const Blogs = () => {
  const [searchParams] = useSearchParams();
  const initialConnectionId = searchParams.get('connectionId') || '';
  const initialGenerate = searchParams.get('generate') === '1';

  const [blogs, setBlogs] = useState([]);
  const [connections, setConnections] = useState([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [connectionFilter, setConnectionFilter] = useState(initialConnectionId);
  const [editingId, setEditingId] = useState(null);
  const [generatorOpen, setGeneratorOpen] = useState(initialGenerate);
  const [presetKeyword, setPresetKeyword] = useState('');

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const [rows, conns] = await Promise.all([
        blogsService.list(connectionFilter ? { connectionId: connectionFilter } : {}),
        connectionsService.list(),
      ]);
      setBlogs(rows);
      setConnections(conns);
    } catch (e) {
      setError(e.response?.data?.error || e.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  }, [connectionFilter]);

  useEffect(() => {
    load();
  }, [load]);

  const connectionsById = useMemo(() => {
    const map = {};
    connections.forEach(c => { map[c.id] = c; });
    return map;
  }, [connections]);

  const websiteConnections = useMemo(
    () => connections.filter(c => c.provider === 'website'),
    [connections]
  );

  const gscConnections = useMemo(
    () => connections.filter(c => c.provider === 'google_search_console'),
    [connections]
  );

  const openGeneratorWithKeyword = (keyword) => {
    setPresetKeyword(keyword);
    setGeneratorOpen(true);
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Delete this blog draft?')) return;
    try {
      await blogsService.remove(id);
      setBlogs(prev => prev.filter(b => b.id !== id));
    } catch (e) {
      setError(e.response?.data?.error || 'Failed to delete');
    }
  };

  const handleGenerated = (row) => {
    setGeneratorOpen(false);
    setBlogs(prev => [{
      id: row.id,
      title: row.title,
      slug: row.slug,
      meta_description: row.metaDescription,
      markdown: row.markdown,
      suggested_excerpt: row.suggestedExcerpt,
      suggested_social_post: row.suggestedSocialPost,
      status: row.status || 'draft',
      created_at: new Date().toISOString(),
      connection_id: row.connectionId || null,
    }, ...prev]);
    setEditingId(row.id);
  };

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-6">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900">Blogs</h1>
          <p className="text-sm text-gray-500 mt-1">
            Generate SEO blog drafts from a connected site, then edit them before publishing.
          </p>
        </div>
        <button
          onClick={() => setGeneratorOpen(true)}
          className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
        >
          <Sparkles className="h-4 w-4" />
          Generate blog
        </button>
      </div>

      {connections.length > 0 && (
        <div className="mb-4 flex items-center gap-2 text-sm">
          <label className="text-gray-600">Connection:</label>
          <select
            value={connectionFilter}
            onChange={e => setConnectionFilter(e.target.value)}
            className="px-3 py-1.5 border border-gray-300 rounded-md text-sm"
          >
            <option value="">All</option>
            {connections.map(c => (
              <option key={c.id} value={c.id}>{c.display_name || c.provider}</option>
            ))}
          </select>
        </div>
      )}

      {error && (
        <div className="mb-4 flex items-start gap-2 p-3 bg-red-50 border border-red-200 rounded-md text-sm text-red-800">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{error}</span>
        </div>
      )}

      <GscKeywordsPanel
        gscConnections={gscConnections}
        onGenerate={openGeneratorWithKeyword}
        onSiteConnected={(row) => setConnections(prev => [row, ...prev.filter(c => c.id !== row.id)])}
      />

      {loading ? (
        <div className="text-sm text-gray-500">Loading…</div>
      ) : blogs.length === 0 ? (
        <BlogsEmptyState hasWebsiteConnection={websiteConnections.length > 0} onGenerate={() => setGeneratorOpen(true)} />
      ) : (
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <table className="min-w-full text-sm">
            <thead className="bg-gray-50 text-left">
              <tr>
                <th className="px-4 py-2 font-medium text-gray-600">Title</th>
                <th className="px-4 py-2 font-medium text-gray-600">Connection</th>
                <th className="px-4 py-2 font-medium text-gray-600">Keyword</th>
                <th className="px-4 py-2 font-medium text-gray-600">Status</th>
                <th className="px-4 py-2 font-medium text-gray-600">Created</th>
                <th className="px-4 py-2"></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-gray-100">
              {blogs.map(blog => {
                const conn = blog.connection_id ? connectionsById[blog.connection_id] : null;
                return (
                  <tr key={blog.id} className="hover:bg-gray-50">
                    <td className="px-4 py-3">
                      <button
                        onClick={() => setEditingId(blog.id)}
                        className="text-left text-gray-900 font-medium hover:text-primary-600"
                      >
                        {blog.title || '(untitled)'}
                      </button>
                      {blog.slug && <div className="text-xs text-gray-400 mt-0.5">/{blog.slug}</div>}
                    </td>
                    <td className="px-4 py-3">
                      {conn ? (
                        <span className="inline-flex items-center gap-1 text-gray-700">
                          <Globe className="h-3 w-3 text-emerald-600" />
                          {conn.display_name || conn.metadata?.host || conn.provider}
                        </span>
                      ) : (
                        <span className="text-gray-400">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 text-gray-700">{blog.keyword || <span className="text-gray-400">—</span>}</td>
                    <td className="px-4 py-3">
                      <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded ${STATUS_STYLES[blog.status] || 'bg-gray-100 text-gray-700'}`}>
                        {blog.status}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-500 text-xs">
                      {blog.created_at ? new Date(blog.created_at).toLocaleDateString() : ''}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        onClick={() => setEditingId(blog.id)}
                        className="p-1.5 text-gray-400 hover:text-primary-600 hover:bg-primary-50 rounded"
                        title="Edit"
                      >
                        <Edit3 className="h-4 w-4" />
                      </button>
                      <button
                        onClick={() => handleDelete(blog.id)}
                        className="p-1.5 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded ml-1"
                        title="Delete"
                      >
                        <Trash2 className="h-4 w-4" />
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {generatorOpen && (
        <GeneratorModal
          connections={websiteConnections}
          defaultConnectionId={initialConnectionId || connectionFilter}
          defaultKeyword={presetKeyword}
          onClose={() => {
            setGeneratorOpen(false);
            setPresetKeyword('');
          }}
          onGenerated={(row) => {
            setPresetKeyword('');
            handleGenerated(row);
          }}
        />
      )}

      {editingId && (
        <EditorModal
          blogId={editingId}
          onClose={() => setEditingId(null)}
          onSaved={(updated) => {
            setBlogs(prev => prev.map(b => (b.id === updated.id ? updated : b)));
          }}
          onDeleted={(deletedId) => {
            setBlogs(prev => prev.filter(b => b.id !== deletedId));
            setEditingId(null);
          }}
        />
      )}
    </div>
  );
};

const BlogsEmptyState = ({ hasWebsiteConnection, onGenerate }) => {
  const navigate = useNavigate();
  return (
    <div className="text-center py-16 px-4 border-2 border-dashed border-gray-200 rounded-lg bg-white">
      <FileText className="h-10 w-10 text-gray-400 mx-auto mb-3" />
      <h3 className="text-base font-medium text-gray-900">No blogs yet</h3>
      {hasWebsiteConnection ? (
        <>
          <p className="text-sm text-gray-500 mt-1 mb-4">
            Generate your first SEO blog draft from a connected site.
          </p>
          <button
            onClick={onGenerate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
          >
            <Sparkles className="h-4 w-4" />
            Generate blog
          </button>
        </>
      ) : (
        <>
          <p className="text-sm text-gray-500 mt-1 mb-4">
            Connect a website first — we'll use it to prefill business info when generating.
          </p>
          <button
            onClick={() => navigate('/connections')}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
          >
            <Plus className="h-4 w-4" />
            Connect a website
          </button>
        </>
      )}
    </div>
  );
};

const GeneratorModal = ({ connections, defaultConnectionId, defaultKeyword = '', onClose, onGenerated }) => {
  const [connectionId, setConnectionId] = useState(defaultConnectionId || (connections[0]?.id || ''));
  const [keyword, setKeyword] = useState(defaultKeyword);
  const [tone, setTone] = useState('');
  const [targetAudience, setTargetAudience] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');

  const submit = async (e) => {
    e.preventDefault();
    if (!keyword.trim()) return;
    setSubmitting(true);
    setErr('');
    try {
      const row = await blogsService.generate({
        connectionId: connectionId || undefined,
        keyword: keyword.trim(),
        tone: tone.trim() || undefined,
        targetAudience: targetAudience.trim() || undefined,
      });
      onGenerated({ ...row, connectionId });
    } catch (e2) {
      setErr(e2.response?.data?.error || e2.response?.data?.message || e2.message || 'Failed to generate');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal title="Generate blog" onClose={onClose}>
      <form onSubmit={submit} className="space-y-4">
        {connections.length > 0 ? (
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Connection</label>
            <select
              value={connectionId}
              onChange={e => setConnectionId(e.target.value)}
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            >
              <option value="">None (use defaults)</option>
              {connections.map(c => (
                <option key={c.id} value={c.id}>
                  {c.display_name || c.metadata?.host || c.provider}
                </option>
              ))}
            </select>
            <p className="text-xs text-gray-500 mt-1">
              We prefill business name and description from the connected site's metadata.
            </p>
          </div>
        ) : (
          <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-800">
            No website connections yet. The blog will use generic defaults. Connect a website for better results.
          </div>
        )}
        <div>
          <label className="block text-sm font-medium text-gray-700 mb-1">Keyword or topic</label>
          <input
            type="text"
            value={keyword}
            onChange={e => setKeyword(e.target.value)}
            placeholder="deep cleaning services Tampa"
            autoFocus
            className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
          />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Tone <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="text"
              value={tone}
              onChange={e => setTone(e.target.value)}
              placeholder="helpful, local, professional"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-1">Audience <span className="text-gray-400 font-normal">(optional)</span></label>
            <input
              type="text"
              value={targetAudience}
              onChange={e => setTargetAudience(e.target.value)}
              placeholder="homeowners in Florida"
              className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
            />
          </div>
        </div>
        {err && (
          <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
        )}
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onClose}
            className="px-4 py-2 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50"
          >
            Cancel
          </button>
          <button
            type="submit"
            disabled={submitting || !keyword.trim()}
            className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
          >
            {submitting ? (
              <>
                <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white"></div>
                Generating…
              </>
            ) : (
              <>
                <Sparkles className="h-4 w-4" />
                Generate
              </>
            )}
          </button>
        </div>
      </form>
    </Modal>
  );
};

const EditorModal = ({ blogId, onClose, onSaved, onDeleted }) => {
  const [blog, setBlog] = useState(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [err, setErr] = useState('');
  const [savedFlash, setSavedFlash] = useState(false);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const b = await blogsService.get(blogId);
        if (!cancelled) setBlog(b);
      } catch (e) {
        if (!cancelled) setErr(e.response?.data?.error || 'Failed to load blog');
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [blogId]);

  const set = (field, value) => setBlog(prev => ({ ...prev, [field]: value }));

  const save = async () => {
    if (!blog) return;
    setSaving(true);
    setErr('');
    try {
      const updated = await blogsService.update(blog.id, {
        title: blog.title,
        slug: blog.slug,
        metaDescription: blog.meta_description,
        markdown: blog.markdown,
        suggestedExcerpt: blog.suggested_excerpt,
        suggestedSocialPost: blog.suggested_social_post,
        status: blog.status,
      });
      setBlog(updated);
      onSaved(updated);
      setSavedFlash(true);
      setTimeout(() => setSavedFlash(false), 1500);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to save');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!blog) return;
    if (!window.confirm('Delete this blog draft? This cannot be undone.')) return;
    try {
      await blogsService.remove(blog.id);
      onDeleted(blog.id);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to delete');
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-end" onClick={onClose}>
      <div
        className="bg-white w-full max-w-3xl h-full overflow-y-auto shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white">
          <h2 className="text-lg font-semibold text-gray-900">Edit blog</h2>
          <div className="flex items-center gap-2">
            {savedFlash && (
              <span className="inline-flex items-center gap-1 text-xs text-green-700">
                <Check className="h-3.5 w-3.5" />
                Saved
              </span>
            )}
            <button
              onClick={handleDelete}
              className="p-2 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded"
              title="Delete"
            >
              <Trash2 className="h-4 w-4" />
            </button>
            <button
              onClick={save}
              disabled={saving || loading || !blog}
              className="px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            <button onClick={onClose} className="text-gray-400 hover:text-gray-600 p-1">
              <X className="h-5 w-5" />
            </button>
          </div>
        </div>
        <div className="p-6 space-y-4">
          {loading ? (
            <div className="text-sm text-gray-500">Loading…</div>
          ) : !blog ? (
            <div className="text-sm text-red-600">{err || 'Not found'}</div>
          ) : (
            <>
              {err && (
                <div className="p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
              )}
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Title</label>
                <input
                  type="text"
                  value={blog.title || ''}
                  onChange={e => set('title', e.target.value)}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Slug</label>
                  <input
                    type="text"
                    value={blog.slug || ''}
                    onChange={e => set('slug', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
                  />
                </div>
                <div>
                  <label className="block text-xs font-medium text-gray-600 mb-1">Status</label>
                  <select
                    value={blog.status || 'draft'}
                    onChange={e => set('status', e.target.value)}
                    className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                  >
                    <option value="draft">draft</option>
                    <option value="published">published</option>
                    <option value="failed">failed</option>
                  </select>
                </div>
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Meta description</label>
                <textarea
                  value={blog.meta_description || ''}
                  onChange={e => set('meta_description', e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Markdown</label>
                <textarea
                  value={blog.markdown || ''}
                  onChange={e => set('markdown', e.target.value)}
                  rows={18}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm font-mono"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Suggested excerpt</label>
                <textarea
                  value={blog.suggested_excerpt || ''}
                  onChange={e => set('suggested_excerpt', e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
              <div>
                <label className="block text-xs font-medium text-gray-600 mb-1">Suggested social post</label>
                <textarea
                  value={blog.suggested_social_post || ''}
                  onChange={e => set('suggested_social_post', e.target.value)}
                  rows={2}
                  className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
                />
              </div>
            </>
          )}
        </div>
      </div>
    </div>
  );
};

const Modal = ({ title, onClose, children }) => (
  <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4" onClick={onClose}>
    <div className="bg-white rounded-lg shadow-xl max-w-xl w-full" onClick={e => e.stopPropagation()}>
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200">
        <h2 className="text-lg font-semibold text-gray-900">{title}</h2>
        <button onClick={onClose} className="text-gray-400 hover:text-gray-600">
          <X className="h-5 w-5" />
        </button>
      </div>
      <div className="p-6">{children}</div>
    </div>
  </div>
);

// GscKeywordsPanel — Top-keywords-from-Search-Console section.
//
// Behavior:
//   - No GSC connections yet + user has a business auth → offer to pick a site
//     from /api/gsc/sites, save via /api/gsc/sites POST.
//   - No GSC connections + no business auth → prompt to Reconnect Google so
//     webmasters.readonly is granted, then the site picker appears.
//   - Has connections → dropdown of sites, days selector, table of top queries,
//     per-row "Generate blog" button that opens the generator with the keyword
//     pre-filled.
const GscKeywordsPanel = ({ gscConnections, onGenerate, onSiteConnected }) => {
  const { loginForBusiness } = useAuth();
  const [siteConnectionId, setSiteConnectionId] = useState(gscConnections[0]?.id || '');
  const [days, setDays] = useState(7);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState([]);
  const [err, setErr] = useState('');
  const [needsReauth, setNeedsReauth] = useState(false);

  // Keep the picker in sync with the current list of GSC connections.
  useEffect(() => {
    if (!gscConnections.length) {
      setSiteConnectionId('');
      setRows([]);
      return;
    }
    if (!gscConnections.find(c => c.id === siteConnectionId)) {
      setSiteConnectionId(gscConnections[0].id);
    }
  }, [gscConnections, siteConnectionId]);

  const load = useCallback(async () => {
    if (!siteConnectionId) return;
    setLoading(true);
    setErr('');
    setNeedsReauth(false);
    try {
      const data = await gscService.topQueries({ connectionId: siteConnectionId, days, limit: 25 });
      setRows(data.rows || []);
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.error || e.message || 'Failed to fetch queries';
      setErr(msg);
      if (status === 403 || /reauth|scope/i.test(msg)) setNeedsReauth(true);
    } finally {
      setLoading(false);
    }
  }, [siteConnectionId, days]);

  useEffect(() => {
    if (siteConnectionId) load();
  }, [siteConnectionId, days, load]);

  return (
    <div className="mb-6 bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 bg-yellow-50">
        <div className="flex items-center gap-2">
          <Search className="h-4 w-4 text-yellow-700" />
          <div>
            <p className="text-sm font-medium text-gray-900">Top keywords from Search Console</p>
            <p className="text-xs text-gray-500">Your best-performing queries — pick one to generate a blog.</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {gscConnections.length > 0 && (
            <>
              <select
                value={siteConnectionId}
                onChange={e => setSiteConnectionId(e.target.value)}
                className="px-2 py-1 border border-gray-300 rounded-md text-xs bg-white"
              >
                {gscConnections.map(c => (
                  <option key={c.id} value={c.id}>{c.display_name || c.metadata?.site_url}</option>
                ))}
              </select>
              <select
                value={days}
                onChange={e => setDays(Number(e.target.value))}
                className="px-2 py-1 border border-gray-300 rounded-md text-xs bg-white"
              >
                <option value={7}>Last 7 days</option>
                <option value={14}>Last 14 days</option>
                <option value={28}>Last 28 days</option>
                <option value={90}>Last 90 days</option>
              </select>
              <button
                onClick={load}
                disabled={loading}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-600 hover:text-gray-900 disabled:opacity-50"
                title="Refresh"
              >
                <RefreshCw className={`h-3 w-3 ${loading ? 'animate-spin' : ''}`} />
              </button>
            </>
          )}
        </div>
      </div>

      {gscConnections.length === 0 ? (
        <GscSitePicker
          onSaved={onSiteConnected}
          onReconnectGoogle={() => loginForBusiness()}
        />
      ) : (
        <div>
          {err && (
            <div className="px-4 py-3 bg-red-50 border-b border-red-100 text-xs text-red-800 flex items-start gap-2">
              <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
              <div className="flex-1">
                <div>{err}</div>
                {needsReauth && (
                  <button
                    onClick={() => loginForBusiness()}
                    className="mt-1 inline-flex items-center gap-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                  >
                    <RefreshCw className="h-3 w-3" />
                    Reconnect Google to grant Search Console access
                  </button>
                )}
              </div>
            </div>
          )}
          {loading ? (
            <div className="px-4 py-6 text-sm text-gray-500">Loading queries…</div>
          ) : rows.length === 0 ? (
            <div className="px-4 py-6 text-sm text-gray-500">No queries in this window.</div>
          ) : (
            <table className="min-w-full text-sm">
              <thead className="bg-gray-50 text-left">
                <tr>
                  <th className="px-4 py-2 font-medium text-gray-600">Keyword</th>
                  <th className="px-4 py-2 font-medium text-gray-600 text-right">Clicks</th>
                  <th className="px-4 py-2 font-medium text-gray-600 text-right">Impressions</th>
                  <th className="px-4 py-2 font-medium text-gray-600 text-right">CTR</th>
                  <th className="px-4 py-2 font-medium text-gray-600 text-right">Position</th>
                  <th className="px-4 py-2"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((row, i) => (
                  <tr key={row.query + i} className="hover:bg-gray-50">
                    <td className="px-4 py-2 text-gray-900">{row.query}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.clicks}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.impressions}</td>
                    <td className="px-4 py-2 text-right tabular-nums">{((row.ctr || 0) * 100).toFixed(1)}%</td>
                    <td className="px-4 py-2 text-right tabular-nums">{row.position ? row.position.toFixed(1) : '—'}</td>
                    <td className="px-4 py-2 text-right">
                      <button
                        onClick={() => onGenerate(row.query)}
                        className="inline-flex items-center gap-1 px-2 py-1 text-xs font-medium text-primary-600 hover:text-primary-700"
                      >
                        <Sparkles className="h-3 w-3" />
                        Generate
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}
    </div>
  );
};

const GscSitePicker = ({ onSaved, onReconnectGoogle }) => {
  const [state, setState] = useState('idle'); // idle | loading | picking | saving | error
  const [sites, setSites] = useState([]);
  const [err, setErr] = useState('');
  const [selected, setSelected] = useState('');

  const loadSites = async () => {
    setState('loading');
    setErr('');
    try {
      const data = await gscService.listSites();
      setSites(data.sites || []);
      setSelected(data.sites?.[0]?.siteUrl || '');
      setState('picking');
    } catch (e) {
      const status = e.response?.status;
      const msg = e.response?.data?.error || e.message || 'Failed to load sites';
      setErr(msg);
      if (status === 401 || status === 403 || /reauth|business|scope/i.test(msg)) {
        setState('needsReauth');
      } else {
        setState('error');
      }
    }
  };

  const save = async () => {
    if (!selected) return;
    setState('saving');
    setErr('');
    try {
      const chosen = sites.find(s => s.siteUrl === selected) || { siteUrl: selected };
      const row = await gscService.saveSite({
        siteUrl: chosen.siteUrl,
        permissionLevel: chosen.permissionLevel,
        ownerGoogleId: chosen.ownerGoogleId,
        ownerEmail: chosen.ownerEmail,
      });
      onSaved(row);
    } catch (e) {
      setErr(e.response?.data?.error || e.message || 'Failed to save');
      setState('picking');
    }
  };

  return (
    <div className="p-6">
      {state === 'idle' && (
        <div className="text-center">
          <p className="text-sm text-gray-700 mb-3">
            Connect a Search Console property to see your top-ranking keywords here.
          </p>
          <button
            onClick={loadSites}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
          >
            <Search className="h-4 w-4" />
            Choose a Search Console site
          </button>
        </div>
      )}
      {state === 'loading' && <div className="text-sm text-gray-500">Loading your sites…</div>}
      {state === 'picking' && (
        <div>
          {sites.length === 0 ? (
            <p className="text-sm text-gray-500">No Search Console sites found on your Google account.</p>
          ) : (
            <>
              <label className="block text-sm font-medium text-gray-700 mb-1">Pick a site</label>
              <select
                value={selected}
                onChange={e => setSelected(e.target.value)}
                className="w-full px-3 py-2 border border-gray-300 rounded-md text-sm"
              >
                {sites.map(s => (
                  <option key={s.siteUrl} value={s.siteUrl}>
                    {s.siteUrl}{s.permissionLevel ? ` — ${s.permissionLevel}` : ''}
                  </option>
                ))}
              </select>
              {err && (
                <div className="mt-2 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>
              )}
              <div className="mt-3 flex justify-end gap-2">
                <button
                  onClick={loadSites}
                  className="px-3 py-1.5 text-xs text-gray-600 hover:text-gray-900"
                >
                  Refresh
                </button>
                <button
                  onClick={save}
                  disabled={!selected}
                  className="px-3 py-1.5 text-sm text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50"
                >
                  Save
                </button>
              </div>
            </>
          )}
        </div>
      )}
      {state === 'saving' && <div className="text-sm text-gray-500">Saving…</div>}
      {state === 'needsReauth' && (
        <div className="text-center">
          <p className="text-sm text-gray-700 mb-3">
            Search Console access wasn't granted on your Google connection. Reconnect Google and approve the new permission.
          </p>
          {err && <div className="mb-3 p-2 bg-red-50 border border-red-200 rounded text-xs text-red-800">{err}</div>}
          <button
            onClick={onReconnectGoogle}
            className="inline-flex items-center gap-2 px-4 py-2 bg-primary-600 text-white text-sm font-medium rounded-md hover:bg-primary-700"
          >
            <RefreshCw className="h-4 w-4" />
            Reconnect Google
          </button>
        </div>
      )}
      {state === 'error' && (
        <div className="text-center">
          <p className="text-sm text-red-700 mb-3">{err}</p>
          <button
            onClick={loadSites}
            className="inline-flex items-center gap-2 px-3 py-1.5 border border-gray-300 rounded-md text-sm text-gray-700 hover:bg-gray-50"
          >
            <RefreshCw className="h-4 w-4" />
            Try again
          </button>
        </div>
      )}
    </div>
  );
};

export default Blogs;
