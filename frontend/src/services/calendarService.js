import axios from '../utils/axiosConfig';

class CalendarService {
  async getRange({ from, to } = {}) {
    const params = {};
    if (from) params.from = from instanceof Date ? from.toISOString() : from;
    if (to) params.to = to instanceof Date ? to.toISOString() : to;
    const response = await axios.get('/api/calendar', { params });
    return response.data;
  }

  async schedule({ content, media, gmbAccountId, gmbLocationId, scheduledTime, postType, callToAction }) {
    const body = {
      content,
      media: media || [],
      platforms: ['google'],
      gmbAccountId,
      gmbLocationId,
      scheduledTime: scheduledTime instanceof Date ? scheduledTime.toISOString() : scheduledTime,
      postType: postType || 'UPDATE',
      callToAction: callToAction || null,
    };
    const response = await axios.post('/api/calendar/schedule', body);
    return response.data;
  }

  async cancel(id) {
    const response = await axios.delete(`/api/calendar/schedule/${id}`);
    return response.data;
  }

  async reschedule(id, { content, scheduledTime, postType, callToAction }) {
    const body = {};
    if (typeof content === 'string') body.content = content;
    if (scheduledTime) body.scheduledTime = scheduledTime instanceof Date ? scheduledTime.toISOString() : scheduledTime;
    if (postType) body.postType = postType;
    if (callToAction !== undefined) body.callToAction = callToAction;
    const response = await axios.patch(`/api/calendar/schedule/${id}`, body);
    return response.data;
  }
}

const calendarService = new CalendarService();
export default calendarService;
