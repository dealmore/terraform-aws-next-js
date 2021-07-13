/**
 * Output the host header of the request
 */

export default function handler(req, res) {
  const host = req.headers['host'];
  res.end(`host: ${host}`);
}
