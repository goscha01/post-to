import axios from 'axios';
import apiTracker from './apiTracker';

// Create a configured axios instance.
// Production: REACT_APP_API_URL is set to the Railway backend URL on Vercel.
// Local dev: falls back to localhost:3001.
const axiosInstance = axios.create({
  baseURL: process.env.REACT_APP_API_URL || 'http://localhost:3001',
  timeout: 10000,
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