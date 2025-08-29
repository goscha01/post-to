import React, { useState, useRef } from 'react';

// ImgBB API Service
class ImgBBService {
  constructor(apiKey) {
    this.apiKey = apiKey;
    this.baseUrl = 'https://api.imgbb.com/1/upload';
  }

  async uploadFile(file, name = null, expiration = null) {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = async () => {
        try {
          if (reader.result && typeof reader.result === 'string') {
            const base64 = reader.result.split(',')[1];
            const url = await this.uploadBase64(base64, name, expiration);
            resolve(url);
          } else {
            reject(new Error('Failed to read file as string'));
          }
        } catch (error) {
          reject(error);
        }
      };
      reader.onerror = () => reject(new Error('Failed to read file'));
      reader.readAsDataURL(file);
    });
  }

  async uploadBase64(base64, name = null, expiration = null) {
    const formData = new FormData();
    formData.append('key', this.apiKey);
    formData.append('image', base64);
    
    if (name) formData.append('name', name);
    if (expiration) formData.append('expiration', expiration);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        return result.data.url;
      } else {
        throw new Error(result.error?.message || 'Upload failed');
      }
    } catch (error) {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }

  async uploadFromUrl(imageUrl, name = null, expiration = null) {
    const formData = new FormData();
    formData.append('key', this.apiKey);
    formData.append('image', imageUrl);
    
    if (name) formData.append('name', name);
    if (expiration) formData.append('expiration', expiration);

    try {
      const response = await fetch(this.baseUrl, {
        method: 'POST',
        body: formData
      });

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      const result = await response.json();

      if (result.success) {
        return result.data.url;
      } else {
        throw new Error(result.error?.message || 'Upload failed');
      }
    } catch (error) {
      throw new Error(`Upload failed: ${error.message}`);
    }
  }
}

