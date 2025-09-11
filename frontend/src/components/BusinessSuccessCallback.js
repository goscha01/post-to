import React, { useEffect, useRef } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

const BusinessSuccessCallback = () => {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { handleAuthCallback } = useAuth();
  const processedRef = useRef(false);
  
  useEffect(() => {
    // Prevent multiple executions
    if (processedRef.current) return;
    
    const token = searchParams.get('token');
    const refreshToken = searchParams.get('refreshToken');
    
    console.log('BusinessSuccessCallback: Token from URL:', token ? 'Token received' : 'No token');
    console.log('BusinessSuccessCallback: Refresh token from URL:', refreshToken ? 'Refresh token received' : 'No refresh token');
    
    if (token) {
      processedRef.current = true;
      
      // Handle the business success callback with refresh token
      handleAuthCallback(token, null, refreshToken, true);
      
      // Set business connection flag
      localStorage.setItem('gmb_business_connected', 'true');
      
      // Show success message briefly then redirect
      setTimeout(() => {
        navigate('/profiles');
      }, 2000);
    } else {
      console.error('Missing token in business success callback');
      navigate('/profiles?error=missing_token');
    }
  }, [navigate, searchParams]); // Removed handleAuthCallback from dependencies

  return (
    <div className="min-h-screen flex items-center justify-center bg-gray-50">
      <div className="max-w-md w-full bg-white rounded-lg shadow-md p-8 text-center">
        <div className="mb-4">
          <svg className="mx-auto h-12 w-12 text-green-500" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
          </svg>
        </div>
        <h2 className="text-2xl font-bold text-gray-900 mb-2">
          Business Account Connected!
        </h2>
        <p className="text-gray-600 mb-6">
          Your Google My Business account has been successfully connected. 
          You can now manage your business profiles and posts.
        </p>
        <div className="flex items-center justify-center">
          <div className="animate-spin rounded-full h-5 w-5 border-b-2 border-primary-600 mr-3"></div>
          <span className="text-sm text-gray-500">Redirecting to business profiles...</span>
        </div>
      </div>
    </div>
  );
};

export default BusinessSuccessCallback;