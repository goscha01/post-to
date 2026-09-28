import React, { useState, useEffect } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { Users, CheckCircle2, XCircle, LogIn } from 'lucide-react';
import teamService from '../services/teamService';
import { useAuth } from '../contexts/AuthContext';

// Landing page for /invite/accept?token=…
//   1. Preview the invite (public endpoint).
//   2. If the user is not logged in, offer "Sign in with Google" — we stash
//      the token in localStorage so AuthCallback can redirect back here after
//      Google returns. (New signups are auto-consumed server-side via
//      auth.js's post-insert branch — no explicit accept click needed there.)
//   3. If the user is logged in with the invited email, show "Accept"; on
//      success we replace the stored JWT with the fresh one returned by the
//      accept endpoint (which sets workspaceOwnerId) and drop them at /dashboard.
//   4. If logged in as the wrong email, ask them to switch accounts.

const PENDING_KEY = 'post_to_pending_invite_token';

const AcceptInvite = () => {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const { user, isAuthenticated, login, logout } = useAuth();
  const token = searchParams.get('token');

  const [preview, setPreview] = useState(null);
  const [previewError, setPreviewError] = useState(null);
  const [loading, setLoading] = useState(true);
  const [accepting, setAccepting] = useState(false);
  const [acceptError, setAcceptError] = useState(null);

  useEffect(() => {
    if (!token) {
      setPreviewError('This invite link is missing a token.');
      setLoading(false);
      return;
    }
    (async () => {
      try {
        const p = await teamService.previewInvite(token);
        setPreview(p);
      } catch (e) {
        setPreviewError(e.response?.data?.error || 'Invite link is invalid or has expired.');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const onSignInAndAccept = () => {
    // Stash the token so AuthCallback can bounce us back here after Google.
    localStorage.setItem(PENDING_KEY, token);
    login(false);
  };

  const onAccept = async () => {
    setAccepting(true);
    setAcceptError(null);
    try {
      const res = await teamService.acceptInvite(token);
      // Replace the stored JWT with the fresh one (workspaceOwnerId baked in).
      if (res?.token) {
        localStorage.setItem('gmb_token', res.token);
      }
      localStorage.removeItem(PENDING_KEY);
      // Reload so AuthProvider re-hydrates from the new JWT and every page
      // fetches under the new workspace.
      window.location.href = '/dashboard';
    } catch (e) {
      setAcceptError(e.response?.data?.error || 'Failed to accept invitation');
      setAccepting(false);
    }
  };

  const emailsMatch =
    isAuthenticated &&
    preview?.email &&
    user?.email &&
    preview.email.trim().toLowerCase() === user.email.trim().toLowerCase();

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50 px-4">
      <div className="max-w-md w-full bg-white rounded-2xl shadow-xl border border-gray-200 p-8">
        <div className="flex items-center justify-center w-12 h-12 mx-auto rounded-full bg-primary-100 text-primary-700 mb-4">
          <Users size={20} />
        </div>

        {loading && (
          <p className="text-center text-sm text-gray-500">Loading invitation…</p>
        )}

        {!loading && previewError && (
          <>
            <div className="flex items-center justify-center gap-2 mb-3 text-red-600">
              <XCircle size={20} />
              <h1 className="text-lg font-semibold">Can't accept this invite</h1>
            </div>
            <p className="text-center text-sm text-gray-600 mb-6">{previewError}</p>
            <button
              onClick={() => navigate('/')}
              className="w-full px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200"
            >
              Go home
            </button>
          </>
        )}

        {!loading && !previewError && preview && (
          <>
            <h1 className="text-xl font-semibold text-gray-900 text-center mb-2">
              You've been invited to Post To
            </h1>
            <p className="text-sm text-gray-600 text-center mb-6">
              {preview.inviter_name || 'Someone'} invited <strong>{preview.email}</strong> to join{' '}
              <strong>{preview.owner_name}</strong>'s workspace as a{' '}
              <strong>{preview.role === 'admin' ? 'Admin' : 'Member'}</strong>.
            </p>

            {!isAuthenticated && (
              <>
                <button
                  onClick={onSignInAndAccept}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700"
                >
                  <LogIn size={16} /> Sign in with Google to accept
                </button>
                <p className="text-xs text-gray-500 text-center mt-3">
                  You'll be asked to sign in with <strong>{preview.email}</strong>.
                </p>
              </>
            )}

            {isAuthenticated && emailsMatch && (
              <>
                {acceptError && (
                  <div className="mb-4 px-3 py-2 bg-red-50 border border-red-200 rounded-lg text-sm text-red-700">
                    {acceptError}
                  </div>
                )}
                <button
                  onClick={onAccept}
                  disabled={accepting}
                  className="w-full flex items-center justify-center gap-2 px-4 py-2.5 bg-primary-600 text-white text-sm font-medium rounded-lg hover:bg-primary-700 disabled:opacity-50"
                >
                  <CheckCircle2 size={16} />
                  {accepting ? 'Joining workspace…' : `Join ${preview.owner_name}'s workspace`}
                </button>
              </>
            )}

            {isAuthenticated && !emailsMatch && (
              <>
                <div className="mb-4 px-3 py-2 bg-amber-50 border border-amber-200 rounded-lg text-sm text-amber-800">
                  This invite was sent to <strong>{preview.email}</strong>, but you're signed in as{' '}
                  <strong>{user?.email}</strong>. Sign out and sign back in with the invited email.
                </div>
                <button
                  onClick={() => {
                    localStorage.setItem(PENDING_KEY, token);
                    logout();
                    navigate('/login');
                  }}
                  className="w-full px-4 py-2 bg-gray-100 text-gray-700 text-sm font-medium rounded-lg hover:bg-gray-200"
                >
                  Sign out and switch account
                </button>
              </>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default AcceptInvite;
