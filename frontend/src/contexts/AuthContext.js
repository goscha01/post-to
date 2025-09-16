import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from '../utils/axiosConfig';
import userProfileService from '../services/userProfileService';

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
        console.error('Invalid token format found in localStorage (Google access token or malformed JWT), clearing it');
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
    console.log('AuthContext: Token changed to:', token ? 'Token exists' : 'No token');
    console.log('AuthContext: isDisconnected:', isDisconnected);
    
    if (token && !isDisconnected) {
      axios.defaults.headers.common['Authorization'] = `Bearer ${token}`;
      setIsAuthenticated(true);
      console.log('AuthContext: Setting isAuthenticated to true');
      fetchUserProfile();
    } else if (isDisconnected) {
      // If disconnected, keep user authenticated for UI but don't set auth headers
      setIsAuthenticated(true);
      setLoading(false);
      console.log('AuthContext: User is disconnected but keeping UI authenticated');
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
          console.error('Error parsing JWT token:', jwtError);
          // Clear invalid token and logout
          logout();
          return;
        }
      }
      setLoading(false);
    } catch (error) {
      console.error('Error fetching user profile:', error);
      logout();
    }
  };

  const login = async (forceConsent = false) => {
    try {
      const url = forceConsent 
        ? 'http://localhost:3001/auth/google?force_consent=true'
        : 'http://localhost:3001/auth/google';
      const response = await axios.get(url);
      window.location.href = response.data.authUrl;
    } catch (error) {
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
      const response = await axios.get(`http://localhost:3001/auth/google/business?user_id=${user.id}`);
      window.location.href = response.data.authUrl;
    } catch (error) {
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.retryAfter || 2;
        alert(`Too many requests. Please wait ${retryAfter} seconds and try again.`);
      } else {
        console.error('Business authentication error:', error);
        alert('Failed to initiate business authentication. Please try again.');
      }
    }
  };

  const handleAuthCallback = async (newToken, googleAccessToken, googleRefreshToken, isBusinessConnection = false) => {
    
    setToken(newToken);
    localStorage.setItem('gmb_token', newToken);
    
    // Only store Google tokens if they exist (for business authentication)
    if (googleAccessToken) {
      localStorage.setItem('gmb_google_access_token', googleAccessToken);
    }
    if (googleRefreshToken) {
      localStorage.setItem('gmb_refresh_token', googleRefreshToken);
      console.log('🔑 Storing refresh token:', googleRefreshToken.substring(0, 20) + '...');
      console.log('🔑 Refresh token length:', googleRefreshToken.length);
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
    } catch (jwtError) {
      console.error('Error parsing JWT token:', jwtError);
      // Clear invalid token
      localStorage.removeItem('gmb_token');
      setToken(null);
    }
    
    axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    setIsAuthenticated(true);
    setLoading(false);
  };

  const logout = () => {
    // Clear user profile picture cache before logging out
    if (user?.id) {
      userProfileService.clearUserProfileCache(user.id);
    }

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
    // Soft disconnect - clear tokens but keep user authenticated for UI purposes
    localStorage.removeItem('gmb_token');
    localStorage.removeItem('gmb_google_access_token');
    localStorage.removeItem('gmb_refresh_token');
    localStorage.removeItem('gmb_business_connected');
    delete axios.defaults.headers.common['Authorization'];
    setToken(null);
    setIsDisconnected(true);
    console.log('AuthContext: User disconnected (soft disconnect)');
  };

  const reconnect = () => {
    // Reset disconnect state to allow reconnection
    setIsDisconnected(false);
  };

  const refreshToken = async () => {
    try {
      // Prevent multiple simultaneous refresh calls
      if (window.refreshInProgress) {
        console.log('🔄 Refresh already in progress, skipping...');
        return null;
      }
      
      window.refreshInProgress = true;
      
      const refreshToken = localStorage.getItem('gmb_refresh_token');
      console.log('🔄 Attempting token refresh...');
      console.log('🔄 Refresh token available:', !!refreshToken);
      console.log('🔄 Refresh token length:', refreshToken ? refreshToken.length : 0);
      console.log('🔄 Refresh token starts with:', refreshToken ? refreshToken.substring(0, 20) + '...' : 'null');
      
      // Debug all localStorage items
      console.log('🔍 All localStorage items:');
      for (let i = 0; i < localStorage.length; i++) {
        const key = localStorage.key(i);
        if (key && key.includes('gmb')) {
          console.log(`🔍 ${key}:`, localStorage.getItem(key) ? 'exists' : 'null');
        }
      }
      
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      console.log('🔄 Sending refresh request to backend...');
      const response = await axios.post('http://localhost:3001/auth/refresh', {
        refreshToken
      });

      console.log('🔄 Refresh response received:', response.status);
      console.log('🔄 Response data:', response.data);
      
      const newToken = response.data.access_token;
      console.log('🔄 New token received:', newToken ? 'exists' : 'null');
      console.log('🔄 New token length:', newToken ? newToken.length : 0);
      
      setToken(newToken);
      localStorage.setItem('gmb_token', newToken);
      axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
      
      console.log('🔄 Token updated in localStorage and axios headers');

      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', error);
      
      // Handle rate limiting specifically
      if (error.response?.status === 429) {
        const retryAfter = error.response.data.retryAfter || 5;
        
        // Wait before retrying (but don't logout immediately)
        await new Promise(resolve => setTimeout(resolve, retryAfter * 1000));
        
        // Try once more
        try {
          const response = await axios.post('http://localhost:3001/auth/refresh', {
            refreshToken: localStorage.getItem('gmb_refresh_token')
          });
          
          const newToken = response.data.access_token;
          setToken(newToken);
          localStorage.setItem('gmb_token', newToken);
          axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
          
          return newToken;
        } catch (retryError) {
          console.error('Token refresh retry failed:', retryError);
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
          console.log('🔑 Adding token to request:', config.url);
          console.log('🔑 Token length:', currentToken.length);
          console.log('🔑 Token starts with:', currentToken.substring(0, 20) + '...');
        } else {
          console.log('🔑 No token available for request:', config.url);
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
            console.log('🔄 401 error detected, refreshing token...');
            const newToken = await refreshToken();
            
            if (newToken) {
              console.log('🔄 Token refreshed, updating request headers...');
              // Update the original request with the new token
              error.config.headers.Authorization = `Bearer ${newToken}`;
              console.log('🔄 Retrying request with new token...');
              return axios.request(error.config);
            } else {
              console.log('🔄 No new token received, logging out...');
              logout();
              return Promise.reject(error);
            }
          } catch (refreshError) {
            console.log('🔄 Token refresh failed:', refreshError.message);
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
