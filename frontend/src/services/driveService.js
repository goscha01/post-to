import axios from '../utils/axiosConfig';

class DriveService {
  async listImages({ q = '', pageSize = 50, folderId = '', type = 'images' } = {}) {
    const response = await axios.get('/api/drive/images', {
      params: { q, pageSize, folderId, type },
    });
    return response.data;
  }
}

const driveService = new DriveService();
export default driveService;
