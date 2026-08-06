import React, { useState } from 'react';
import { Link, useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import {
  Home,
  Building2,
  FileText,
  Newspaper,
  MessageSquare,
  BarChart3,
  LineChart,
  Megaphone,
  Bot,
  Sparkles,
  Settings,
  Link2,
  CalendarDays,
  Zap,
  Menu,
  X,
  LogOut,
  User
} from 'lucide-react';

const Layout = ({ children }) => {
  const { logout, user } = useAuth();
  const location = useLocation();
  const navigate = useNavigate();
  const [sidebarOpen, setSidebarOpen] = useState(false);

  // Debug user data

  // Grouped nav: sections with an optional label. Sections with a null label
  // render as a plain block at the top (Dashboard / Business Profiles).
  const navigationSections = [
    {
      label: null,
      items: [
        { name: 'Dashboard', href: '/dashboard', icon: Home },
        { name: 'Business Profiles', href: '/profiles', icon: Building2 },
      ],
    },
    {
      label: 'Posting',
      items: [
        { name: 'Calendar', href: '/calendar', icon: CalendarDays },
        { name: 'Posts', href: '/posts', icon: FileText },
        { name: 'Services', href: '/services', icon: Settings },
        { name: 'Reviews', href: '/reviews', icon: MessageSquare },
        { name: 'Blogs', href: '/blogs', icon: Newspaper },
        { name: 'Automations', href: '/automations', icon: Zap },
        { name: 'Insights', href: '/insights', icon: BarChart3 },
      ],
    },
    {
      label: 'Marketing',
      items: [
        { name: 'Analytics', href: '/analytics', icon: LineChart },
        { name: 'Ads', href: '/ads', icon: Megaphone },
        { name: 'OpenAI Ads', href: '/openai-ads', icon: Bot },
        { name: 'Campaign Assistant', href: '/campaign-assistant', icon: Sparkles },
        { name: 'Integrations', href: '/connections', icon: Link2 },
      ],
    },
  ];

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const isActive = (path) => location.pathname === path;

  const renderNav = ({ onLinkClick } = {}) =>
    navigationSections.map((section, si) => (
      <div key={section.label || `top-${si}`} className={si === 0 ? '' : 'mt-4'}>
        {section.label && (
          <div className="px-3 pb-1 pt-1 text-[11px] font-semibold uppercase tracking-wider text-gray-400">
            {section.label}
          </div>
        )}
        <div className="space-y-1">
          {section.items.map((item) => {
            const Icon = item.icon;
            return (
              <Link
                key={item.name}
                to={item.href}
                onClick={onLinkClick}
                className={`group flex items-center px-2 py-2 text-sm font-medium rounded-md ${
                  isActive(item.href)
                    ? 'bg-primary-100 text-primary-900'
                    : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                }`}
              >
                <Icon className="mr-3 h-5 w-5" />
                {item.name}
              </Link>
            );
          })}
        </div>
      </div>
    ));

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Mobile sidebar */}
      <div className={`fixed inset-0 z-50 lg:hidden ${sidebarOpen ? 'block' : 'hidden'}`}>
        <div className="fixed inset-0 bg-gray-600 bg-opacity-75" onClick={() => setSidebarOpen(false)} />
        <div className="fixed inset-y-0 left-0 flex w-64 flex-col bg-white">
          <div className="flex h-16 items-center justify-between px-4">
            <h1 className="text-lg font-semibold text-gray-900">GMB Manager</h1>
            <button
              onClick={() => setSidebarOpen(false)}
              className="text-gray-400 hover:text-gray-600"
            >
              <X className="h-6 w-6" />
            </button>
          </div>
          <nav className="flex-1 px-2 py-4 overflow-y-auto">
            {renderNav({ onLinkClick: () => setSidebarOpen(false) })}
          </nav>
          <div className="border-t border-gray-200 p-4">
            {/* User Info */}
            <div className="flex items-center px-2 py-3 mb-3">
              <div className="flex-shrink-0">
                {user?.picture_url ? (
                  <img
                    className="h-8 w-8 rounded-full"
                    src={user.picture_url}
                    alt={user.name || 'User'}
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-gray-300 flex items-center justify-center">
                    <User className="h-5 w-5 text-gray-600" />
                  </div>
                )}
              </div>
              <div className="ml-3">
                <p className="text-sm font-medium text-gray-900">
                  {user?.name || 'User'}
                </p>
                <p className="text-xs text-gray-500">
                  {user?.email || ''}
                </p>
              </div>
            </div>
            
            <button
              onClick={handleLogout}
              className="flex w-full items-center px-2 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 rounded-md"
            >
              <LogOut className="mr-3 h-5 w-5" />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Desktop sidebar */}
      <div className="hidden lg:fixed lg:inset-y-0 lg:flex lg:w-64 lg:flex-col">
        <div className="flex flex-col flex-grow bg-white border-r border-gray-200">
          <div className="flex items-center h-16 px-4 border-b border-gray-200">
            <h1 className="text-lg font-semibold text-gray-900">GMB Manager</h1>
          </div>
          <nav className="flex-1 px-2 py-4 overflow-y-auto">
            {renderNav()}
          </nav>
          <div className="border-t border-gray-200 p-4">
            {/* User Info */}
            <div className="flex items-center px-2 py-3 mb-3">
              <div className="flex-shrink-0">
                {user?.picture_url ? (
                  <img
                    className="h-8 w-8 rounded-full"
                    src={user.picture_url}
                    alt={user.name || 'User'}
                  />
                ) : (
                  <div className="h-8 w-8 rounded-full bg-gray-300 flex items-center justify-center">
                    <User className="h-5 w-5 text-gray-600" />
                  </div>
                )}
              </div>
              <div className="ml-3">
                <p className="text-sm font-medium text-gray-900">
                  {user?.name || 'User'}
                </p>
                <p className="text-xs text-gray-500">
                  {user?.email || ''}
                </p>
              </div>
            </div>
            
            <button
              onClick={handleLogout}
              className="flex w-full items-center px-2 py-2 text-sm font-medium text-gray-600 hover:bg-gray-50 hover:text-gray-900 rounded-md"
            >
              <LogOut className="mr-3 h-5 w-5" />
              Sign out
            </button>
          </div>
        </div>
      </div>

      {/* Main content */}
      <div className="lg:pl-64">
        {/* Top bar */}
        <div className="sticky top-0 z-40 flex h-16 shrink-0 items-center gap-x-4 border-b border-gray-200 bg-white px-4 shadow-sm sm:gap-x-6 sm:px-6 lg:px-8">
          <button
            type="button"
            className="-m-2.5 p-2.5 text-gray-700 lg:hidden"
            onClick={() => setSidebarOpen(true)}
          >
            <Menu className="h-6 w-6" />
          </button>

          <div className="flex flex-1 gap-x-4 self-stretch lg:gap-x-6">
            <div className="flex flex-1"></div>
          </div>
        </div>

        {/* Page content */}
        <main className="py-6">
          <div className="mx-auto max-w-7xl px-4 sm:px-6 lg:px-8">
            {children}
          </div>
        </main>
      </div>
    </div>
  );
};

export default Layout;


