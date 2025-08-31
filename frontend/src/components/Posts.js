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

// Post Image Component
const PostImage = ({ imageUrl, altText, mediaFormat }) => {
  const [imageSrc, setImageSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchImage = async () => {
      try {
        setLoading(true);
        setError(false);

        // Check if it's a Google Photos URL that needs proxying
        if (imageUrl && imageUrl.includes('lh3.googleusercontent.com')) {
          const response = await axios.get(`http://localhost:3001/api/gmb/proxy-image?url=${encodeURIComponent(imageUrl)}`);
          
          if (response.data.success && response.data.dataUrl) {
            setImageSrc(response.data.dataUrl);
          } else {
            setError(true);
          }
        } else {
          // For non-Google URLs, use directly
          setImageSrc(imageUrl);
        }
      } catch (err) {
        console.error('Error fetching post image:', err);
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    if (imageUrl) {
      fetchImage();
    }
  }, [imageUrl]);

  if (loading) {
    return (
      <div className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center animate-pulse">
        <div className="h-8 w-8 bg-gray-400 rounded"></div>
      </div>
    );
  }

  if (error || !imageSrc) {
    return (
      <div className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
        Image not available
      </div>
    );
  }

  return (
    <div className="relative">
      <img
        src={imageSrc}
        alt={altText}
        className="w-full h-48 object-cover shadow-sm"
      />
      {mediaFormat === 'VIDEO' && (
        <div className="absolute top-2 right-2 bg-black bg-opacity-75 text-white text-xs px-2 py-1 rounded">
          VIDEO
        </div>
      )}
    </div>
  );
};

const Posts = () => {
  const { isAuthenticated } = useAuth();
  const [posts, setPosts] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);

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
   
      // Post creation loading state
   const [creatingPost, setCreatingPost] = useState(false);
   
   // Post update loading state
   const [updatingPost, setUpdatingPost] = useState(false);
   
   // Image upload loading state
   const [uploadingImages, setUploadingImages] = useState(false);
   
   // Edit post state
   const [editingPost, setEditingPost] = useState(null);
       const [editFormData, setEditFormData] = useState({
      summary: '',
      postType: 'UPDATE',
      callToAction: {
        type: '',
        url: ''
      },
      mediaUrls: ['']
    });
   
   // Notification state
   const [notification, setNotification] = useState(null);
  
     const [formData, setFormData] = useState({
     summary: '',
     postType: 'UPDATE',
     callToAction: {
       type: '',
       url: ''
     },
     mediaUrls: ['']
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
     setCreatingPost(true);
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

              // Add call to action only if both type and URL are provided
       if (formData.callToAction.type && formData.callToAction.type.trim() !== '' && 
           formData.callToAction.url && formData.callToAction.url.trim() !== '') {
         postData.callToAction = {
           actionType: formData.callToAction.type,
           url: formData.callToAction.url.trim()
         };
         console.log('Added CTA to post data:', postData.callToAction);
       } else if (formData.callToAction.type && formData.callToAction.type.trim() !== '') {
         // Warning: CTA type selected but no URL provided
         alert('Warning: You selected a Call to Action type but did not provide a URL. The CTA button will not be displayed.');
         console.log('CTA type selected but no URL provided, skipping CTA');
       } else {
         console.log('No CTA type selected, skipping CTA');
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

      // Upload URLs
      if (formData.mediaUrls.length > 0) {
        try {
          console.log('=== URL UPLOAD DEBUG ===');
          console.log('URLs to upload:', formData.mediaUrls);
          const validUrls = formData.mediaUrls.filter(url => url.trim() !== '');
          console.log('Valid URLs:', validUrls);
          
           if (validUrls.length > 0) {
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
           }
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
              mediaFormat: media.mediaFormat || 'PHOTO',
              sourceUrl: media.sourceUrl || media.url || media.thumbnailUrl
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
         hasMedia: !!postData.media,
         hasCallToAction: !!postData.callToAction,
         callToAction: postData.callToAction
       });
       
       // Additional CTA debugging
       console.log('=== FRONTEND CTA DEBUG ===');
       console.log('formData.callToAction:', formData.callToAction);
       console.log('formData.callToAction.type:', formData.callToAction.type);
       console.log('formData.callToAction.url:', formData.callToAction.url);
       console.log('postData.callToAction:', postData.callToAction);
       console.log('=== END FRONTEND CTA DEBUG ===');
      
      const response = await axios.post('http://localhost:3001/api/posts', postData);
      console.log('=== POST CREATION RESPONSE ===');
      console.log('Response status:', response.status);
      console.log('Response data:', response.data);
      
             // Create a new post object to add to local state immediately
       const newPostId = `new-post-${Date.now()}`;
       const newPost = {
         id: newPostId, // Temporary ID
         content: formData.summary,
         postType: formData.postType,
         platform: 'google',
         createdAt: new Date().toISOString(),
         status: 'published',
         media: allMedia.map(media => ({
           id: media.name?.split('/').pop() || `media-${Date.now()}`,
           mediaFormat: media.mediaFormat || 'PHOTO',
           sourceUrl: media.sourceUrl || media.url || media.thumbnailUrl,
           thumbnailUrl: media.thumbnailUrl || media.thumbnail || null,
           altText: 'Post image'
         })),
         callToAction: postData.callToAction || null,
         gmbPost: null // Will be populated when fetched from GMB
       };
      
      console.log('=== CREATED NEW POST OBJECT ===');
      console.log('New post object:', newPost);
      console.log('New post media:', newPost.media);
      
      // Add the new post to the beginning of the posts array
      setPosts(prevPosts => [newPost, ...prevPosts]);
      
      // Reset form and state
      setFormData({
        summary: '',
        postType: 'UPDATE',
        callToAction: { type: '', url: '' },
        mediaUrls: ['']
      });
      setCreatingPost(false);
      setExpandedPosts(new Set()); // Reset expanded posts
      
      // Show success message
      showNotification('Post created successfully!', 'success');
      
      // Refresh posts list in background to get the real GMB post data
      console.log('=== REFRESHING POSTS IN BACKGROUND ===');
      setTimeout(async () => {
        try {
          // Fetch fresh posts from GMB
          const response = await axios.get(`http://localhost:3001/api/posts/location/${locationId}?page=${currentPage}&limit=3`, {
            headers: {
              'x-gmb-account-id': accountId
            }
          });
          
          if (response.data.posts && response.data.pagination) {
            // Check if our new post appears in the GMB response
            const gmbPostExists = response.data.posts.some(gmbPost => 
              gmbPost.content === formData.summary && 
              gmbPost.postType === formData.postType
            );
            
            if (gmbPostExists) {
              // New post found in GMB, replace local posts with GMB data
              setPosts(response.data.posts);
              console.log('New post found in GMB, synced successfully');
            } else {
              // New post not yet in GMB, keep local post and append GMB posts
              setPosts(prevPosts => {
                const localNewPost = prevPosts.find(p => p.id === newPostId);
                if (localNewPost) {
                  return [localNewPost, ...response.data.posts];
                }
                return response.data.posts;
              });
              console.log('New post not yet in GMB, preserved local post');
            }
            
            // Update pagination state
            setCurrentPage(response.data.pagination.page);
            setTotalPages(response.data.pagination.totalPages);
            setTotalPosts(response.data.pagination.total);
            setHasNext(response.data.pagination.hasNext);
            setHasPrev(response.data.pagination.hasPrev);
          }
          
          console.log('=== POSTS REFRESHED IN BACKGROUND ===');
        } catch (error) {
          console.log('Background refresh failed:', error);
        }
      }, 3000); // Wait 3 seconds for GMB API to index the new post
    } catch (error) {
      console.error('Error creating post:', error);
      alert('Failed to create post. Please try again.');
     } finally {
       setCreatingPost(false);
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

   // Helper function to format date as relative time
   const formatRelativeTime = (dateString) => {
     const date = new Date(dateString);
     const now = new Date();
     const diffInMs = now - date;
     const diffInSeconds = Math.floor(diffInMs / 1000);
     const diffInMinutes = Math.floor(diffInSeconds / 60);
     const diffInHours = Math.floor(diffInMinutes / 60);
     const diffInDays = Math.floor(diffInHours / 24);

     if (diffInDays >= 7) {
       return date.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' });
     } else if (diffInDays > 0) {
       return `${diffInDays} day${diffInDays === 1 ? '' : 's'} ago`;
     } else if (diffInHours > 0) {
       return `${diffInHours} hour${diffInHours === 1 ? '' : 's'} ago`;
     } else if (diffInMinutes > 0) {
       return `${diffInMinutes} minute${diffInMinutes === 1 ? '' : 's'} ago`;
     } else {
       return `${diffInSeconds} second${diffInSeconds === 1 ? '' : 's'} ago`;
     }
   };

  // Show notification
  const showNotification = (message, type = 'success') => {
    setNotification({ message, type });
    setTimeout(() => setNotification(null), 3000);
  };

     // Handle adding uploaded image URL to form
   const handleImageUploaded = (imageUrl) => {
     if (editingPost) {
       setEditFormData(prev => ({
         ...prev,
         mediaUrls: [...prev.mediaUrls, imageUrl]
       }));
     } else {
       setFormData(prev => ({
         ...prev,
         mediaUrls: [...prev.mediaUrls, imageUrl]
       }));
     }
     setUploadingImages(false);
     showNotification('Image uploaded successfully! You can now add it to your post.', 'success');
   };

       // Handle edit post
    const handleEditPost = (post) => {
      setEditingPost(post);
      setEditFormData({
        summary: post.content || '',
        postType: post.postType || 'UPDATE',
        callToAction: {
          type: post.callToAction?.actionType || '',
          url: post.callToAction?.url || ''
        },
        mediaUrls: post.media && post.media.length > 0 
          ? post.media.map(media => media.sourceUrl || media.url || media.thumbnailUrl).filter(Boolean)
          : ['']
      });
    };

   // Handle update post
   const handleUpdatePost = async (e) => {
     e.preventDefault();
     if (!editingPost) return;

     setUpdatingPost(true);
     try {
       console.log('=== UPDATE POST STARTED ===');
       console.log('Editing post:', editingPost);
       console.log('Edit form data:', editFormData);
       
       // Extract account and location IDs from selectedProfile
       const profileParts = selectedProfile.split('/');
       const locationId = profileParts[profileParts.length - 1];
       const accountId = profileParts[1];

       console.log('Profile parts:', profileParts);
       console.log('Account ID:', accountId);
       console.log('Location ID:', locationId);

       const updateData = {
         content: editFormData.summary,
         postType: editFormData.postType
       };

       // Add call to action only if both type and URL are provided
       if (editFormData.callToAction.type && editFormData.callToAction.type.trim() !== '' && 
           editFormData.callToAction.url && editFormData.callToAction.url.trim() !== '') {
         updateData.callToAction = {
           actionType: editFormData.callToAction.type,
           url: editFormData.callToAction.url.trim()
         };
       } else if (editFormData.callToAction.type && editFormData.callToAction.type.trim() !== '') {
         // Warning: CTA type selected but no URL provided
         alert('Warning: You selected a Call to Action type but did not provide a URL. The CTA button will not be displayed.');
       }

       // Add media if provided
       if (editFormData.mediaUrls && editFormData.mediaUrls.length > 0) {
         const validMediaUrls = editFormData.mediaUrls.filter(url => url.trim() !== '');
         if (validMediaUrls.length > 0) {
           updateData.media = validMediaUrls.map(url => ({
             mediaFormat: 'PHOTO',
             sourceUrl: url
           }));
         }
       }

       console.log('Update data to send:', updateData);

       // Use PATCH request as per GMB API documentation
       try {
         console.log('Making PATCH request to:', `http://localhost:3001/api/posts/${editingPost.id}`);
         console.log('With data:', updateData);
         console.log('With params:', { gmbAccountId: accountId, gmbLocationId: locationId });
         
         const response = await axios.patch(`http://localhost:3001/api/posts/${editingPost.id}`, updateData, {
           params: {
             gmbAccountId: accountId,
             gmbLocationId: locationId
           }
         });
         console.log('PATCH request successful:', response.data);
       } catch (patchError) {
         console.log('PATCH request failed:', patchError);
         console.log('PATCH error details:', patchError.response?.data);
         console.log('PATCH error status:', patchError.response?.status);
         throw patchError; // Re-throw to be caught by outer catch
       }

       console.log('=== UPDATE POST SUCCESS ===');
       
       // Refresh posts and reset edit state
       console.log('Refreshing posts...');
       try {
         await fetchPosts(selectedProfile, currentPage, false);
         console.log('Posts refreshed successfully');
       } catch (fetchError) {
         console.log('Error refreshing posts:', fetchError);
       }
       
       console.log('Resetting edit state...');
       setEditingPost(null);
       setEditFormData({
         summary: '',
         postType: 'UPDATE',
         callToAction: { type: '', url: '' },
         mediaUrls: ['']
       });
       
       console.log('Showing success notification...');
       showNotification('Post updated successfully!', 'success');
       console.log('=== UPDATE POST COMPLETE ===');
     } catch (error) {
       console.error('=== UPDATE POST ERROR ===');
       console.error('Error updating post:', error);
       console.error('Error response:', error.response?.data);
       console.error('Error status:', error.response?.status);
       showNotification(`Failed to update post: ${error.response?.data?.error || error.message}`, 'error');
     } finally {
       setUpdatingPost(false);
     }
   };

   // Cancel edit
   const handleCancelEdit = () => {
     setEditingPost(null);
     setEditFormData({
       summary: '',
       postType: 'UPDATE',
       callToAction: { type: '', url: '' },
       mediaUrls: ['']
     });
   };

   // Handle delete image from preview
   const handleDeleteImage = (index) => {
     if (editingPost) {
       setEditFormData(prev => {
         const newUrls = prev.mediaUrls.filter((_, i) => i !== index);
         // Ensure there's always at least one empty string for the form
         return {
           ...prev,
           mediaUrls: newUrls.length === 0 ? [''] : newUrls
         };
       });
     } else {
       setFormData(prev => {
         const newUrls = prev.mediaUrls.filter((_, i) => i !== index);
         // Ensure there's always at least one empty string for the form
         return {
           ...prev,
           mediaUrls: newUrls.length === 0 ? [''] : newUrls
         };
       });
     }
     showNotification('Image removed from preview', 'success');
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
      case 'UPDATE':
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
    <div className="space-y-6" style={{
      '--tw-ring-color': 'rgb(59 130 246 / 1)',
      '--tw-ring-opacity': '1'
    }}>
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

             {/* Create/Edit Post Form Section */}
       <div className="bg-white shadow rounded-lg p-6">
         <div className="flex items-center justify-between mb-4">
                       <div>
              <h2 className="text-lg font-medium text-gray-900">
                {editingPost ? 'Edit Post' : 'New Post'}
              </h2>
            </div>
           <div className="flex items-center space-x-4">
             {/* Post Type Selection Buttons */}
             <div className="flex items-center space-x-2">
               <span className="text-sm font-medium text-gray-700">Post Type:</span>
               <div className="flex bg-gray-100 rounded-lg p-1">
                 <button
                   type="button"
                   onClick={() => {
                     if (editingPost) {
                       setEditFormData({ ...editFormData, postType: 'UPDATE' });
                     } else {
                       setFormData({ ...formData, postType: 'UPDATE' });
                     }
                   }}
                   className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                     (editingPost ? editFormData.postType : formData.postType) === 'UPDATE'
                       ? 'bg-white text-gray-900 shadow-sm'
                       : 'text-gray-600 hover:text-gray-900'
                   }`}
                 >
                   Update
                 </button>
                 <button
                   type="button"
                   onClick={() => {
                     if (editingPost) {
                       setEditFormData({ ...editFormData, postType: 'OFFER' });
                     } else {
                       setFormData({ ...formData, postType: 'OFFER' });
                     }
                   }}
                   className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                     (editingPost ? editFormData.postType : formData.postType) === 'OFFER'
                       ? 'bg-white text-gray-900 shadow-sm'
                       : 'text-gray-600 hover:text-gray-900'
                   }`}
                 >
                   Offer
                 </button>
                 <button
                   type="button"
                   onClick={() => {
                     if (editingPost) {
                       setEditFormData({ ...editFormData, postType: 'EVENT' });
                     } else {
                       setFormData({ ...formData, postType: 'EVENT' });
                     }
                   }}
                   className={`px-3 py-1 text-sm font-medium rounded-md transition-colors ${
                     (editingPost ? editFormData.postType : formData.postType) === 'EVENT'
                       ? 'bg-white text-gray-900 shadow-sm'
                       : 'text-gray-600 hover:text-gray-900'
                   }`}
                 >
                   Event
                 </button>
               </div>
             </div>
             
             {editingPost && (
               <button
                 onClick={handleCancelEdit}
                 className="px-4 py-2 text-sm font-medium text-gray-700 bg-gray-100 border border-gray-300 rounded-md hover:bg-gray-200"
               >
                 Cancel Edit
               </button>
             )}
           </div>
         </div>
        
                 <form onSubmit={editingPost ? handleUpdatePost : handleCreatePost}>
           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
             {/* Left Column - Form */}
             <div className="lg:col-span-2 space-y-4">
               {/* Picture Upload Section - Moved to Top */}
               <div>
                 <label className="block text-sm font-medium text-gray-700 mb-2">Add Pictures</label>
                 
                 {/* Hidden ImgBB Image Uploader with Simple Button */}
                 <div className="mb-4">
                   <div className="hidden">
                     <ImageUploader 
                       onImageUploaded={handleImageUploaded}
                     />
                   </div>
                   <button
                     type="button"
                     disabled={uploadingImages}
                     onClick={() => {
                       setUploadingImages(true);
                       // Trigger the hidden file input from ImageUploader
                       const fileInput = document.querySelector('input[type="file"]');
                       if (fileInput) {
                         fileInput.click();
                       }
                     }}
                     className={`inline-flex items-center px-4 py-3 border border-primary-300 shadow-sm text-sm font-medium rounded-md transition-colors duration-200 ${
                       uploadingImages
                         ? 'text-primary-500 bg-primary-25 cursor-not-allowed'
                         : 'text-primary-700 bg-primary-50 hover:bg-primary-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500'
                     }`}
                   >
                     {uploadingImages ? (
                       <>
                         <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-500 mr-2"></div>
                         Uploading Images...
                       </>
                     ) : (
                       <>
                         <Plus className="h-5 w-5 mr-2" />
                         Upload Images
                       </>
                     )}
                   </button>
                 </div>
                 

               </div>

                               {/* Description Section */}
                <div>
                  <label className="block text-sm font-medium text-gray-700">
                    Description
                    <span className="text-gray-500 font-normal ml-2">
                      ({(editingPost ? editFormData.summary : formData.summary).length}/1500)
                    </span>
                  </label>
                  <textarea
                    value={editingPost ? editFormData.summary : formData.summary}
                    onChange={(e) => {
                      const value = e.target.value;
                      if (value.length <= 1500) {
                        if (editingPost) {
                          setEditFormData({ ...editFormData, summary: value });
                        } else {
                          setFormData({ ...formData, summary: value });
                        }
                      }
                    }}
                    rows={4}
                    maxLength={1500}
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                    placeholder="Write your post content here..."
                    required
                  />
                  <div className="mt-1 text-xs text-gray-500 text-right">
                    {(editingPost ? editFormData.summary : formData.summary).length}/1500 characters
                  </div>
                </div>

                               {/* Post Type Section - Hidden since we have buttons above */}
                <div className="hidden">
                  <label className="block text-sm font-medium text-gray-700">Post Type</label>
                  <select
                    value={editingPost ? editFormData.postType : formData.postType}
                    onChange={(e) => editingPost
                      ? setEditFormData({ ...editFormData, postType: e.target.value })
                      : setFormData({ ...formData, postType: e.target.value })
                    }
                    className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                  >
                    <option value="UPDATE">Update</option>
                    <option value="OFFER">Offer</option>
                    <option value="EVENT">Event</option>
                    <option value="PRODUCT">Product</option>
                  </select>
                </div>

               {/* Call to Action Type Section */}
               <div>
                 <label className="block text-sm font-medium text-gray-700">Call to Action Type</label>
                 <select
                   value={editingPost ? editFormData.callToAction.type : formData.callToAction.type}
                   onChange={(e) => editingPost
                     ? setEditFormData({
                         ...editFormData,
                         callToAction: { ...editFormData.callToAction, type: e.target.value }
                       })
                     : setFormData({
                         ...formData,
                         callToAction: { ...formData.callToAction, type: e.target.value }
                       })
                   }
                   className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                 >
                   <option value="">None</option>
                   <option value="BOOK">Book</option>
                   <option value="ORDER">Order</option>
                   <option value="SHOP">Shop</option>
                                       <option value="LEARN_MORE">Learn more</option>
                   <option value="SIGN_UP">Sign Up</option>
                   <option value="CALL">Call</option>
                 </select>
               </div>

               {/* Call to Action URL */}
               {(editingPost ? editFormData.callToAction.type : formData.callToAction.type) && (
                 <div>
                   <label className="block text-sm font-medium text-gray-700">Call to Action URL</label>
                   <input
                     type="url"
                     value={editingPost ? editFormData.callToAction.url : formData.callToAction.url}
                     onChange={(e) => editingPost
                       ? setEditFormData({
                           ...editFormData,
                           callToAction: { ...editFormData.callToAction, url: e.target.value }
                         })
                       : setFormData({
                           ...formData,
                           callToAction: { ...formData.callToAction, url: e.target.value }
                         })
                     }
                     className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                     placeholder="https://example.com"
                   />
                 </div>
               )}

               {/* Submit Button */}
               <div className="flex justify-end pt-4">
                 <button
                   type="submit"
                   disabled={creatingPost || updatingPost}
                   className={`px-8 py-3 border border-transparent rounded-md shadow-sm text-sm font-medium text-white transition-colors duration-200 ${
                     (creatingPost || updatingPost)
                       ? 'bg-primary-400 cursor-not-allowed' 
                       : 'bg-primary-600 hover:bg-primary-700'
                   }`}
                 >
                   {creatingPost ? (
                     <>
                       <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2 inline-block"></div>
                       Creating Post...
                     </>
                   ) : updatingPost ? (
                     <>
                       <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2 inline-block"></div>
                       Updating Post...
                     </>
                   ) : (
                     editingPost ? 'Update Post' : 'Create Post'
                   )}
                 </button>
               </div>
             </div>

             {/* Right Column - Post Preview */}
             <div className="lg:col-span-1">
               <div className="sticky top-6">
                 <div className="bg-gray-50 rounded-lg p-4 border border-gray-200">
                   <h3 className="text-lg font-medium text-gray-900 mb-4">Post Preview</h3>
                   
                   {/* Preview Content */}
                   <div className="space-y-4">
                                           {/* Image Preview */}
                      <div>
                        <h4 className="text-sm font-medium text-gray-700 mb-2"></h4>
                       {(editingPost ? editFormData.mediaUrls : formData.mediaUrls).filter(url => url.trim() !== '').length > 0 ? (
                         <div className="space-y-3">
                           {(editingPost ? editFormData.mediaUrls : formData.mediaUrls)
                             .filter(url => url.trim() !== '')
                             .slice(0, 2) // Show only first 2 images in preview
                             .map((url, index) => (
                               <div key={`preview-${index}`} className="relative group">
                                 <img
                                   src={url}
                                   alt={`Preview ${index + 1}`}
                                   className="w-full h-56 object-cover rounded-lg border shadow-sm"
                                   onError={(e) => {
                                     e.target.style.display = 'none';
                                     e.target.nextSibling.style.display = 'block';
                                   }}
                                 />
                                 <div className="hidden w-full h-56 bg-gray-200 rounded-lg border shadow-sm flex items-center justify-center text-xs text-gray-500">
                                   Image
                                 </div>
                                 {/* Delete Button */}
                                 <button
                                   onClick={() => handleDeleteImage(index)}
                                   className="absolute top-2 right-2 bg-red-500 hover:bg-red-600 text-white rounded-full w-6 h-6 flex items-center justify-center transition-colors duration-200"
                                   title="Delete image"
                                 >
                                   ×
                                 </button>
                               </div>
                             ))}
                           {(editingPost ? editFormData.mediaUrls : formData.mediaUrls).filter(url => url.trim() !== '').length > 2 && (
                             <div className="text-xs text-gray-500 text-center py-2">
                               +{(editingPost ? editFormData.mediaUrls : formData.mediaUrls).filter(url => url.trim() !== '').length - 2} more images
                             </div>
                           )}
                         </div>
                       ) : (
                         <div className="w-full h-48 bg-gray-200 rounded-lg border-2 border-dashed border-gray-300 flex items-center justify-center">
                           <div className="text-center">
                             <div className="text-gray-400 text-4xl mb-2">📷</div>
                             <p className="text-xs text-gray-500">No images uploaded</p>
                           </div>
                         </div>
                       )}
                     </div>

                     {/* Content Preview */}
                     <div>
                       {(editingPost ? editFormData.summary : formData.summary) ? (
                         <p className="text-sm text-gray-900 leading-relaxed">
                           {(editingPost ? editFormData.summary : formData.summary).length > 150 
                             ? `${(editingPost ? editFormData.summary : formData.summary).substring(0, 150)}...` 
                             : (editingPost ? editFormData.summary : formData.summary)
                           }
                         </p>
                                               ) : (
                          <p className="text-sm text-gray-900 italic">No content yet</p>
                        )}
                     </div>

                                           {/* Call to Action Link Preview */}
                      <div className="space-y-2">
                        <div>
                          <h4 className="text-sm font-medium text-gray-500 mb-2">Aug 13, 2025</h4>
                                                   {(editingPost ? editFormData.callToAction.type : formData.callToAction.type) ? (
                            <a
                              href={(editingPost ? editFormData.callToAction.url : formData.callToAction.url) || '#'}
                              className={`text-primary-600 hover:text-primary-700 text-sm font-medium ${
                                !(editingPost ? editFormData.callToAction.url : formData.callToAction.url) ? 'pointer-events-none' : ''
                              }`}
                            >
                              {(editingPost ? editFormData.callToAction.type : formData.callToAction.type).charAt(0).toUpperCase() + (editingPost ? editFormData.callToAction.type : formData.callToAction.type).slice(1).toLowerCase()}
                            </a>
                          ) : (
                            <span className="text-sm text-gray-400 italic">No CTA</span>
                          )}
                       </div>
                     </div>
                   </div>
                 </div>
               </div>
             </div>
           </div>
         </form>
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
                                     {posts.map((post) => {
                     console.log('=== POST DATA DEBUG ===');
                     console.log('Post ID:', post.id);
                     console.log('Post content:', post.content);
                     console.log('Post media:', post.media);
                     console.log('Post callToAction:', post.callToAction);
                     console.log('Has callToAction:', !!post.callToAction);
                     console.log('Has callToAction.url:', !!(post.callToAction && post.callToAction.url));
                     console.log('Post media length:', post.media ? post.media.length : 'N/A');
                     if (post.media && post.media.length > 0) {
                       console.log('First media item:', post.media[0]);
                       console.log('First media sourceUrl:', post.media[0].sourceUrl);
                       console.log('First media url:', post.media[0].url);
                     }
                     
                     // Additional CTA debugging
                     if (post.callToAction) {
                       console.log('CTA Details:');
                       console.log('  - actionType:', post.callToAction.actionType);
                       console.log('  - url:', post.callToAction.url);
                       console.log('  - type:', post.callToAction.type);
                       console.log('  - All CTA keys:', Object.keys(post.callToAction));
                     }
                     console.log('=== END POST DATA DEBUG ===');
                     
                     return (
                       <div key={post.id} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden">
                      {/* Post Header with Action Buttons */}
                      <div className="flex items-center justify-end p-3 bg-gray-50">
                        {/* Action Buttons */}
                        <div className="flex items-center space-x-2">
                                                     <button
                             onClick={() => handleEditPost(post)}
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
                               
                               if (!imageUrl) {
                                 console.log('No valid image URL found for media item:', mediaItem);
                                 return (
                                   <div key={mediaItem.id || index} className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                     No image available
                                   </div>
                                 );
                               }
                               
                               // Additional validation for image URL
                               if (typeof imageUrl !== 'string' || imageUrl.trim() === '') {
                                 console.log('Invalid image URL format:', imageUrl);
                                 return (
                                   <div key={mediaItem.id || index} className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                     Invalid image URL
                                   </div>
                                 );
                               }
                               
                               return (
                                 <div key={mediaItem.id || index} className="relative group">
                                   <PostImage
                                     imageUrl={imageUrl}
                                     altText={mediaItem.altText || 'Post image'}
                                     mediaFormat={mediaItem.mediaFormat}
                                   />
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

                                                 {/* Post Footer with Date, Status, and CTA */}
                         <div className="flex items-center justify-between text-xs text-gray-500 pt-2 border-t border-gray-100">
                           <span className="flex items-center">
                             <Clock className="h-4 w-4 mr-1" />
                             {post.createdAt ? formatRelativeTime(post.createdAt) : 'Date not available'}
                           </span>
                           <div className="flex items-center space-x-3">
                             {post.callToAction && (
                               <a
                                 href={post.callToAction.url || '#'}
                                 target="_blank"
                                 rel="noopener noreferrer"
                                 className={`inline-flex items-center px-2 py-1 text-xs font-medium rounded transition-colors duration-200 ${
                                   post.callToAction.url 
                                     ? 'bg-blue-100 text-blue-800 hover:bg-blue-200' 
                                     : 'bg-gray-100 text-gray-500 cursor-not-allowed'
                                 }`}
                                 onClick={!post.callToAction.url ? (e) => e.preventDefault() : undefined}
                               >
                                 {post.callToAction.actionType || 'CTA'}
                               </a>
                             )}
                             {post.status === 'published' && (
                               <span className="flex items-center">
                                 <CheckCircle className="h-4 w-4 mr-1" />
                                 Published
                               </span>
                             )}
                           </div>
                         </div>


                                             </div>
                     </div>
                   );
                   })}
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

              </div>
            )}
          </div>
        </div>
      )}

      

      
    </div>
  );
};

export default Posts;
