import React, { createContext, useContext, useState, useEffect } from 'react';
import axios from 'axios';

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
  const [token, setToken] = useState(localStorage.getItem('gmb_token'));
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
          const payload = JSON.parse(atob(token.split('.')[1]));
          console.log('JWT payload:', payload);
          const userData = {
            id: payload.userId,
            email: payload.email,
            googleId: payload.googleId,
            name: payload.name || payload.email?.split('@')[0] || 'User',
            picture_url: payload.picture_url
          };
          console.log('Setting user data:', userData);
          setUser(userData);
        } catch (jwtError) {
          console.error('Error parsing JWT token:', jwtError);
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

  const handleAuthCallback = (newToken, googleAccessToken, googleRefreshToken, isBusinessConnection = false) => {
    console.log('Handling auth callback with token:', newToken ? 'Token received' : 'No token');
    console.log('Google access token received:', googleAccessToken ? 'Yes' : 'No');
    console.log('Google refresh token received:', googleRefreshToken ? 'Yes' : 'No');
    console.log('Business connection:', isBusinessConnection);
    
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
      const payload = JSON.parse(atob(newToken.split('.')[1]));
      setUser({
        id: payload.userId,
        email: payload.email,
        googleId: payload.googleId,
        name: payload.name || payload.email?.split('@')[0] || 'User',
        picture_url: payload.picture_url
      });
    } catch (jwtError) {
      console.error('Error parsing JWT token:', jwtError);
    }
    
    axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;
    console.log('AuthContext: Setting isAuthenticated to true in handleAuthCallback');
    setIsAuthenticated(true);
    setLoading(false);
    console.log('Authentication state updated');
  };

  const logout = () => {
    setUser(null);
    setToken(null);
    setIsAuthenticated(false);
    localStorage.removeItem('gmb_token');
    localStorage.removeItem('gmb_business_connected');
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
    console.log('AuthContext: User reconnecting');
  };

  const refreshToken = async () => {
    try {
      const refreshToken = localStorage.getItem('gmb_refresh_token');
      if (!refreshToken) {
        throw new Error('No refresh token available');
      }

      const response = await axios.post('http://localhost:3001/auth/refresh', {
        refreshToken
      });

      const newToken = response.data.access_token;
      setToken(newToken);
      localStorage.setItem('gmb_token', newToken);
      axios.defaults.headers.common['Authorization'] = `Bearer ${newToken}`;

      return newToken;
    } catch (error) {
      console.error('Token refresh failed:', error);
      logout();
      throw error;
    }
  };

  // Axios interceptor for automatic token refresh
  useEffect(() => {
    const interceptor = axios.interceptors.response.use(
      (response) => response,
      async (error) => {
        if (error.response?.status === 401 && token && !isDisconnected) {
          try {
            await refreshToken();
            // Retry the original request
            return axios.request(error.config);
          } catch (refreshError) {
            logout();
            return Promise.reject(refreshError);
          }
        }
        return Promise.reject(error);
      }
    );

    return () => {
      axios.interceptors.response.eject(interceptor);
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
