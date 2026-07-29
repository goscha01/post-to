import React, { useState, useEffect, useCallback, useMemo } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Plus, Sparkles, Trash2, Edit3, Globe, Search, X, AlertCircle, Check, FileText, RefreshCw, Send, ExternalLink, Copy, Upload, Image as ImageIcon } from 'lucide-react';
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
    const target = blogs.find(b => b.id === id);
    const msg = target?.status === 'published'
      ? 'Delete this article? It will be removed from your live site on the next build.'
      : 'Delete this blog draft?';
    if (!window.confirm(msg)) return;
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

      <BlogDomainsPanel connections={connections} />

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
  const [publishing, setPublishing] = useState(false);
  const [publishedUrls, setPublishedUrls] = useState([]);
  const [publishedNoDomain, setPublishedNoDomain] = useState(false);
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
    const wasPublished = blog.status === 'published';
    const msg = wasPublished
      ? 'Delete this article? It will be removed from your live site on the next build.'
      : 'Delete this blog draft? This cannot be undone.';
    if (!window.confirm(msg)) return;
    try {
      await blogsService.remove(blog.id);
      onDeleted(blog.id);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to delete');
    }
  };

  const publish = async () => {
    if (!blog) return;
    setPublishing(true);
    setErr('');
    setPublishedUrls([]);
    setPublishedNoDomain(false);
    try {
      const result = await blogsService.publish(blog.id);
      setBlog(result.blog);
      onSaved(result.blog);
      setPublishedUrls(result.urls || []);
      setPublishedNoDomain(!result.hasVerifiedDomain);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to publish');
    } finally {
      setPublishing(false);
    }
  };

  const unpublish = async () => {
    if (!blog) return;
    setPublishing(true);
    setErr('');
    try {
      const updated = await blogsService.unpublish(blog.id);
      setBlog(updated);
      onSaved(updated);
      setPublishedUrls([]);
      setPublishedNoDomain(false);
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to unpublish');
    } finally {
      setPublishing(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 bg-black/40 flex items-stretch justify-end" onClick={onClose}>
      <div
        className="bg-white w-full max-w-3xl h-full overflow-y-auto shadow-xl"
        onClick={e => e.stopPropagation()}
      >
        <div className="sticky top-0 z-10 flex items-center justify-between px-6 py-4 border-b border-gray-200 bg-white">
          <div className="flex items-center gap-3">
            <h2 className="text-lg font-semibold text-gray-900">Edit blog</h2>
            {blog?.status && (
              <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded ${STATUS_STYLES[blog.status] || 'bg-gray-100 text-gray-700'}`}>
                {blog.status}
              </span>
            )}
          </div>
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
              className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
            >
              {saving ? 'Saving…' : 'Save'}
            </button>
            {blog?.status === 'published' ? (
              <button
                onClick={unpublish}
                disabled={publishing || loading}
                className="px-3 py-1.5 text-sm font-medium text-gray-700 bg-white border border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50"
              >
                {publishing ? 'Unpublishing…' : 'Unpublish'}
              </button>
            ) : (
              <button
                onClick={publish}
                disabled={publishing || loading || !blog}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50"
              >
                <Send className="h-3.5 w-3.5" />
                {publishing ? 'Publishing…' : 'Publish'}
              </button>
            )}
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
              {publishedUrls.length > 0 && (
                <div className="p-3 bg-green-50 border border-green-200 rounded space-y-2">
                  <div className="text-sm font-medium text-green-800 flex items-center gap-1">
                    <Check className="h-4 w-4" />
                    Published
                  </div>
                  {publishedUrls.map(u => (
                    <div key={u} className="flex items-center gap-2 text-xs">
                      <a href={u} target="_blank" rel="noreferrer" className="text-primary-600 hover:underline flex-1 truncate inline-flex items-center gap-1">
                        <ExternalLink className="h-3 w-3" />{u}
                      </a>
                      <button
                        onClick={() => navigator.clipboard?.writeText(u)}
                        className="p-1 text-gray-500 hover:text-gray-900"
                        title="Copy URL"
                      >
                        <Copy className="h-3.5 w-3.5" />
                      </button>
                    </div>
                  ))}
                </div>
              )}
              {publishedNoDomain && (
                <div className="p-3 bg-amber-50 border border-amber-200 rounded text-xs text-amber-900">
                  Article is marked published, but no verified blog domain is connected yet — add one at the top of the Blogs page to get a public URL.
                </div>
              )}
              <HeroImageField
                blog={blog}
                onChange={(updated) => setBlog(prev => ({ ...prev, hero_image: updated.hero_image }))}
              />
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

// Extract a root hostname from any of the site-shaped connections we already
// have (website scrape, GSC property). Returns 'spotless.homes' for inputs like
// 'https://www.spotless.homes/', 'sc-domain:spotless.homes', etc.
function extractHostFromConnection(conn) {
  if (!conn) return null;
  const meta = conn.metadata || {};
  const candidates = [
    meta.host,
    meta.hostname,
    meta.site_url,
    meta.url,
    conn.external_id,
    conn.display_name,
  ].filter(Boolean);
  for (const raw of candidates) {
    let s = String(raw).trim().toLowerCase();
    if (!s) continue;
    if (s.startsWith('sc-domain:')) s = s.slice(10);
    s = s.replace(/^https?:\/\//, '').replace(/\/.*$/, '').replace(/^www\./, '');
    if (/^[a-z0-9-]+(\.[a-z0-9-]+)+$/.test(s)) return s;
  }
  return null;
}

// BlogDomainsPanel — subdomain onboarding for the multi-tenant blog renderer.
//
// UX flow (auto-filled):
//   1. Pre-fill hostname as `blog.<user's connected site>` — user rarely has
//      to type. DNS instructions render immediately (they don't depend on the
//      row existing yet — cnameTarget is a service-level constant).
//   2. One button "Save & verify" — creates the row and immediately runs the
//      DNS check + Railway customDomainCreate. If DNS isn't set yet the row
//      persists in "Pending DNS" state and the user retries via "Verify".
//   3. Verified rows collapse to a one-line "hostname · Open · Remove" chip.
const BlogDomainsPanel = ({ connections = [] }) => {
  const [state, setState] = useState({ loading: true, domains: [], cnameTarget: '' });
  const [adding, setAdding] = useState(false);
  const [hostname, setHostname] = useState('');
  const [siteName, setSiteName] = useState('');
  const [manuallyEdited, setManuallyEdited] = useState(false);
  const [err, setErr] = useState('');
  const [busyId, setBusyId] = useState(null);

  // Best guess: first website connection, otherwise first GSC connection.
  const sourceConnection = useMemo(() => {
    return (
      connections.find(c => c.provider === 'website') ||
      connections.find(c => c.provider === 'google_search_console') ||
      null
    );
  }, [connections]);

  const suggestedHost = useMemo(() => {
    const root = extractHostFromConnection(sourceConnection);
    return root ? `blog.${root}` : '';
  }, [sourceConnection]);

  const suggestedSiteName = useMemo(() => {
    if (!sourceConnection) return '';
    return sourceConnection.display_name || sourceConnection.metadata?.title || sourceConnection.metadata?.siteName || '';
  }, [sourceConnection]);

  const load = useCallback(async () => {
    setState(s => ({ ...s, loading: true }));
    try {
      const data = await blogsService.listDomains();
      setState({ loading: false, domains: data.domains || [], cnameTarget: data.cnameTarget || '' });
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to load domains');
      setState(s => ({ ...s, loading: false }));
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  // Auto-fill hostname + site name when suggestion becomes available, unless
  // the user has already typed something.
  useEffect(() => {
    if (!manuallyEdited && suggestedHost && !hostname) setHostname(suggestedHost);
    if (!manuallyEdited && suggestedSiteName && !siteName) setSiteName(suggestedSiteName);
  }, [suggestedHost, suggestedSiteName, hostname, siteName, manuallyEdited]);

  // Save row, then immediately try to verify. If DNS isn't set yet, the row
  // stays in pending state and the retry button reuses the same handler.
  const saveAndVerify = async (e) => {
    e.preventDefault();
    const trimmed = hostname.trim();
    if (!trimmed) return;
    setErr('');
    setAdding(true);
    try {
      const created = await blogsService.createDomain({
        hostname: trimmed,
        siteName: siteName.trim() || undefined,
      });
      let currentDomain = created.domain;
      const cnameTarget = created.cnameTarget || state.cnameTarget;
      // Optimistic insert so the row shows while we verify.
      setState(s => ({
        ...s,
        cnameTarget,
        domains: [currentDomain, ...s.domains.filter(d => d.id !== currentDomain.id)],
      }));
      try {
        currentDomain = await blogsService.verifyDomain(currentDomain.id);
        setState(s => ({
          ...s,
          domains: s.domains.map(d => (d.id === currentDomain.id ? currentDomain : d)),
        }));
        setHostname('');
        setSiteName('');
        setManuallyEdited(false);
      } catch (verifyErr) {
        // Backend returns the refreshed row on 400 (DNS pending / SSL
        // pending). Apply it so the row's CNAME instructions show Railway's
        // per-domain target, not the stale global default.
        const refreshed = verifyErr.response?.data?.domain;
        if (refreshed) {
          setState(s => ({
            ...s,
            domains: s.domains.map(d => (d.id === refreshed.id ? refreshed : d)),
          }));
        }
        setErr(verifyErr.response?.data?.error || 'DNS not resolved yet — copy the CNAME below and set it at your DNS provider, then click Verify.');
      }
    } catch (e2) {
      setErr(e2.response?.data?.error || 'Failed to add domain');
    } finally {
      setAdding(false);
    }
  };

  const verify = async (id) => {
    setBusyId(id);
    setErr('');
    try {
      const updated = await blogsService.verifyDomain(id);
      setState(s => ({ ...s, domains: s.domains.map(d => d.id === id ? updated : d) }));
    } catch (e) {
      // Backend returns the refreshed row even on 400 (DNS not ready / SSL
      // pending) so the DNS instructions can update with the correct
      // per-domain Railway CNAME target. Apply that before showing the error.
      const refreshed = e.response?.data?.domain;
      if (refreshed) {
        setState(s => ({ ...s, domains: s.domains.map(d => d.id === id ? refreshed : d) }));
      }
      setErr(e.response?.data?.error || 'Verification failed');
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (id) => {
    if (!window.confirm('Remove this blog domain? Published articles will stop being reachable at this URL.')) return;
    setBusyId(id);
    setErr('');
    try {
      await blogsService.deleteDomain(id);
      setState(s => ({ ...s, domains: s.domains.filter(d => d.id !== id) }));
    } catch (e) {
      setErr(e.response?.data?.error || 'Failed to delete');
    } finally {
      setBusyId(null);
    }
  };

  const hasVerified = state.domains.some(d => d.metadata?.verified);
  const pending = state.domains.filter(d => !d.metadata?.verified);
  const verifiedRows = state.domains.filter(d => d.metadata?.verified);

  return (
    <div className="mb-6 bg-white border border-gray-200 rounded-lg overflow-hidden">
      <div className="flex items-center justify-between gap-2 px-4 py-3 border-b border-gray-100 bg-emerald-50">
        <div className="flex items-center gap-2">
          <Globe className="h-4 w-4 text-emerald-700" />
          <div>
            <p className="text-sm font-medium text-gray-900">Publish to your domain</p>
            <p className="text-xs text-gray-500">
              {hasVerified
                ? 'Your published articles show up on the domain below.'
                : sourceConnection
                  ? 'We pre-filled the subdomain from your connected site. Click Save & verify — we\'ll show you the exact DNS record to add at your registrar.'
                  : 'Enter the subdomain you want your published articles to live on. We\'ll register it and give you the DNS record to add.'}
            </p>
          </div>
        </div>
      </div>

      {err && (
        <div className="px-4 py-2 bg-red-50 border-b border-red-100 text-xs text-red-800 flex items-start gap-2">
          <AlertCircle className="h-4 w-4 mt-0.5 flex-shrink-0" />
          <span>{err}</span>
        </div>
      )}

      <div className="px-4 py-3 space-y-4">
        {state.loading ? (
          <div className="text-sm text-gray-500">Loading…</div>
        ) : (
          <>
            {/* Verified rows collapse to a compact chip */}
            {verifiedRows.length > 0 && (
              <ul className="space-y-2">
                {verifiedRows.map(d => (
                  <BlogDomainRow
                    key={d.id}
                    domain={d}
                    cnameTarget={state.cnameTarget}
                    busy={busyId === d.id}
                    onVerify={() => verify(d.id)}
                    onDelete={() => remove(d.id)}
                  />
                ))}
              </ul>
            )}

            {/* Pending rows: full DNS instructions inline with the row */}
            {pending.length > 0 && (
              <ul className="space-y-2">
                {pending.map(d => (
                  <BlogDomainRow
                    key={d.id}
                    domain={d}
                    cnameTarget={state.cnameTarget}
                    busy={busyId === d.id}
                    onVerify={() => verify(d.id)}
                    onDelete={() => remove(d.id)}
                  />
                ))}
              </ul>
            )}

            {/* Add-new form only when there's no pending domain (avoid two
                overlapping DNS instruction blocks). If a pending one exists,
                the user should finish verifying it first.

                The DNS record is NOT previewed here — Railway assigns a
                unique per-domain CNAME target after we register the hostname,
                and that value is what Let's Encrypt validates against for
                SSL. Showing a generic target here would be misleading. Once
                the user clicks Save & verify, the pending row that appears
                below shows the correct per-domain CNAME value. */}
            {pending.length === 0 && (
              <form onSubmit={saveAndVerify} className="space-y-3">
                <div className="text-xs text-gray-600">
                  We'll register the subdomain on our blog service and give you the
                  exact DNS record (CNAME) to add at your registrar. SSL is
                  auto-provisioned by Let's Encrypt once DNS resolves.
                </div>

                <div className="flex flex-wrap items-end gap-2">
                  <div className="flex-1 min-w-[220px]">
                    <label className="block text-xs font-medium text-gray-600 mb-1">Subdomain</label>
                    <input
                      type="text"
                      value={hostname}
                      onChange={e => { setHostname(e.target.value); setManuallyEdited(true); }}
                      placeholder={suggestedHost || 'blog.yoursite.com'}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <div className="flex-1 min-w-[180px]">
                    <label className="block text-xs font-medium text-gray-600 mb-1">
                      Site name <span className="text-gray-400 font-normal">(optional)</span>
                    </label>
                    <input
                      type="text"
                      value={siteName}
                      onChange={e => { setSiteName(e.target.value); setManuallyEdited(true); }}
                      placeholder={suggestedSiteName || 'Your Business'}
                      className="w-full px-3 py-1.5 border border-gray-300 rounded-md text-sm"
                    />
                  </div>
                  <button
                    type="submit"
                    disabled={adding || !hostname.trim()}
                    className="inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium text-white bg-primary-600 rounded-md hover:bg-primary-700 disabled:opacity-50"
                  >
                    {adding ? (
                      <>
                        <RefreshCw className="h-4 w-4 animate-spin" />
                        Verifying…
                      </>
                    ) : (
                      <>
                        <Check className="h-4 w-4" />
                        {hasVerified ? 'Add another' : 'Save & verify'}
                      </>
                    )}
                  </button>
                </div>
              </form>
            )}
          </>
        )}
      </div>
    </div>
  );
};

const BlogDomainRow = ({ domain, cnameTarget, busy, onVerify, onDelete }) => {
  const hostname = domain.metadata?.hostname;
  const verified = !!domain.metadata?.verified;
  const target = domain.metadata?.cname_target || cnameTarget;

  // Verified: single-line chip with a mini theme preview + refresh button.
  if (verified) {
    return (
      <li className="border border-green-200 bg-green-50 rounded-md px-3 py-2 space-y-2">
        <div className="flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <Check className="h-4 w-4 text-green-700 flex-shrink-0" />
            <a
              href={`https://${hostname}`}
              target="_blank"
              rel="noreferrer"
              className="font-medium text-gray-900 text-sm truncate hover:underline"
            >
              {hostname}
            </a>
            <span className="inline-flex items-center gap-1 text-xs text-green-800">
              <ExternalLink className="h-3 w-3" /> live
            </span>
          </div>
          <button
            onClick={onDelete}
            disabled={busy}
            className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
            title="Remove"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
        <VerifiedThemeStrip domain={domain} />
      </li>
    );
  }

  // Pending: DNS instructions + Verify. Split into two sub-states — DNS
  // pointing at the wrong value vs DNS OK but SSL cert still provisioning —
  // so the user knows whether to touch DNS again or just wait.
  const currentCname = (domain.metadata?.railway_current_cname || '').toLowerCase().replace(/\.$/, '');
  const expectedCname = (target || '').toLowerCase().replace(/\.$/, '');
  const dnsOk = !!(currentCname && expectedCname && currentCname === expectedCname);
  const sslPending = dnsOk;

  return (
    <li className={`border rounded-md p-3 ${sslPending ? 'border-blue-200 bg-blue-50/40' : 'border-amber-200 bg-amber-50/40'}`}>
      <div className="flex items-center justify-between gap-3 mb-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="font-medium text-gray-900 text-sm truncate">{hostname}</span>
          <span className={`inline-flex items-center text-xs px-2 py-0.5 rounded ${sslPending ? 'bg-blue-100 text-blue-800' : 'bg-amber-100 text-amber-800'}`}>
            {sslPending ? 'Provisioning SSL (~1–2 min)' : 'Waiting for DNS'}
          </span>
        </div>
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onVerify}
            disabled={busy}
            className="inline-flex items-center gap-1 px-2.5 py-1 text-xs font-medium text-white bg-primary-600 rounded hover:bg-primary-700 disabled:opacity-50"
          >
            <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
            {busy ? 'Checking…' : 'Verify'}
          </button>
          <button
            onClick={onDelete}
            disabled={busy}
            className="p-1 text-gray-400 hover:text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
            title="Remove"
          >
            <Trash2 className="h-4 w-4" />
          </button>
        </div>
      </div>
      {sslPending ? (
        <div className="text-xs text-gray-700">
          DNS is correct. Railway is issuing a Let's Encrypt certificate. This usually
          finishes within 1–2 minutes — click Verify again shortly.
        </div>
      ) : (
        <>
          <div className="text-xs text-gray-700">
            Add this DNS record at your registrar, then click Verify:
          </div>
          <div className="mt-1 grid grid-cols-3 gap-2 text-xs font-mono bg-white border border-gray-200 rounded p-2">
            <div>
              <div className="text-[10px] uppercase text-gray-500 font-sans">Type</div>
              <div>CNAME</div>
            </div>
            <div>
              <div className="text-[10px] uppercase text-gray-500 font-sans">Host</div>
              <div>{hostname?.split('.')[0]}</div>
            </div>
            <div className="min-w-0">
              <div className="text-[10px] uppercase text-gray-500 font-sans flex items-center gap-1">
                Value
                <button
                  type="button"
                  onClick={() => navigator.clipboard?.writeText(target)}
                  className="inline-flex items-center gap-0.5 text-primary-600 hover:text-primary-700"
                  title="Copy value"
                >
                  <Copy className="h-3 w-3" />
                  copy
                </button>
              </div>
              <div className="truncate">{target}</div>
            </div>
          </div>
          {currentCname && (
            <div className="mt-2 text-xs text-amber-800">
              DNS currently resolves to <code className="bg-white px-1 rounded">{currentCname}</code> — needs to be <code className="bg-white px-1 rounded">{expectedCname}</code>.
            </div>
          )}
        </>
      )}
    </li>
  );
};

// VerifiedThemeStrip — mini theme preview + Refresh button under a verified
// blog domain row. Shows the scraped primary color swatch, logo thumbnail,
// and detected font family, so the user can see at a glance whether the
// auto-populated theme looks right. Refresh re-runs the scrape.
const VerifiedThemeStrip = ({ domain }) => {
  const [busy, setBusy] = useState(false);
  const [flash, setFlash] = useState('');
  const [current, setCurrent] = useState(domain);
  const theme = current.metadata?.theme || {};
  const hasAnything = theme.primaryColor || theme.fontFamily || theme.logoUrl;

  const refresh = async () => {
    setBusy(true);
    setFlash('');
    try {
      const updated = await blogsService.refreshDomainTheme(current.id);
      setCurrent(updated);
      setFlash('Refreshed from main site');
      setTimeout(() => setFlash(''), 2500);
    } catch (e) {
      setFlash(e.response?.data?.error || 'Refresh failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center justify-between gap-3 text-xs">
      <div className="flex items-center gap-3 min-w-0 text-gray-600">
        {theme.logoUrl && (
          <img src={theme.logoUrl} alt="logo" className="h-5 w-5 rounded object-contain bg-white border border-gray-200" />
        )}
        {theme.primaryColor && (
          <span className="inline-flex items-center gap-1">
            <span
              className="h-3 w-3 rounded-full border border-gray-300"
              style={{ backgroundColor: theme.primaryColor }}
              title={theme.primaryColor}
            />
            <span className="font-mono text-[11px]">{theme.primaryColor}</span>
          </span>
        )}
        {theme.fontFamily && (
          <span className="text-[11px] text-gray-500">{theme.fontFamily}</span>
        )}
        {!hasAnything && (
          <span className="text-[11px] text-gray-500 italic">No theme scraped yet — click Refresh.</span>
        )}
      </div>
      <div className="flex items-center gap-2 flex-shrink-0">
        {flash && <span className="text-[11px] text-green-700">{flash}</span>}
        <button
          type="button"
          onClick={refresh}
          disabled={busy}
          className="inline-flex items-center gap-1 px-2 py-0.5 text-[11px] text-gray-600 hover:text-gray-900 hover:bg-white rounded disabled:opacity-50"
          title="Re-scrape the main site for theme signals"
        >
          <RefreshCw className={`h-3 w-3 ${busy ? 'animate-spin' : ''}`} />
          {busy ? 'Scanning…' : 'Refresh theme'}
        </button>
      </div>
    </div>
  );
};

// HeroImageField — upload / preview / remove for the blog's hero image.
// Uploads via multipart POST, stores a root-relative path on the row (e.g.
// /assets/blog/<slug>-hero.jpg). Renders inline preview from the same path
// once the customer's site build syncs the file; before then, the img may
// 404 for a couple minutes — that's expected and we show a helper note.
const HeroImageField = ({ blog, onChange }) => {
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const inputRef = React.useRef(null);
  const hero = blog?.hero_image;
  // Preview URL: the path is relative to the customer's domain. Best-effort
  // guess for preview: assume first published-live domain. Since we don't
  // have that available here without extra plumbing, we just show a
  // filename + upload-time indicator; the real preview is on the live site.
  // TODO: pass linked domain hostname in from the parent for a real preview.

  const openPicker = () => inputRef.current?.click();

  const upload = async (file) => {
    if (!file) return;
    setBusy(true);
    setErr('');
    try {
      const updated = await blogsService.uploadHeroImage(blog.id, file);
      onChange(updated);
    } catch (e) {
      setErr(e.response?.data?.error || 'Upload failed');
    } finally {
      setBusy(false);
      if (inputRef.current) inputRef.current.value = '';
    }
  };

  const remove = async () => {
    if (!window.confirm('Remove this hero image? The image file will be deleted from your storage.')) return;
    setBusy(true);
    setErr('');
    try {
      const updated = await blogsService.removeHeroImage(blog.id);
      onChange(updated);
    } catch (e) {
      setErr(e.response?.data?.error || 'Remove failed');
    } finally {
      setBusy(false);
    }
  };

  return (
    <div>
      <label className="block text-xs font-medium text-gray-600 mb-1">Hero image</label>
      <input
        ref={inputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,image/avif,image/gif"
        className="hidden"
        onChange={(e) => upload(e.target.files?.[0])}
      />
      {hero ? (
        <div className="flex items-start gap-3 p-2 border border-gray-200 rounded-md">
          <div className="h-16 w-24 flex-shrink-0 bg-gray-100 rounded overflow-hidden flex items-center justify-center">
            <ImageIcon className="h-5 w-5 text-gray-400" />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-xs font-mono text-gray-700 truncate">{hero}</div>
            <div className="text-[11px] text-gray-500 mt-0.5">
              Will render as the article's hero once the site build syncs.
            </div>
            {err && <div className="text-[11px] text-red-700 mt-1">{err}</div>}
            <div className="mt-2 flex items-center gap-2">
              <button
                type="button"
                onClick={openPicker}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-gray-700 border border-gray-300 rounded hover:bg-gray-50 disabled:opacity-50"
              >
                <Upload className="h-3 w-3" />
                {busy ? 'Uploading…' : 'Replace'}
              </button>
              <button
                type="button"
                onClick={remove}
                disabled={busy}
                className="inline-flex items-center gap-1 px-2 py-1 text-xs text-red-600 hover:bg-red-50 rounded disabled:opacity-50"
              >
                <Trash2 className="h-3 w-3" />
                Remove
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div>
          <button
            type="button"
            onClick={openPicker}
            disabled={busy}
            className="inline-flex items-center gap-2 px-3 py-2 text-sm text-gray-700 border border-dashed border-gray-300 rounded-md hover:bg-gray-50 disabled:opacity-50 w-full"
          >
            <Upload className="h-4 w-4" />
            {busy ? 'Uploading…' : 'Upload hero image'}
            <span className="ml-auto text-xs text-gray-500">JPG / PNG / WebP · &lt;10MB</span>
          </button>
          {err && <div className="mt-1 text-[11px] text-red-700">{err}</div>}
        </div>
      )}
    </div>
  );
};

export default Blogs;
