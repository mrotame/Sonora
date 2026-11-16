const ID = /^[A-Za-z0-9_-]{11}$/;
const WATCH_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com']);

/**
 * Returns the video id of a recognized YouTube video URL, or null.
 * Accepts https://youtube.com/watch?v=ID and https://youtu.be/ID. A `list`
 * parameter is ignored (only the single video is ever requested). Playlist
 * pages, channels, shorts and live paths are not recognized.
 */
export function parseYouTubeVideoId(input: string): string | null {
  if (input.length > 300) return null;
  let url: URL;
  try {
    url = new URL(input.trim());
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  const host = url.hostname.toLowerCase();
  let id: string | null = null;
  if (WATCH_HOSTS.has(host) && url.pathname === '/watch') id = url.searchParams.get('v');
  else if (host === 'youtu.be') id = url.pathname.slice(1);
  return id !== null && ID.test(id) ? id : null;
}

export function canonicalUrl(videoId: string): string {
  return `https://www.youtube.com/watch?v=${videoId}`;
}
