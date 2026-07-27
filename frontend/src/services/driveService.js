import axios from '../utils/axiosConfig';

class DriveService {
  async listImages({ q = '', pageSize = 50, folderId = '', type = 'images', googleId = '', profileEmail = '' } = {}) {
    const params = { q, pageSize, folderId, type };
    if (googleId) params.googleId = googleId;
    if (profileEmail) params.profileEmail = profileEmail;
    const response = await axios.get('/api/drive/images', { params });
    return response.data;
  }
}

const driveService = new DriveService();
export default driveService;
