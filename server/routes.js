/**
 * Server-side API routes
 */

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

function isValidUuid(value) {
  return typeof value === 'string' && UUID_REGEX.test(value)
}

/**
 * Simple in-memory token-bucket rate limiter
 * @param {number} maxTokens - Maximum requests allowed in the window
 * @param {number} windowMs - Time window in milliseconds
 */
function createRateLimiter(maxTokens, windowMs) {
  const buckets = new Map()

  // Periodically clean up expired entries to avoid memory leaks
  setInterval(() => {
    const now = Date.now()
    for (const [key, bucket] of buckets) {
      if (now - bucket.lastRefill > windowMs * 2) {
        buckets.delete(key)
      }
    }
  }, windowMs).unref()

  return (req, res, next) => {
    const ip = req.ip || req.connection.remoteAddress || 'unknown'
    const now = Date.now()

    let bucket = buckets.get(ip)
    if (!bucket) {
      bucket = { tokens: maxTokens, lastRefill: now }
      buckets.set(ip, bucket)
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill
    const refill = Math.floor((elapsed / windowMs) * maxTokens)
    if (refill > 0) {
      bucket.tokens = Math.min(maxTokens, bucket.tokens + refill)
      bucket.lastRefill = now
    }

    if (bucket.tokens <= 0) {
      return res.status(429).json({ error: 'Too many requests, please try again later' })
    }

    bucket.tokens--
    next()
  }
}

const ALL_CATEGORIES = [
  'sponsor', 'selfpromo', 'interaction', 'intro', 'outro',
  'preview', 'music_offtopic', 'filler'
]

const CATEGORIES_PARAM = `&categories=${encodeURIComponent(JSON.stringify(ALL_CATEGORIES))}`

async function getEnabledCategories(settingsManager) {
  const enabled = []
  for (const cat of ALL_CATEGORIES) {
    const value = await settingsManager.getSetting(`category_${cat}`)
    if (value === true || value === 'true') {
      enabled.push(cat)
    }
  }
  return enabled
}

async function registerRoutes({ router, peertubeHelpers, settingsManager }) {
  const logger = peertubeHelpers.logger

  // Rate limiter: 60 requests per minute per IP for public endpoints
  const segmentsRateLimiter = createRateLimiter(60, 60 * 1000)

  /**
   * GET /segments/:videoUuid
   * Returns SponsorBlock segments for a given video
   */
  router.get('/segments/:videoUuid', segmentsRateLimiter, async (req, res) => {
    const videoUuid = req.params.videoUuid

    if (!isValidUuid(videoUuid)) {
      return res.status(400).json({ error: 'Invalid video UUID format' })
    }

    try {
      const database = peertubeHelpers.database

      // Get YouTube ID for this video
      const [mappings] = await database.query(`
        SELECT youtube_id FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, { bind: [videoUuid] })

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found for this video',
          segments: []
        })
      }

      const youtubeId = mappings[0].youtube_id

      // If video was already processed by FFmpeg, don't skip segments client-side
      const [processed] = await database.query(`
        SELECT id FROM plugin_sponsorblock_processing_queue
        WHERE video_uuid = $1 AND status = 'done'
        LIMIT 1
      `, { bind: [videoUuid] })

      if (processed && processed.length > 0) {
        return res.json({ videoUuid, youtubeId, segments: [], processed: true })
      }

      // Get enabled categories from settings
      const enabledCategories = await getEnabledCategories(settingsManager)

      if (enabledCategories.length === 0) {
        return res.json({ videoUuid, youtubeId, segments: [] })
      }

      // Build parameterized placeholders for categories ($2, $3, ...)
      const categoryPlaceholders = enabledCategories.map((_, i) => `$${i + 2}`).join(', ')

      // Get segments filtered by enabled categories
      const [segments] = await database.query(`
        SELECT
          segment_uuid,
          start_time,
          end_time,
          category,
          action_type,
          votes
        FROM plugin_sponsorblock_segments
        WHERE youtube_id = $1
          AND category IN (${categoryPlaceholders})
        ORDER BY start_time ASC
      `, { bind: [youtubeId, ...enabledCategories] })

      res.json({
        videoUuid,
        youtubeId,
        segments: segments || []
      })

    } catch (error) {
      logger.error('Error fetching segments', error)
      res.status(500).json({
        error: 'Internal server error',
        segments: []
      })
    }
  })

  /**
   * GET /mapping/:videoUuid
   * Returns YouTube ID mapping for a video
   */
  router.get('/mapping/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    if (!isValidUuid(videoUuid)) {
      return res.status(400).json({ error: 'Invalid video UUID format' })
    }

    try {
      // Auth check: admin/moderator only
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || (user.role !== 0 && user.role !== 1)) {
        return res.status(403).json({ error: 'Admin or moderator access required' })
      }

      const database = peertubeHelpers.database

      const [mappings] = await database.query(`
        SELECT youtube_id, created_at, last_sync
        FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, { bind: [videoUuid] })

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found'
        })
      }

      res.json(mappings[0])

    } catch (error) {
      logger.error('Error fetching mapping', error)
      res.status(500).json({
        error: 'Internal server error'
      })
    }
  })

  /**
   * POST /mapping/:videoUuid
   * Manually associate a YouTube ID with a PeerTube video
   */
  router.post('/mapping/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    if (!isValidUuid(videoUuid)) {
      return res.status(400).json({ error: 'Invalid video UUID format' })
    }

    try {
      // Auth check: admin/moderator only
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || (user.role !== 0 && user.role !== 1)) {
        return res.status(403).json({ error: 'Admin or moderator access required' })
      }

      let { youtubeId } = req.body

      // Accept full YouTube URLs and extract the ID
      if (youtubeId && youtubeId.includes('/')) {
        const extracted = extractYoutubeId(youtubeId)
        if (extracted) {
          youtubeId = extracted
        }
      }

      // Validate YouTube ID format (11 chars, alphanumeric + _ -)
      if (!youtubeId || !/^[a-zA-Z0-9_-]{11}$/.test(youtubeId)) {
        return res.status(400).json({ error: 'Invalid YouTube ID format' })
      }

      const database = peertubeHelpers.database

      // Upsert mapping
      await database.query(`
        INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id, created_at, last_sync)
        VALUES ($1, $2, NOW(), NOW())
        ON CONFLICT (peertube_uuid) DO UPDATE SET youtube_id = $2, last_sync = NOW()
      `, { bind: [videoUuid, youtubeId] })

      // Fetch segments from SponsorBlock
      const segments = await fetchAndCacheSegments(database, youtubeId, logger)

      logger.info(`Manual mapping created: ${videoUuid} -> ${youtubeId} (${segments.length} segments)`)

      res.json({
        success: true,
        videoUuid,
        youtubeId,
        segments
      })

    } catch (error) {
      logger.error('Error creating mapping', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * POST /scan
   * Scan videoImport table for YouTube imports and create mappings
   */
  router.post('/scan', async (req, res) => {
    try {
      // Auth check: admin/moderator only
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || (user.role !== 0 && user.role !== 1)) {
        return res.status(403).json({ error: 'Admin or moderator access required' })
      }

      const database = peertubeHelpers.database

      // Find YouTube imports
      const [imports] = await database.query(`
        SELECT vi."targetUrl", v."uuid"
        FROM "videoImport" vi
        JOIN "video" v ON vi."videoId" = v."id"
        WHERE vi."targetUrl" LIKE '%youtube%' OR vi."targetUrl" LIKE '%youtu.be%'
      `)

      let scanned = 0
      let mapped = 0
      const errors = []

      for (const row of (imports || [])) {
        scanned++
        const youtubeId = extractYoutubeId(row.targetUrl)
        if (!youtubeId) {
          errors.push(`Could not extract YouTube ID from: ${row.targetUrl}`)
          continue
        }

        // Check if mapping already exists
        const [existing] = await database.query(`
          SELECT 1 FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1
        `, { bind: [row.uuid] })

        if (existing && existing.length > 0) continue

        // Create mapping
        await database.query(`
          INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id, created_at, last_sync)
          VALUES ($1, $2, NOW(), NOW())
          ON CONFLICT (peertube_uuid) DO NOTHING
        `, { bind: [row.uuid, youtubeId] })

        // Fetch segments
        try {
          await fetchAndCacheSegments(database, youtubeId, logger)
          mapped++
        } catch (err) {
          errors.push(`Failed to fetch segments for ${youtubeId}: ${err.message}`)
        }
      }

      logger.info(`Scan complete: ${scanned} scanned, ${mapped} mapped, ${errors.length} errors`)

      res.json({ success: true, scanned, mapped, errors })

    } catch (error) {
      logger.error('Error during scan', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * POST /process/:videoUuid
   * Queue a single video for FFmpeg segment removal
   */
  router.post('/process/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    if (!isValidUuid(videoUuid)) {
      return res.status(400).json({ error: 'Invalid video UUID format' })
    }

    try {
      // Auth check: admin/moderator only
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || (user.role !== 0 && user.role !== 1)) {
        return res.status(403).json({ error: 'Admin or moderator access required' })
      }

      const database = peertubeHelpers.database

      // Get YouTube ID mapping
      const [mappings] = await database.query(
        'SELECT youtube_id FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1',
        { bind: [videoUuid] }
      )

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({ error: 'process-no-mapping' })
      }

      const youtubeId = mappings[0].youtube_id

      // Get segments
      const [segments] = await database.query(
        'SELECT start_time, end_time, category FROM plugin_sponsorblock_segments WHERE youtube_id = $1 ORDER BY start_time ASC',
        { bind: [youtubeId] }
      )

      if (!segments || segments.length === 0) {
        return res.status(404).json({ error: 'process-no-segments' })
      }

      // Check for existing pending/processing entry
      const [existing] = await database.query(
        "SELECT id FROM plugin_sponsorblock_processing_queue WHERE video_uuid = $1 AND status IN ('pending', 'processing')",
        { bind: [videoUuid] }
      )

      if (existing && existing.length > 0) {
        return res.status(409).json({ error: 'process-already-queued' })
      }

      // Insert into queue with priority 5
      const [inserted] = await database.query(`
        INSERT INTO plugin_sponsorblock_processing_queue (video_uuid, youtube_id, segments, priority)
        VALUES ($1, $2, $3, 5)
        RETURNING id
      `, { bind: [videoUuid, youtubeId, JSON.stringify(segments)] })

      logger.info(`Queued video ${videoUuid} for processing (${segments.length} segments, priority 5)`)

      res.json({
        success: true,
        queueId: inserted[0].id,
        segmentsCount: segments.length
      })

    } catch (error) {
      logger.error('Error queuing video for processing', error)
      res.status(500).json({ error: 'process-error' })
    }
  })

  /**
   * POST /process-all
   * Queue all mapped videos that have segments but no pending/done queue entry
   */
  router.post('/process-all', async (req, res) => {
    try {
      // Auth check: admin/moderator only
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || (user.role !== 0 && user.role !== 1)) {
        return res.status(403).json({ error: 'Admin or moderator access required' })
      }

      const database = peertubeHelpers.database

      // Find all mappings with segments that have no done/pending/processing queue entry
      const [candidates] = await database.query(`
        SELECT DISTINCT m.peertube_uuid, m.youtube_id
        FROM plugin_sponsorblock_mapping m
        INNER JOIN plugin_sponsorblock_segments s ON s.youtube_id = m.youtube_id
        WHERE NOT EXISTS (
          SELECT 1 FROM plugin_sponsorblock_processing_queue q
          WHERE q.video_uuid = m.peertube_uuid
            AND q.status IN ('done', 'pending', 'processing')
        )
      `)

      let queued = 0
      const errors = []

      for (const candidate of (candidates || [])) {
        try {
          const [segments] = await database.query(
            'SELECT start_time, end_time, category FROM plugin_sponsorblock_segments WHERE youtube_id = $1 ORDER BY start_time ASC',
            { bind: [candidate.youtube_id] }
          )

          if (!segments || segments.length === 0) continue

          await database.query(`
            INSERT INTO plugin_sponsorblock_processing_queue (video_uuid, youtube_id, segments, priority)
            VALUES ($1, $2, $3, 1)
          `, { bind: [candidate.peertube_uuid, candidate.youtube_id, JSON.stringify(segments)] })

          queued++
        } catch (err) {
          errors.push(`${candidate.peertube_uuid}: ${err.message}`)
        }
      }

      logger.info(`Process-all: queued ${queued} videos, ${errors.length} errors`)

      res.json({ success: true, queued, errors })

    } catch (error) {
      logger.error('Error in process-all', error)
      res.status(500).json({ error: 'process-error' })
    }
  })

  /**
   * GET /admin/stats
   * Returns dashboard statistics
   */
  router.get('/admin/stats', async (req, res) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(403).json({ error: 'Admin access required' })
      }

      const database = peertubeHelpers.database

      const [[mappingCount], [segmentStats], [queueStats], [lastSync]] = await Promise.all([
        database.query('SELECT COUNT(*) AS count FROM plugin_sponsorblock_mapping'),
        database.query('SELECT COUNT(*) AS count, COALESCE(SUM(end_time - start_time), 0) AS total_time FROM plugin_sponsorblock_segments'),
        database.query(`
          SELECT
            COUNT(*) FILTER (WHERE status = 'pending') AS pending,
            COUNT(*) FILTER (WHERE status = 'processing') AS processing,
            COUNT(*) FILTER (WHERE status = 'done') AS done,
            COUNT(*) FILTER (WHERE status = 'error') AS errored
          FROM plugin_sponsorblock_processing_queue
        `),
        database.query('SELECT MAX(last_sync) AS last_global_sync FROM plugin_sponsorblock_mapping')
      ])

      res.json({
        mapped_videos: parseInt(mappingCount[0].count, 10),
        total_segments: parseInt(segmentStats[0].count, 10),
        total_time_saved: parseFloat(segmentStats[0].total_time) || 0,
        queue: {
          pending: parseInt(queueStats[0].pending, 10),
          processing: parseInt(queueStats[0].processing, 10),
          done: parseInt(queueStats[0].done, 10),
          errored: parseInt(queueStats[0].errored, 10)
        },
        last_global_sync: lastSync[0].last_global_sync
      })
    } catch (error) {
      logger.error('Error fetching admin stats', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * GET /admin/mappings
   * Returns all mappings with segment counts and queue status
   */
  router.get('/admin/mappings', async (req, res) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(403).json({ error: 'Admin access required' })
      }

      const database = peertubeHelpers.database

      const [mappings] = await database.query(`
        SELECT
          m.peertube_uuid,
          m.youtube_id,
          m.created_at,
          m.last_sync,
          v.name AS video_name,
          COALESCE(seg.segment_count, 0) AS segment_count,
          COALESCE(seg.time_saved, 0) AS time_saved,
          q.status AS queue_status,
          q.error AS queue_error
        FROM plugin_sponsorblock_mapping m
        LEFT JOIN "video" v ON v.uuid = m.peertube_uuid
        LEFT JOIN (
          SELECT youtube_id, COUNT(*) AS segment_count, SUM(end_time - start_time) AS time_saved
          FROM plugin_sponsorblock_segments
          GROUP BY youtube_id
        ) seg ON seg.youtube_id = m.youtube_id
        LEFT JOIN LATERAL (
          SELECT status, error FROM plugin_sponsorblock_processing_queue
          WHERE video_uuid = m.peertube_uuid
          ORDER BY created_at DESC LIMIT 1
        ) q ON true
        ORDER BY m.created_at DESC
      `)

      res.json({ mappings: mappings || [] })
    } catch (error) {
      logger.error('Error fetching admin mappings', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * DELETE /mapping/:videoUuid
   * Delete a mapping and its orphaned segments
   */
  router.delete('/mapping/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    if (!isValidUuid(videoUuid)) {
      return res.status(400).json({ error: 'Invalid video UUID format' })
    }

    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(403).json({ error: 'Admin access required' })
      }

      const database = peertubeHelpers.database

      // Get the youtube_id before deleting the mapping
      const [mappings] = await database.query(
        'SELECT youtube_id FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1',
        { bind: [videoUuid] }
      )

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({ error: 'Mapping not found' })
      }

      const youtubeId = mappings[0].youtube_id

      // Delete the mapping
      await database.query(
        'DELETE FROM plugin_sponsorblock_mapping WHERE peertube_uuid = $1',
        { bind: [videoUuid] }
      )

      // Delete queue entries for this video
      await database.query(
        'DELETE FROM plugin_sponsorblock_processing_queue WHERE video_uuid = $1',
        { bind: [videoUuid] }
      )

      // Delete segments only if no other mapping references the same youtube_id
      const [otherMappings] = await database.query(
        'SELECT 1 FROM plugin_sponsorblock_mapping WHERE youtube_id = $1 LIMIT 1',
        { bind: [youtubeId] }
      )

      if (!otherMappings || otherMappings.length === 0) {
        await database.query(
          'DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1',
          { bind: [youtubeId] }
        )
      }

      logger.info(`Deleted mapping ${videoUuid} -> ${youtubeId}`)

      res.json({ success: true })
    } catch (error) {
      logger.error('Error deleting mapping', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * POST /sync-all
   * Re-fetch segments for all mappings in background
   */
  router.post('/sync-all', async (req, res) => {
    try {
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || user.role !== 0) {
        return res.status(403).json({ error: 'Admin access required' })
      }

      const database = peertubeHelpers.database

      const [mappings] = await database.query(
        'SELECT peertube_uuid, youtube_id FROM plugin_sponsorblock_mapping'
      )

      const total = (mappings || []).length

      // Respond immediately
      res.json({ success: true, total })

      // Process in background with rate limiting
      ;(async () => {
        for (const mapping of (mappings || [])) {
          try {
            await fetchAndCacheSegments(database, mapping.youtube_id, logger)
            await database.query(
              'UPDATE plugin_sponsorblock_mapping SET last_sync = NOW() WHERE peertube_uuid = $1',
              { bind: [mapping.peertube_uuid] }
            )
          } catch (err) {
            logger.error(`Sync-all: failed for ${mapping.youtube_id}`, err)
          }
          // Rate limit: 200ms between requests
          await new Promise(resolve => setTimeout(resolve, 200))
        }
        logger.info(`Sync-all complete: ${total} mappings processed`)
      })()
    } catch (error) {
      logger.error('Error in sync-all', error)
      res.status(500).json({ error: 'Internal server error' })
    }
  })

  /**
   * POST /sync/:videoUuid
   * Manually trigger sync for a video
   */
  router.post('/sync/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    if (!isValidUuid(videoUuid)) {
      return res.status(400).json({ error: 'Invalid video UUID format' })
    }

    try {
      // Auth check: admin/moderator only
      const user = await peertubeHelpers.user.getAuthUser(res)
      if (!user || (user.role !== 0 && user.role !== 1)) {
        return res.status(403).json({ error: 'Admin or moderator access required' })
      }

      const database = peertubeHelpers.database

      // Get YouTube ID
      const [mappings] = await database.query(`
        SELECT youtube_id FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, { bind: [videoUuid] })

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found'
        })
      }

      const youtubeId = mappings[0].youtube_id

      // Fetch fresh segments
      const apiUrl = 'https://sponsor.ajay.app'
      const response = await fetch(`${apiUrl}/api/skipSegments?videoID=${youtubeId}${CATEGORIES_PARAM}`)

      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Failed to fetch from SponsorBlock API'
        })
      }

      const segments = await response.json()

      // Delete old and insert new segments in a transaction
      await database.query('BEGIN')
      let insertedCount = 0
      try {
        await database.query(`
          DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
        `, { bind: [youtubeId] })

        for (const segment of segments) {
          if (!validateSegment(segment)) {
            logger.warn(`Skipping invalid segment from API: ${JSON.stringify(segment).slice(0, 200)}`)
            continue
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
          ] })
          insertedCount++
        }

        await database.query('COMMIT')
      } catch (txError) {
        await database.query('ROLLBACK')
        throw txError
      }

      // Update last_sync timestamp
      await database.query(`
        UPDATE plugin_sponsorblock_mapping
        SET last_sync = NOW()
        WHERE peertube_uuid = $1
      `, { bind: [videoUuid] })

      logger.info(`Synced ${insertedCount} segments for ${videoUuid}`)

      res.json({
        success: true,
        segmentsCount: insertedCount,
        youtubeId
      })

    } catch (error) {
      logger.error('Error syncing segments', error)
      res.status(500).json({
        error: 'Internal server error'
      })
    }
  })
}

/**
 * Extract YouTube ID from a URL or raw ID string
 */
function extractYoutubeId(input) {
  if (!input) return null

  // Already a raw ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(input.trim())) {
    return input.trim()
  }

  // Try URL patterns
  try {
    const url = new URL(input)

    // youtube.com/watch?v=ID
    if (url.searchParams.has('v')) {
      const v = url.searchParams.get('v')
      if (/^[a-zA-Z0-9_-]{11}$/.test(v)) return v
    }

    // youtu.be/ID or youtube.com/embed/ID or youtube.com/shorts/ID
    const pathMatch = url.pathname.match(/^\/(?:embed\/|shorts\/|v\/)?([a-zA-Z0-9_-]{11})/)
    if (pathMatch) return pathMatch[1]
  } catch {
    // Not a valid URL
  }

  return null
}

/**
 * Validate a segment from the SponsorBlock API response
 * Returns true if the segment has valid shape, false otherwise
 */
function validateSegment(segment) {
  if (!segment || typeof segment !== 'object') return false
  if (typeof segment.UUID !== 'string' || segment.UUID.length === 0 || segment.UUID.length > 128) return false
  if (!Array.isArray(segment.segment) || segment.segment.length !== 2) return false
  const [start, end] = segment.segment
  if (typeof start !== 'number' || typeof end !== 'number') return false
  if (start < 0 || end < 0 || start >= end) return false
  if (!isFinite(start) || !isFinite(end)) return false
  if (typeof segment.category !== 'string' || segment.category.length === 0 || segment.category.length > 50) return false
  if (segment.votes !== undefined && typeof segment.votes !== 'number') return false
  return true
}

/**
 * Fetch segments from SponsorBlock API and cache them in database
 */
async function fetchAndCacheSegments(database, youtubeId, logger) {
  const apiUrl = 'https://sponsor.ajay.app'
  const response = await fetch(`${apiUrl}/api/skipSegments?videoID=${youtubeId}${CATEGORIES_PARAM}`)

  if (response.status === 404) {
    // No segments found on SponsorBlock — not an error
    return []
  }

  if (!response.ok) {
    throw new Error(`SponsorBlock API error: ${response.status}`)
  }

  const apiSegments = await response.json()

  // Delete old and insert new segments in a transaction
  await database.query('BEGIN')
  try {
    await database.query(`
      DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
    `, { bind: [youtubeId] })

    const segments = []
    for (const segment of apiSegments) {
      if (!validateSegment(segment)) {
        logger.warn(`Skipping invalid segment from API: ${JSON.stringify(segment).slice(0, 200)}`)
        continue
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
      ] })
      segments.push({
        segment_uuid: segment.UUID,
        start_time: segment.segment[0],
        end_time: segment.segment[1],
        category: segment.category,
        action_type: segment.actionType || 'skip',
        votes: segment.votes || 0
      })
    }

    await database.query('COMMIT')
    return segments
  } catch (txError) {
    await database.query('ROLLBACK')
    throw txError
  }
}

module.exports = { registerRoutes, ALL_CATEGORIES }
