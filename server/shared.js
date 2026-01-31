/**
 * Shared utilities for SponsorBlock plugin
 * Centralizes validation, API access, and caching logic
 */

const { URL } = require('url');

const ALL_CATEGORIES = [
  'sponsor', 'selfpromo', 'interaction', 'intro', 'outro',
  'preview', 'music_offtopic', 'filler'
];

const CATEGORIES_PARAM = `&categories=${encodeURIComponent(JSON.stringify(ALL_CATEGORIES))}`;

const FETCH_TIMEOUT_MS = 30000;

/**
 * Validate that an API URL is safe (not targeting internal/private networks)
 * Rejects private IPs, loopback, link-local, and non-HTTPS schemes
 */
function validateApiUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    throw new Error(`Invalid API URL: ${urlString}`);
  }

  if (parsed.protocol !== 'https:') {
    throw new Error(`API URL must use HTTPS, got: ${parsed.protocol}`);
  }

  const hostname = parsed.hostname;

  // Reject IPv6 private/loopback
  if (hostname.startsWith('[')) {
    const ipv6 = hostname.slice(1, -1).toLowerCase();
    if (ipv6 === '::1' || ipv6.startsWith('fc') || ipv6.startsWith('fd') || ipv6.startsWith('fe80')) {
      throw new Error(`API URL must not target private/internal addresses: ${hostname}`);
    }
  }

  // Reject IPv4 private/loopback/link-local ranges
  const ipv4Match = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (ipv4Match) {
    const [, a, b] = ipv4Match.map(Number);
    if (
      a === 127 ||                          // 127.0.0.0/8 loopback
      a === 10 ||                           // 10.0.0.0/8 private
      (a === 172 && b >= 16 && b <= 31) ||  // 172.16.0.0/12 private
      (a === 192 && b === 168) ||           // 192.168.0.0/16 private
      (a === 169 && b === 254) ||           // 169.254.0.0/16 link-local
      a === 0                               // 0.0.0.0/8
    ) {
      throw new Error(`API URL must not target private/internal addresses: ${hostname}`);
    }
  }

  // Reject localhost by name
  if (hostname === 'localhost' || hostname.endsWith('.local')) {
    throw new Error(`API URL must not target local addresses: ${hostname}`);
  }

  return parsed.toString();
}

/**
 * Validate a segment from the SponsorBlock API response
 */
function validateSegment(segment) {
  if (!segment || typeof segment !== 'object') return false;
  if (typeof segment.UUID !== 'string' || segment.UUID.length === 0 || segment.UUID.length > 128) return false;
  if (!Array.isArray(segment.segment) || segment.segment.length !== 2) return false;
  const [start, end] = segment.segment;
  if (typeof start !== 'number' || typeof end !== 'number') return false;
  if (start < 0 || end < 0 || start >= end) return false;
  if (!isFinite(start) || !isFinite(end)) return false;
  if (typeof segment.category !== 'string' || segment.category.length === 0 || segment.category.length > 50) return false;
  if (segment.votes !== undefined && typeof segment.votes !== 'number') return false;
  return true;
}

/**
 * Extract YouTube ID from a URL or raw ID string
 * Handles youtube.com/watch, youtu.be, /embed/, /shorts/, /v/ formats
 */
function extractYoutubeId(input) {
  if (!input) return null;

  if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) {
    return input.trim();
  }

  try {
    const url = new URL(input);

    // youtube.com/watch?v=ID
    if (url.searchParams.has('v')) {
      const v = url.searchParams.get('v');
      if (/^[a-zA-Z0-9_-]{11}$/.test(v)) return v;
    }

    // youtu.be/ID or youtube.com/embed/ID or youtube.com/shorts/ID or youtube.com/v/ID
    const pathMatch = url.pathname.match(/^\/(?:embed\/|shorts\/|v\/)?([a-zA-Z0-9_-]{11})/);
    if (pathMatch) return pathMatch[1];
  } catch {
    // Not a valid URL
  }

  return null;
}

/**
 * Get enabled SponsorBlock categories from settings
 */
async function getEnabledCategories(settingsManager) {
  const enabled = [];
  for (const cat of ALL_CATEGORIES) {
    const value = await settingsManager.getSetting(`category_${cat}`);
    if (value === true || value === 'true') {
      enabled.push(cat);
    }
  }
  return enabled;
}

/**
 * Fetch segments from SponsorBlock API and cache them in database
 * @param {object} options
 * @param {object} options.database - PeerTube database query interface
 * @param {object} options.settingsManager - PeerTube settings manager
 * @param {string} options.youtubeId - YouTube video ID
 * @param {object} options.logger - PeerTube logger
 * @returns {Promise<Array>} Cached segments
 */
async function fetchAndCacheSegments({ database, settingsManager, youtubeId, logger }) {
  const apiUrl = settingsManager
    ? (await settingsManager.getSetting('api_url') || 'https://sponsor.ajay.app')
    : 'https://sponsor.ajay.app';

  validateApiUrl(apiUrl);

  const url = `${apiUrl}/api/skipSegments?videoID=${youtubeId}${CATEGORIES_PARAM}`;
  logger.debug(`Fetching SponsorBlock segments for ${youtubeId}`);

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), FETCH_TIMEOUT_MS);

  let response;
  try {
    response = await fetch(url, { signal: controller.signal });
  } finally {
    clearTimeout(timeout);
  }

  if (response.status === 404) {
    logger.debug(`No segments found for ${youtubeId}`);
    return [];
  }

  if (!response.ok) {
    throw new Error(`SponsorBlock API error: ${response.status}`);
  }

  const apiSegments = await response.json();

  if (!Array.isArray(apiSegments)) {
    throw new Error(`SponsorBlock API returned unexpected response type: ${typeof apiSegments}`);
  }

  // Delete old and insert new segments in a transaction
  await database.query('BEGIN');
  try {
    await database.query(
      'DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1',
      { bind: [youtubeId] }
    );

    const segments = [];
    for (const segment of apiSegments) {
      if (!validateSegment(segment)) {
        logger.warn(`Skipping invalid segment from API: ${JSON.stringify(segment).slice(0, 200)}`);
        continue;
      }
      await database.query(`
        INSERT INTO plugin_sponsorblock_segments
        (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
        VALUES ($1, $2, $3, $4, $5, $6, $7)
        ON CONFLICT (segment_uuid) DO NOTHING
      `, { bind: [
        youtubeId,
        segment.UUID,
        segment.segment[0],
        segment.segment[1],
        segment.category,
        segment.actionType || 'skip',
        segment.votes || 0
      ] });
      segments.push({
        segment_uuid: segment.UUID,
        start_time: segment.segment[0],
        end_time: segment.segment[1],
        category: segment.category,
        action_type: segment.actionType || 'skip',
        votes: segment.votes || 0
      });
    }

    await database.query('COMMIT');
    logger.info(`Cached ${segments.length} segments for ${youtubeId}`);
    return segments;
  } catch (txError) {
    await database.query('ROLLBACK');
    throw txError;
  }
}

module.exports = {
  ALL_CATEGORIES,
  CATEGORIES_PARAM,
  FETCH_TIMEOUT_MS,
  validateApiUrl,
  validateSegment,
  extractYoutubeId,
  getEnabledCategories,
  fetchAndCacheSegments
};
