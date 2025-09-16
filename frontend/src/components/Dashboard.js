import React, { useState, useEffect } from 'react';
import { Link } from 'react-router-dom';
import axios from '../utils/axiosConfig';
import { useAuth } from '../contexts/AuthContext';
import {
  Building2,
  FileText,
  MessageSquare,
  BarChart3,
  Plus,
  TrendingUp,
  Users,
  Eye
} from 'lucide-react';

const Dashboard = () => {
  const { isAuthenticated } = useAuth();
  const [stats, setStats] = useState({
    totalProfiles: 0,
    totalPosts: 0,
    totalReviews: 0,
    totalViews: 0
  });
  const [recentPosts, setRecentPosts] = useState([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (isAuthenticated) {
      fetchDashboardData();
    }
  }, [isAuthenticated]);

  const fetchDashboardData = async () => {
    try {
      setLoading(true);
      // Fetch dashboard data from API
      // This would typically include stats, recent posts, etc.
      
      // Mock data for now
      setStats({
        totalProfiles: 3,
        totalPosts: 12,
        totalReviews: 45,
        totalViews: 1250
      });
      
      setRecentPosts([
        {
          id: 1,
          title: 'New Product Launch',
          type: 'UPDATE',
          status: 'published',
          publishedAt: '2024-01-15T10:30:00Z'
        },
        {
          id: 2,
          title: 'Special Offer - 20% Off',
          type: 'OFFER',
          status: 'published',
          publishedAt: '2024-01-14T15:45:00Z'
        }
      ]);
    } catch (error) {
      console.error('Error fetching dashboard data:', error);
    } finally {
      setLoading(false);
    }
  };

  const statCards = [
    {
      name: 'Business Profiles',
      value: stats.totalProfiles,
      icon: Building2,
      color: 'bg-blue-500',
      href: '/profiles'
    },
    {
      name: 'Total Posts',
      value: stats.totalPosts,
      icon: FileText,
      color: 'bg-green-500',
      href: '/posts'
    },
    {
      name: 'Reviews',
      value: stats.totalReviews,
      icon: MessageSquare,
      color: 'bg-yellow-500',
      href: '/reviews'
    },
    {
      name: 'Total Views',
      value: stats.totalViews.toLocaleString(),
      icon: Eye,
      color: 'bg-purple-500',
      href: '/insights'
    }
  ];

  const quickActions = [
    {
      name: 'Create Post',
      description: 'Share updates with your customers',
      icon: Plus,
      href: '/posts',
      color: 'bg-primary-600 hover:bg-primary-700'
    },
    {
      name: 'View Insights',
      description: 'Check your business performance',
      icon: BarChart3,
      href: '/insights',
      color: 'bg-green-600 hover:bg-green-700'
    },
    {
      name: 'Manage Reviews',
      description: 'Respond to customer feedback',
      icon: MessageSquare,
      href: '/reviews',
      color: 'bg-yellow-600 hover:bg-yellow-700'
    }
  ];

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view dashboard</p>
        </div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="animate-spin rounded-full h-12 w-12 border-b-2 border-primary-600"></div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div>
        <h1 className="text-2xl font-bold text-gray-900">Dashboard</h1>
        <p className="mt-1 text-sm text-gray-500">
          Welcome back! Here's what's happening with your business profiles.
        </p>
      </div>

      {/* Stats Grid */}
      <div className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-4">
        {statCards.map((stat) => {
          const Icon = stat.icon;
          return (
            <Link
              key={stat.name}
              to={stat.href}
              className="bg-white overflow-hidden shadow rounded-lg hover:shadow-md transition-shadow duration-200"
            >
              <div className="p-5">
                <div className="flex items-center">
                  <div className="flex-shrink-0">
                    <div className={`${stat.color} rounded-md p-3`}>
                      <Icon className="h-6 w-6 text-white" />
                    </div>
                  </div>
                  <div className="ml-5 w-0 flex-1">
                    <dl>
                      <dt className="text-sm font-medium text-gray-500 truncate">
                        {stat.name}
                      </dt>
                      <dd className="text-lg font-medium text-gray-900">
                        {stat.value}
                      </dd>
                    </dl>
                  </div>
                </div>
              </div>
            </Link>
          );
        })}
      </div>

      {/* Quick Actions */}
      <div>
        <h2 className="text-lg font-medium text-gray-900 mb-4">Quick Actions</h2>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
          {quickActions.map((action) => {
            const Icon = action.icon;
            return (
              <Link
                key={action.name}
                to={action.href}
                className={`${action.color} text-white rounded-lg p-6 hover:shadow-lg transition-all duration-200`}
              >
                <div className="flex items-center">
                  <Icon className="h-8 w-8 mr-4" />
                  <div>
                    <h3 className="text-lg font-medium">{action.name}</h3>
                    <p className="text-primary-100 text-sm mt-1">
                      {action.description}
                    </p>
                  </div>
                </div>
              </Link>
            );
          })}
        </div>
      </div>

      {/* Recent Activity */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">Recent Posts</h2>
        </div>
        <div className="divide-y divide-gray-200">
          {recentPosts.length > 0 ? (
            recentPosts.map((post) => (
              <div key={post.id} className="px-6 py-4">
                <div className="flex items-center justify-between">
                  <div className="flex items-center">
                    <div className="flex-shrink-0">
                      <div className="h-8 w-8 bg-primary-100 rounded-full flex items-center justify-center">
                        <FileText className="h-4 w-4 text-primary-600" />
                      </div>
                    </div>
                    <div className="ml-4">
                      <p className="text-sm font-medium text-gray-900">{post.title}</p>
                      <p className="text-sm text-gray-500">
                        {post.type} • {new Date(post.publishedAt).toLocaleDateString()}
                      </p>
                    </div>
                  </div>
                  <div className="flex items-center">
                    <span className={`inline-flex items-center px-2.5 py-0.5 rounded-full text-xs font-medium ${
                      post.status === 'published' 
                        ? 'bg-green-100 text-green-800' 
                        : 'bg-yellow-100 text-yellow-800'
                    }`}>
                      {post.status}
                    </span>
                  </div>
                </div>
              </div>
            ))
          ) : (
            <div className="px-6 py-8 text-center">
              <FileText className="mx-auto h-12 w-12 text-gray-400" />
              <h3 className="mt-2 text-sm font-medium text-gray-900">No posts yet</h3>
              <p className="mt-1 text-sm text-gray-500">
                Get started by creating your first post.
              </p>
              <div className="mt-6">
                <Link
                  to="/posts"
                  className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
                >
                  <Plus className="h-4 w-4 mr-2" />
                  Create Post
                </Link>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Performance Overview */}
      <div className="bg-white shadow rounded-lg">
        <div className="px-6 py-4 border-b border-gray-200">
          <h2 className="text-lg font-medium text-gray-900">Performance Overview</h2>
        </div>
        <div className="p-6">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
            <div className="text-center">
              <div className="text-2xl font-bold text-primary-600">
                {stats.totalViews.toLocaleString()}
              </div>
              <div className="text-sm text-gray-500">Total Views</div>
              <div className="flex items-center justify-center mt-1 text-green-600 text-sm">
                <TrendingUp className="h-4 w-4 mr-1" />
                +12% from last month
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-green-600">
                {stats.totalReviews}
              </div>
              <div className="text-sm text-gray-500">Customer Reviews</div>
              <div className="flex items-center justify-center mt-1 text-green-600 text-sm">
                <TrendingUp className="h-4 w-4 mr-1" />
                +8% from last month
              </div>
            </div>
            <div className="text-center">
              <div className="text-2xl font-bold text-yellow-600">
                {stats.totalPosts}
              </div>
              <div className="text-sm text-gray-500">Active Posts</div>
              <div className="flex items-center justify-center mt-1 text-green-600 text-sm">
                <TrendingUp className="h-4 w-4 mr-1" />
                +15% from last month
              </div>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

export default Dashboard;
