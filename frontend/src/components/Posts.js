import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import {
  FileText,
  Plus,
  Edit,
  Trash2,
  Calendar,
  Clock,
  CheckCircle,
  AlertCircle,
  Eye,
  BarChart3,
  Heart,
  MessageCircle,
  Share
} from 'lucide-react';

const Posts = () => {
  const { isAuthenticated } = useAuth();
  const [posts, setPosts] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [showCreateModal, setShowCreateModal] = useState(false);
  const [selectedProfile, setSelectedProfile] = useState('');
  
  // Pagination state
  const [currentPage, setCurrentPage] = useState(1);
  const [totalPages, setTotalPages] = useState(1);
  const [totalPosts, setTotalPosts] = useState(0);
  const [hasNext, setHasNext] = useState(false);
  const [hasPrev, setHasPrev] = useState(false);
  const [loadingMore, setLoadingMore] = useState(false);
  
  // Expanded posts state
  const [expandedPosts, setExpandedPosts] = useState(new Set());
  
  const [formData, setFormData] = useState({
    title: '',
    summary: '',
    postType: 'STANDARD',
    callToAction: {
      type: 'BOOK',
      url: ''
    },
    mediaUrls: [],
    mediaFiles: []
  });

  useEffect(() => {
    if (isAuthenticated) {
      fetchData();
    }
  }, [isAuthenticated]);

  // Auto-fetch posts when profile is selected
  useEffect(() => {
    if (selectedProfile) {
      fetchPosts(selectedProfile, 1, false);
    }
  }, [selectedProfile]);

  const fetchData = async () => {
    try {
      setLoading(true);
      // Fetch business profiles first
      const profilesResponse = await axios.get('http://localhost:3001/api/gmb/accounts');
      if (profilesResponse.data.accounts) {
        const profilesWithLocations = await Promise.all(
          profilesResponse.data.accounts.map(async (account) => {
            try {
              // Extract account ID from the full name
              const accountId = account.name.split('/').pop();
              const locationsResponse = await axios.get(
                `http://localhost:3001/api/gmb/accounts/${accountId}/locations`
              );
              
              // Add account ID to each location and create full path
              const locationsWithAccount = (locationsResponse.data.locations || []).map(location => ({
                ...location,
                accountId: accountId,
                fullPath: `accounts/${accountId}/locations/${location.name.split('/').pop()}`
              }));
              
              return {
                ...account,
                locations: locationsWithAccount
              };
            } catch (error) {
              return { ...account, locations: [] };
            }
          })
        );
        setProfiles(profilesWithLocations);
        if (profilesWithLocations.length > 0 && profilesWithLocations[0].locations.length > 0) {
          setSelectedProfile(profilesWithLocations[0].locations[0].fullPath);
        }
      }
    } catch (error) {
      console.error('Error fetching data:', error);
    } finally {
      setLoading(false);
    }
  };

  const fetchPosts = async (locationId, page = 1, append = false) => {
    if (!locationId) return;
    
    try {
      // Extract IDs from the full path: accounts/{accountId}/locations/{locationId}
      const profileParts = locationId.split('/');
      const locationIdOnly = profileParts[profileParts.length - 1];
      const accountId = profileParts[1];
      
      console.log('Fetching posts for location:', locationIdOnly, 'account:', accountId, 'page:', page);
      
      const response = await axios.get(`http://localhost:3001/api/posts/location/${locationIdOnly}?page=${page}&limit=3`, {
        headers: {
          'x-gmb-account-id': accountId
        }
      });
      
      console.log('=== FRONTEND POSTS DEBUG ===');
      console.log('Posts response:', response.data);
      console.log('Posts array:', response.data.posts);
      if (response.data.posts && response.data.posts.length > 0) {
        console.log('First post:', response.data.posts[0]);
        console.log('First post media:', response.data.posts[0].media);
        console.log('First post media type:', typeof response.data.posts[0].media);
        console.log('First post media length:', response.data.posts[0].media?.length);
        if (response.data.posts[0].media && response.data.posts[0].media.length > 0) {
          console.log('First media item:', response.data.posts[0].media[0]);
          console.log('First media item keys:', Object.keys(response.data.posts[0].media[0]));
        }
      }
      console.log('=== END FRONTEND POSTS DEBUG ===');
      
      // Handle pagination response
      if (response.data.posts && response.data.pagination) {
        if (append) {
          // Append posts for load more functionality
          setPosts(prevPosts => [...prevPosts, ...response.data.posts]);
        } else {
          // Replace posts for new page or initial load
          setPosts(response.data.posts);
        }
        
        // Update pagination state
        setCurrentPage(response.data.pagination.page);
        setTotalPages(response.data.pagination.totalPages);
        setTotalPosts(response.data.pagination.total);
        setHasNext(response.data.pagination.hasNext);
        setHasPrev(response.data.pagination.hasPrev);
      } else {
        // Fallback for old response format
        setPosts(response.data);
        setCurrentPage(1);
        setTotalPages(1);
        setTotalPosts(response.data.length);
        setHasNext(false);
        setHasPrev(false);
      }
    } catch (error) {
      console.error('Error fetching posts:', error);
    }
  };

  const handleCreatePost = async (e) => {
    e.preventDefault();
    
    // Validate media URLs
    const validMediaUrls = formData.mediaUrls.filter(url => url.trim() !== '');
    const invalidUrls = validMediaUrls.filter(url => {
      try {
        new URL(url);
        return false;
      } catch {
        return true;
      }
    });
    
    if (invalidUrls.length > 0) {
      alert('Please enter valid image URLs for all media files.');
      return;
    }
    
    try {
      // Extract account and location IDs from selectedProfile
      const profileParts = selectedProfile.split('/');
      const locationId = profileParts[profileParts.length - 1];
      const accountId = profileParts[1]; // accounts/{accountId}/locations/{locationId}
      
      // Debug the profile path structure
      console.log('Selected profile path:', selectedProfile);
      console.log('Profile parts:', profileParts);
      console.log('Extracted account ID:', accountId);
      console.log('Extracted location ID:', locationId);
      
      if (!accountId || !locationId) {
        console.error('Could not extract IDs from path:', selectedProfile);
        alert('Error: Could not determine account or location ID. Please select a different profile.');
        return;
      }
      
      // Prepare post data based on post type
      const postData = {
        platforms: ['google'],
        content: formData.summary,
        gmbAccountId: accountId,
        gmbLocationId: locationId,
        postType: formData.postType
      };

      // Add call to action for OFFER posts
      if (formData.postType === 'OFFER' && formData.callToAction.url) {
        postData.callToAction = {
          actionType: formData.callToAction.type === 'BOOK' ? 'BOOK' : 
                     formData.callToAction.type === 'ORDER' ? 'ORDER' : 
                     formData.callToAction.type === 'SHOP' ? 'SHOP' : 
                     formData.callToAction.type === 'LEARN_MORE' ? 'LEARN_MORE' : 
                     formData.callToAction.type === 'SIGN_UP' ? 'SIGN_UP' : 
                     formData.callToAction.type === 'CALL' ? 'CALL' : 'BOOK',
          url: formData.callToAction.url
        };
      }

      // Add event data for EVENT posts
      if (formData.postType === 'EVENT') {
        postData.event = {
          title: formData.title || 'Event',
          schedule: {
            startDate: {
              year: new Date().getFullYear(),
              month: new Date().getMonth() + 1,
              day: new Date().getDate()
            },
            startTime: {
              hours: 9,
              minutes: 0,
              seconds: 0,
              nanos: 0
            },
            endDate: {
              year: new Date().getFullYear(),
              month: new Date().getMonth() + 1,
              day: new Date().getDate()
            },
            endTime: {
              hours: 17,
              minutes: 0,
              seconds: 0,
              nanos: 0
            }
          }
        };
      }

      // Upload media first if provided
      const allMedia = [];
      
      // Upload local files
      if (formData.mediaFiles && formData.mediaFiles.length > 0) {
        try {
          console.log('Uploading local files...');
          const filePromises = formData.mediaFiles.map(async (file) => {
            // Convert file to base64
            const base64 = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => resolve(reader.result.split(',')[1]);
              reader.readAsDataURL(file);
            });

            const mediaResponse = await axios.post('http://localhost:3001/api/posts/media', {
              mediaFormat: 'PHOTO',
              fileData: base64,
              gmbAccountId: accountId,
              gmbLocationId: locationId,
              category: 'ADDITIONAL'
            });
            return mediaResponse.data.media;
          });

          const uploadedFiles = await Promise.all(filePromises);
          console.log('Local files uploaded successfully:', uploadedFiles);
          allMedia.push(...uploadedFiles);
        } catch (fileError) {
          console.error('Error uploading local files:', fileError);
          alert('Warning: Some local files failed to upload. Post will be created without those files.');
        }
      }

      // Upload URLs
      if (formData.mediaUrls.length > 0) {
        try {
          console.log('Uploading media URLs...');
          const urlPromises = formData.mediaUrls
            .filter(url => url.trim() !== '') // Filter out empty URLs
            .map(async (url) => {
              const mediaResponse = await axios.post('http://localhost:3001/api/posts/media', {
                mediaFormat: 'PHOTO',
                sourceUrl: url,
                gmbAccountId: accountId,
                gmbLocationId: locationId,
                category: 'ADDITIONAL'
              });
              return mediaResponse.data.media;
            });

          const uploadedUrls = await Promise.all(urlPromises);
          console.log('URLs uploaded successfully:', uploadedUrls);
          allMedia.push(...uploadedUrls);
        } catch (urlError) {
          console.error('Error uploading URLs:', urlError);
          alert('Warning: Some URLs failed to upload. Post will be created without those images.');
        }
      }

      // Add all uploaded media to post data
      if (allMedia.length > 0) {
        postData.media = allMedia.map(media => ({
          mediaFormat: media.mediaFormat,
          sourceUrl: media.sourceUrl
        }));
      }

      console.log('Sending post data:', postData);
      
      const response = await axios.post('http://localhost:3001/api/posts', postData);
      
      // Refresh posts list and reset to first page
      setCurrentPage(1);
      setExpandedPosts(new Set()); // Reset expanded posts when creating new post
      await fetchPosts(selectedProfile, 1, false);
      
      // Reset form and close modal
      setFormData({
        title: '',
        summary: '',
        postType: 'STANDARD',
        callToAction: { type: 'BOOK', url: '' },
        mediaUrls: [],
        mediaFiles: []
      });
      setShowCreateModal(false);
      
      alert('Post created successfully!');
    } catch (error) {
      console.error('Error creating post:', error);
      alert('Failed to create post. Please try again.');
    }
  };

  const handleDeletePost = async (postId) => {
    if (!window.confirm('Are you sure you want to delete this post?')) return;
    
    try {
      await axios.delete(`http://localhost:3001/api/posts/${postId}`);
      await fetchPosts(selectedProfile);
      alert('Post deleted successfully!');
    } catch (error) {
      console.error('Error deleting post:', error);
      alert('Failed to delete post. Please try again.');
    }
  };

  const handleLoadMore = async () => {
    if (!hasNext || loadingMore) return;
    
    setLoadingMore(true);
    try {
      await fetchPosts(selectedProfile, currentPage + 1, true);
    } catch (error) {
      console.error('Error loading more posts:', error);
    } finally {
      setLoadingMore(false);
    }
  };

  const handlePageChange = async (newPage) => {
    if (newPage < 1 || newPage > totalPages) return;
    
    setCurrentPage(newPage);
    await fetchPosts(selectedProfile, newPage, false);
  };

  // Helper function to truncate text to first sentence
  const truncateToFirstSentence = (text, maxLength = 150) => {
    if (!text) return '';
    
    // Find the first sentence (ends with ., !, or ?)
    const firstSentenceMatch = text.match(/^[^.!?]+[.!?]/);
    if (firstSentenceMatch) {
      const firstSentence = firstSentenceMatch[0];
      return firstSentence.length <= maxLength ? firstSentence : firstSentence.substring(0, maxLength) + '...';
    }
    
    // If no sentence ending found, truncate by length
    return text.length <= maxLength ? text : text.substring(0, maxLength) + '...';
  };

  // Toggle expanded state for a post
  const toggleExpanded = (postId) => {
    setExpandedPosts(prev => {
      const newSet = new Set(prev);
      if (newSet.has(postId)) {
        newSet.delete(postId);
      } else {
        newSet.add(postId);
      }
      return newSet;
    });
  };

  const getPostTypeIcon = (type) => {
    switch (type) {
      case 'STANDARD':
        return <FileText className="h-4 w-4" />;
      case 'OFFER':
        return <FileText className="h-4 w-4" />;
      case 'EVENT':
        return <Calendar className="h-4 w-4" />;
      case 'PRODUCT':
        return <FileText className="h-4 w-4" />;
      default:
        return <FileText className="h-4 w-4" />;
    }
  };

  const getStatusColor = (status) => {
    switch (status) {
      case 'published':
        return 'bg-green-100 text-green-800';
      case 'draft':
        return 'bg-gray-100 text-gray-800';
      case 'scheduled':
        return 'bg-blue-100 text-blue-800';
      default:
        return 'bg-gray-100 text-gray-800';
    }
  };

  if (!isAuthenticated) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="text-center">
          <p className="text-gray-500">Please log in to view posts</p>
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
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-gray-900">Posts</h1>
          <p className="mt-1 text-sm text-gray-500">
            Create and manage posts for your business profiles
          </p>
        </div>
        <button
          onClick={() => setShowCreateModal(true)}
          className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700"
        >
          <Plus className="h-4 w-4 mr-2" />
          Create Post
        </button>
      </div>

      {/* Profile Selector */}
      <div className="bg-white shadow rounded-lg p-6">
        <label htmlFor="profile-select" className="block text-sm font-medium text-gray-700 mb-2">
          Select Business Profile
        </label>
        <select
          id="profile-select"
          value={selectedProfile}
          onChange={(e) => {
            setSelectedProfile(e.target.value);
            setCurrentPage(1); // Reset to first page when changing profiles
            setExpandedPosts(new Set()); // Reset expanded posts when changing profiles
            fetchPosts(e.target.value, 1, false);
          }}
          className="block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
        >
          <option value="">Select a profile...</option>
          {profiles.map((profile) =>
            profile.locations.map((location) => (
              <option key={location.fullPath} value={location.fullPath}>
                {profile.accountName} - {location.title || 'Untitled Location'}
              </option>
            ))
          )}
        </select>
      </div>

      {/* Posts List */}
      {selectedProfile && (
        <div className="bg-white shadow rounded-lg">
          <div className="px-6 py-4 border-b border-gray-200">
            <div className="flex items-center justify-between">
            <h2 className="text-lg font-medium text-gray-900">Posts</h2>
            <button
              onClick={() => {
                setCurrentPage(1);
                setExpandedPosts(new Set()); // Reset expanded posts when refreshing
                fetchPosts(selectedProfile, 1, false);
              }}
              className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
            >
              <Clock className="h-4 w-4 mr-1" />
              Refresh Posts
            </button>
          </div>
          </div>
          <div className="p-6">
            {posts.length > 0 ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
                  {posts.map((post) => (
                    <div key={post.id} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden">
                      {/* Post Header with Action Buttons */}
                      <div className="flex items-center justify-end p-3 bg-gray-50">
                        {/* Action Buttons */}
                        <div className="flex items-center space-x-2">
                          <button
                            onClick={() => {/* Handle edit */}}
                            className="text-gray-400 hover:text-gray-600 p-1 rounded hover:bg-gray-100"
                            title="Edit post"
                          >
                            <Edit className="h-4 w-4" />
                          </button>
                          <button
                            onClick={() => handleDeletePost(post.id)}
                            className="text-red-400 hover:text-red-600 p-1 rounded hover:bg-red-50"
                            title="Delete post"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                      </div>

                      {/* Media Display - Image on Top */}
                      {post.media && post.media.length > 0 ? (
                        <div>
                          <div className="grid grid-cols-1 gap-0">
                            {post.media.map((mediaItem) => (
                              <div key={mediaItem.id} className="relative group">
                                <img
                                  src={mediaItem.sourceUrl || mediaItem.thumbnailUrl}
                                  alt={mediaItem.altText || 'Post image'}
                                  className="w-full h-48 object-cover shadow-sm"
                                  onError={(e) => {
                                    e.target.style.display = 'none';
                                    e.target.nextSibling.style.display = 'flex';
                                  }}
                                />
                                <div className="hidden absolute inset-0 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                  Image not available
                                </div>
                                {mediaItem.mediaFormat === 'VIDEO' && (
                                  <div className="absolute top-2 right-2 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded">
                                    VIDEO
                                  </div>
                                )}
                              </div>
                            ))}
                          </div>
                        </div>
                      ) : (
                        <div className="mb-4 text-sm text-gray-500 text-center py-8 bg-gray-50 rounded-lg">
                          No media attached to this post
                        </div>
                      )}

                      {/* Post Content - Text Below Image */}
                      <div className="p-3">
                        <div className="text-sm text-gray-900 mb-3">
                          {expandedPosts.has(post.id) ? (
                            <div>
                              <p>{post.content}</p>
                              <button
                                onClick={() => toggleExpanded(post.id)}
                                className="text-primary-600 hover:text-primary-700 font-medium mt-2 text-sm"
                              >
                                Show less
                              </button>
                            </div>
                          ) : (
                            <div>
                              <p>{truncateToFirstSentence(post.content)}</p>
                              {post.content && post.content.length > 150 && (
                                <button
                                  onClick={() => toggleExpanded(post.id)}
                                  className="text-primary-600 hover:text-primary-700 font-medium mt-2 text-sm"
                                >
                                  ...more
                                </button>
                              )}
                            </div>
                          )}
                        </div>

                        {/* Post Footer with Date and Status */}
                        <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-100">
                          <span className="flex items-center">
                            <Clock className="h-4 w-4 mr-1" />
                            {post.createdAt ? new Date(post.createdAt).toLocaleDateString() : 'Date not available'}
                          </span>
                          {post.status === 'published' && (
                            <span className="flex items-center">
                              <CheckCircle className="h-4 w-4 mr-1" />
                              Published
                            </span>
                          )}
                        </div>


                      </div>
                    </div>
                  ))}
                </div>
                
                {/* Load More Section */}
                <div className="px-6 py-4 border-t border-gray-200 mt-6">
                  <div className="flex items-center justify-between">
                    <div className="text-sm text-gray-700">
                      <span>Showing {posts.length} of {totalPosts} posts</span>
                    </div>
                    
                    {/* Load More Button */}
                    {hasNext && (
                      <button
                        onClick={handleLoadMore}
                        disabled={loadingMore}
                        className="inline-flex items-center px-4 py-2 border border-transparent shadow-sm text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 disabled:opacity-50 disabled:cursor-not-allowed"
                      >
                        {loadingMore ? (
                          <>
                            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-white mr-2"></div>
                            Loading...
                          </>
                        ) : (
                          <>
                            <Plus className="h-4 w-4 mr-2" />
                            Load More
                          </>
                        )}
                      </button>
                    )}
                  </div>
                </div>
              </>
            ) : (
              <div className="col-span-full px-6 py-12 text-center">
                <FileText className="mx-auto h-16 w-16 text-gray-400" />
                <h3 className="mt-4 text-lg font-medium text-gray-900">No posts yet</h3>
                <p className="mt-2 text-sm text-gray-500 max-w-md mx-auto">
                  Get started by creating your first post for this location. Your posts will appear here in a beautiful grid layout.
                </p>
                <div className="mt-6">
                  <button
                    onClick={() => setShowCreateModal(true)}
                    className="inline-flex items-center px-6 py-3 border border-transparent shadow-sm text-base font-medium rounded-lg text-white bg-primary-600 hover:bg-primary-700 transition-colors duration-200"
                  >
                    <Plus className="h-5 w-5 mr-2" />
                    Create Your First Post
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Create Post Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-20 mx-auto p-5 border w-96 shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <h3 className="text-lg font-medium text-gray-900 mb-4">Create New Post</h3>
              <form onSubmit={handleCreatePost} className="space-y-4">
                <div>
                  <label className="block text-sm font-medium text-gray-700">Post Type</label>
                  <select
                    value={formData.postType}
                    onChange={(e) => setFormData({ ...formData, postType: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  >
                    <option value="STANDARD">Standard Post</option>
                    <option value="OFFER">Offer</option>
                    <option value="EVENT">Event</option>
                    <option value="PRODUCT">Product</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700">Title</label>
                  <input
                    type="text"
                    value={formData.title}
                    onChange={(e) => setFormData({ ...formData, title: e.target.value })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    required
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700">Summary</label>
                  <textarea
                    value={formData.summary}
                    onChange={(e) => setFormData({ ...formData, summary: e.target.value })}
                    rows={3}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    required
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700">Call to Action Type</label>
                  <select
                    value={formData.callToAction.type}
                    onChange={(e) => setFormData({
                      ...formData,
                      callToAction: { ...formData.callToAction, type: e.target.value }
                    })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  >
                    <option value="BOOK">Book</option>
                    <option value="ORDER">Order</option>
                    <option value="SHOP">Shop</option>
                    <option value="LEARN_MORE">Learn More</option>
                  </select>
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700">Call to Action URL</label>
                  <input
                    type="url"
                    value={formData.callToAction.url}
                    onChange={(e) => setFormData({
                      ...formData,
                      callToAction: { ...formData.callToAction, url: e.target.value }
                    })}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  />
                </div>
                
                <div>
                  <label className="block text-sm font-medium text-gray-700">Add Pictures</label>
                  
                  {/* File Upload Section */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Upload Local Files</label>
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                      onChange={(e) => {
                        const files = Array.from(e.target.files);
                        const newFiles = [...(formData.mediaFiles || []), ...files];
                        setFormData({ ...formData, mediaFiles: newFiles });
                      }}
                      className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                    />
                    {formData.mediaFiles && formData.mediaFiles.length > 0 && (
                      <div className="mt-2 space-y-2">
                        {formData.mediaFiles.map((file, index) => (
                          <div key={index} className="flex items-center space-x-2 text-sm">
                            <span className="text-gray-600">{file.name}</span>
                            <button
                              type="button"
                              onClick={() => {
                                const newFiles = formData.mediaFiles.filter((_, i) => i !== index);
                                setFormData({ ...formData, mediaFiles: newFiles });
                              }}
                              className="text-red-500 hover:text-red-700"
                            >
                              Remove
                            </button>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                  
                  {/* URL Input Section */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Or Add Picture URLs</label>
                    <div className="space-y-2">
                      {formData.mediaUrls.map((url, index) => (
                        <div key={index} className="flex items-center space-x-2">
                          <input
                            type="url"
                            value={url}
                            onChange={(e) => {
                              const newUrls = [...formData.mediaUrls];
                              newUrls[index] = e.target.value;
                              setFormData({ ...formData, mediaUrls: newUrls });
                            }}
                            placeholder="https://example.com/image.jpg"
                            className="flex-1 border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                          />
                          <button
                            type="button"
                            onClick={() => {
                              const newUrls = formData.mediaUrls.filter((_, i) => i !== index);
                              setFormData({ ...formData, mediaUrls: newUrls });
                            }}
                            className="text-red-500 hover:text-red-700"
                          >
                            Remove
                          </button>
                        </div>
                      ))}
                      <button
                        type="button"
                        onClick={() => setFormData({
                          ...formData,
                          mediaUrls: [...formData.mediaUrls, '']
                        })}
                        className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
                      >
                        + Add Picture URL
                      </button>
                    </div>
                  </div>
                  
                  {/* Combined Preview */}
                  {(formData.mediaUrls.filter(url => url.trim() !== '').length > 0 || (formData.mediaFiles && formData.mediaFiles.length > 0)) && (
                    <div className="mt-3">
                      <label className="block text-sm font-medium text-gray-700 mb-2">Preview</label>
                      <div className="grid grid-cols-2 gap-2">
                        {/* URL Previews */}
                        {formData.mediaUrls
                          .filter(url => url.trim() !== '')
                          .map((url, index) => (
                            <div key={`url-${index}`} className="relative">
                              <img
                                src={url}
                                alt={`URL Preview ${index + 1}`}
                                className="w-full h-24 object-cover rounded border"
                                onError={(e) => {
                                  e.target.style.display = 'none';
                                  e.target.nextSibling.style.display = 'block';
                                }}
                              />
                              <div className="hidden w-full h-24 bg-gray-200 rounded border flex items-center justify-center text-xs text-gray-500">
                                Invalid URL
                              </div>
                            </div>
                          ))}
                        
                        {/* File Previews */}
                        {formData.mediaFiles && formData.mediaFiles.map((file, index) => (
                          <div key={`file-${index}`} className="relative">
                            <img
                              src={URL.createObjectURL(file)}
                              alt={`File Preview ${index + 1}`}
                              className="w-full h-24 object-cover rounded border"
                            />
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
                
                <div className="flex justify-end space-x-3 pt-4">
                  <button
                    type="button"
                    onClick={() => setShowCreateModal(false)}
                    className="px-4 py-2 border border-gray-300 rounded-md text-sm font-medium text-gray-700 hover:bg-gray-50"
                  >
                    Cancel
                  </button>
                  <button
                    type="submit"
                    className="px-4 py-2 border border-transparent rounded-md shadow-sm text-sm font-medium text-white bg-primary-600 hover:bg-primary-700"
                  >
                    Create Post
                  </button>
                </div>
              </form>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Posts;
