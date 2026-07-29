export default function handler(_req, res) {
  res.status(200).json({
    status: 'OK',
    service: 'post-to-blogs',
    timestamp: new Date().toISOString(),
  });
}
