import axios from 'axios';
import apiTracker from './apiTracker';

// Create a configured axios instance.
// Production: REACT_APP_API_URL is set to the Railway backend URL on Vercel.
// Local dev: falls back to localhost:3001.
//
// Default timeout is 60s — was 10s but that reliably tripped for anything
// that does real work: multipart /api/posts uploads with images, AI vision
// on multi-image sets, Drive proxy fetches through OAuth. Individual calls
// that need longer override per-request (see AI post-from-image below).
const axiosInstance = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:3001',
  timeout: 60000,
});

// Setup request interceptor for logging
axiosInstance.interceptors.request.use(
  (config) => {
    return config;
  },
  (error) => {
    return Promise.reject(error);
  }
);

export default axiosInstance;