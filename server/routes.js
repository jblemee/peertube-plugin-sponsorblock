/**
 * Server-side API routes
 */

async function registerRoutes({ router, peertubeHelpers }) {
  const logger = peertubeHelpers.logger

  /**
   * GET /segments/:videoUuid
   * Returns SponsorBlock segments for a given video
   */
  router.get('/segments/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    try {
      const database = peertubeHelpers.database

      // Get YouTube ID for this video
      const [mappings] = await database.query(`
        SELECT youtube_id FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, [videoUuid])

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found for this video',
          segments: []
        })
      }

      const youtubeId = mappings[0].youtube_id

      // Get segments
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
        ORDER BY start_time ASC
      `, [youtubeId])

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

    try {
      const database = peertubeHelpers.database

      const [mappings] = await database.query(`
        SELECT youtube_id, created_at, last_sync
        FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, [videoUuid])

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
      `, [videoUuid, youtubeId])

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
        `, [row.uuid])

        if (existing && existing.length > 0) continue

        // Create mapping
        await database.query(`
          INSERT INTO plugin_sponsorblock_mapping (peertube_uuid, youtube_id, created_at, last_sync)
          VALUES ($1, $2, NOW(), NOW())
          ON CONFLICT (peertube_uuid) DO NOTHING
        `, [row.uuid, youtubeId])

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
   * POST /sync/:videoUuid
   * Manually trigger sync for a video
   */
  router.post('/sync/:videoUuid', async (req, res) => {
    const videoUuid = req.params.videoUuid

    try {
      const database = peertubeHelpers.database

      // Get YouTube ID
      const [mappings] = await database.query(`
        SELECT youtube_id FROM plugin_sponsorblock_mapping
        WHERE peertube_uuid = $1
      `, [videoUuid])

      if (!mappings || mappings.length === 0) {
        return res.status(404).json({
          error: 'No YouTube mapping found'
        })
      }

      const youtubeId = mappings[0].youtube_id

      // Fetch fresh segments
      const apiUrl = 'https://sponsor.ajay.app'
      const response = await fetch(`${apiUrl}/api/skipSegments?videoID=${youtubeId}`)

      if (!response.ok) {
        return res.status(response.status).json({
          error: 'Failed to fetch from SponsorBlock API'
        })
      }

      const segments = await response.json()

      // Delete old segments
      await database.query(`
        DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
      `, [youtubeId])

      // Insert new segments
      let insertedCount = 0
      for (const segment of segments) {
        await database.query(`
          INSERT INTO plugin_sponsorblock_segments
          (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
          VALUES ($1, $2, $3, $4, $5, $6, $7)
          ON CONFLICT (segment_uuid) DO NOTHING
        `, [
          youtubeId,
          segment.UUID,
          segment.segment[0],
          segment.segment[1],
          segment.category,
          segment.actionType || 'skip',
          segment.votes || 0
        ])
        insertedCount++
      }

      // Update last_sync timestamp
      await database.query(`
        UPDATE plugin_sponsorblock_mapping
        SET last_sync = NOW()
        WHERE peertube_uuid = $1
      `, [videoUuid])

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
 * Fetch segments from SponsorBlock API and cache them in database
 */
async function fetchAndCacheSegments(database, youtubeId, logger) {
  const apiUrl = 'https://sponsor.ajay.app'
  const response = await fetch(`${apiUrl}/api/skipSegments?videoID=${youtubeId}`)

  if (response.status === 404) {
    // No segments found on SponsorBlock — not an error
    return []
  }

  if (!response.ok) {
    throw new Error(`SponsorBlock API error: ${response.status}`)
  }

  const apiSegments = await response.json()

  // Delete old segments
  await database.query(`
    DELETE FROM plugin_sponsorblock_segments WHERE youtube_id = $1
  `, [youtubeId])

  // Insert new segments
  const segments = []
  for (const segment of apiSegments) {
    await database.query(`
      INSERT INTO plugin_sponsorblock_segments
      (youtube_id, segment_uuid, start_time, end_time, category, action_type, votes)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      ON CONFLICT (segment_uuid) DO NOTHING
    `, [
      youtubeId,
      segment.UUID,
      segment.segment[0],
      segment.segment[1],
      segment.category,
      segment.actionType || 'skip',
      segment.votes || 0
    ])
    segments.push({
      segment_uuid: segment.UUID,
      start_time: segment.segment[0],
      end_time: segment.segment[1],
      category: segment.category,
      action_type: segment.actionType || 'skip',
      votes: segment.votes || 0
    })
  }

  return segments
}

module.exports = { registerRoutes }
