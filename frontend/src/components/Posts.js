import React, { useState, useEffect } from 'react';
import axios from 'axios';
import { useAuth } from '../contexts/AuthContext';
import ImageUploader from './react_imgbb_uploader.js';
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
  const [showImageUploaderModal, setShowImageUploaderModal] = useState(false);
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
  
  // Delete loading state
  const [deletingPosts, setDeletingPosts] = useState(new Set());
  
  // Notification state
  const [notification, setNotification] = useState(null);
  
  const [formData, setFormData] = useState({
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
          console.log('First media item sourceUrl:', response.data.posts[0].media[0].sourceUrl);
          console.log('First media item url:', response.data.posts[0].media[0].url);
          console.log('First media item thumbnailUrl:', response.data.posts[0].media[0].thumbnailUrl);
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
    console.log('=== FORM SUBMISSION STARTED ===');
    console.log('Form data:', formData);
    
    // Validate media URLs
    const validMediaUrls = formData.mediaUrls.filter(url => url.trim() !== '');
    console.log('=== URL VALIDATION DEBUG ===');
    console.log('All media URLs:', formData.mediaUrls);
    console.log('Valid media URLs:', validMediaUrls);
    
    const invalidUrls = validMediaUrls.filter(url => {
      try {
        new URL(url);
        console.log('Valid URL:', url);
        return false;
      } catch (error) {
        console.log('Invalid URL:', url, 'Error:', error.message);
        return true;
      }
    });
    
    if (invalidUrls.length > 0) {
      console.log('Invalid URLs found:', invalidUrls);
      alert('Please enter valid image URLs for all media files.');
      return;
    }
    console.log('=== END URL VALIDATION DEBUG ===');
    
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
         content: formData.summary, // This maps to the backend 'content' field
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
          title: 'Event',
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
      console.log('=== CHECKING MEDIA FILES ===');
      console.log('formData.mediaFiles:', formData.mediaFiles);
      console.log('formData.mediaFiles type:', typeof formData.mediaFiles);
      console.log('formData.mediaFiles length:', formData.mediaFiles?.length);
      console.log('formData.mediaFiles truthy check:', !!formData.mediaFiles);
      console.log('formData.mediaFiles length > 0 check:', formData.mediaFiles?.length > 0);
      
      if (formData.mediaFiles && formData.mediaFiles.length > 0) {
        try {
          console.log('=== LOCAL FILE UPLOAD DEBUG ===');
          console.log('Number of files to upload:', formData.mediaFiles.length);
          console.log('Files to upload:', formData.mediaFiles.map(f => ({ name: f.name, size: f.size, type: f.type })));
          
          const filePromises = formData.mediaFiles.map(async (file, index) => {
            console.log(`Processing file ${index + 1}:`, file.name);
            
            // Convert file to base64
            const base64 = await new Promise((resolve) => {
              const reader = new FileReader();
              reader.onload = () => {
                const result = reader.result.split(',')[1];
                console.log(`File ${file.name} converted to base64, length:`, result.length);
                resolve(result);
              };
              reader.readAsDataURL(file);
            });

            console.log(`Sending file ${file.name} to backend...`);
            const mediaResponse = await axios.post('http://localhost:3001/api/posts/media', {
              mediaFormat: 'PHOTO',
              fileData: base64,
              gmbAccountId: accountId,
              gmbLocationId: locationId,
              category: 'ADDITIONAL'
            });
            
            console.log(`File ${file.name} upload response:`, mediaResponse.data);
            return mediaResponse.data.media;
          });

          const uploadedFiles = await Promise.all(filePromises);
          console.log('=== LOCAL FILE UPLOAD SUCCESS ===');
          console.log('All local files uploaded successfully:', uploadedFiles);
          console.log('Uploaded files structure:', uploadedFiles.map(f => ({ name: f.name, mediaFormat: f.mediaFormat, sourceUrl: f.sourceUrl })));
          allMedia.push(...uploadedFiles);
          console.log('=== END LOCAL FILE UPLOAD DEBUG ===');
        } catch (fileError) {
          console.error('=== LOCAL FILE UPLOAD ERROR ===');
          console.error('Error uploading local files:', fileError);
          console.error('Error response:', fileError.response?.data);
          console.error('Error status:', fileError.response?.status);
          alert('Warning: Some local files failed to upload. Post will be created without those files.');
        }
      }

      // Upload URLs
      if (formData.mediaUrls.length > 0) {
        try {
          console.log('=== URL UPLOAD DEBUG ===');
          console.log('URLs to upload:', formData.mediaUrls);
          const validUrls = formData.mediaUrls.filter(url => url.trim() !== '');
          console.log('Valid URLs:', validUrls);
          
          const urlPromises = validUrls.map(async (url, index) => {
            console.log(`Processing URL ${index + 1}:`, url);
            try {
              const mediaResponse = await axios.post('http://localhost:3001/api/posts/media', {
                mediaFormat: 'PHOTO',
                sourceUrl: url,
                gmbAccountId: accountId,
                gmbLocationId: locationId,
                category: 'ADDITIONAL'
              });
              console.log(`URL ${index + 1} upload response:`, mediaResponse.data);
              return mediaResponse.data.media;
            } catch (error) {
              console.error(`URL ${index + 1} upload failed:`, error.response?.data || error.message);
              throw error;
            }
          });

          const uploadedUrls = await Promise.all(urlPromises);
          console.log('=== URL UPLOAD SUCCESS ===');
          console.log('URLs uploaded successfully:', uploadedUrls);
          console.log('Uploaded URLs structure:', uploadedUrls.map(u => ({ name: u.name, mediaFormat: u.mediaFormat, sourceUrl: u.sourceUrl })));
          allMedia.push(...uploadedUrls);
          console.log('=== END URL UPLOAD DEBUG ===');
        } catch (urlError) {
          console.error('=== URL UPLOAD ERROR ===');
          console.error('Error uploading URLs:', urlError);
          console.error('Error response:', urlError.response?.data);
          console.error('Error status:', urlError.response?.status);
          alert('Warning: Some URLs failed to upload. Post will be created without those images.');
        }
      }

             // Add all uploaded media to post data
       console.log('=== FRONTEND MEDIA DEBUG ===');
       console.log('All media array before mapping:', allMedia);
       console.log('All media array length:', allMedia.length);
       
       if (allMedia.length > 0) {
         // Use only real media
         postData.media = allMedia.map(media => {
           const mappedMedia = {
             mediaFormat: media.mediaFormat,
             sourceUrl: media.sourceUrl
           };
           console.log('Mapped media item:', mappedMedia);
           return mappedMedia;
         });
         console.log('Final postData.media array:', postData.media);
       } else {
         // No media to add
         console.log('No media to add to post data');
       }
       console.log('=== END FRONTEND MEDIA DEBUG ===');

      console.log('Sending post data:', postData);
      console.log('Post data structure:', {
        platforms: postData.platforms,
        content: postData.content,
        gmbAccountId: postData.gmbAccountId,
        gmbLocationId: postData.gmbLocationId,
        postType: postData.postType,
        hasMedia: !!postData.media
      });
      
      const response = await axios.post('http://localhost:3001/api/posts', postData);
      console.log('=== POST CREATION RESPONSE ===');
      console.log('Response status:', response.status);
      console.log('Response data:', response.data);
      
      // Refresh posts list and reset to first page
      console.log('=== REFRESHING POSTS ===');
      setCurrentPage(1);
      setExpandedPosts(new Set()); // Reset expanded posts when creating new post
      await fetchPosts(selectedProfile, 1, false);
      console.log('=== POSTS REFRESHED ===');
      
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
    // Get post content for confirmation
    const post = posts.find(p => p.id === postId);
    const postContent = post?.content || 'this post';
    
    if (!window.confirm(`Are you sure you want to delete "${postContent.substring(0, 50)}${postContent.length > 50 ? '...' : ''}"?\n\nThis action cannot be undone.`)) return;
    
    try {
      // Set loading state for this specific post
      setDeletingPosts(prev => new Set(prev).add(postId));
      
      // Extract account and location IDs from selectedProfile
      const profileParts = selectedProfile.split('/');
      const locationId = profileParts[profileParts.length - 1];
      const accountId = profileParts[1]; // accounts/{accountId}/locations/{locationId}
      
      if (!accountId || !locationId) {
        alert('Error: Could not determine account or location ID. Please select a different profile.');
        return;
      }
      
      await axios.delete(`http://localhost:3001/api/posts/${postId}`, {
        params: {
          gmbAccountId: accountId,
          gmbLocationId: locationId
        }
      });
      
      // Refresh the current page of posts
      await fetchPosts(selectedProfile, currentPage, false);
      showNotification('Post deleted successfully!', 'success');
    } catch (error) {
      console.error('Error deleting post:', error);
      if (error.response?.data?.error) {
        showNotification(`Failed to delete post: ${error.response.data.error}`, 'error');
      } else {
        showNotification('Failed to delete post. Please try again.', 'error');
      }
    } finally {
      // Clear loading state
      setDeletingPosts(prev => {
        const newSet = new Set(prev);
        newSet.delete(postId);
        return newSet;
      });
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

  // Helper function to validate URL
  const isValidUrl = (string) => {
    try {
      new URL(string);
      return true;
    } catch (_) {
      return false;
    }
  };

  // Show notification
  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

  // Handle adding uploaded image URL to form
  const handleImageUploaded = (imageUrl) => {
    setFormData(prev => ({
      ...prev,
      mediaUrls: [...prev.mediaUrls, imageUrl]
    }));
    setShowImageUploaderModal(false);
    showNotification('Image uploaded successfully! You can now add it to your post.', 'success');
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
      {/* Notification */}
      {notification && (
        <div className={`p-4 rounded-md ${
          notification.type === 'success' 
            ? 'bg-green-50 border border-green-200 text-green-800' 
            : 'bg-red-50 border border-red-200 text-red-800'
        }`}>
          <div className="flex items-center justify-between">
            <span>{notification.message}</span>
            <button
              onClick={() => setNotification(null)}
              className="text-gray-400 hover:text-gray-600"
            >
              ×
            </button>
            </div>
        </div>
      )}
      
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

      {/* Image Uploader Section */}
      <div className="bg-white shadow rounded-lg p-6">
        <div className="flex items-center justify-between mb-4">
          <div>
            <h2 className="text-lg font-medium text-gray-900">Image Uploader</h2>
            <p className="text-sm text-gray-500">Upload images to ImgBB for your posts</p>
          </div>
          <button
            onClick={() => setShowImageUploaderModal(true)}
            className="inline-flex items-center px-3 py-2 border border-primary-300 shadow-sm text-sm font-medium rounded-md text-primary-700 bg-primary-50 hover:bg-primary-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            <Plus className="h-4 w-4 mr-2" />
            Open Uploader
          </button>
        </div>
        
                 {/* Quick Upload Preview */}
         <div className="bg-gray-50 rounded-lg p-4">
           <p className="text-sm text-gray-600 mb-3">
             Use the ImgBB image uploader to get direct URLs for your posts. Uploaded images will be automatically added to your next post.
           </p>
           
           {/* Quick URL Input */}
           <div className="mb-4 p-3 bg-white rounded border">
             <label className="block text-sm font-medium text-gray-700 mb-2">Quick Add Image URL</label>
             <div className="flex gap-2">
               <input
                 type="url"
                 placeholder="https://example.com/image.jpg"
                 className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500 text-sm"
                 onKeyPress={(e) => {
                   if (e.key === 'Enter') {
                     e.preventDefault();
                     const url = e.target.value.trim();
                     if (url && isValidUrl(url)) {
                       setFormData(prev => ({
                         ...prev,
                         mediaUrls: [...prev.mediaUrls, url]
                       }));
                       e.target.value = '';
                     }
                   }
                 }}
               />
               <button
                 onClick={(e) => {
                   const input = e.target.previousElementSibling;
                   const url = input.value.trim();
                   if (url && isValidUrl(url)) {
                     setFormData(prev => ({
                       ...prev,
                       mediaUrls: [...prev.mediaUrls, url]
                     }));
                     input.value = '';
                   }
                 }}
                 className="px-3 py-2 bg-blue-500 text-white rounded-md hover:bg-blue-600 text-sm"
               >
                 Add
               </button>
             </div>
             <p className="text-xs text-gray-500 mt-1">
               Press Enter or click Add to quickly add an image URL to your post
             </p>
           </div>
           
           {/* Uploaded Images Display */}
           {formData.mediaUrls.length > 0 ? (
             <div className="space-y-3">
               <div className="flex items-center justify-between">
                 <span className="text-sm font-medium text-gray-700">
                   {formData.mediaUrls.length} image(s) ready for next post
                 </span>
                 <button
                   onClick={() => setFormData(prev => ({ ...prev, mediaUrls: [] }))}
                   className="px-3 py-1 text-sm text-red-600 hover:text-red-700 hover:bg-red-50 rounded-md"
                 >
                   Clear All
                 </button>
               </div>
               
                               {/* Image Grid */}
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {formData.mediaUrls.map((url, index) => (
                    <div key={index} className="bg-white rounded border p-3">
                      <div className="relative group mb-2">
                        <img
                          src={url}
                          alt={`Uploaded image ${index + 1}`}
                          className="w-full h-32 object-cover rounded border shadow-sm"
                          onError={(e) => {
                            e.target.style.display = 'none';
                            e.target.nextSibling.style.display = 'flex';
                          }}
                        />
                        <div className="hidden w-full h-32 bg-gray-200 rounded border flex items-center justify-center text-xs text-gray-500">
                          Invalid URL
                        </div>
                        
                        {/* Remove button */}
                        <button
                          onClick={() => {
                            const newUrls = formData.mediaUrls.filter((_, i) => i !== index);
                            setFormData(prev => ({ ...prev, mediaUrls: newUrls }));
                          }}
                          className="absolute -top-2 -right-2 bg-red-500 text-white rounded-full w-5 h-5 flex items-center justify-center text-xs hover:bg-red-600 opacity-0 group-hover:opacity-100 transition-opacity"
                          title="Remove image"
                        >
                          ×
                        </button>
                      </div>
                      
                      {/* URL Display */}
                      <div className="text-xs">
                        <p className="text-gray-600 mb-1">Image URL:</p>
                        <div className="flex items-center gap-1">
                          <input
                            type="text"
                            value={url}
                            readOnly
                            className="flex-1 bg-gray-50 border border-gray-200 rounded px-2 py-1 text-xs font-mono"
                            onClick={(e) => e.target.select()}
                          />
                          <button
                            onClick={() => {
                              navigator.clipboard.writeText(url);
                              showNotification('URL copied to clipboard!', 'success');
                            }}
                            className="px-2 py-1 bg-blue-500 text-white rounded text-xs hover:bg-blue-600"
                            title="Copy URL"
                          >
                            Copy
                          </button>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
             </div>
           ) : (
             <div className="flex items-center space-x-2">
               <div className="flex-1 bg-white border border-gray-300 rounded-md px-3 py-2">
                 <span className="text-sm text-gray-500">
                   No images uploaded yet
                 </span>
               </div>
             </div>
           )}
         </div>
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
                            disabled={deletingPosts.has(post.id)}
                            className={`p-1 rounded transition-colors ${
                              deletingPosts.has(post.id)
                                ? 'text-gray-400 cursor-not-allowed'
                                : 'text-red-400 hover:text-red-600 hover:bg-red-50'
                            }`}
                            title={deletingPosts.has(post.id) ? 'Deleting...' : 'Delete post'}
                          >
                            {deletingPosts.has(post.id) ? (
                              <div className="h-4 w-4 border-2 border-gray-400 border-t-transparent rounded-full animate-spin"></div>
                            ) : (
                              <Trash2 className="h-4 w-4" />
                            )}
                          </button>
                        </div>
                      </div>

                      {/* Media Display - Image on Top */}
                      {post.media && post.media.length > 0 ? (
                        <div>
                          <div className="grid grid-cols-1 gap-0">
                                                         {post.media.map((mediaItem, index) => {
                               const imageUrl = mediaItem.sourceUrl || mediaItem.url || mediaItem.thumbnailUrl;
                               console.log(`Rendering media item ${index}:`, {
                                 id: mediaItem.id,
                                 sourceUrl: mediaItem.sourceUrl,
                                 url: mediaItem.url,
                                 thumbnailUrl: mediaItem.thumbnailUrl,
                                 finalUrl: imageUrl,
                                 isGoogleUrl: imageUrl && imageUrl.includes('lh3.googleusercontent.com')
                               });
                               
                                                                // Ensure Google Photos URLs have proper format
                                 let processedUrl = imageUrl;
                                 if (imageUrl && imageUrl.includes('lh3.googleusercontent.com')) {
                                   if (!imageUrl.includes('=')) {
                                     processedUrl = `${imageUrl}=h305-no`;
                                     console.log(`Fixed Google URL: ${imageUrl} -> ${processedUrl}`);
                                   } else {
                                     // If it already has parameters, ensure it has the right format
                                     if (!imageUrl.includes('h305-no')) {
                                       processedUrl = `${imageUrl}=h305-no`;
                                       console.log(`Enhanced Google URL: ${imageUrl} -> ${processedUrl}`);
                                     }
                                   }
                                 }
                              
                              return (
                                                                 <div key={mediaItem.id || index} className="relative group">
                                   <img
                                     src={processedUrl}
                                     alt={mediaItem.altText || 'Post image'}
                                     className="w-full h-48 object-cover shadow-sm"
                                     onError={(e) => {
                                       console.log('Image failed to load:', processedUrl);
                                       
                                       // Try alternative Google Photos URL formats
                                       if (processedUrl.includes('lh3.googleusercontent.com')) {
                                         const baseUrl = processedUrl.split('=')[0];
                                         const alternativeUrl = `${baseUrl}=w400-h300-no`;
                                         console.log('Trying alternative Google URL:', alternativeUrl);
                                         e.target.src = alternativeUrl;
                                         
                                         // If that also fails, show the error state
                                         e.target.onerror = () => {
                                           console.log('Alternative URL also failed:', alternativeUrl);
                                           e.target.style.display = 'none';
                                           e.target.nextSibling.style.display = 'flex';
                                         };
                                       } else {
                                         e.target.style.display = 'none';
                                         e.target.nextSibling.style.display = 'flex';
                                       }
                                     }}
                                     onLoad={(e) => {
                                       console.log('Image loaded successfully:', processedUrl);
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
                              );
                            })}
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
                  
                  {/* Image Uploader Button */}
                  <div className="mb-3">
                    <button
                      type="button"
                      onClick={() => setShowImageUploaderModal(true)}
                      className="inline-flex items-center px-3 py-2 border border-primary-300 shadow-sm text-sm font-medium rounded-md text-primary-700 bg-primary-50 hover:bg-primary-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
                    >
                      <Plus className="h-4 w-4 mr-2" />
                      Upload Images with ImgBB
                    </button>
                    <p className="text-xs text-gray-500 mt-1">
                      Upload images to ImgBB and get direct URLs for your posts
                    </p>
                  </div>
                  
                  {/* Mock Image Notice */}
                  <div className="mb-3 p-2 bg-blue-50 border border-blue-200 rounded-md">
                    <p className="text-xs text-blue-700">
                      <strong>Testing Mode:</strong> A mock image will automatically be added to every post for testing media functionality.
                    </p>
                  </div>
                  
                  {/* File Upload Section */}
                  <div className="mb-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">Upload Local Files (Optional)</label>
                    <input
                      type="file"
                      multiple
                      accept="image/*"
                                             onChange={(e) => {
                         console.log('=== FILE INPUT CHANGE ===');
                         console.log('Event target files:', e.target.files);
                         console.log('Files length:', e.target.files.length);
                         
                         const files = Array.from(e.target.files);
                         console.log('Converted files array:', files);
                         console.log('Current formData.mediaFiles:', formData.mediaFiles);
                         
                         const newFiles = [...(formData.mediaFiles || []), ...files];
                         console.log('New files array:', newFiles);
                         
                         setFormData({ ...formData, mediaFiles: newFiles });
                         console.log('=== END FILE INPUT CHANGE ===');
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
                    <label className="block text-sm font-medium text-gray-700 mb-2">Or Add Picture URLs (Optional)</label>
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

      {/* Image Uploader Modal */}
      {showImageUploaderModal && (
        <div className="fixed inset-0 bg-gray-600 bg-opacity-50 overflow-y-auto h-full w-full z-50">
          <div className="relative top-10 mx-auto p-5 border w-11/12 max-w-4xl shadow-lg rounded-md bg-white">
            <div className="mt-3">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-lg font-medium text-gray-900">Upload Images with ImgBB</h3>
                <button
                  onClick={() => setShowImageUploaderModal(false)}
                  className="text-gray-400 hover:text-gray-600 text-2xl font-bold"
                >
                  ×
                </button>
              </div>
              
              {/* Custom ImageUploader with callback */}
              <div className="max-h-96 overflow-y-auto">
                <ImageUploader 
                  onImageUploaded={handleImageUploaded}
                />
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default Posts;
