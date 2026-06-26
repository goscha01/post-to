import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from '../utils/axiosConfig';
import rlog from '../utils/remoteLogger';
import userProfileService from '../services/userProfileService';
import businessProfileService from '../services/businessProfileService';
import postsService from '../services/postsService';
import reviewsMediaService from '../services/reviewsMediaService';
import servicesMediaService from '../services/servicesMediaService';
import insightsService from '../services/insightsService';
import sessionCacheConfig from '../config/sessionCacheConfig';

const AuthContext = createContext();

export const useAuth = () => {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
};

export const AuthProvider = ({ children }) => {
  const [user, setUser] = useState(null);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [loading, setLoading] = useState(true);
  const [token, setToken] = useState(() => {
    const storedToken = localStorage.getItem('gmb_token');
    
    // Validate token format on initialization
    if (storedToken) {
      // Check if it's a Google access token (starts with ya29.) or invalid JWT
      if (storedToken.startsWith('ya29.') || storedToken.split('.').length !== 3) {
        localStorage.removeItem('gmb_token');
        localStorage.removeItem('gmb_business_connected');
        localStorage.removeItem('gmb_google_access_token');
        localStorage.removeItem('gmb_refresh_token');
        return null;
      }
    }
    
    return storedToken;
  });
  const [isDisconnected, setIsDisconnected] = useState(false);

  // Configure axios defaults
  useEffect(() => {
    
    if (token && !isDisconnected) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      setIsAuthenticated(true);
      
      // Start new session for caching
      sessionCacheConfig.startNewSession();
      
      fetchUserProfile();
    } else if (isDisconnected) {
      // If disconnected, keep user authenticated for UI but don't set auth headers
      setIsAuthenticated(true);
      setLoading(false);
    } else {
      setLoading(false);
    }
  }, [token, isDisconnected]);

  const fetchUserProfile = async () => {
    try {
      // Extract user info from JWT token
      if (token) {
        try {
          // Check if it's a Google access token (not a JWT)
          if (token.startsWith('ya29.')) {
            throw new Error('Google access token found instead of JWT - clearing invalid token');
          }
          
          // Validate JWT token format before parsing
          const tokenParts = token.split('.');
          if (tokenParts.length !== 3) {
            throw new Error('Invalid JWT token format');
          }
          
          // Decode base64 payload safely
          const payload = JSON.parse(atob(tokenParts[1]));
          const userData = {
            id: payload.userId,
            email: payload.email,
            googleId: payload.googleId,
            name: payload.name || payload.email?.split('@')[0] || 'User',
            picture_url: payload.picture_url
          };

          // Process and cache user profile picture
          // Small delay to ensure token is properly stored
          await new Promise(resolve => setTimeout(resolve, 100));
          const userWithCachedImage = await userProfileService.processUserProfilePicture(userData);
          setUser(userWithCachedImage);
        } catch (jwtError) {
          // Clear invalid token and logout
          logout();
          return;
        }
      }
      setLoading(false);
    } catch (error) {
      logout();
    }
  };

  const login = async (forceConsent = false) => {
    rlog('info', 'AuthContext', 'login.start', { forceConsent });
    try {
      const url = forceConsent
        ? '/auth/google?force_consent=true'
        : '/auth/google';
      const response = await axios.get(url);
      rlog('info', 'AuthContext', 'login.gotAuthUrl', { status: response.status, hasAuthUrl: !!response.data?.authUrl });
      window.location.href = response.data.authUrl;
    } catch (error) {
      rlog('error', 'AuthContext', 'login.error', {
        status: error.response?.status,
        data: error.response?.data,
        message: error.message
      });
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.retryAfter || 2;
        alert(`Too many requests. Please wait ${retryAfter} seconds and try again.`);
      }
    }
  };

  const loginForBusiness = async () => {
    try {
      if (!user?.id) {
        throw new Error('User must be authenticated to connect business profile');
      }
      const response = await axios.get(`/auth/google/business?user_id=${user.id}`);
      window.location.href = response.data.authUrl;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.retryAfter || 2;
        alert(`Too many requests. Please wait ${retryAfter} seconds and try again.`);
      } else {
        alert('Failed to initiate business authentication. Please try again.');
      }
    }
  };

  const handleAuthCallback = async (newToken, googleAccessToken, googleRefreshToken, isBusinessConnection = false) => {
    rlog('info', 'AuthContext', 'handleAuthCallback.start', {
      hasNewToken: !!newToken,
      tokenLen: newToken?.length || 0,
      tokenStart: newToken?.slice(0, 12),
      hasGoogleAccess: !!googleAccessToken,
      hasGoogleRefresh: !!googleRefreshToken,
      isBusinessConnection
    });

    setToken(newToken);
    localStorage.setItem('gmb_token', newToken);
    
    // Only store Google tokens if they exist (for business authentication)
    if (googleAccessToken) {
      localStorage.setItem('gmb_google_access_token', googleAccessToken);
    }
    if (googleRefreshToken) {
      localStorage.setItem('gmb_refresh_token', googleRefreshToken);
    }
    
    // Store business connection status
    if (isBusinessConnection) {
      localStorage.setItem('gmb_business_connected', 'true');
    }
    
    // Extract user info from JWT token
    try {
      // Check if it's a Google access token (not a JWT)
      if (newToken.startsWith('ya29.')) {
        throw new Error('Google access token received instead of JWT - this should not happen');
      }
      
      // Validate JWT token format before parsing
      const tokenParts = newToken.split('.');
      if (tokenParts.length !== 3) {
        throw new Error('Invalid JWT token format');
      }
      
      const payload = JSON.parse(atob(tokenParts[1]));
      const userData = {
        id: payload.userId,
        email: payload.email,
        googleId: payload.googleId,
        name: payload.name || payload.email?.split('@')[0] || 'User',
        picture_url: payload.picture_url
      };

      // Process and cache user profile picture
      // Small delay to ensure token is properly stored
      await new Promise(resolve => setTimeout(resolve, 100));
      const userWithCachedImage = await userProfileService.processUserProfilePicture(userData);
      setUser(userWithCachedImage);
      rlog('info', 'AuthContext', 'handleAuthCallback.userSet', { userId: userData.id, email: userData.email });
    } catch (jwtError) {
      rlog('error', 'AuthContext', 'handleAuthCallback.jwtDecodeFailed', {
        message: jwtError.message,
        tokenStart: newToken?.slice(0, 12)
      });
      // Clear invalid token
      localStorage.removeItem('gmb_token');
      setToken(null);
    }
    
    axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setIsAuthenticated(true);
    setLoading(false);
  };

  const logout = () => {
    
    // Clear all frontend service caches only
    businessProfileService.clearCache();
    postsService.clearCache();
    reviewsMediaService.clearCache();
    servicesMediaService.clearCache();
    insightsService.clearCache();
    
    // Clear user profile picture cache before logging out
    if (user?.id) {
      userProfileService.clearUserProfileCache(user.id);
    }

    // Clear session cache configuration
    sessionCacheConfig.clearSessionCache();

    setUser(null);
    setToken(null);
    setIsAuthenticated(false);
    localStorage.removeItem('gmb_token');
    localStorage.removeItem('gmb_business_connected');
    localStorage.removeItem('gmb_google_access_token');
    localStorage.removeItem('gmb_refresh_token');
    delete axios.defaults.headers.common['Authorization'];
    
  };

  const softDisconnect = () => {
    
    // Clear all frontend service caches only
    businessProfileService.clearCache();
    postsService.clearCache();
    reviewsMediaService.clearCache();
    servicesMediaService.clearCache();
    insightsService.clearCache();
    
    // Clear session cache configuration
    sessionCacheConfig.clearSessionCache();
    
    // Soft disconnect - clear tokens but keep user authenticated for UI purposes
    localStorage.removeItem('gmb_token');
    localStorage.removeItem('gmb_google_access_token');
    localStorage.removeItem('gmb_refresh_token');
    localStorage.removeItem('gmb_business_connected');
    delete axios.defaults.headers.common['Authorization'];
    setToken(null);
    setIsDisconnected(true);
  };

  const reconnect = () => {
    // Reset disconnect state to allow reconnection
    setIsDisconnected(false);
  };

  const refreshToken = async () => {
    try {
      // Prevent multiple simultaneous refresh calls
      if (window.refreshInProgress) {
        return null;
      }
      
      window.refreshInProgress = true;
      
      const refreshToken = localStorage.getItem('gmb_refresh_token');
      
      // Debug all localStorage items
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('gmb')) {
        }
      }
      
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const response = await axios.post('/auth/refresh', {
        refreshToken
      });

      
      const newToken = response.data.access_token;
      
      setToken(newToken);
      localStorage.setItem('gmb_token', newToken);
      axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
      

      return newToken;
    } catch (error) {
      
      // Handle rate limiting specifically
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.retryAfter || 5;
        
        // Wait before retrying (but don't logout immediately)
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        
        // Try once more
        try {
          const response = await axios.post('/auth/refresh', {
            refreshToken: localStorage.getItem('gmb_refresh_token')
          });
          
          const newToken = response.data.access_token;
          setToken(newToken);
          localStorage.setItem('gmb_token', newToken);
          axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
          
          return newToken;
        } catch (retryError) {
          logout();
          throw retryError;
        }
      } else {
        // For other errors, logout immediately
        logout();
        throw error;
      }
    } finally {
      window.refreshInProgress = false;
    }
  };

  // Axios interceptors for automatic token refresh
  useEffect(() => {
    // Request interceptor to add token to all requests
    const requestInterceptor = axios.interceptors.request.use(
      (config) => {
        const currentToken = localStorage.getItem('gmb_token');
        if (currentToken) {
          config.headers.Authorization = `Bearer ${currentToken}`;
        } else {
        }
        return config;
      },
      (error) => Promise.reject(error)
    );

    // Response interceptor for automatic token refresh
    const responseInterceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        // Handle 401 errors with token refresh
        if (error.response?.status === 401 && token && !isDisconnected) {
          try {
            const newToken = await refreshToken();
            
            if (newToken) {
              // Update the original request with the new token
              error.config.headers.Authorization = `Bearer ${newToken}`;
              return axios.request(error.config);
            } else {
              logout();
              return Promise.reject(error);
            }
          } catch (refreshError) {
            // Only logout if it's not a rate limit error
            if (refreshError.response?.status !== 429) {
              logout();
            }
            return Promise.reject(refreshError);
          }
        }
        
        // Handle 429 errors with better messaging
        if (error.response?.status === 429) {
          const retryAfter = error.response.data.retryAfter || 5;
          
          // Wait and retry once
          await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
          return axios.request(error.config);
        }
        
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.request.eject(requestInterceptor);
      axios.interceptors.response.eject(responseInterceptor);
    };
  }, [token, isDisconnected]);

  const value = {
    user,
    isAuthenticated,
    loading,
    token,
    isDisconnected,
    login,
    loginForBusiness,
    logout,
    softDisconnect,
    reconnect,
    handleAuthCallback,
    refreshToken
  };

  return (
    <AuthContext.Provider value={value}>
      {children}
    </AuthContext.Provider>
  );
};
