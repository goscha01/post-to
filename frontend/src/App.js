import React, { useState, useEffect } from 'react';
import { BrowserRouter as Router, Routes, Route, Navigate, useNavigate } from 'react-router-dom';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './components/Login';
import Dashboard from './components/Dashboard';
import BusinessProfiles from './components/BusinessProfiles';
import Posts from './components/Posts';
import Reviews from './components/Reviews';
import Insights from './components/Insights';
import Services from './components/Services';
import Layout from './components/Layout';
import './App.css';

// Protected Route Component
const ProtectedRoute = ({ children }) => {
  const { isAuthenticated, loading } = useAuth();
  
  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <div className="animate-spin rounded-full h-32 w-32 border-b-2 border-primary-600"></div>
      </div>
    );
  }
  
  return isAuthenticated ? children : <Navigate to="/login" />;
};

// Main App Component
const AppContent = () => {
  const { isAuthenticated } = useAuth();

  return (
    <Router future={{ v7_startTransition: true, v7_relativeSplatPath: true }}>
      <Routes>
        <Route path="/login" element={!isAuthenticated ? <Login /> : <Navigate to="/dashboard" />} />
        <Route path="/auth/callback" element={<AuthCallback />} />
        <Route path="/auth/error" element={<AuthError />} />
        <Route path="/" element={<Navigate to="/dashboard" />} />
        <Route
          path="/dashboard"
          element={
            <ProtectedRoute>
              <Layout>
                <Dashboard />
              </Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/profiles"
          element={
            <ProtectedRoute>
              <Layout>
                <BusinessProfiles />
              </Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/posts"
          element={
            <ProtectedRoute>
              <Layout>
                <Posts />
              </Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/reviews"
          element={
            <ProtectedRoute>
              <Layout>
                <Reviews />
              </Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/insights"
          element={
            <ProtectedRoute>
              <Layout>
                <Insights />
              </Layout>
            </ProtectedRoute>
          }
        />
        <Route
          path="/services"
          element={
            <ProtectedRoute>
              <Layout>
                <Services />
              </Layout>
            </ProtectedRoute>
          }
        />
      </Routes>
    </Router>
  );
};

// Auth Callback Component
const AuthCallback = () => {
  const { handleAuthCallback, isAuthenticated } = useAuth();
  const navigate = useNavigate();
  
  useEffect(() => {
    const urlParams = new URLSearchParams(window.location.search);
    const token = urlParams.get('token');
    const googleAccessToken = urlParams.get('google_access_token');
    const googleRefreshToken = urlParams.get('google_refresh_token');
    const businessConnected = urlParams.get('business_connected');
    
    console.log('AuthCallback: Token from URL:', token ? 'Token received' : 'No token');
    console.log('AuthCallback: Google access token from URL:', googleAccessToken ? 'Token received' : 'No token');
    console.log('AuthCallback: Google refresh token from URL:', googleRefreshToken ? 'Token received' : 'No token');
    console.log('AuthCallback: Business connected:', businessConnected === 'true');
    
    if (token && googleAccessToken && googleRefreshToken) {
      handleAuthCallback(token, googleAccessToken, googleRefreshToken, businessConnected === 'true');
    } else {
      console.error('Missing required tokens:', { token: !!token, googleAccessToken: !!googleAccessToken, googleRefreshToken: !!googleRefreshToken });
    }
  }, [handleAuthCallback]);

  useEffect(() => {
    console.log('AuthCallback: isAuthenticated changed to:', isAuthenticated);
    if (isAuthenticated) {
      const urlParams = new URLSearchParams(window.location.search);
      const businessConnected = urlParams.get('business_connected');
      
      if (businessConnected === 'true') {
        console.log('AuthCallback: Business connection successful, redirecting to profiles');
        navigate('/profiles');
      } else {
        console.log('AuthCallback: Regular authentication, redirecting to dashboard');
        navigate('/dashboard');
      }
    }
  }, [isAuthenticated, navigate]);

  return (
    <div className="min-h-screen flex items-center justify-center">
      <div className="text-center">
        <div className="animate-spin rounded-full h-16 w-16 border-b-2 border-primary-600 mx-auto mb-4"></div>
        <p className="text-gray-600">Completing authentication...</p>
      </div>
    </div>
  );
};

// Auth Error Component
const AuthError = () => {
  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-md p-6">
        <div className="text-center">
          <div className="mx-auto flex items-center justify-center h-12 w-12 rounded-full bg-red-100 mb-4">
            <svg className="h-6 w-6 text-red-600" fill="none" viewBox="0 0 24 24" stroke="currentColor">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </div>
          <h3 className="text-lg font-medium text-gray-900 mb-2">Authentication Failed</h3>
          <p className="text-gray-600 mb-6">
            There was an error during the authentication process. Please try again.
          </p>
          <a
            href="/login"
            className="inline-flex items-center px-4 py-2 border border-transparent text-sm font-medium rounded-md text-white bg-primary-600 hover:bg-primary-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-primary-500"
          >
            Try Again
          </a>
        </div>
      </div>
    </div>
  );
};

// Main App Component with Provider
const App = () => {
  return (
    <AuthProvider>
      <AppContent />
    </AuthProvider>
  );
};

export default App;
