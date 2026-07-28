import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import axios from '../utils/axiosConfig';
import { useAuth } from '../contexts/AuthContext';
import ImageUploader from './react_imgbb_uploader.js';
import imageService from '../services/imageService';
import businessProfileService from '../services/businessProfileService';
import postsService from '../services/postsService';
import calendarService from '../services/calendarService';
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
  Share,
  RefreshCw,
  HardDrive,
  Sparkles,
} from 'lucide-react';
import {
  CTA_OPTIONS,
  isCallCta,
  looksLikePhone,
  toTelUrl,
  digitsOnly, // eslint-disable-line no-unused-vars
  SmartPreviewImage,
  DrivePickerModal,
} from './composerShared';

// Post Image Component
const PostImage = ({ imageUrl, altText, mediaFormat, mediaData }) => {
  const [imageSrc, setImageSrc] = useState(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    const fetchImage = async () => {
      if (!imageUrl) {
        setLoading(false);
        return;
      }

      try {
        setLoading(true);
        setError(false);

        // If we have cached base64 data, use it directly
        if (mediaData && mediaData.data && mediaData.fromCache) {
          setImageSrc(mediaData.data);
          setLoading(false);
          return;
        }

        // Otherwise, fetch through the image service (which uses proxy-image endpoint)
        const result = await imageService.getImage(imageUrl);
        
        if (result.success) {
          setImageSrc(result.dataUrl);
        } else {
          setError(true);
        }
      } catch (err) {
        setError(true);
      } finally {
        setLoading(false);
      }
    };

    fetchImage();
  }, [imageUrl, mediaData]);

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
  const { isAuthenticated, isDisconnected } = useAuth();
  const [searchParams] = useSearchParams();
  const [posts, setPosts] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);

  const [selectedProfile, setSelectedProfile] = useState('');
  
  
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
   
   // File upload state
   const [uploadedFiles, setUploadedFiles] = useState([]);

   // Drive picker + AI composer state (shared behavior with Calendar composer)
   const [drivePickerOpen, setDrivePickerOpen] = useState(false);
   const [aiGenerating, setAiGenerating] = useState(false);
   const [aiError, setAiError] = useState(null);
   const [aiJustFilled, setAiJustFilled] = useState(false);
   const [aiImageDescriptions, setAiImageDescriptions] = useState([]);

   // Timing: publish now vs. schedule for later. Datetime default = 1h out.
   const [postingMode, setPostingMode] = useState('now'); // 'now' | 'later'
   const [scheduledAt, setScheduledAt] = useState(() => {
     const d = new Date(Date.now() + 60 * 60 * 1000);
     const pad = (n) => String(n).padStart(2, '0');
     return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
   });
   
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

  const fetchData = useCallback(async () => {
    try {
      setLoading(true);
      // Use centralized business profile service with caching
      const profilesWithLocations = await businessProfileService.getAccounts();
      setProfiles(profilesWithLocations);
      // If Calendar (or any deep link) passed ?location=accounts/X/locations/Y,
      // prefer that location — but only if it actually exists in the user's
      // profile tree. Otherwise fall back to the first available.
      const desired = searchParams.get('location');
      const allPaths = profilesWithLocations.flatMap((p) => (p.locations || []).map((l) => l.fullPath));
      if (desired && allPaths.includes(desired)) {
        setSelectedProfile(desired);
      } else if (profilesWithLocations.length > 0 && profilesWithLocations[0].locations.length > 0) {
        setSelectedProfile(profilesWithLocations[0].locations[0].fullPath);
      }
    } catch (error) {
    } finally {
      setLoading(false);
    }
  }, [searchParams]);

  const fetchPosts = useCallback(async (locationId, page = 1, append = false, forceRefresh = false) => {
    if (!locationId) return;
    
    
    try {
      // Extract IDs from the full path: accounts/{accountId}/locations/{locationId}
      const profileParts = locationId.split('/');
      const locationIdOnly = profileParts[profileParts.length - 1];
      const accountId = profileParts[1];
      

      // Use centralized posts service with caching
      const posts = await postsService.getPostsForLocation(locationIdOnly, accountId, forceRefresh);
      
      // Log posts order for debugging
      if (posts && posts.length > 0) {
      }
      
      if (posts && posts.length > 0) {
        // Process media for posts
        const postsWithMedia = await postsService.getMediaForPosts(posts);

        setPosts(postsWithMedia);
        
        // Background refresh: check for updates and refresh UI if needed
        if (!forceRefresh) {
          setTimeout(async () => {
            try {
              const freshPosts = await postsService.getPostsForLocation(locationIdOnly, accountId, true);
              
              // Check if data has changed by comparing post IDs and content
              let hasChanges = false;
              
              if (freshPosts.length !== postsWithMedia.length) {
                hasChanges = true;
              } else {
                // Create maps for easier comparison by post ID
                const freshPostsMap = new Map(freshPosts.map(post => [post.id, post]));
                const cachedPostsMap = new Map(postsWithMedia.map(post => [post.id, post]));
                
                // Check if all posts exist and have the same content
                for (const [postId, freshPost] of freshPostsMap) {
                  const cachedPost = cachedPostsMap.get(postId);
                  
                  if (!cachedPost ||
                      freshPost.content !== cachedPost.content ||
                      (freshPost.media?.length || 0) !== (cachedPost.media?.length || 0)) {
                    hasChanges = true;
                    break;
                  }
                }
              }
              
              if (hasChanges) {
                // Process media for fresh posts
                const freshPostsWithMedia = await postsService.getMediaForPosts(freshPosts);
                
                
                setPosts(freshPostsWithMedia);
                
                // Update the cached data with the fresh data
                postsService.setCachedData(`posts_${locationIdOnly}`, freshPosts);
              } else {
              }
            } catch (error) {
            }
          }, 1000); // Wait 1 second after initial render
        }
      } else {
        setPosts([]);
      }

      setRefreshing(false); // Fresh data loaded
      setLoading(false);
    } catch (error) {
      setRefreshing(false);
      setLoading(false);
    }
  }, []);

  useEffect(() => {

    if (isAuthenticated && !isDisconnected) {
      // Always fetch data when authenticated (remove business connection check)

      fetchData();
    } else if (isDisconnected) {
      // Clear data when disconnected
      setPosts([]);
      setProfiles([]);
      setLoading(false);
    }
  }, [isAuthenticated, isDisconnected, fetchData]);

  // Auto-fetch posts when profile is selected
  useEffect(() => {
    if (selectedProfile && !isDisconnected) {
      fetchPosts(selectedProfile);
    }
  }, [selectedProfile, isDisconnected, fetchPosts]);

  const handleCreatePost = async (e) => {
    e.preventDefault();
     setCreatingPost(true);


    
    // Validate media URLs
    const validMediaUrls = formData.mediaUrls.filter(url => url.trim() !== '');



    
    const invalidUrls = validMediaUrls.filter(url => {
      try {
        new URL(url);

        return false;
      } catch (error) {

        return true;
      }
    });
    
    if (invalidUrls.length > 0) {

      alert('Please enter valid image URLs for all media files.');
      setCreatingPost(false);
      return;
    }

    // CTA validation: CALL needs a valid phone; other types need a URL.
    if (formData.callToAction.type && formData.callToAction.url) {
      const raw = formData.callToAction.url.trim();
      if (isCallCta(formData.callToAction.type)) {
        if (!looksLikePhone(raw)) {
          alert('Enter a valid phone number for the Call now button (7-15 digits, optional leading +).');
          setCreatingPost(false);
          return;
        }
      } else if (raw) {
        try {
          // eslint-disable-next-line no-new
          new URL(raw);
        } catch {
          alert('Enter a valid URL for the call to action.');
          setCreatingPost(false);
          return;
        }
      }
    }


    try {
      // Extract account and location IDs from selectedProfile
      const profileParts = selectedProfile.split('/');
      const locationId = profileParts[profileParts.length - 1];
      const accountId = profileParts[1]; // accounts/{accountId}/locations/{locationId}
      
      // Debug the profile path structure




      
      if (!accountId || !locationId) {
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
           url: isCallCta(formData.callToAction.type)
             ? toTelUrl(formData.callToAction.url)
             : formData.callToAction.url.trim()
         };

       } else if (formData.callToAction.type && formData.callToAction.type.trim() !== '') {
         // Warning: CTA type selected but no URL provided
         alert('Warning: You selected a Call to Action type but did not provide a URL. The CTA button will not be displayed.');

       } else {

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

      // Build the media array directly from the mediaUrls textboxes. We used
      // to POST each URL through /api/posts/media first, but that endpoint
      // just echoed the URL back — any single 4xx (timeout, transient
      // network) blew up Promise.all and dropped every image with the
      // "Some URLs failed to upload" warning. There's nothing useful to
      // proxy through for URL-based media, so skip the roundtrip.
      const allMedia = [];
      const validUrls = formData.mediaUrls.filter((url) => url.trim() !== '');
      for (const url of validUrls) {
        allMedia.push({ mediaFormat: 'PHOTO', sourceUrl: url });
      }

             // Add all uploaded media to post data



       
       if (allMedia.length > 0) {
         // Use only real media
         postData.media = allMedia.map(media => {
           const mappedMedia = {
              mediaFormat: media.mediaFormat || 'PHOTO',
              sourceUrl: media.sourceUrl || media.url || media.thumbnailUrl
           };

           return mappedMedia;
         });

       } else {
         // No media to add

       }



       // Post data prepared for submission
       
       // Additional CTA debugging






      
      // Create FormData for file uploads
      const formDataToSend = new FormData();
      
      // Add text fields
      formDataToSend.append('platforms', JSON.stringify(postData.platforms));
      formDataToSend.append('content', postData.content);
      formDataToSend.append('gmbAccountId', postData.gmbAccountId);
      formDataToSend.append('gmbLocationId', postData.gmbLocationId);
      formDataToSend.append('postType', postData.postType);
      
      // Add optional fields
      if (postData.callToAction) {
        formDataToSend.append('callToAction', JSON.stringify(postData.callToAction));
      }
      if (postData.event) {
        formDataToSend.append('event', JSON.stringify(postData.event));
      }
      if (postData.offer) {
        formDataToSend.append('offer', JSON.stringify(postData.offer));
      }
      
      // Add media URLs (for backward compatibility)
      if (postData.media && postData.media.length > 0) {
        formDataToSend.append('media', JSON.stringify(postData.media));
      }
      
      // Add uploaded files
      if (uploadedFiles && uploadedFiles.length > 0) {
        uploadedFiles.forEach(file => {
          formDataToSend.append('images', file);
        });
      }

      let response;
      if (postingMode === 'later') {
        // Scheduled route — hits scheduled_posts, worker publishes at
        // scheduled_time. File uploads not supported yet on this path
        // (schedule endpoint accepts JSON, not multipart).
        if (uploadedFiles.length > 0) {
          alert(
            'Direct file uploads are not yet supported for scheduled posts — remove the files or paste image URLs instead.'
          );
          setCreatingPost(false);
          return;
        }
        const when = new Date(scheduledAt);
        if (Number.isNaN(when.getTime())) {
          alert('Invalid scheduled time.');
          setCreatingPost(false);
          return;
        }
        if (when.getTime() < Date.now() - 60_000) {
          alert('Scheduled time must be in the future.');
          setCreatingPost(false);
          return;
        }
        response = { data: await calendarService.schedule({
          content: postData.content,
          media: (postData.media || []).map((m) => ({
            sourceUrl: m.sourceUrl,
            mediaFormat: m.mediaFormat || 'PHOTO',
          })),
          gmbAccountId: postData.gmbAccountId,
          gmbLocationId: postData.gmbLocationId,
          scheduledTime: when,
          postType: postData.postType,
          callToAction: postData.callToAction || null,
        }) };
      } else {
        response = await axios.post('/api/posts', formDataToSend, {
          headers: { 'Content-Type': 'multipart/form-data' },
        });
      }



      
             // Create a new post object to add to local state immediately
       const newPostId = response.data.postId || `new-post-${Date.now()}`;
       const newPost = {
         id: newPostId, // Use real post ID from backend response
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
      showNotification(
        postingMode === 'later'
          ? `Post scheduled for ${new Date(scheduledAt).toLocaleString()}!`
          : 'Post created successfully!',
        'success'
      );
      
      // Refresh posts list in background to get the real GMB post data

      setTimeout(async () => {
        try {
          // Fetch fresh posts from GMB using the posts service
          const freshPosts = await postsService.getPostsForLocation(locationId, accountId, true);
          
          if (freshPosts && freshPosts.length > 0) {
            // Check if our new post appears in the GMB response
            const gmbPostExists = freshPosts.some(gmbPost => 
              gmbPost.content === formData.summary && 
              gmbPost.postType === formData.postType
            );
            
            if (gmbPostExists) {
              // New post found in GMB, replace local posts with GMB data
              setPosts(freshPosts);

            } else {
              // New post not yet in GMB, keep local post and append GMB posts
              setPosts(prevPosts => {
                const localNewPost = prevPosts.find(p => p.id === newPostId);
                if (localNewPost) {
                  return [localNewPost, ...freshPosts];
                }
                return freshPosts;
              });

            }
            
          }
          

        } catch (error) {

        }
      }, 3000); // Wait 3 seconds for GMB API to index the new post
    } catch (error) {
      // Surface the real failure so debugging isn't a game of 20 questions.
      // Also emit to the console + client-log so the next silent failure
      // lands in Loki as ai_post_error / equivalent.
      // eslint-disable-next-line no-console
      console.error('[handleCreatePost] failed:', error, {
        status: error?.response?.status,
        data: error?.response?.data,
      });
      const backendMsg = error?.response?.data?.error || error?.response?.data?.details;
      const httpStatus = error?.response?.status;
      const localMsg = error?.message;
      const composed = backendMsg
        ? `Failed to post (${httpStatus || 'no-status'}): ${backendMsg}`
        : httpStatus
        ? `Failed to post (${httpStatus}): ${localMsg || 'unknown'}`
        : `Failed to post: ${localMsg || 'unknown error — check console'}`;
      alert(composed);
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
      
      await axios.delete(`/api/posts/${postId}`, {
        params: {
          gmbAccountId: accountId,
          gmbLocationId: locationId
        }
      });
      
      // Refresh posts
      await fetchPosts(selectedProfile);
      showNotification('Post deleted successfully!', 'success');
    } catch (error) {
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



       
       // Extract account and location IDs from selectedProfile
       const profileParts = selectedProfile.split('/');
       const locationId = profileParts[profileParts.length - 1];
       const accountId = profileParts[1];





       const updateData = {
         content: editFormData.summary,
         postType: editFormData.postType
       };

       // Add call to action only if both type and URL are provided
       if (editFormData.callToAction.type && editFormData.callToAction.type.trim() !== '' && 
           editFormData.callToAction.url && editFormData.callToAction.url.trim() !== '') {
         updateData.callToAction = {
           actionType: editFormData.callToAction.type,
           url: isCallCta(editFormData.callToAction.type)
             ? toTelUrl(editFormData.callToAction.url)
             : editFormData.callToAction.url.trim()
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



       // Use PATCH request as per GMB API documentation
       try {



         
         const response = await axios.patch(`/api/posts/${editingPost.id}`, updateData, {
           params: {
             gmbAccountId: accountId,
             gmbLocationId: locationId
           }
         });

       } catch (patchError) {



         throw patchError; // Re-throw to be caught by outer catch
       }


       
       // Refresh posts and reset edit state

       try {
         await fetchPosts(selectedProfile);

       } catch (fetchError) {

       }
       

       setEditingPost(null);
       setEditFormData({
         summary: '',
         postType: 'UPDATE',
         callToAction: { type: '', url: '' },
         mediaUrls: ['']
       });
       

       showNotification('Post updated successfully!', 'success');

     } catch (error) {
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

  // Handle file upload
  const handleFileUpload = (event) => {
    const files = Array.from(event.target.files);
    setUploadedFiles(prev => [...prev, ...files]);
  };

  // Handle remove uploaded file
  const removeUploadedFile = (index) => {
    setUploadedFiles(prev => prev.filter((_, i) => i !== index));
  };

  // ── Drive picker + AI (shared with Calendar composer) ──
  const currentMediaUrls = () => {
    const fd = editingPost ? editFormData : formData;
    return (fd.mediaUrls || []).map((u) => (u || '').trim()).filter(Boolean);
  };

  const setMediaUrlsOnActive = (updater) => {
    if (editingPost) {
      setEditFormData((prev) => ({ ...prev, mediaUrls: updater(prev.mediaUrls || []) }));
    } else {
      setFormData((prev) => ({ ...prev, mediaUrls: updater(prev.mediaUrls || []) }));
    }
  };

  const handleDrivePicked = (picked) => {
    setMediaUrlsOnActive((prev) => {
      const next = [...prev];
      for (const url of picked) {
        if (next.includes(url)) continue;
        const emptyIdx = next.findIndex((v) => !v || !v.trim());
        if (emptyIdx >= 0) next[emptyIdx] = url;
        else next.push(url);
      }
      return next;
    });
    setDrivePickerOpen(false);
  };

  const handleGenerateAi = async () => {
    setAiError(null);
    setAiJustFilled(false);
    const urls = currentMediaUrls();
    if (urls.length === 0) {
      setAiError('Add at least one image URL first — the AI writes the caption from what it sees.');
      return;
    }
    // Pull business context from the currently-selected profile so the
    // caption sounds grounded in the actual business.
    const profileParts = (selectedProfile || '').split('/');
    const targetAccountId = profileParts[1];
    const targetLocationId = profileParts[profileParts.length - 1];
    let businessName = 'the business';
    let businessType = 'local service business';
    let city = '';
    for (const p of profiles) {
      const accId = p?.name?.split('/').pop();
      if (accId !== targetAccountId) continue;
      const loc = (p.locations || []).find(
        (l) => (l?.name?.split('/').pop() || l?.fullPath?.split('/').pop()) === targetLocationId
      );
      if (loc) {
        businessName = loc.title || loc.locationName || p.accountName || businessName;
        businessType =
          loc.primaryCategory?.displayName ||
          loc.categories?.primaryCategory?.displayName ||
          businessType;
        city = loc.storefrontAddress?.locality || loc.address?.locality || '';
      }
      break;
    }

    setAiGenerating(true);
    setAiImageDescriptions([]);
    const currentPostType = editingPost ? editFormData.postType : formData.postType;
    const currentCta = editingPost ? editFormData.callToAction : formData.callToAction;
    try {
      const resp = await axios.post(
        '/api/ai/post-from-image',
        {
          imageUrls: urls.slice(0, 10),
          businessName,
          businessType,
          city,
          postType: currentPostType,
          includeCallToAction: !!currentCta.type,
          ctaType: currentCta.type || null,
        },
        { timeout: 120000 }
      );
      if (resp.data?.text) {
        if (editingPost) {
          setEditFormData((prev) => ({ ...prev, summary: resp.data.text }));
        } else {
          setFormData((prev) => ({ ...prev, summary: resp.data.text }));
        }
        setAiJustFilled(true);
        setAiImageDescriptions(Array.isArray(resp.data.imageDescriptions) ? resp.data.imageDescriptions : []);
      } else {
        setAiError('AI returned an empty response — try again or edit manually.');
      }
    } catch (err) {
      const status = err?.response?.status;
      const detail = err?.response?.data?.error || err?.message;
      if (status === 429) {
        setAiError(`Daily AI cap reached (${err?.response?.data?.used}/${err?.response?.data?.cap}).`);
      } else {
        setAiError(detail || 'AI generation failed');
      }
    } finally {
      setAiGenerating(false);
    }
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
        <div className="flex space-x-3">
          <button
            onClick={() => {
              fetchPosts(selectedProfile, 1, false, false);
            }}
            disabled={refreshing}
            className="inline-flex items-center px-4 py-2 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh Posts
          </button>
          <button
            onClick={async () => {
              try {
                setRefreshing(true);
                // Clear all caches to get fresh data
                postsService.clearPostsCache();
                postsService.clearMediaCache();
                
                // Force refresh posts for current location
                if (selectedProfile) {
                  const profileParts = selectedProfile.split('/');
                  const locationIdOnly = profileParts[profileParts.length - 1];
                  const accountId = profileParts[1];
                  
                  await postsService.getPostsForLocation(locationIdOnly, accountId, true);
                  await fetchPosts(selectedProfile, 1, false, true);
                }
              } catch (error) {
              } finally {
                setRefreshing(false);
              }
            }}
            disabled={refreshing}
            className="inline-flex items-center px-4 py-2 border border-blue-300 shadow-sm text-sm font-medium rounded-md text-blue-700 bg-blue-50 hover:bg-blue-100 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-blue-500 disabled:opacity-50"
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${refreshing ? 'animate-spin' : ''}`} />
            Refresh All Posts
          </button>
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
            setExpandedPosts(new Set()); // Reset expanded posts when changing profiles
            fetchPosts(e.target.value);
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
           {/* When: publish immediately or schedule (matches Calendar composer).
               Hidden while editing an existing post — schedule vs publish
               only applies to new drafts. */}
           {!editingPost && (
             <div className="mb-4 flex flex-col sm:flex-row sm:items-center gap-3">
               <span className="text-sm font-medium text-gray-700">When:</span>
               <div className="flex items-center gap-1">
                 <button
                   type="button"
                   onClick={() => setPostingMode('now')}
                   className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                     postingMode === 'now'
                       ? 'bg-primary-600 text-white border-primary-600'
                       : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                   }`}
                 >
                   Publish now
                 </button>
                 <button
                   type="button"
                   onClick={() => setPostingMode('later')}
                   className={`px-3 py-1.5 text-sm font-medium rounded-md border ${
                     postingMode === 'later'
                       ? 'bg-primary-600 text-white border-primary-600'
                       : 'bg-white text-gray-700 border-gray-300 hover:bg-gray-50'
                   }`}
                 >
                   Schedule for later
                 </button>
               </div>
               {postingMode === 'later' && (
                 <input
                   type="datetime-local"
                   value={scheduledAt}
                   onChange={(e) => setScheduledAt(e.target.value)}
                   className="block sm:w-auto border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 text-sm"
                 />
               )}
             </div>
           )}
           <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
             {/* Left Column - Form */}
             <div className="lg:col-span-2 space-y-4">
               {/* Picture Upload Section - Moved to Top */}
               <div>
                 <label className="block text-sm font-medium text-gray-700 mb-2">Add Pictures</label>
                 
                 {/* File Upload Section */}
                 <div className="mb-4 space-y-4">
                   {/* Direct File Upload */}
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-2">
                       Upload Image Files (Direct to Database)
                     </label>
                     <input
                       type="file"
                       multiple
                       accept="image/*"
                       onChange={handleFileUpload}
                       className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-semibold file:bg-primary-50 file:text-primary-700 hover:file:bg-primary-100"
                     />
                     {uploadedFiles.length > 0 && (
                       <div className="mt-2">
                         <p className="text-sm text-gray-600">
                           Selected files: {uploadedFiles.length}
                         </p>
                         <div className="flex flex-wrap gap-2 mt-1">
                           {uploadedFiles.map((file, index) => (
                             <span
                               key={index}
                               className="inline-flex items-center px-2 py-1 rounded-full text-xs font-medium bg-green-100 text-green-800"
                             >
                               {file.name}
                               <button
                                 type="button"
                                 onClick={() => removeUploadedFile(index)}
                                 className="ml-1 text-green-600 hover:text-green-800"
                               >
                                 ×
                               </button>
                             </span>
                           ))}
                         </div>
                       </div>
                     )}
                   </div>

                   {/* ImgBB URL Upload (for backward compatibility) */}
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-2">
                       Upload via URL (ImgBB Service)
                     </label>
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
                           Upload Images via URL
                         </>
                       )}
                     </button>
                   </div>

                   {/* Google Drive picker — same as the Calendar composer */}
                   <div>
                     <label className="block text-sm font-medium text-gray-700 mb-2">
                       Pick from Google Drive
                     </label>
                     <button
                       type="button"
                       onClick={() => setDrivePickerOpen(true)}
                       className="inline-flex items-center px-4 py-3 border border-primary-300 shadow-sm text-sm font-medium rounded-md text-primary-700 bg-primary-50 hover:bg-primary-100"
                     >
                       <HardDrive className="h-5 w-5 mr-2" />
                       Browse Drive
                     </button>
                     <p className="mt-1 text-xs text-gray-500">
                       Browse folders across every connected Google account. Duplicates are flagged.
                     </p>
                   </div>
                 </div>


               </div>

                               {/* Description Section */}
                <div>
                  <div className="flex items-center justify-between">
                    <label className="block text-sm font-medium text-gray-700">
                      Description
                      <span className="text-gray-500 font-normal ml-2">
                        ({(editingPost ? editFormData.summary : formData.summary).length}/1500)
                      </span>
                    </label>
                    <button
                      type="button"
                      onClick={handleGenerateAi}
                      disabled={aiGenerating || currentMediaUrls().length === 0}
                      className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded-md text-xs font-medium border transition-colors ${
                        aiGenerating || currentMediaUrls().length === 0
                          ? 'text-gray-400 border-gray-200 bg-white cursor-not-allowed'
                          : 'text-primary-700 border-primary-300 bg-primary-50 hover:bg-primary-100'
                      }`}
                      title={
                        currentMediaUrls().length === 0
                          ? 'Add at least one image URL to generate a caption from it'
                          : 'Write a caption from the selected image(s)'
                      }
                    >
                      <Sparkles className={`h-3.5 w-3.5 ${aiGenerating ? 'animate-pulse' : ''}`} />
                      {aiGenerating
                        ? 'Generating…'
                        : (editingPost ? editFormData.summary : formData.summary)
                        ? 'Regenerate with AI'
                        : 'Generate with AI'}
                    </button>
                  </div>
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
                  {aiError && (
                    <p className="mt-1 text-xs text-red-700">{aiError}</p>
                  )}
                  {aiJustFilled && (
                    <p className="mt-1 text-xs text-primary-700">
                      ✨ AI-generated from your image{currentMediaUrls().length > 1 ? 's' : ''} — edit before posting if anything is off.
                    </p>
                  )}
                  {aiImageDescriptions.length > 0 && (
                    <details className="mt-2 rounded-md border border-gray-200 bg-gray-50">
                      <summary className="cursor-pointer px-3 py-2 text-xs font-medium text-gray-700 select-none">
                        What the AI saw ({aiImageDescriptions.length} image{aiImageDescriptions.length === 1 ? '' : 's'})
                      </summary>
                      <ul className="px-3 pb-3 pt-1 space-y-1 text-xs text-gray-700">
                        {aiImageDescriptions.map((desc, i) => (
                          <li key={i}>
                            <span className="font-medium text-gray-500">Image {i + 1}:</span> {desc}
                          </li>
                        ))}
                      </ul>
                    </details>
                  )}
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

               {/* Call to Action Type — labels match Google Business Profile Add-post UI */}
               <div>
                 <label className="block text-sm font-medium text-gray-700">Call to Action Type</label>
                 <select
                   value={editingPost ? editFormData.callToAction.type : formData.callToAction.type}
                   onChange={(e) => {
                     const nextType = e.target.value;
                     const prev = editingPost ? editFormData.callToAction : formData.callToAction;
                     // Clear the URL/phone value when switching between phone- and
                     // URL-shaped inputs — the old value won't validate as the new
                     // kind and only confuses the user.
                     const switching = isCallCta(prev.type) !== isCallCta(nextType);
                     const nextCta = { type: nextType, url: switching ? '' : prev.url };
                     if (editingPost) {
                       setEditFormData({ ...editFormData, callToAction: nextCta });
                     } else {
                       setFormData({ ...formData, callToAction: nextCta });
                     }
                   }}
                   className="mt-1 block w-full border-gray-300 rounded-md shadow-sm focus:ring-primary-500 focus:border-primary-500 sm:text-sm"
                 >
                   {CTA_OPTIONS.map((o) => (
                     <option key={o.v || 'none'} value={o.v}>
                       {o.label}
                     </option>
                   ))}
                 </select>
               </div>

               {/* Call to Action URL or Phone Number */}
               {(editingPost ? editFormData.callToAction.type : formData.callToAction.type) && (
                 <div>
                   <label className="block text-sm font-medium text-gray-700">
                     {isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                       ? 'Phone number'
                       : 'Call to Action URL'}
                   </label>
                   <input
                     type={
                       isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                         ? 'tel'
                         : 'url'
                     }
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
                     placeholder={
                       isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                         ? '(904) 902-0402'
                         : 'https://example.com'
                     }
                   />
                   <p className="mt-1 text-xs text-gray-500">
                     {isCallCta(editingPost ? editFormData.callToAction.type : formData.callToAction.type)
                       ? 'Customers will call this number when they tap the button.'
                       : 'Where the button sends people when tapped.'}
                   </p>
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
                       {postingMode === 'later' ? 'Scheduling…' : 'Creating Post...'}
                     </>
                   ) : updatingPost ? (
                     <>
                       <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-white mr-2 inline-block"></div>
                       Updating Post...
                     </>
                   ) : (
                     editingPost
                       ? 'Update Post'
                       : postingMode === 'later'
                       ? 'Schedule Post'
                       : 'Create Post'
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
                                 {/* Drive-aware preview: auth'd proxy for
                                     Drive URLs so files that haven't been
                                     publicly shared still render. */}
                                 <SmartPreviewImage
                                   url={url}
                                   alt={`Preview ${index + 1}`}
                                   className="w-full h-56 object-cover rounded-lg border shadow-sm"
                                 />
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
                          <h4 className="text-sm font-medium text-gray-500 mb-2">
                            {(postingMode === 'later' && scheduledAt
                              ? new Date(scheduledAt)
                              : new Date()
                            ).toLocaleDateString(undefined, {
                              month: 'short',
                              day: 'numeric',
                              year: 'numeric',
                            })}
                          </h4>
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
              {refreshing && (
                <div className="flex items-center text-sm text-blue-600">
                  <svg className="animate-spin -ml-1 mr-2 h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                    <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                    <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
                  </svg>
                  Refreshing...
                </div>
              )}
            </div>
            <button
              onClick={() => {
                setExpandedPosts(new Set()); // Reset expanded posts when refreshing
                fetchPosts(selectedProfile, 1, false, false); // Use cache (don't force refresh)
              }}
              className="inline-flex items-center px-3 py-1 border border-gray-300 shadow-sm text-sm font-medium rounded-md text-gray-700 bg-white hover:bg-gray-50"
            >
              <Clock className="h-4 w-4 mr-1" />
              Refresh Posts
            </button>
          </div>
          <div className="p-6">
            {posts.length > 0 ? (
              <>
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4 md:gap-6">
                  {posts.map((post, index) => {








                     if (post.media && post.media.length > 0) {



                     }
                     
                     // Additional CTA debugging
                     if (post.callToAction) {





                     }

                     
                     return (
                       <div key={`${post.id}-${post.createdAt}`} className="bg-white rounded-lg shadow-sm hover:shadow-md transition-shadow duration-200 overflow-hidden">
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

                               if (!imageUrl) {

                                 return (
                                   <div key={`${post.id}-media-${index}`} className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                     No image available
                                   </div>
                                 );
                               }
                               
                               // Additional validation for image URL
                               if (typeof imageUrl !== 'string' || imageUrl.trim() === '') {

                                 return (
                                   <div key={`${post.id}-media-${index}`} className="w-full h-48 bg-gray-200 rounded-t-lg flex items-center justify-center text-sm text-gray-500">
                                     Invalid image URL
                                   </div>
                                 );
                               }
                               
                               return (
                                 <div key={`${post.id}-media-${index}`} className="relative group">
                                   <PostImage
                                     imageUrl={imageUrl}
                                     altText={mediaItem.altText || 'Post image'}
                                     mediaFormat={mediaItem.mediaFormat}
                                     mediaData={mediaItem}
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

      {drivePickerOpen && (
        <DrivePickerModal
          existingUrls={currentMediaUrls()}
          onClose={() => setDrivePickerOpen(false)}
          onPick={handleDrivePicked}
        />
      )}

    </div>
  );
};

export default Posts;