// Main Image Uploader Component
const ImageUploader = ({ onImageUploaded }) => {
  const [apiKey, setApiKey] = useState('');
  const [uploadedUrl, setUploadedUrl] = useState('');
  const [isUploading, setIsUploading] = useState(false);
  const [error, setError] = useState('');
  const [dragOver, setDragOver] = useState(false);
  const [urlInput, setUrlInput] = useState('');
  const [imageName, setImageName] = useState('');
  const [previewImage, setPreviewImage] = useState('');
  
  const fileInputRef = useRef(null);

  const imgbbService = apiKey ? new ImgBBService(apiKey) : null;

  const handleFileSelect = async (file) => {
    if (!imgbbService) {
      setError('Please enter your ImgBB API key first');
      return;
    }

    if (!file.type.startsWith('image/')) {
      setError('Please select an image file');
      return;
    }

    // Create preview
    const previewUrl = URL.createObjectURL(file);
    setPreviewImage(previewUrl);

    setIsUploading(true);
    setError('');

    try {
      const url = await imgbbService.uploadFile(file, imageName || null);
      setUploadedUrl(url);
      setError('');
      
      // Call the callback if provided
      if (onImageUploaded && typeof onImageUploaded === 'function') {
        onImageUploaded(url);
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setIsUploading(false);
    }
  };

  const handleFileInputChange = (e) => {
    if (e.target.files && e.target.files[0]) {
      handleFileSelect(e.target.files[0]);
    }
  };

  const handleDragOver = (e) => {
    e.preventDefault();
    setDragOver(true);
  };

  const handleDragLeave = (e) => {
    e.preventDefault();
    setDragOver(false);
  };

  const handleDrop = (e) => {
    e.preventDefault();
    setDragOver(false);
    
    const files = e.dataTransfer.files;
    if (files && files[0]) {
      handleFileSelect(files[0]);
    }
  };

  const handleUrlUpload = async () => {
    if (!imgbbService) {
      setError('Please enter your ImgBB API key first');
      return;
    }

    if (!urlInput.trim()) {
      setError('Please enter an image URL');
      return;
    }

    setIsUploading(true);
    setError('');
    setPreviewImage(urlInput);

    try {
      const url = await imgbbService.uploadFromUrl(urlInput, imageName || null);
      setUploadedUrl(url);
      setError('');
      
      // Call the callback if provided
      if (onImageUploaded && typeof onImageUploaded === 'function') {
        onImageUploaded(url);
      }
    } catch (err) {
      setError(err.message);
      setPreviewImage('');
    } finally {
      setIsUploading(false);
    }
  };

  const copyToClipboard = async () => {
    try {
      await navigator.clipboard.writeText(uploadedUrl);
      alert('URL copied to clipboard!');
    } catch (err) {
      // Fallback for older browsers
      const textArea = document.createElement('textarea');
      textArea.value = uploadedUrl;
      document.body.appendChild(textArea);
      textArea.select();
      document.execCommand('copy');
      document.body.removeChild(textArea);
      alert('URL copied to clipboard!');
    }
  };

  const resetUploader = () => {
    setUploadedUrl('');
    setError('');
    setPreviewImage('');
    setUrlInput('');
    setImageName('');
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  return (
    <div className="max-w-2xl mx-auto p-6 bg-white rounded-lg shadow-lg">
      <h2 className="text-2xl font-bold text-center mb-6 text-gray-800">
        ImgBB Image Uploader
      </h2>

      {/* API Key Input */}
      <div className="mb-6">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          ImgBB API Key
        </label>
        <input
          type="password"
          value={apiKey}
          onChange={(e) => setApiKey(e.target.value)}
          placeholder="Enter your ImgBB API key"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
        <p className="text-xs text-gray-500 mt-1">
          Get your free API key from{' '}
          <a href="https://api.imgbb.com/" target="_blank" rel="noopener noreferrer" className="text-blue-500 hover:underline">
            api.imgbb.com
          </a>
        </p>
      </div>

      {/* Image Name Input */}
      <div className="mb-4">
        <label className="block text-sm font-medium text-gray-700 mb-2">
          Image Name (Optional)
        </label>
        <input
          type="text"
          value={imageName}
          onChange={(e) => setImageName(e.target.value)}
          placeholder="Custom name for your image"
          className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
        />
      </div>

      {/* File Upload Section */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3 text-gray-700">Upload from File</h3>
        
        {/* Drag and Drop Area */}
        <div
          className={`border-2 border-dashed rounded-lg p-8 text-center transition-colors ${
            dragOver 
              ? 'border-blue-500 bg-blue-50' 
              : 'border-gray-300 hover:border-gray-400'
          }`}
          onDragOver={handleDragOver}
          onDragLeave={handleDragLeave}
          onDrop={handleDrop}
          onClick={() => fileInputRef.current?.click()}
        >
          <div className="cursor-pointer">
            <svg className="mx-auto h-12 w-12 text-gray-400 mb-4" stroke="currentColor" fill="none" viewBox="0 0 48 48">
              <path d="M28 8H12a4 4 0 00-4 4v20m32-12v8m0 0v8a4 4 0 01-4 4H12a4 4 0 01-4-4v-4m32-4l-3.172-3.172a4 4 0 00-5.656 0L28 28M8 32l9.172-9.172a4 4 0 015.656 0L28 28m0 0l4 4m4-24h8m-4-4v8m-12 4h.02" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
            <p className="text-gray-600">
              <span className="font-medium">Click to upload</span> or drag and drop
            </p>
            <p className="text-sm text-gray-500">PNG, JPG, GIF up to 32MB</p>
          </div>
        </div>
        
        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          onChange={handleFileInputChange}
          className="hidden"
        />
      </div>

      {/* URL Upload Section */}
      <div className="mb-6">
        <h3 className="text-lg font-semibold mb-3 text-gray-700">Upload from URL</h3>
        <div className="flex gap-2">
          <input
            type="url"
            value={urlInput}
            onChange={(e) => setUrlInput(e.target.value)}
            placeholder="https://example.com/image.jpg"
            className="flex-1 px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
          />
          <button
            onClick={handleUrlUpload}
            disabled={isUploading || !apiKey}
            className="px-4 py-2 bg-green-500 text-white rounded-md hover:bg-green-600 disabled:bg-gray-400 disabled:cursor-not-allowed"
          >
            Upload
          </button>
        </div>
      </div>

      {/* Preview Image */}
      {previewImage && (
        <div className="mb-4">
          <h4 className="text-sm font-medium text-gray-700 mb-2">Preview:</h4>
          <img 
            src={previewImage} 
            alt="Preview" 
            className="max-w-full h-48 object-contain mx-auto rounded border"
          />
        </div>
      )}

      {/* Loading State */}
      {isUploading && (
        <div className="mb-4 p-4 bg-blue-50 rounded-md">
          <div className="flex items-center">
            <div className="animate-spin rounded-full h-4 w-4 border-b-2 border-blue-500 mr-2"></div>
            <span className="text-blue-700">Uploading image...</span>
          </div>
        </div>
      )}

      {/* Error Display */}
      {error && (
        <div className="mb-4 p-4 bg-red-50 border border-red-200 rounded-md">
          <p className="text-red-700 text-sm">{error}</p>
        </div>
      )}

      {/* Success - Show URL */}
      {uploadedUrl && (
        <div className="mb-4 p-4 bg-green-50 border border-green-200 rounded-md">
          <h4 className="font-medium text-green-800 mb-2">Upload Successful!</h4>
          <p className="text-sm text-gray-600 mb-2">Image URL (ready for Google My Business):</p>
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={uploadedUrl}
              readOnly
              className="flex-1 px-2 py-1 text-sm bg-white border border-gray-300 rounded"
            />
            <button
              onClick={copyToClipboard}
              className="px-3 py-1 bg-blue-500 text-white text-sm rounded hover:bg-blue-600"
            >
              Copy
            </button>
          </div>
          <div className="mt-3 flex gap-2">
            <a
              href={uploadedUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-blue-600 hover:underline"
            >
              View Image
            </a>
            <button
              onClick={resetUploader}
              className="text-sm text-gray-600 hover:text-gray-800"
            >
              Upload Another
            </button>
          </div>
        </div>
      )}

      {/* Instructions */}
      <div className="mt-6 p-4 bg-gray-50 rounded-md">
        <h4 className="font-medium text-gray-800 mb-2">Instructions:</h4>
        <ol className="text-sm text-gray-600 space-y-1">
          <li>1. Get your free API key from <a href="https://api.imgbb.com/" className="text-blue-500 hover:underline">api.imgbb.com</a></li>
          <li>2. Enter the API key above</li>
          <li>3. Upload your image by file or URL</li>
          <li>4. Copy the generated URL for Google My Business</li>
        </ol>
      </div>
    </div>
  );
};

export default ImageUploader;