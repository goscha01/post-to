import axios from '../utils/axiosConfig';

class CalendarService {
  async getRange({ from, to } = {}) {
    const params = {};
    if (from) params.from = from instanceof Date ? from.toISOString() : from;
    if (to) params.to = to instanceof Date ? to.toISOString() : to;
    const response = await axios.get('/api/calendar', { params });
    return response.data;
  }
}

const calendarService = new CalendarService();
export default calendarService;
